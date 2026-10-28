/** Wallet-signed settings: "use my .wif" and the tip destination. The server issues a single-use nonce, the wallet signs it, the server reads the chain. */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAccount, useConnect, useSignMessage } from 'wagmi'
import { api, type ApiUser } from '../api/client'
import { useSession } from '../api/session'
import { useStore } from '../state/store'
import { InfoTip } from './InfoTip'

type Addr = `0x${string}`
export const shortAddr = (a?: string | null) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ''

/** Connect (if needed), ask the server for a proof message, sign it with `want` (or the connected wallet). */
export function useWalletProof() {
  const { address } = useAccount()
  const { connectAsync, connectors } = useConnect()
  const { signMessageAsync } = useSignMessage()
  return async (purpose: 'wif' | 'tips', want?: string) => {
    let a = address as Addr | undefined
    if (!a) {
      const c = connectors[0]; if (!c) throw new Error('no wallet found in this browser')
      a = (await connectAsync({ connector: c })).accounts[0]
    }
    if (want && a.toLowerCase() !== want.toLowerCase()) throw new Error(`switch your wallet to ${shortAddr(want)} and try again`)
    const p = await api<{ nonce: string; message: string }>('/wallet/proof', { method: 'POST', json: { purpose, address: a } })
    const signature = await signMessageAsync({ message: p.message, account: a })
    return { address: a, nonce: p.nonce, signature }
  }
}

/** "already own a .wif? use it": sign with the wallet that holds it; the server checks ownerOfName onchain. */
export function UseMyWif({ onDone, compact }: { onDone?: (name: string) => void; compact?: boolean }) {
  const prove = useWalletProof()
  const { setMe, refresh } = useSession()
  const { toast } = useStore()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const go = async () => {
    setBusy(true); setErr(null)
    try {
      const p = await prove('wif')
      const r = await api<{ name: string; me?: ApiUser }>('/names/use', { method: 'POST', json: p })
      if (r.me) setMe(r.me as never)
      refresh(); qc.invalidateQueries({ queryKey: ['names'] }); qc.invalidateQueries({ queryKey: ['onboarding'] })
      toast(`${r.name}.wif is yours here. you’re @${r.name}`, undefined, 'ok')
      onDone?.(r.name)
    } catch (e) {
      const m = (e as Error).message || 'couldn’t check that wallet'
      if (!/reject|denied|closed/i.test(m)) setErr(m)
    } finally { setBusy(false) }
  }
  return (
    <div className={`usewif ${compact ? 'usewif--compact' : ''}`} data-testid="use-my-wif">
      <button type="button" className={compact ? 'linkbtn' : 'btn btn--ghost btn--sm'} disabled={busy} onClick={go}>
        {busy ? 'check your wallet…' : 'already own a .wif? use it'}</button>
      <InfoTip label="about using your .wif">sign with the wallet that holds it. nothing is sent; we read the owner onchain.</InfoTip>
      {err && <p className="tiny bad usewif__err" role="alert">{err}</p>}
    </div>
  )
}

type Tips = { wallets: { address: string; kind: string }[]; payout: { address: string | null; via: 'chosen' | 'name' | 'main'; name: string | null; resolves: string | null }; changes: { address: string; at: number }[] }

/** Settings card: pick which linked wallet receives tips. A fresh signature from that wallet is required each time. */
export function TipDestination() {
  const q = useQuery({ queryKey: ['settings', 'tips'], queryFn: () => api<Tips>('/settings/tips') })
  const prove = useWalletProof()
  const { toast } = useStore()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const d = q.data
  const cur = d?.payout.address?.toLowerCase() ?? null
  const pick = async (a: string) => {
    setBusy(a); setErr(null)
    try {
      const p = await prove('tips', a)
      await api('/settings/tips', { method: 'POST', json: p })
      await q.refetch()
      toast(`tips now go to ${shortAddr(a)}`, undefined, 'ok')
    } catch (e) {
      const m = (e as Error).message || 'couldn’t save'
      if (!/reject|denied|closed/i.test(m)) setErr(m)
    } finally { setBusy(null) }
  }
  const mismatch = d?.payout.name && d.payout.resolves && cur && d.payout.resolves.toLowerCase() !== cur
  return (
    <section className="card settings-card tipdest" data-testid="tip-destination">
      <h3 className="settings-card__title">tip destination<InfoTip label="about the tip destination">tips go straight to this wallet. changing it needs a signature from the new wallet.</InfoTip></h3>
      {!d ? <p className="muted small">loading…</p> : !d.wallets.length ? <p className="muted small">link a wallet first.</p> : (
        <ul className="tipdest__list" role="radiogroup" aria-label="tip destination">
          {d.wallets.map(w => {
            const on = w.address.toLowerCase() === cur
            return (
              <li key={w.address}>
                <button type="button" role="radio" aria-checked={on} className={`tipdest__row ${on ? 'is-on' : ''}`} disabled={!!busy || on} onClick={() => pick(w.address)}>
                  <span className="tipdest__dot" aria-hidden="true" />
                  <span className="mono">{shortAddr(w.address)}</span>
                  <span className="muted tiny">{w.kind === 'main' ? 'main' : w.kind === 'privy' ? 'embedded' : 'linked'}</span>
                  <span className="tipdest__state tiny">{busy === w.address ? 'sign…' : on ? 'receiving' : ''}</span>
                </button>
              </li>
            )
          })}
        </ul>)}
      {mismatch && <p className="tiny muted">{d!.payout.name}.wif points elsewhere<InfoTip label="about your .wif address">your .wif resolves to {shortAddr(d!.payout.resolves)}. tips here use the wallet above.</InfoTip></p>}
      {err && <p className="tiny bad" role="alert">{err}</p>}
    </section>
  )
}

/** Before a tip: where the WIF actually lands, shortened, with copy. */
export function PayoutLine({ handle, address }: { handle?: string; address?: string | null }) {
  const q = useQuery({ queryKey: ['payout', handle], queryFn: () => api<{ address: string | null; via: string; name: string | null }>(`/users/${handle}/payout`), enabled: !!handle && !address })
  const a = address ?? q.data?.address ?? null
  const [copied, setCopied] = useState(false)
  if (!a) return null
  return (
    <p className="payout tiny" data-testid="tip-payout">
      <span className="muted">goes to</span> <span className="mono">{shortAddr(a)}</span>
      <button type="button" className="linkbtn" aria-label="copy payout address" onClick={() => { navigator.clipboard?.writeText(a); setCopied(true); setTimeout(() => setCopied(false), 1400) }}>{copied ? 'copied' : 'copy'}</button>
      <InfoTip label="about the payout address">the wallet this person chose for tips. it goes there directly.</InfoTip>
    </p>
  )
}
