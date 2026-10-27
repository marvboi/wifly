/**
 * WIF Names (WIFNAME), final API (contracts/docs/WIF-NAMES.md).
 * - name -> wallet: resolve("marv.wif") (setAddr record, else owner, else 0x0 = unclaimed)
 * - wallet -> name: reverseName(address) (verified "marv.wif" or ""). Never display nameOf.
 * - records: setAddr(id, addr) + setText(id, key, value) for keys avatar, x, url, bio (values <= 256 bytes)
 * - claim + records in ONE tx via multicall([claim, setText…, setAddr])
 * - records reset on every sale or transfer; the card theme (setTheme: 0 default, 1 white, 2 green) is kept
 * Every function accepts "marv" or "marv.wif". @handles are a separate, off-chain namespace resolved by the API.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { encodeFunctionData, keccak256, toBytes, zeroAddress, type Address, type Hex } from 'viem'
import { useReadContract } from 'wagmi'
import { api } from '../api/client'
import { NAMES_ADDRESS, claimFeeOf, robinhoodChain } from '../config'
import { namesAbi } from '../contracts/namesAbi'
import type { Plan } from './wifly'

export const TEXT_KEYS = ['avatar', 'x', 'url', 'bio'] as const
export type TextKey = typeof TEXT_KEYS[number]
export const MAX_TEXT_BYTES = 256
export const bytesOf = (s: string) => new TextEncoder().encode(s).length

/** Lowercase + trim, drop a leading @ and the .wif suffix: "  Marv.WIF " -> "marv". */
export const normalizeName = (raw: string) => raw.trim().toLowerCase().replace(/^@/, '').replace(/\.wif$/, '')
export const wif = (label: string) => `${normalizeName(label)}.wif`
export const nameId = (label: string) => BigInt(keccak256(toBytes(normalizeName(label))))
export const isWifName = (s: string) => /^[a-z0-9_]{3,20}\.wif$/i.test(s.trim())

export type NameCheck = {
  name: string; display: string; available: boolean; reason?: 'invalid' | 'reserved' | 'taken' | 'listed' | 'yours'; message?: string
  price?: number; owner?: { handle: string; wifName?: string | null } | null; claimFee: number; suggestions: string[]; live: boolean
}

function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v)
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t) }, [v, ms])
  return d
}

/** Availability + fee. API mirror always; when the names contract is live, isAvailable / claimFeeOf onchain win. */
export function useNameCheck(raw: string) {
  const n = useDebounced(normalizeName(raw))
  const valid = /^[a-z0-9_]{3,20}$/.test(n)
  const q = useQuery({ queryKey: ['names', 'check', n], queryFn: () => api<NameCheck>(`/names/check?n=${encodeURIComponent(n)}`), enabled: n.length > 0, staleTime: 10_000 })
  const live = !!NAMES_ADDRESS && valid
  const avail = useReadContract({ address: NAMES_ADDRESS, abi: namesAbi, functionName: 'isAvailable', args: [n], chainId: robinhoodChain.id, query: { enabled: live } })
  const fee = useReadContract({ address: NAMES_ADDRESS, abi: namesAbi, functionName: 'claimFeeOf', args: [n], chainId: robinhoodChain.id, query: { enabled: live } })
  let check = q.data && q.data.name === n ? q.data : undefined
  if (check && live && typeof avail.data === 'boolean' && check.reason !== 'yours' && check.reason !== 'reserved' && check.reason !== 'invalid')
    check = { ...check, available: avail.data, reason: avail.data ? undefined : check.reason ?? 'taken', message: avail.data ? undefined : check.message ?? 'taken by another wallet' }
  const claimFee = typeof fee.data === 'bigint' ? Number(fee.data / 10n ** 16n) / 100 : claimFeeOf(n)
  return { name: n, check: check ? { ...check, claimFee } : undefined, loading: n.length > 0 && (q.isFetching || n !== normalizeName(raw)), claimFee }
}

export type Resolved = { input: string; kind: 'wif' | 'handle' | 'address'; label: string; address: string | null; source: string; owner?: { handle: string; name: string; wifName?: string | null } | null }

/**
 * Anything an address field accepts: marv.wif (onchain resolve, holder's wallet), @marv (the DB), or 0x…
 * marv.wif never falls back to whoever holds @marv.
 */
export async function resolveRecipient(raw: string): Promise<Resolved | null> {
  const s = raw.trim()
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return { input: s, kind: 'address', label: `${s.slice(0, 6)}…${s.slice(-4)}`, address: s.toLowerCase(), source: 'raw' }
  if (isWifName(s)) {
    const label = normalizeName(s)
    try {
      const r = await api<{ address: string; source: string; owner: Resolved['owner'] }>(`/names/resolve/${label}.wif`)
      return { input: s, kind: 'wif', label: `${label}.wif`, address: r.address, source: r.source, owner: r.owner }
    } catch { return { input: s, kind: 'wif', label: `${label}.wif`, address: null, source: 'none' } }
  }
  const h = s.replace(/^@/, '').toLowerCase()
  if (!/^[a-z0-9_]{3,20}$/.test(h)) return null
  try {
    const r = await api<{ user: { handle: string; name: string; address: string | null; wifName?: string | null } }>(`/users/${h}`)
    return { input: s, kind: 'handle', label: `@${r.user.handle}`, address: r.user.address, source: 'db', owner: r.user }
  } catch { return null }
}

export function useResolve(raw: string) {
  const s = useDebounced(raw.trim(), 300)
  return useQuery({ queryKey: ['resolve', s], queryFn: () => resolveRecipient(s), enabled: s.length >= 3 })
}

/** Validate records like the contract (BadKey / TextTooLong) plus our own formats. */
export function recordErrors(r: Partial<Record<TextKey | 'address', string>>): Partial<Record<TextKey | 'address', string>> {
  const e: Partial<Record<TextKey | 'address', string>> = {}
  for (const k of TEXT_KEYS) if (r[k] && bytesOf(r[k]!) > MAX_TEXT_BYTES) e[k] = `${bytesOf(r[k]!)}/${MAX_TEXT_BYTES} bytes`
  if (r.address && !/^0x[0-9a-fA-F]{40}$/.test(r.address)) e.address = 'that isn’t a wallet address'
  if (r.url && !/^https:\/\/\S+$/.test(r.url)) e.url = 'links start with https://'
  if (r.x && !/^@?[A-Za-z0-9_]{1,15}$/.test(r.x)) e.x = 'that isn’t an X handle'
  if (r.avatar && !/^(\/uploads\/\S+|https:\/\/\S+|ipfs:\/\/\S+)$/.test(r.avatar)) e.avatar = 'an upload, https or ipfs link'
  return e
}

const N = NAMES_ADDRESS ?? zeroAddress
const enc = encodeFunctionData
const toWei = (n: number) => BigInt(Math.round(n * 100)) * 10n ** 16n
const textCalls = (id: bigint, rec: Partial<Record<TextKey, string>>) =>
  TEXT_KEYS.filter(k => rec[k] !== undefined).map(k => enc({ abi: namesAbi, functionName: 'setText', args: [id, k, rec[k] ?? ''] }))

export const namePlans = {
  /** One tx: multicall([claim(name), setText…, setAddr?]). The approve covers exactly the claim fee. */
  /** theme: 1 white / 2 green, bundled as setTheme(id, t) in the same multicall. Omit for the default look (theme 0). */
  /** primary: append setPrimary(id) so "make it yours onchain" is one multicall([claim, setPrimary]). */
  claimWithRecords: (raw: string, fee: number, rec: Partial<Record<TextKey, string>> = {}, addr?: Address, theme?: 1 | 2, primary?: boolean): Plan => {
    const label = normalizeName(raw), id = nameId(label)
    const calls: Hex[] = [enc({ abi: namesAbi, functionName: 'claim', args: [`${label}.wif`] }), ...textCalls(id, rec)]
    if (theme) calls.push(enc({ abi: namesAbi, functionName: 'setTheme', args: [id, theme] }))
    if (addr) calls.push(enc({ abi: namesAbi, functionName: 'setAddr', args: [id, addr] }))
    if (primary) calls.push(enc({ abi: namesAbi, functionName: 'setPrimary', args: [id] }))
    return { label: primary ? 'claim name and make it your @' : 'claim name', to: N, pull: toWei(fee), data: calls.length === 1 ? calls[0] : enc({ abi: namesAbi, functionName: 'multicall', args: [calls] }) }
  },
  /** Owner only. 0 default, 1 white, 2 green (BadTheme above MAX_THEME). Kept when the name is sold. */
  setTheme: (raw: string, theme: 0 | 1 | 2): Plan => ({ label: 'change card look', to: N, pull: 0n, data: enc({ abi: namesAbi, functionName: 'setTheme', args: [nameId(raw), theme] }) }),
  setPrimary: (raw: string): Plan => ({ label: 'set primary name', to: N, pull: 0n, data: enc({ abi: namesAbi, functionName: 'setPrimary', args: [nameId(raw)] }) }),
  /** Only changed records, in one multicall. */
  setRecords: (raw: string, rec: Partial<Record<TextKey, string>>, addr?: Address | null): Plan => {
    const id = nameId(raw)
    const calls = textCalls(id, rec)
    if (addr !== undefined) calls.push(enc({ abi: namesAbi, functionName: 'setAddr', args: [id, addr ?? zeroAddress] }))
    return { label: 'save records', to: N, pull: 0n, data: calls.length === 1 ? calls[0] : enc({ abi: namesAbi, functionName: 'multicall', args: [calls] }) }
  },
}
