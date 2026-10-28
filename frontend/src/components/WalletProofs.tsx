/** Wallet-signed settings: "use my .wif" and the tip destination. The server issues a single-use nonce, the wallet signs it, the server reads the chain. */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAccount, useConnect, useSignMessage } from 'wagmi'
import { api, type ApiUser } from '../api/client'
import { useSession } from '../api/session'
import { useStore } from '../state/store'
import { InfoTip } from './InfoTip'
import { privyBridge } from '../auth/privyBridge'

type Addr = `0x${string}`
export const shortAddr = (a?: string | null) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ''

/** Ask the connected browser wallet to let the person pick an account (MetaMask, Rabby…). Returns the accounts it now exposes. */
export async function pickWalletAccount(connector: { getProvider: () => Promise<unknown> } | undefined): Promise<Addr[]> {
  if (!connector) return []
  const prov = await connector.getProvider() as { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } | undefined
  if (!prov?.request) return []
  await prov.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] })
  return ((await prov.request({ method: 'eth_accounts' })) as Addr[] | undefined) ?? []
}
const waitFor = async (ok: () => boolean, ms = 6000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise(r => setTimeout(r, 200)); return ok() }

/**
 * Ask the server for a proof message and sign it with `want` (or the connected wallet).
 * The Privy embedded wallet signs through Privy (a sign-in with x or email starts first if needed); a browser wallet on
 * another account is asked to switch accounts instead of failing.
 */
export function useWalletProof() {
  const { address, connector } = useAccount()
  const { connectAsync, connectors } = useConnect()
  const { signMessageAsync } = useSignMessage()
  const { me, unlockPrivy } = useSession()
  return async (purpose: 'wif' | 'tips' | 'main', want?: string) => {
    const w = want?.toLowerCase()
    const embedded = !!w && !!me?.links?.walletList?.some(x => x.address === w && x.privy)
    if (w && (privyBridge.has(w) || (embedded && address?.toLowerCase() !== w))) {
      if (!privyBridge.has(w)) {
        if (!(await unlockPrivy())) throw new Error('closed')
        if (!(await waitFor(() => privyBridge.has(w)))) throw new Error('that wallet belongs to another x or email sign-in. sign in with that one to use it')
      }
      const p = await api<{ nonce: string; message: string }>('/wallet/proof', { method: 'POST', json: { purpose, address: w } })
      return { address: w as Addr, nonce: p.nonce, signature: await privyBridge.signFrom(w, p.message) }
    }
    let a = address as Addr | undefined
    let conn = connector
    if (!a) {
      const c = connectors[0]; if (!c) throw new Error('no wallet found in this browser')
      a = (await connectAsync({ connector: c })).accounts[0]; conn = c
    }
    if (w && a.toLowerCase() !== w) {
      const accts = await pickWalletAccount(conn).catch(() => [] as Addr[])
      a = accts.find(x => x.toLowerCase() === w) ?? a
      if (a.toLowerCase() !== w) throw new Error(`switch your wallet to ${shortAddr(want)} and try again`)
    }
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

/** Settings: where tips land. One wallet is a single calm line; with more, "change" opens the picker. A fresh signature from the new wallet is required each time. */
export function TipDestination({ bare }: { bare?: boolean } = {}) {
  const q = useQuery({ queryKey: ['settings', 'tips'], queryFn: () => api<Tips>('/settings/tips') })
  const prove = useWalletProof()
  const { toast } = useStore()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [choosing, setChoosing] = useState(false)
  const d = q.data
  const cur = d?.payout.address?.toLowerCase() ?? null
  const pick = async (a: string) => {
    setBusy(a); setErr(null)
    try {
      const p = await prove('tips', a)
      await api('/settings/tips', { method: 'POST', json: p })
      await q.refetch()
      setChoosing(false)
      toast(`tips now go to ${shortAddr(a)}`, undefined, 'ok')
    } catch (e) {
      const m = (e as Error).message || 'couldn’t save'
      if (!/reject|denied|closed/i.test(m)) setErr(m)
    } finally { setBusy(null) }
  }
  const mismatch = d?.payout.name && d.payout.resolves && cur && d.payout.resolves.toLowerCase() !== cur
  const many = (d?.wallets.length ?? 0) > 1
  const target = cur ?? d?.wallets[0]?.address ?? null
  const body = !d ? <p className="muted small">loading…</p> : !d.wallets.length ? <p className="muted small">link a wallet first. tips land there.</p> : (
    <>
      <div className="tipdest__line" data-testid="tip-line">
        <span className="small">tips go to <span className="mono">{shortAddr(target)}</span></span>
        {many && <button type="button" className="linkbtn" aria-expanded={choosing} onClick={() => setChoosing(c => !c)}>{choosing ? 'done' : 'change'}</button>}
      </div>
      {many && choosing && (
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
    </>)
  const extra = <>
    {mismatch && <p className="tiny muted">{d!.payout.name}.wif points elsewhere<InfoTip label="about your .wif address">your .wif resolves to {shortAddr(d!.payout.resolves)}. tips here use the wallet above.</InfoTip></p>}
    {err && <p className="tiny bad" role="alert">{err}</p>}
  </>
  if (bare) return <div className="tipdest" data-testid="tip-destination">{body}{extra}</div>
  return (
    <section className="card settings-card tipdest" data-testid="tip-destination">
      <h3 className="settings-card__title">tip destination<InfoTip label="about the tip destination">tips go straight to this wallet. changing it needs a signature from the new wallet.</InfoTip></h3>
      {body}{extra}
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
