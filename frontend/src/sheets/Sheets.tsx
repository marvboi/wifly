import { useAnyAccount } from '../auth/privyBridge'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { AnimatedNumber } from '../components/Motion'
import { Mascot } from '../components/Mascot'
import { CoinRain } from '../components/CoinRain'
import { companion } from '../lib/companion'
import { TipJar } from '../components/BrandSlots'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PayoutLine } from '../components/WalletProofs'
import { InfoTip } from '../components/InfoTip'
import { adoptUser, api, getDrop, type ApiUser, LINK_REQUIRED_EVENT, uploadAvatar } from '../api/client'
import { AvatarPicker } from '../components/AvatarPicker'
import { useSession } from '../api/session'
import { privyBridge, privyEnabled, wantPrivy } from '../auth/privyBridge'
import { Composer } from '../components/Composer'
import { useNavigate } from 'react-router-dom'
import { useAccount, useConnect } from 'wagmi'
import type { Address } from 'viem'
import { FEE_SPLIT, LIVE, TOPSPOT_FEE_SHARE, TOPSPOT_HOLDER_SHARE, TOPSPOT_MIN_RAISE, VOTE_PRICE } from '../config'
import { posts, users } from '../state/registry'
import { PREVIEW_NOTE, useStore, type SheetState } from '../state/store'
import { FEE_SPLIT_LABEL, topSpotMinBid, topSpotSplit } from '../lib/fees'
import { failArgs, plans, useQuoteFee, useHasUnlocked, useIsSubscribed, useSendPlan, useTopSpotRules, id32, type Plan } from '../lib/wifly'
import { Amount, Avatar, DisplayName, Name, Token, WifUsd } from '../components/Bits'
import { BurnSheet, BadgeSheet, TiersSheet } from './NewSheets'
import { HumanCheck } from '../components/HumanCheck'
import { FeeParts, FeeSplit } from '../components/FeeSplit'
import { Icon } from '../components/Icon'
import { BumpNotice, MakeItYours } from '../components/Identity'
import { LowBalance, SwapPanel } from '../components/Swap'
import { TxSteps } from '../components/TxSteps'
import { isWifName, useResolve } from '../lib/names'
import { useDebounced } from '../api/hooks'
import { RECOVER_GRACE_MS, createSignInGate, stillPending, type SignInKind, type SignInView } from '../lib/attempt'

// Top Spot shares as labels (TOP_SPOT_PREV_BPS 9000 onchain)
const pct = (x: number) => `${Math.round(x * 100)}%`

export function Sheet({ title, onClose, children, footer, size, className }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: 'sm'; className?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    document.body.classList.add('no-scroll')
    return () => { document.removeEventListener('keydown', onKey); document.body.classList.remove('no-scroll') }
  }, [onClose])
  const phone = typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches
  return (
    <motion.div className="sheet-wrap" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.2 } }}>
      <motion.div className={[size ? `sheet sheet--${size}` : 'sheet', className].filter(Boolean).join(' ')} role="dialog" aria-modal="true" aria-label={title}
        initial={phone ? { y: '100%' } : { opacity: 0, y: 36, scale: 0.96 }}
        animate={phone ? { y: 0 } : { opacity: 1, y: 0, scale: 1 }}
        exit={phone ? { y: '100%', transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } } : { opacity: 0, y: 20, scale: 0.97, transition: { duration: 0.16 } }}
        transition={{ type: 'spring', stiffness: 360, damping: 32, mass: 0.9 }}>
        <div className="sheet__grab" aria-hidden="true" />
        <header className="sheet__head">
          <h2 className="sheet__title">{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="close"><Icon name="close" size={20} /></button>
        </header>
        <div className="sheet__body">{children}</div>
        {footer && <footer className="sheet__foot">{footer}</footer>}
      </motion.div>
    </motion.div>
  )
}

export function AmountPicker({ value, onChange, presets }: { value: number; onChange: (n: number) => void; presets: number[] }) {
  return (
    <div className="picker">
      <label className="picker__field">
        <Token size={28} />
        <input inputMode="decimal" value={value ? String(value) : ''} placeholder="0"
          onChange={e => onChange(Number(e.target.value.replace(/[^0-9.]/g, '')) || 0)} aria-label="amount in wif" />
        <span className="picker__unit">wif</span>
      </label>
      <div className="picker__presets">
        {presets.map(p => (
          <button key={p} className={`pill ${value === p ? 'is-on' : ''}`} onClick={() => onChange(p)}>{p.toLocaleString()}</button>
        ))}
      </div>
      <div className="picker__usd"><WifUsd wif={value} /></div>
    </div>
  )
}

/** Wallet address for a member, when the server knows it. */
const addrOf = (handle?: string): Address | undefined => (handle ? users[handle]?.address : undefined)

/** Self-payment check, the same rule the contract enforces with SelfPayment(). */
function useIsSelf(handle?: string) {
  const { address } = useAnyAccount()
  const { me } = useSession()
  if (!handle) return false
  if (me && handle === me.handle) return true
  const a = addrOf(handle)
  return !!a && !!address && a.toLowerCase() === address.toLowerCase()
}

/**
 * Confirm handler shared by every money sheet. Returns { run, busy }.
 * Payments off (no contract yet): closes the sheet and says nothing was sent. No local state changes, no celebration.
 * Live mode: sends the plan and waits for the receipt (useSendPlan only reports sent once status is 'success').
 * While waiting for the signature and the confirmation `busy` is true, so sheets show a calm "sending…" state.
 * The celebration and the local update run only after confirmation. A rejection or revert shows an error toast
 * and changes nothing.
 */
type RunOpts = { celebrate?: () => Promise<void>; onConfirmed?: (hash: string) => void; doneNote?: string }
export function useAction() {
  const send = useSendPlan()
  const { toast, closeSheet } = useStore()
  const [busy, setBusy] = useState(false)
  const run = async (plan: Plan | null, title: string, onLocal: () => void, opts: RunOpts = {}): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    try {
      if (!LIVE) { closeSheet(); toast('not sent', PREVIEW_NOTE); return false }
      if (!plan) { toast('not sent', 'this person hasn’t connected a wallet yet'); return false }
      const r = await send(plan)
      if (!r.sent) { toast(...failArgs(r)); return false }
      opts.onConfirmed?.(r.hash)
      await opts.celebrate?.()
      onLocal(); closeSheet(); toast(title, opts.doneNote ?? 'confirmed onchain')
      return true
    } finally { setBusy(false) }
  }
  return { run, busy }
}

const PreviewNote = () => LIVE ? null : <p className="preview-note"><Icon name="shield" size={14} /> payments aren’t live yet. confirming sends nothing.</p>
const SelfNote = ({ what }: { what: string }) => <p className="selfnote"><Icon name="shield" size={14} /> you can’t {what} yourself.</p>

type TipPhase = 'idle' | 'sending' | 'drop' | 'done'
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const BURST = Array.from({ length: 9 }, (_, i) => { const a = (i / 9) * Math.PI * 2 - Math.PI / 2; return { x: Math.cos(a) * 62, y: Math.sin(a) * 50 - 6, d: i % 3 } })

/** Tip sheet hero: the jar fills with the amount; on send a coin drops in, the jar wobbles, the total ticks up, and the face cheers. */
function TipHero({ amount, phase, base }: { amount: number; phase: TipPhase; base?: number }) {
  const landed = phase === 'done'
  return (
    <div className="tip-hero" aria-hidden="true">
      <div className="tip-hero__stage">
        <span className={`tip-hero__jar ${phase === 'sending' ? 'is-waiting' : ''}`}>
          {/* brand jar: idle (no coin) while signing/confirming; plays one coin drop, wobble and +1 tick only once the tip lands
              (its own loop is 2.8s; the sheet closes before a second) */}
          <TipJar key={phase === 'drop' || phase === 'done' ? 'go' : 'still'} size={96} animate={phase === 'drop' || phase === 'done'} showCounter={false} title="" />
        </span>
        {landed && BURST.map((b, i) => (
          <motion.span key={i} className={`tip-hero__bit tip-hero__bit--${b.d}`} initial={{ x: 0, y: 10, scale: 0.4, opacity: 1 }}
            animate={{ x: b.x, y: b.y, scale: [0.4, 1, 0.7], opacity: [1, 1, 0] }} transition={{ duration: 0.85, ease: [0.2, 0.8, 0.3, 1], delay: 0.04 * (i % 3) }} />
        ))}
        <AnimatePresence>
          {landed && (
            <motion.span key="face" className="tip-hero__face" initial={{ scale: 0, rotate: -30, y: 10 }} animate={{ scale: 1, rotate: 8, y: 0 }}
              exit={{ scale: 0 }} transition={{ type: 'spring', stiffness: 520, damping: 16, delay: 0.12 }}><Mascot size={44} happy /></motion.span>
          )}
        </AnimatePresence>
      </div>
      <div className="tip-hero__nums">
        <span className="tip-hero__amt num"><AnimatedNumber value={amount} /> <small>wif</small></span>
        {base !== undefined && <span className="tip-hero__total small">this drop has earned <b className="num"><AnimatedNumber value={base + (landed ? amount : 0)} /></b> wif</span>}
      </div>
    </div>
  )
}

function TipSheet({ to, postId, dm }: { to?: string; postId?: string; dm?: boolean }) {
  const { run, busy } = useAction()
  const qc = useQueryClient()
  const [amount, setAmount] = useState(100)
  const direct = !!to && (isWifName(to) || /^0x[0-9a-fA-F]{40}$/.test(to))
  // a member picked in the sheet (or the one it opened for); the member tab works with no target: it searches
  const [picked, setPicked] = useState<string | undefined>(to && !direct && users[to] ? to : undefined)
  const target = picked ? users[picked] : undefined
  useEffect(() => { // opened for someone the page hasn't loaded yet: fetch them, then pick
    if (!to || direct || users[to]) return
    let live = true
    api<{ user: ApiUser }>(`/users/${to}`).then(r => { adoptUser(r.user); if (live) setPicked(r.user.handle) }).catch(() => {})
    return () => { live = false }
  }, [to, direct])
  const [mode, setMode] = useState<'member' | 'name'>(direct ? 'name' : 'member')
  const [dest, setDest] = useState(direct ? to! : '')
  const res = useResolve(mode === 'name' ? dest : '')
  const resolved = mode === 'name' ? res.data ?? null : null
  const post = postId ? posts.find(p => p.id === postId) : undefined
  const self = useIsSelf(mode === 'member' ? picked : undefined)
  const recipient = mode === 'name' ? resolved?.label ?? 'recipient' : target?.name ?? 'creator'
  const [phase, setPhase] = useState<TipPhase>('idle')
  const reduced = useReducedMotion()
  const net = useQuoteFee(amount).receives
  const pay = useQuery({ queryKey: ['payout', picked], queryFn: () => api<{ address: string | null }>(`/users/${picked}/payout`), enabled: mode === 'member' && !!target })
  const payTo = (pay.data?.address ?? addrOf(picked)) as Address | undefined
  const netLabel = net.toLocaleString('en-US', { maximumFractionDigits: 2 })

  const confirm = async () => {
    if (phase !== 'idle') return
    setPhase('sending')
    let plan: Plan | null = null
    if (mode === 'member') { if (payTo) plan = plans.tip(payTo, amount, postId) }
    else { if (!resolved?.address) { setPhase('idle'); return } plan = plans.tip(resolved.address as Address, amount, postId) }
    // live: the jar stays idle while the wallet signs and the chain confirms; the coin drop, wobble, total tick and
    // burst play only after the receipt says success. with payments off it plays straight away and nothing is sent.
    const celebrate = async () => {
      setPhase('drop')
      await wait(reduced ? 150 : 620)
      setPhase('done')
      companion.celebrate('tip', `${amount.toLocaleString()} wif to ${recipient}. lovely`)
      await wait(reduced ? 300 : 1100)
    }
    const onConfirmed = (hash: string) => {
      // record it so they get a notification; the WIF itself already went to their wallet onchain. if this call fails the
      // server's onchain tip sweep still records it and notifies them, so a miss is logged, not shown as an error
      const missed = (e: unknown) => console.warn('[tip] not recorded yet, the onchain sweep will pick it up', e instanceof Error ? e.message : e)
      if (mode !== 'member' || !picked) return
      // from a chat: the tip also lands in the thread as a tip bubble
      if (dm) api(`/dms/${picked}/tip`, { method: 'POST', json: { amount, txHash: hash } }).then(() => qc.invalidateQueries({ queryKey: ['dms'] })).catch(missed)
      else if (postId) api(`/drops/${postId}/tips`, { method: 'POST', json: { amount, txHash: hash } }).catch(missed)
      // from a profile or the tip sheet: no post, no chat
      else api(`/users/${encodeURIComponent(picked)}/tips`, { method: 'POST', json: { amount, txHash: hash } }).catch(missed)
    }
    const title = `${recipient} got ${netLabel} wif`
    const doneNote = 'it’s in their wallet now'
    const ok = await run(plan, title, () => {}, { celebrate, onConfirmed, doneNote })
    if (!ok) setPhase('idle')
  }

  return (
    <Sheet title="send a tip" onClose={useStore().closeSheet}
      footer={<>
        <TxSteps pull={amount} action="send tip" />
        <button className="btn btn--dark btn--block btn--lg" disabled={!amount || self || (mode === 'member' && !target) || (mode === 'name' && !resolved?.address) || phase !== 'idle' || busy} onClick={confirm}>
          {phase === 'idle' ? `tip ${amount ? amount.toLocaleString() : ''} wif` : phase === 'sending' ? 'sending…' : 'sent'}
        </button>
        <PreviewNote />
      </>}>
      <TipHero amount={amount} phase={phase} base={post?.tipped} />
      <div className="seg" role="tablist">
        <button role="tab" aria-selected={mode === 'member'} className={mode === 'member' ? 'is-on' : ''} onClick={() => setMode('member')} data-testid="tip-tab-member">member</button>
        <button role="tab" aria-selected={mode === 'name'} className={mode === 'name' ? 'is-on' : ''} onClick={() => setMode('name')} data-testid="tip-tab-name">name.wif / address</button>
      </div>
      {mode === 'member' ? (target ? (
        <>
        <RecipientRow handle={target.handle} onChange={dm ? undefined : () => setPicked(undefined)} />
        {post && <div className="muted small clamp-1">for: “{post.text}”</div>}
        <PayoutLine address={payTo ?? null} />
        </>
      ) : <MemberSearch onPick={setPicked} />) : (
        <>
        <div className="xfield">
          <label className="field">
            <span className="field__label">send to</span>
            <span className="field__input"><input value={dest} onChange={e => setDest(e.target.value.trim())} placeholder="name.wif, @username or 0x…" aria-label="recipient" autoCapitalize="none" spellCheck={false} /></span>
          </label>
          <ResolveLine raw={dest} loading={res.isFetching} r={resolved} />
        </div>
        {resolved?.address && <RecipientRow handle={resolved.owner?.handle} address={resolved.address} label={resolved.label} />}
        <PayoutLine address={resolved?.address ?? null} />
        </>
      )}
      {self && <SelfNote what="tip" />}
      <AmountPicker value={amount} onChange={setAmount} presets={[25, 100, 500, 1000]} />
      {amount > 0 && <p className="tip-lands"><Icon name="check" size={14} /> <b>they get {netLabel} wif</b> · lands in their wallet right away</p>}
      <FeeSplit amount={amount} recipientLabel={`${recipient} gets`} />
      <LowBalance need={amount} />
    </Sheet>
  )
}

/** Shows where a name.wif / @handle / 0x… resolves before anything is sent. Unclaimed names resolve to no wallet. */
/** Who the tip goes to, before you pay: their picture, name and @handle, or a wallet mark and short address. */
function RecipientRow({ handle, address, label, onChange }: { handle?: string; address?: string; label?: string; onChange?: () => void }) {
  const known = handle ? users[handle] : undefined
  const q = useQuery({ queryKey: ['user', handle], queryFn: () => api<{ user: ApiUser }>(`/users/${handle}`).then(r => adoptUser(r.user)), enabled: !!handle && !known, staleTime: 60_000 })
  const u = known ?? (q.data ?? undefined)
  return (
    <div className="tiprcpt" data-testid="tip-recipient">
      {u ? <Avatar handle={u.handle} size={36} /> : <span className="tiprcpt__wallet" aria-hidden="true"><Icon name="wallet" size={18} /></span>}
      <span className="tiprcpt__who">
        {u ? <><b className="clamp-1"><DisplayName user={u} /></b><span className="muted clamp-1">@{u.handle}</span></>
          : <><b className="clamp-1">{label && !/^0x/.test(label) ? label : 'wallet'}</b><span className="muted mono">{address ? `${address.slice(0, 6)}…${address.slice(-4)}` : ''}</span></>}
      </span>
      {onChange && <button type="button" className="btn btn--text btn--sm" onClick={onChange}>change</button>}
    </div>
  )
}

/** The member tab with nobody picked yet: type a name or @username, pick a real member (never yourself). */
function MemberSearch({ onPick }: { onPick: (handle: string) => void }) {
  const { me } = useSession()
  const [v, setV] = useState('')
  const term = useDebounced(v.trim().replace(/^@/, ''), 250)
  const q = useQuery({
    queryKey: ['tip-people', term], enabled: term.length >= 1, staleTime: 30_000,
    queryFn: () => api<{ users: ApiUser[] }>(`/search?type=people&q=${encodeURIComponent(term)}`).then(r => r.users.filter(Boolean).map(adoptUser)),
  })
  const rows = (q.data ?? []).filter(u => u.handle !== me?.handle).slice(0, 6)
  // 11.8.7: before typing, people you follow (newest first), else real suggestions. never made up.
  const mine = me?.handle
  const near = useQuery({
    queryKey: ['tip-near', mine], enabled: !!mine && term.length === 0, staleTime: 60_000,
    queryFn: async () => {
      const f = await api<{ users: ApiUser[] }>(`/users/${encodeURIComponent(mine!)}/following`).then(r => r.users.filter(Boolean)).catch(() => [] as ApiUser[])
      if (f.length) return { label: 'people you follow', users: f.slice(0, 6).map(adoptUser) }
      const s = await api<{ users: ApiUser[] }>('/suggest/users?limit=6').then(r => r.users.filter(Boolean)).catch(() => [] as ApiUser[])
      return { label: 'suggested', users: s.slice(0, 6).map(adoptUser) }
    },
  })
  const nearRows = (near.data?.users ?? []).filter(u => u.handle !== mine)
  const row = (u: { handle: string; name: string; wifName?: string | null }) => (
    <li key={u.handle}>
      <button type="button" role="option" aria-selected="false" className="tipfind__row" data-testid="tip-member-row" onClick={() => onPick(u.handle)}>
        <Avatar handle={u.handle} size={36} />
        <span className="tiprcpt__who"><b className="clamp-1">{u.name}</b><span className="muted clamp-1">@{u.handle}</span></span>
        {u.wifName && <span className="tipfind__pill">{u.wifName}.wif</span>}
      </button>
    </li>
  )
  return (
    <div className="tipfind" data-testid="tip-member-search">
      <label className="field">
        <span className="field__label">send to</span>
        <span className="field__input"><Icon name="search" size={16} /><input autoFocus value={v} onChange={e => setV(e.target.value)} placeholder="search @username or name" aria-label="search members" autoCapitalize="none" spellCheck={false} /></span>
      </label>
      {term.length === 0 && nearRows.length > 0 && (
        <div className="tipfind__near" data-testid="tip-near">
          <span className="tipfind__head small muted">{near.data?.label}</span>
          <ul className="tipfind__list" role="listbox" aria-label={near.data?.label}>{nearRows.map(row)}</ul>
        </div>
      )}
      {term.length >= 1 && (
        <ul className="tipfind__list" role="listbox">
          {rows.map(row)}
          {!q.isFetching && rows.length === 0 && <li className="small muted tipfind__none">no members match “{term}”</li>}
        </ul>
      )}
    </div>
  )
}

export function ResolveLine({ raw, loading, r }: { raw: string; loading: boolean; r: { label: string; address: string | null; kind: string; source: string } | null }) {
  if (raw.length < 3) return null
  if (loading) return <p className="tiny muted">resolving {raw}…</p>
  if (!r) return <p className="tiny error">that isn’t a name.wif, @username or address</p>
  if (!r.address) return <p className="tiny error">{r.label} resolves to no wallet, so it can’t receive wif</p>
  return <p className="tiny resolve-ok"><Icon name="check" size={12} /> {r.label} → <span className="mono">{r.address.slice(0, 6)}…{r.address.slice(-4)}</span> <span className="muted">· {r.kind === 'wif' ? (r.source === 'chain' ? 'resolve() onchain' : 'wifly mirror') : r.kind === 'handle' ? 'member wallet' : 'address'}</span></p>
}

function UnlockSheet({ postId }: { postId: string }) {
  const { closeSheet, unlock } = useStore()
  const { run, busy } = useAction()
  const { address } = useAnyAccount()
  const post = posts.find(p => p.id === postId)
  const self = useIsSelf(post?.author)
  const onChain = useHasUnlocked(address, addrOf(post?.author), id32('content', postId))
  if (!post?.locked) return null
  const price = post.locked.price
  const a = addrOf(post.author)
  return (
    <Sheet title="unlock drop" onClose={closeSheet}
      footer={<>
        <TxSteps pull={price} action="unlock the drop" />
        <button className="btn btn--dark btn--block btn--lg" disabled={self || onChain === true || busy}
          onClick={() => run(a ? plans.unlock(a, post.id, price) : null, 'post unlocked', () => unlock(post.id))}>
          <Icon name="unlock" size={18} /> {busy ? 'sending…' : onChain ? 'already unlocked' : `unlock for ${price.toLocaleString()} wif`}
        </button>
        <PreviewNote />
      </>}>
      <div className="recipient">
        <Avatar handle={post.author} size={44} />
        <div><Name handle={post.author} /><div className="muted small">{post.locked.unlocks.toLocaleString()} people unlocked this</div></div>
      </div>
      <div className="unlock-card">
        <Icon name="lock" size={20} />
        <div><div className="strong">{post.locked.teaser}</div><div className="muted small">yours to keep. no subscription needed.</div></div>
      </div>
      {self && <SelfNote what="pay" />}
      <FeeSplit amount={price} />
      <LowBalance need={price} />
    </Sheet>
  )
}

function SubscribeSheet({ handle, tierId }: { handle: string; tierId?: string }) {
  const { closeSheet, subscribe, subs } = useStore()
  const { run, busy } = useAction()
  const { address } = useAnyAccount()
  const u = users[handle]
  const live = useIsSubscribed(address, addrOf(handle))
  const currentTier = live ? (live.active ? `t${live.tier + 1}` : undefined) : subs[handle]
  const [pick, setPick] = useState(tierId ?? currentTier ?? u?.tiers?.[1]?.id ?? 't1')
  const self = useIsSelf(handle)
  if (!u?.tiers) return null
  const tier = u.tiers.find(t => t.id === pick)!
  const current = u.tiers.find(t => t.id === currentTier)
  const a = addrOf(handle)
  const note = !current ? 'starts today and runs 30 days.'
    : current.id === pick ? `renewing adds 30 days to the end of your current ${current.name} period.`
      : `switching from ${current.name} starts a fresh 30 days from today. time left on ${current.name} isn’t carried over.`
  return (
    <Sheet title={`support ${u.name}`} onClose={closeSheet}
      footer={<>
        <TxSteps pull={tier.price} action="start 30 days" />
        <button className="btn btn--dark btn--block btn--lg" disabled={self || busy}
          onClick={() => run(a ? plans.subscribe(a, pick, tier.price) : null, `subscribed: ${tier.name}`, () => subscribe(handle, pick))}>
          {busy ? 'sending…' : <>{current?.id === pick ? 'renew' : current ? 'switch tier' : 'subscribe'} · {tier.price.toLocaleString()} wif / 30 days</>}
        </button>
        <PreviewNote />
      </>}>
      <div className="tiers">
        {u.tiers.map(t => (
          <button key={t.id} className={`tier ${pick === t.id ? 'is-on' : ''}`} onClick={() => setPick(t.id)} aria-pressed={pick === t.id}>
            <div className="tier__top">
              <span className="tier__name">{t.name}</span>
              <span className="tier__price"><Amount value={t.price} size={16} /><span className="muted small">/mo</span></span>
            </div>
            <ul>{t.perks.map(p => <li key={p}><Icon name="check" size={14} /> {p}</li>)}</ul>
            {currentTier === t.id && <span className="tier__current">current</span>}
          </button>
        ))}
      </div>
      <p className={`small ${current && current.id !== pick ? 'warn' : 'muted'}`}>{note}</p>
      {self && <SelfNote what="subscribe to" />}
      <FeeSplit amount={tier.price} />
      <LowBalance need={tier.price} />
      <p className="muted small">your agent can renew this for you each month, within the daily cap you set.</p>
    </Sheet>
  )
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t) }, [ms])
  return now
}

function BidSheet() {
  const { closeSheet, topSpot, takeTopSpot } = useStore()
  const { run, busy } = useAction()
  const rules = useTopSpotRules()
  const now = useNow()
  const min = rules?.minBid !== undefined ? Math.ceil(rules.minBid) : topSpotMinBid(topSpot.paid)
  const [bid, setBid] = useState(min)
  const empty = rules ? rules.empty : !topSpot.holder
  const lockedFor = rules?.unlocksAt ? Math.max(0, rules.unlocksAt - Math.floor(now / 1000)) : 0
  const holder = topSpot.holder ? users[topSpot.holder] : undefined
  const { me } = useSession()
  const latest = me ? posts.filter(p => p.author === me.handle && !p.replyTo).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0] : undefined
  const postId = latest?.id ?? ''
  const ok = bid >= min && lockedFor === 0 && !!postId
  const split = topSpotSplit(bid, empty)
  const n = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 0 })
  return (
    <Sheet title="promote to the top spot" onClose={closeSheet}
      footer={<>
        <TxSteps pull={bid} action="promote to the top spot" />
        <button className="btn btn--dark btn--block btn--lg" disabled={!ok || busy}
          onClick={() => run(plans.takeTopSpot(postId, bid), 'you hold the top spot', () => takeTopSpot(postId, bid))}>
          <Icon name="pin" size={18} /> {busy ? 'sending…' : lockedFor ? `locked for ${lockedFor}s` : `promote for ${bid.toLocaleString()} wif`}
        </button>
        <PreviewNote />
      </>}>
      <p className="muted">pin your latest drop on top<InfoTip label="about promotion">it stays above every feed until someone pays more.</InfoTip></p>
      {!me ? <p className="small warn">sign in first. the top spot pins your latest drop.</p> : !postId && <p className="small warn">post a drop first. the top spot pins your latest one.</p>}
      <AmountPicker value={bid} onChange={setBid} presets={[min, Math.ceil(min * 1.25), Math.ceil(min * 1.5)]} />
      {bid < min && <p className="small error">minimum bid is {min.toLocaleString()} wif{empty ? '' : ` (${pct(TOPSPOT_MIN_RAISE)} over the current spot)`}.</p>}
      {lockedFor > 0 && <p className="small warn">the current holder is in the minimum hold. bidding opens in {lockedFor}s.</p>}
      <LowBalance need={bid} />
      <div className="fee">
        <div className="fee__rows">
          {!empty && <div className="fee__row"><span>{`${holder?.name ?? 'current holder'} gets back · ${pct(TOPSPOT_HOLDER_SHARE)}`}</span><span className="num strong">{n(split.toHolder)} wif</span></div>}
          <div className="fee__row"><span>promotion fee · {empty ? '100% (empty spot)' : pct(TOPSPOT_FEE_SHARE)}</span><span className="num">{n(split.fee)} wif</span></div>
        </div>
        <FeeParts fee={split.fee} />
        <div className="fee__legend"><span>{empty ? 'the first bid on an empty spot is all fee.' : `when someone outbids you, you get ${pct(TOPSPOT_HOLDER_SHARE)} of their bid back.`} every fee: {FEE_SPLIT_LABEL}.</span></div>
      </div>
    </Sheet>
  )
}

function BuySheet({ handle, itemId }: { handle: string; itemId: string }) {
  const { closeSheet } = useStore()
  const { run, busy } = useAction()
  const u = users[handle]
  const self = useIsSelf(handle)
  const item = u?.shop?.find(i => i.id === itemId)
  if (!item) return null
  const a = addrOf(handle)
  return (
    <Sheet title="checkout" onClose={closeSheet}
      footer={<>
        <TxSteps pull={item.price} action="buy it" />
        <button className="btn btn--dark btn--block btn--lg" disabled={self || busy}
          onClick={() => run(a ? plans.pay(a, item.price, 'order', `${handle}:${item.id}`) : null, `order ready: ${item.title}`, () => {})}>
          {busy ? 'sending…' : `pay ${item.price.toLocaleString()} wif`}
        </button>
        <PreviewNote />
      </>}>
      <div className="shop-line">
        <span className="shop-line__thumb"><Icon name={item.kind === 'Digital' ? 'image' : 'calendar'} size={22} /></span>
        <div><div className="strong">{item.title}</div><div className="muted small">{item.kind} · {item.detail}</div><div className="muted small">sold by {u.name}</div></div>
      </div>
      {self && <SelfNote what="buy from" />}
      <FeeSplit amount={item.price} recipientLabel={`${u.name} receives`} />
      <LowBalance need={item.price} />
    </Sheet>
  )
}

function PayDmSheet({ handle }: { handle: string }) {
  const { closeSheet, payDm } = useStore()
  const { run, busy } = useAction()
  const nav = useNavigate()
  const u = users[handle]
  const self = useIsSelf(handle)
  const price = u?.dmPrice ?? 0
  const a = addrOf(handle)
  return (
    <Sheet title="paid message" onClose={closeSheet}
      footer={<>
        <TxSteps pull={price} action="pay and send" />
        <button className="btn btn--dark btn--block btn--lg" disabled={self || busy}
          onClick={() => run(a ? plans.pay(a, price, 'dm', handle) : null, 'message unlocked', () => { payDm(handle); nav(`/messages/${handle}`) })}>
          {busy ? 'sending…' : `pay ${price} wif and message`}
        </button>
        <PreviewNote />
      </>}>
      <div className="recipient"><Avatar handle={handle} size={44} /><div><Name handle={handle} /><div className="muted small">doesn’t follow you</div></div></div>
      <p>{u?.name} charges <b className="num">{price} wif</b> for a first message from people they don’t follow. replies are free after that.</p>
      <FeeSplit amount={price} recipientLabel={`${u?.name} receives`} />
      <LowBalance need={price} />
    </Sheet>
  )
}

function VoteSheet({ handle, postId }: { handle: string; postId?: string }) {
  const { closeSheet, addVotes } = useStore()
  const { run, busy } = useAction()
  const [n, setN] = useState(5)
  const [cheer, setCheer] = useState(false)
  const reduced = useReducedMotion()
  const u = users[handle]
  const self = useIsSelf(handle)
  const post = postId ? posts.find(p => p.id === postId) : undefined
  // only after the receipt says success: the face cheers and the creator's coin rain falls, then the sheet closes
  const celebrate = async () => {
    setCheer(true)
    companion.celebrate('vote', `${n} vote${n === 1 ? '' : 's'} for ${u?.name ?? handle}`)
    await wait(reduced ? 300 : 1200)
  }
  const cost = n * VOTE_PRICE
  const a = addrOf(handle)
  return (
    <Sheet title={post ? 'vote for this drop' : `vote for ${u?.name}`} onClose={closeSheet}
      footer={<>
        <TxSteps pull={cost} action="cast votes" />
        <button className="btn btn--dark btn--block btn--lg" disabled={!n || self || busy}
          onClick={() => run(a ? plans.vote(a, cost, postId) : null, `${n} vote${n === 1 ? '' : 's'} cast`, () => {
            if (postId) addVotes(`post:${postId}`, n)
            addVotes(`creator:${handle}`, n)
          }, { celebrate })}><Icon name="vote" size={18} /> {busy ? 'sending…' : `cast ${n} vote${n === 1 ? '' : 's'} · ${cost.toLocaleString()} wif`}</button>
        <PreviewNote />
      </>}>
      <div className="recipient">
        <Avatar handle={handle} size={44} />
        <div><Name handle={handle} />{post && <div className="muted small clamp-1">“{post.text}”</div>}</div>
      </div>
      <p className="muted">{VOTE_PRICE} wif per vote<InfoTip label="about votes">the crowd decides what rises. {FEE_SPLIT.pot}% to the weekly pot, {FEE_SPLIT.burn}% burned.</InfoTip></p>
      {self && <SelfNote what="vote for" />}
      <div className="vote-cheer" aria-hidden="true"><Mascot size={56} mood={cheer ? 'happy' : n >= 25 ? 'wow' : 'calm'} happy={cheer} pulse={cheer ? 1 : n} /></div>
      {cheer && <CoinRain />}
      <div className="stepper" role="group" aria-label="number of votes">
        <button className="icon-btn icon-btn--line" onClick={() => setN(Math.max(1, n - 1))} aria-label="fewer votes">−</button>
        <div className="stepper__val"><motion.span key={n} className="display-num" initial={{ y: -12, scale: 0.8, opacity: 0.4 }} animate={{ y: 0, scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 600, damping: 20 }}>{n}</motion.span><span className="muted small">votes</span></div>
        <button className="icon-btn icon-btn--line" onClick={() => setN(n + 1)} aria-label="more votes"><Icon name="plus" size={18} /></button>
      </div>
      <div className="picker__presets picker__presets--center">
        {[1, 5, 25, 100].map(p => <button key={p} className={`pill ${n === p ? 'is-on' : ''}`} onClick={() => setN(p)}>{p}</button>)}
      </div>
      <div className="fee">
        <div className="fee__rows">
          <div className="fee__row"><span>vote fee · 100%</span><span className="num strong">{cost.toLocaleString()} wif</span></div>
          <div className="fee__row"><span>counts toward</span><span>creator of the week</span></div>
        </div>
        <FeeParts fee={cost} />
        <LowBalance need={cost} />
        <div className="fee__legend"><span>if {u?.name.split(' ')[0]} is picked creator of the week, part of the weekly community pot is shared back with their voters.</span></div>
      </div>
    </Sheet>
  )
}

function SwapSheet({ wifOut, reason }: { wifOut?: number; reason?: string }) {
  const { closeSheet } = useStore()
  return (
    <Sheet title="get $wif" onClose={closeSheet}>
      <SwapPanel compact preset={wifOut ? { wifOut, reason } : undefined} onDone={closeSheet} />
    </Sheet>
  )
}

const PROMPTS = [
  'drop something. the crowd decides if it rises.',
  'what did you make today?',
  'say it plainly. fair is the whole point.',
]

/** New drop: opened from the dock. Everyone, a paid drop (one-time unlock in WIF, with a free teaser), or supporters only. */
function ComposeSheet({ replyTo, quoteOf, initialLock = 'open' }: { replyTo?: string; quoteOf?: string; initialLock?: 'open' | 'price' | 'supporters' }) {
  const { closeSheet, openSheet, toast } = useStore()
  const { me } = useSession()
  const send = useSendPlan()
  const [lock, setLock] = useState<'open' | 'price' | 'supporters'>(initialLock)
  const [price, setPrice] = useState(25)
  const [teaser, setTeaser] = useState('')
  const myTiers = ((me as unknown as { tiers?: { id: string; name: string; price: number }[] })?.tiers) ?? []
  const [tier, setTier] = useState<string>('')
  const [prompt] = useState(() => PROMPTS[Math.floor(Math.random() * PROMPTS.length)])
  const nav = useNavigate()
  const plain = !replyTo && !quoteOf
  const extra = !plain ? undefined
    : lock === 'price' ? { locked: { price, teaser: teaser.trim() } }
    : lock === 'supporters' && (tier || myTiers[0]?.id) ? { supportersOnly: tier || myTiers[0].id } : undefined
  const canSubmit = lock === 'open' || (lock === 'price' ? price > 0 && teaser.trim().length > 0 : myTiers.length > 0)
  return (
    <Sheet title={replyTo ? 'reply' : quoteOf ? 'quote' : lock === 'price' ? 'new paid drop' : 'new drop'} onClose={closeSheet}>
      {replyTo && <ReplyContext id={replyTo} />}
      <Composer autoFocus replyTo={replyTo} quoteOf={quoteOf} placeholder={plain ? (lock === 'price' ? 'the part people pay to read' : prompt) : undefined}
        extra={extra} canSubmit={canSubmit} submitLabel={lock === 'price' ? `drop for ${price.toLocaleString()} wif` : undefined}
        onDone={async p => {
          closeSheet()
          if (p && replyTo) nav(`/post/${replyTo}`)
          // Onchain: the unlock price lives in Wifly.contentPrice. Off in this preview (TX_ENABLED=false).
          if (p && LIVE && lock === 'price') { const r = await send(plans.setContentPrice(p.id, price)); if (!r.sent) toast('drop is up, price not set onchain yet', r.reason) }
        }}>
        {plain && <>
          <div className="seg seg--sm" role="radiogroup" aria-label="who can see it">
            <button role="radio" aria-checked={lock === 'open'} className={lock === 'open' ? 'is-on' : ''} onClick={() => setLock('open')}>everyone</button>
            <button role="radio" aria-checked={lock === 'price'} className={lock === 'price' ? 'is-on' : ''} onClick={() => setLock('price')}><Icon name="lock" size={14} /> paid drop</button>
            <button role="radio" aria-checked={lock === 'supporters'} className={lock === 'supporters' ? 'is-on' : ''} onClick={() => setLock('supporters')}><Icon name="star" size={14} /> supporters</button>
          </div>
          {lock === 'price' && <div className="paiddrop">
            <label className="field">
              <span className="field__label">free teaser <span className="muted">· everyone sees this</span></span>
              <span className="field__input"><input value={teaser} maxLength={140} onChange={e => setTeaser(e.target.value)} placeholder="a line that makes people want the rest" /></span>
            </label>
            <span className="field__label">unlock price</span>
            <AmountPicker value={price} onChange={setPrice} presets={[10, 25, 50, 100]} />
            <FeeSplit amount={price} recipientLabel="you receive per unlock" />
            <div className="lockcard" aria-label="how it looks in the feed">
              <Icon name="lock" size={16} /><div><b>{teaser.trim() || 'your teaser shows here'}</b><div className="muted small">unlock for {price.toLocaleString()} wif · paid onchain in $wif</div></div>
            </div>
          </div>}
          {lock === 'supporters' && (myTiers.length ? <div className="seg seg--sm" role="radiogroup" aria-label="which tier">
            {myTiers.map(t => <button key={t.id} role="radio" aria-checked={(tier || myTiers[0].id) === t.id} className={(tier || myTiers[0].id) === t.id ? 'is-on' : ''} onClick={() => setTier(t.id)}>{t.name} · {t.price.toLocaleString()} wif/mo</button>)}
          </div> : <p className="muted small">you have no tiers yet. <button className="linkbtn" onClick={() => openSheet({ type: 'tiers' })}>set up subscription tiers</button></p>)}
        </>}
      </Composer>
    </Sheet>
  )
}

function ReplyContext({ id }: { id: string }) {
  const p = getDrop(id) ?? posts.find(x => x.id === id)
  if (!p) return null
  return (
    <div className="reply-ctx">
      <Avatar handle={p.author} size={32} />
      <div><div className="small"><b>{users[p.author]?.name ?? p.author}</b> <span className="muted">@{p.author}</span></div><p className="reply-ctx__text">{p.text}</p></div>
    </div>
  )
}

function SignInSheet({ reason }: { reason?: string }) {
  const { closeSheet, toast } = useStore()
  const { signInGuest, signInWallet, signInPrivy } = useSession()
  const { isConnected } = useAccount()
  const { connectAsync, connectors } = useConnect()
  const [view, setView] = useState<SignInView>({ busy: null, line: null })
  const busy = view.busy
  const [useWallet, setUseWallet] = useState(false)
  const nav = useNavigate()
  const done = (m: { onboarded?: boolean; handle: string }) => {
    closeSheet()
    // like x: stay on the page you were reading; only a brand-new account goes through /welcome
    if (!m.onboarded) nav('/welcome'); else toast(`signed in as @${m.handle}`)
  }
  // 11.8.4b: every way in (wallet, guest, x/email) runs through one gate: a "cancel" link while it waits, a 20s cap that
  // brings the buttons back with "try again", recovery when the window comes back with nothing pending, late results safe.
  const doneRef = useRef(done); doneRef.current = done
  const gate = useRef<ReturnType<typeof createSignInGate<{ onboarded?: boolean; handle: string }>> | null>(null)
  gate.current ??= createSignInGate<{ onboarded?: boolean; handle: string }>({
    onView: v => setView(v),
    onSignedIn: m => doneRef.current(m),
    quiet: e => /sign-in closed|reject|denied|cancel/i.test((e as Error)?.message ?? ''),
  })
  const last = useRef<SignInKind>('guest')
  const wallet = () => { last.current = 'wallet'; gate.current!.run('wallet', async () => {
    let addr: `0x${string}` | undefined
    if (!isConnected) { const c = connectors[0]; if (!c) throw new Error('no wallet found in this browser'); addr = (await connectAsync({ connector: c })).accounts[0] }
    return signInWallet(addr)
  }) }
  const guest = () => { last.current = 'guest'; gate.current!.run('guest', () => signInGuest()) }
  const privy = () => { last.current = 'privy'; gate.current!.run('privy', () => signInPrivy()) }
  const again = () => (last.current === 'wallet' ? wallet : last.current === 'privy' ? privy : guest)()
  // a wallet popup or privy's window closed without telling us: once the page is back and nothing is pending, recover
  useEffect(() => {
    const back = () => {
      if (document.visibilityState !== 'visible') return
      const g = gate.current!, k = g.busy(), id = g.attempt()
      if (!k || k === 'guest') return
      setTimeout(() => {
        if (g.attempt() !== id) return
        const s = privyBridge.get(), dlg = document.getElementById('privy-dialog')
        if (!stillPending(k, { authenticated: s.authenticated, dialogOpen: !!dlg && dlg.getClientRects().length > 0 })) g.recover(k)
      }, RECOVER_GRACE_MS[k])
    }
    window.addEventListener('focus', back); document.addEventListener('visibilitychange', back)
    return () => { window.removeEventListener('focus', back); document.removeEventListener('visibilitychange', back) }
  }, [])
  const status = busy
    ? <p className="signin__retry small muted" role="status" data-testid="signin-cancel">{busy === 'wallet' ? 'waiting for your wallet.' : busy === 'privy' ? 'waiting for sign-in.' : 'signing you in.'} <button type="button" className="linkbtn" onClick={() => gate.current!.cancel()}>cancel</button></p>
    : view.line ? <p className="signin__retry small muted" role="status" data-testid="signin-retry">{view.line} <button type="button" className="linkbtn" onClick={again}>try again</button></p>
    : null
  // the sign-in sheet is open: start fetching Privy now so the modal is ready by the tap
  useEffect(() => { wantPrivy() }, [])
  if (privyEnabled && !useWallet) return (
    <Sheet title="sign in" onClose={closeSheet}>
      <div className="signin">
        <Mascot size={72} />
        <h3 className="signin__title">{reason ?? 'join wifly.'}</h3>
        <p className="muted small">{reason ? 'it takes about a minute. you can keep looking around after.' : 'use X, email or a wallet. it takes about a minute.'}</p>
        <HumanCheck />
        <button className="btn btn--dark btn--block" disabled={!!busy} onClick={privy}><Icon name="user" size={18} /> {busy === 'privy' ? 'opening…' : 'sign up or sign in'}</button>
        <button className="btn btn--ghost btn--block" disabled={!!busy} onClick={() => setUseWallet(true)}><Icon name="wallet" size={18} /> i have a wallet</button>
        {status}
        {reason && <button className="btn btn--text btn--block" onClick={closeSheet}>keep browsing</button>}
      </div>
    </Sheet>
  )
  return (
    <Sheet title="sign in" onClose={closeSheet}>
      <div className="signin">
        <Mascot size={72} />
        <h3 className="signin__title">{reason ?? 'join wifly.'}</h3>
        {reason && <p className="muted small">it takes about a minute. you can keep looking around after.</p>}
        <p className="muted small">you sign a message to prove it’s you. nothing is sent or spent.</p>
        <HumanCheck />
        <button className="btn btn--dark btn--block" disabled={!!busy} onClick={wallet}><Icon name="wallet" size={18} /> {busy === 'wallet' ? 'check your wallet…' : isConnected ? 'sign in with your wallet' : 'connect a wallet'}</button>
        <button className="btn btn--ghost btn--block" disabled={!!busy} onClick={guest}><Icon name="user" size={18} /> {busy === 'guest' ? 'signing…' : 'try it with a guest key'}</button>
        {status}
        <p className="muted tiny">a guest key lives in this browser only. you can link a wallet later.</p>
        {reason && <button className="btn btn--text btn--block" onClick={closeSheet}>keep browsing</button>}
      </div>
    </Sheet>
  )
}

function ProfileSheet() {
  const { closeSheet, toast } = useStore()
  const nav = useNavigate()
  const { me, setMe } = useSession()
  const qc = useQueryClient()
  const [f, setF] = useState({ name: me?.name ?? '', handle: me?.handle ?? '', bio: me?.bio ?? '', location: me?.location ?? '', avatar: me?.avatar ?? null as string | null })
  const [busy, setBusy] = useState(false)
  if (!me) return null
  const first = !me.onboarded
  const save = async () => {
    setBusy(true)
    try {
      const r = await api<{ me: typeof me }>('/me', { method: 'PATCH', json: f })
      adoptUser({ ...r.me, you: true }); setMe(r.me)
      qc.invalidateQueries(); closeSheet(); toast(first ? `welcome, @${r.me.handle}` : 'profile saved')
    } catch (e) { toast('couldn’t save', (e as Error).message) } finally { setBusy(false) }
  }
  const pick = async (fl: File) => {
    try { const url = await uploadAvatar(fl); setF(v => ({ ...v, avatar: url })) } catch (e) { toast('couldn’t add that photo', (e as Error).message) }
  }
  const bioLeft = 160 - [...f.bio].length
  return (
    <Sheet title={first ? 'make it yours' : 'edit profile'} onClose={closeSheet} footer={
      <div className="compose__foot"><span className="muted small">{first ? 'you can change all of this later.' : ''}</span><button className="btn btn--dark" disabled={busy || !f.name.trim() || bioLeft < 0} onClick={save}>{busy ? 'saving…' : first ? 'let’s go' : 'save'}</button></div>
    }>
      <div className="pform">
        <AvatarPicker src={f.avatar || null} name={f.name} handle={me.handle} size={80} onPick={pick} onRemove={() => setF(v => ({ ...v, avatar: null }))} onError={m => toast('couldn’t add that photo', m)} />
        <label className="field"><span>name</span><input value={f.name} maxLength={40} onChange={e => setF({ ...f, name: e.target.value })} /></label>
        <label className="field"><span>handle</span><div className="field__pre"><b>@</b><input value={f.handle} maxLength={20} disabled={!!me.wifName} onChange={e => setF({ ...f, handle: e.target.value.replace(/[^A-Za-z0-9_]/g, '') })} /></div></label>
        {me.wifName
          ? <p className="tiny muted">your @ follows your main .wif ({me.wifName}.wif). <button className="linkbtn" onClick={() => { closeSheet(); nav('/names?tab=mine') }}>pick your main name</button></p>
          : !first && <div className="pform__onchain"><p className="tiny muted">your @{me.handle} is free and lives in wifly. make it yours onchain with {me.handle}.wif.</p><MakeItYours block /></div>}
        {!first && <BumpNotice />}
        <label className="field"><span>bio <em className={`num ${bioLeft < 0 ? 'warn' : ''}`}>{bioLeft}</em></span><textarea rows={3} value={f.bio} onChange={e => setF({ ...f, bio: e.target.value })} placeholder="what you make, what you care about" /></label>
        <label className="field"><span>where</span><input value={f.location} maxLength={40} onChange={e => setF({ ...f, location: e.target.value })} placeholder="lisbon, osaka, everywhere" /></label>
      </div>
    </Sheet>
  )
}

/** Guests: one calm line, three ways to link, a quiet "not now". Once linked, the action carries on. */
function LinkSheet({ then }: { then?: () => void }) {
  const { closeSheet } = useStore()
  const { me, guest, linkX, linkEmail, linkWallet } = useSession()
  const { address, isConnected } = useAccount()
  const { connectAsync, connectors } = useConnect()
  const [busy, setBusy] = useState<'wallet' | 'x' | 'email' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const pending = useRef(then)
  // linked: a gated sheet turns into its action by itself; a plain action (like, follow …) runs once
  useEffect(() => {
    if (!me || guest || !pending.current) return
    const run = pending.current; pending.current = undefined
    closeSheet(); run()
  }, [me, guest, closeSheet])
  useEffect(() => { if (privyEnabled) wantPrivy() }, [])
  const go = (kind: 'wallet' | 'x' | 'email') => async () => {
    if (busy) return
    setBusy(kind); setErr(null)
    try {
      if (kind === 'wallet') {
        let a = isConnected ? address : undefined
        if (!a) { const c = connectors[0]; if (!c) throw new Error('no wallet found in this browser'); a = (await connectAsync({ connector: c })).accounts[0] }
        await linkWallet(a!)
      } else if (kind === 'x') await linkX()
      else await linkEmail()
    } catch (e) {
      const m = (e as Error).message || 'that didn’t go through'
      if (!/rejected|denied|closed/i.test(m)) setErr(m.toLowerCase())
    } finally { setBusy(null) }
  }
  return (
    <Sheet title="link to continue" onClose={closeSheet} size="sm">
      <div className="linksheet" data-testid="link-sheet">
        <p className="linksheet__line muted">create a free account to like, tip and post</p>
        <div className="linksheet__btns">
          <button className="btn btn--dark btn--block" disabled={!!busy} onClick={go('wallet')}><Icon name="wallet" size={18} /> {busy === 'wallet' ? 'check your wallet…' : 'wallet'}</button>
          <button className="btn btn--ghost btn--block" disabled={!!busy || !privyEnabled} onClick={go('x')}><Icon name="x" size={16} /> {busy === 'x' ? 'opening…' : 'x'}{!privyEnabled && <span className="linksheet__soon">soon</span>}</button>
          <button className="btn btn--ghost btn--block" disabled={!!busy || !privyEnabled} onClick={go('email')}><Icon name="mail" size={18} /> {busy === 'email' ? 'opening…' : 'email'}{!privyEnabled && <span className="linksheet__soon">soon</span>}</button>
        </div>
        {err && <p className="linksheet__err small" role="alert">{err}</p>}
        <button className="btn btn--text btn--sm linksheet__later" onClick={closeSheet}>not now</button>
      </div>
    </Sheet>
  )
}

export function Sheets() {
  const { sheet, openSheet } = useStore()
  const { me, ready, guest } = useSession()
  // any write the api turned down for a guest opens the link sheet (a safety net behind the button gates)
  useEffect(() => {
    const open = () => openSheet({ type: 'link' })
    window.addEventListener(LINK_REQUIRED_EVENT, open)
    return () => window.removeEventListener(LINK_REQUIRED_EVENT, open)
  }, [openSheet])
  const asLink = !!sheet && (sheet.type === 'link' || (!!GUEST_ASK[sheet.type] && ready && !!me && guest))
  const key = !sheet ? '' : asLink ? 'link' : sheet.type === 'signin' || sheet.type === 'profile' ? 'auth' : sheet.type
  return <AnimatePresence>{sheet && <SheetSwitch key={key} sheet={sheet} />}</AnimatePresence>
}

/** Guest actions open a gentle sign-up sheet instead of the action sheet. */
const GUEST_ASK: Partial<Record<NonNullable<SheetState>['type'], string>> = {
  tip: 'sign up to send a tip', vote: 'sign up to vote', compose: 'sign up to post and reply', drop: 'sign up to post',
  unlock: 'sign up to unlock this', subscribe: 'sign up to subscribe', paydm: 'sign up to send a message', buy: 'sign up to buy this',
  bid: 'sign up to bid', burn: 'sign up to earn badges', tiers: 'sign up to set up memberships',
}

/** A signed-in account still without a picked @name browses freely; the first action takes it to the name step. */
function ToWelcome({ renaming }: { renaming: boolean }) {
  const { closeSheet } = useStore()
  const nav = useNavigate()
  useEffect(() => { closeSheet(); nav(`/welcome${renaming ? '?step=you' : ''}`) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

function SheetSwitch({ sheet }: { sheet: NonNullable<SheetState> }) {
  const { me, ready } = useSession()
  const ask = GUEST_ASK[sheet.type]
  if (ask && !ready) return null // wait for the session so a gated sheet never flashes (or fetches) before the sign-in / link sheet
  if (ask && ready && !me) return <SignInSheet reason={ask} />
  if (ask && me?.needsHandle) return <ToWelcome renaming={!!me.renaming} />
  if (ask && me?.guest) return <LinkSheet />
  switch (sheet.type) {
    case 'link': return me ? <LinkSheet then={sheet.then} /> : <SignInSheet />
    case 'tip': return <TipSheet {...sheet} />
    case 'unlock': return <UnlockSheet postId={sheet.postId} />
    case 'subscribe': return <SubscribeSheet handle={sheet.handle} tierId={sheet.tierId} />
    case 'bid': return <BidSheet />
    case 'buy': return <BuySheet handle={sheet.handle} itemId={sheet.itemId} />
    case 'paydm': return <PayDmSheet handle={sheet.handle} />
    case 'vote': return <VoteSheet handle={sheet.handle} postId={sheet.postId} />
    case 'swap': return <SwapSheet wifOut={sheet.wifOut} reason={sheet.reason} />
    case 'burn': return <BurnSheet amount={sheet.amount} />
    case 'badge': return <BadgeSheet id={sheet.id} handle={sheet.handle} />
    case 'drop': return <ComposeSheet initialLock="price" />
    case 'tiers': return <TiersSheet />
    case 'compose': return <ComposeSheet replyTo={sheet.replyTo} quoteOf={sheet.quoteOf} />
    case 'signin': return <SignInSheet reason={sheet.reason} />
    case 'profile': return <ProfileSheet />
  }
}
