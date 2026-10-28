/**
 * The Wifly companion: the animated ω-face as a persistent helper.
 * - Dock: bottom-right on every app page, above the mobile tab bar. Tucks to the edge while you scroll down so it
 *   never sits on a post, hides while a sheet (with its primary button) is open, and can be collapsed.
 * - Panel: chat commands ("tip alice.wif 50", "renew my Plus", "subscribe to @lena") -> confirm card -> executed by the
 *   server through the agent path (tipFor / subscribeFor / subscribeForPlan / takeTopSpotFor), inside the daily cap,
 *   spending only the deposited Wifly balance. Top up, cap sheet (set / raise / revoke) and the activity log live here.
 */
import { profilePath } from '../lib/paths'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Mascot, type Mood } from '../components/Mascot'
import { Icon } from '../components/Icon'
import { TxSteps } from '../components/TxSteps'
import { useSession } from '../api/session'
import { useStore } from '../state/store'
import { AGENT_READY, FEE_BPS, LIVE, TOPSPOT_FEE_SHARE, WIFLY_AGENT_ADDRESS } from '../config'
import { failTitle, plans, useSendPlan } from '../lib/wifly'
import { Usd, usdText, useWifPrice } from '../lib/price'
import { companion, useCompanionFeed } from '../lib/companion'
import { FEE_PERCENT_LABEL, FEE_SPLIT_LABEL, splitFee } from '../lib/fees'
import { call, useActivity, useAgent, useAgentRefresh, useCompanionInfo, useMyAgent, type AgentState, type ChatCard, type ChatReply, type Executed, type Planned } from './agentApi'

const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—')
const n = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 2 })
const FN_WORDS: Record<string, string> = { tipFor: 'tip', subscribeFor: 'subscribe', subscribeForPlan: 'renew plus', takeTopSpotFor: 'promote' }
const SUGGEST = ['what’s my balance', 'swap 0.01 eth to wif', 'buy $5 of wif every monday at 9:00']
const GREETING = 'i’m wifly’s free assistant. ask me anything about wifly. with plus i can also prepare tips, swaps, recurring buys and memberships, and you confirm each one.'
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

type Msg = { id: number; from: 'me' | 'face'; text: string; card?: Planned; cards?: ChatCard[]; result?: Executed }
type View = 'chat' | 'mine' | 'cap' | 'activity' | 'topup'

export function Companion() {
  const { me, guest } = useSession()
  const { sheet } = useStore()
  const { pathname } = useLocation()
  const [open, setOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('wifly.companion') === 'min')
  const [tucked, setTucked] = useState(false)
  const feed = useCompanionFeed('calm')
  useEffect(() => { localStorage.setItem('wifly.companion', collapsed ? 'min' : 'on') }, [collapsed])
  useEffect(() => { setOpen(false) }, [pathname])
  useEffect(() => { const o = () => setOpen(true); window.addEventListener('wifly:companion', o); return () => window.removeEventListener('wifly:companion', o) }, [])
  // tuck to the edge while scrolling down, come back on scroll up or after a short pause
  useEffect(() => {
    let y = window.scrollY, t: ReturnType<typeof setTimeout>
    const on = () => { const d = window.scrollY - y; y = window.scrollY; if (d > 4) setTucked(true); else if (d < -4) setTucked(false); clearTimeout(t); t = setTimeout(() => setTucked(false), 1400) }
    window.addEventListener('scroll', on, { passive: true }); return () => { window.removeEventListener('scroll', on); clearTimeout(t) }
  }, [])
  const hidden = !!sheet && !open

  return (
    <>
      <AnimatePresence>
        {!hidden && !open && (
          <motion.div className={`cmp-dock ${collapsed ? 'is-min' : ''} ${tucked ? 'is-tucked' : ''}`} key="dock"
            initial={{ opacity: 0, y: 20, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 20, scale: 0.9 }}
            transition={{ type: 'spring', stiffness: 380, damping: 28 }}>
            <AnimatePresence>
              {feed.bubble && !collapsed && (
                <motion.button className="cmp-bubble" key={feed.bubble} onClick={() => setOpen(true)}
                  initial={{ opacity: 0, y: 8, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 4 }}>{feed.bubble}</motion.button>
              )}
            </AnimatePresence>
            {feed.party && <CelebrateBits key={feed.pulse} />}
            <button className="cmp-dock__face" onClick={() => (collapsed ? setCollapsed(false) : setOpen(true))} aria-label="open the wifly companion">
              <Mascot size={collapsed ? 40 : 58} mood={feed.mood} pulse={feed.pulse} title="wifly companion" />
            </button>
            {!collapsed && <button className="cmp-dock__min" onClick={() => setCollapsed(true)} aria-label="make the companion smaller"><Icon name="chevron" size={12} /></button>}
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>{open && <Panel key="panel" signedIn={!!me} guest={guest} onClose={() => setOpen(false)} feedMood={feed.mood} pulse={feed.pulse} />}</AnimatePresence>
    </>
  )
}

/** A small burst of neon bits and two coins around the face (no glow). */
function CelebrateBits() {
  const bits = Array.from({ length: 8 }, (_, i) => { const a = (i / 8) * Math.PI * 2; return { x: Math.cos(a) * 46, y: Math.sin(a) * 40 - 10, c: i % 2 } })
  return (
    <span className="cmp-party" aria-hidden="true">
      {bits.map((b, i) => <motion.span key={i} className={`cmp-party__bit ${b.c ? 'is-ink' : ''}`} initial={{ x: 0, y: 0, scale: 0.3, opacity: 1 }}
        animate={{ x: b.x, y: b.y, scale: [0.3, 1, 0.6], opacity: [1, 1, 0] }} transition={{ duration: 0.9, ease: [0.2, 0.8, 0.3, 1] }} />)}
      {[0, 1].map(i => <motion.img key={`c${i}`} src="/brand/wif-coin-256.png" alt="" className="cmp-party__coin" width={20} height={20}
        initial={{ x: i ? 10 : -14, y: -10, opacity: 0, rotate: 0 }} animate={{ y: -64 - i * 10, opacity: [0, 1, 0], rotate: i ? 40 : -40 }} transition={{ duration: 1.1, delay: i * 0.1 }} />)}
    </span>
  )
}

function Panel({ signedIn, guest, onClose, feedMood, pulse }: { signedIn: boolean; guest?: boolean; onClose: () => void; feedMood: Mood; pulse: number }) {
  const { openSheet } = useStore()
  const agent = useAgent(signedIn)
  const st = agent.data
  const [view, setView] = useState<View>('chat')
  const [topUp, setTopUp] = useState(0)
  const [mood, setMood] = useState<Mood>('happy')
  const info = useCompanionInfo(signedIn)
  const [freeLeft, setFreeLeft] = useState<number | null | undefined>(undefined)
  const left = freeLeft !== undefined ? freeLeft : info.data?.freeLeft
  const navigate = useNavigate()
  const [msgs, setMsgs] = useState<Msg[]>(() => [{ id: 0, from: 'face', text: GREETING }])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const id = useRef(1)
  const list = useRef<HTMLDivElement>(null)
  const refresh = useAgentRefresh()
  useEffect(() => { const t = setTimeout(() => setMood('calm'), 1400); return () => clearTimeout(t) }, [])
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' }) }, [msgs, busy])
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [onClose])
  const push = (m: Omit<Msg, 'id'>) => setMsgs(v => [...v, { ...m, id: id.current++ }])

  const ask = async (raw: string) => {
    const t = raw.trim(); if (!t || busy) return
    if (!signedIn) { push({ from: 'me', text: t }); push({ from: 'face', text: 'sign in first, then i can help with that.' }); setMood('oops'); return }
    if (guest) { push({ from: 'me', text: t }); push({ from: 'face', text: 'link a wallet, x or email first, then i can help with that.' }); setMood('oops'); openSheet({ type: 'link' }); return }
    setText(''); push({ from: 'me', text: t }); setBusy(true); setMood('think')
    try {
      const history = msgs.slice(-6).map(m => ({ from: m.from, text: m.text }))
      const r = await call<ChatReply>('/companion/chat', 'POST', { text: t, history })
      if (r.error) throw new Error(r.error)
      setFreeLeft(r.freeLeft)
      const action = r.cards.find((c): c is Extract<ChatCard, { type: 'action' }> => c.type === 'action')?.plan
      if (action) refresh(action.state)
      push({ from: 'face', text: r.reply, card: action && (action.ok || action.needsTopUp || action.recipient) ? action : undefined, cards: r.cards.filter(c => c.type !== 'action') })
      setMood(r.busy ? 'oops' : action?.ok || r.cards.some(c => c.type === 'swap' || c.type === 'dca') ? 'wow' : r.cards.some(c => c.type === 'unlock') ? 'calm' : 'happy')
    } catch (e) { push({ from: 'face', text: (e as Error).message }); setMood('oops') } finally { setBusy(false); setTimeout(() => setMood('calm'), 1800) }
  }

  const execute = async (p: Planned, msgId: number) => {
    setBusy(true); setMood('think')
    try {
      const r = await call<Executed>('/agent/execute', 'POST', { text: p.command, expect: { kind: p.kind, amount: p.amount ?? 0, to: p.recipient?.address ?? null } })
      refresh(r.state ?? r.action?.state)
      setMsgs(v => v.map(m => (m.id === msgId ? { ...m, result: r } : m)))
      if (r.status === 'sent') { companion.celebrate('agent', `${p.summary}. confirmed`); setMood('happy'); push({ from: 'face', text: 'done. it’s in your activity with the transaction link.' }) }
      else if (r.status === 'preview') { setMood('happy'); push({ from: 'face', text: r.reason ?? 'payments aren’t live yet, so nothing was sent.' }) }
      else { setMood('oops'); push({ from: 'face', text: r.reason ?? 'that didn’t go through.' }) }
    } catch (e) { setMood('oops'); push({ from: 'face', text: (e as Error).message }) } finally { setBusy(false); setTimeout(() => setMood('calm'), 2000) }
  }

  const submit = (e: FormEvent) => { e.preventDefault(); ask(text) }

  return (
    <>
      <motion.div className="cmp-scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
      <motion.section className="cmp-panel" role="dialog" aria-label="wifly companion"
        initial={{ opacity: 0, y: 24, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 24, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 380, damping: 32 }}>
        <header className="cmp-head">
          <Mascot size={44} mood={busy ? 'think' : mood === 'calm' ? feedMood : mood} pulse={pulse} title="wifly companion" />
          <div className="cmp-head__copy">
            <div className="cmp-head__title"><span className="strong">wifly companion</span><span className="cmp-free" title="runs on free ai models only">free ai assistant</span></div>
            <div className="muted small">{!signedIn ? 'sign in to chat' : info.data && !info.data.chatOn ? 'chat is off · commands still work' : left != null ? `${left} free question${left === 1 ? '' : 's'} left today` : info.data?.plus.ok ? `plus · agent ${AGENT_READY && st?.enabled ? 'on' : 'off'}` : '…'}</div>
          </div>
          <button className="cmp-x" onClick={onClose} aria-label="close"><Icon name="close" size={16} /></button>
        </header>
        {signedIn && AGENT_READY && <Meters st={st} onCap={() => setView('cap')} onTopUp={() => { setTopUp(0); setView('topup') }} />}
        <nav className="cmp-tabs" role="tablist">
          {(['chat', 'mine', 'cap', 'activity'] as const).map(v => <button key={v} role="tab" aria-selected={view === v || (v === 'chat' && view === 'topup')} className={view === v || (v === 'chat' && view === 'topup') ? 'is-on' : ''} onClick={() => setView(v)}>{v === 'cap' ? 'daily cap' : v === 'mine' ? 'my agent' : v}</button>)}
        </nav>
        <div className="cmp-body">
          {view === 'chat' && (
            <div className="cmp-chat" ref={list}>
              {msgs.map(m => (
                <div key={m.id} className={`cmp-msg cmp-msg--${m.from}`}>
                  {m.from === 'face' && <span className="cmp-msg__face" aria-hidden="true"><Mascot size={26} tile /></span>}
                  <div className="cmp-msg__col">
                    <p className="cmp-msg__text">{m.text}</p>
                    {m.card && <ConfirmCard p={m.card} st={st} result={m.result} busy={busy}
                      onConfirm={() => execute(m.card!, m.id)} onTopUp={s => { setTopUp(s); setView('topup') }} />}
                    {m.cards?.map((c, i) => <ChatCardView key={i} c={c} busy={busy} onAsk={ask} onGo={to => { onClose(); navigate(to) }} />)}
                  </div>
                </div>
              ))}
              {busy && <div className="cmp-msg cmp-msg--face"><span className="cmp-msg__face"><Mascot size={26} mood="think" /></span><p className="cmp-typing"><span /><span /><span /></p></div>}
            </div>
          )}
          {view === 'topup' && st && <TopUp st={st} suggested={topUp} onDone={() => { setView('chat'); push({ from: 'face', text: 'balance topped up. send that command again and i’ll take it from here.' }); setMood('happy') }} onBack={() => setView('chat')} />}
          {view === 'mine' && !AGENT_READY && <SpendingOff />}
          {view === 'mine' && AGENT_READY && (signedIn ? <MyAgentPane onGo={to => { onClose(); navigate(to) }} /> : <><SignInNote onSignIn={() => { onClose(); openSheet({ type: 'signin' }) }} /><RentAgentCard /></>)}
          {view === 'cap' && !AGENT_READY && <SpendingOff />}
          {view === 'cap' && AGENT_READY && (signedIn ? st ? <CapSheet st={st} /> : <Loading /> : <SignInNote onSignIn={() => { onClose(); openSheet({ type: 'signin' }) }} />)}
          {view === 'activity' && (signedIn ? <ActivityLog /> : <SignInNote onSignIn={() => { onClose(); openSheet({ type: 'signin' }) }} />)}
        </div>
        {view === 'chat' && (
          <footer className="cmp-foot">
            <div className="cmp-sugg">{SUGGEST.map(s => <button key={s} className="chip chip--sm" onClick={() => ask(s)} disabled={busy}>{s}</button>)}</div>
            <form className="cmp-input" onSubmit={submit}>
              <input value={text} onChange={e => setText(e.target.value)} placeholder="tip marv.wif 50" aria-label="tell the companion what to do" maxLength={200} />
              <button className="btn btn--dark btn--sm" disabled={!text.trim() || busy} aria-label="send"><Icon name="send" size={16} /></button>
            </form>
          </footer>
        )}
      </motion.section>
    </>
  )
}

/** Every non-action card the chat can return. Nothing here sends: links open the screen that does, taps send text back. */
function ChatCardView({ c, busy, onAsk, onGo }: { c: ChatCard; busy: boolean; onAsk: (t: string) => void; onGo: (to: string) => void }) {
  if (c.type === 'suggest') return (
    <div className="cmp-card cmp-card--soft">
      <span className="muted tiny">did you mean</span>
      <button className="btn btn--ghost btn--sm btn--block" disabled={busy} onClick={() => onAsk(c.text)}>{c.label}</button>
      {!!c.fixes.length && <span className="muted tiny">{c.fixes.slice(0, 3).map(x => `${x.from} → ${x.to}`).join(' · ')}</span>}
    </div>
  )
  if (c.type === 'suggestions') return <div className="cmp-sugg cmp-sugg--inline">{c.options.map(o => <button key={o} className="chip chip--sm" disabled={busy} onClick={() => onAsk(o)}>{o}</button>)}</div>
  if (c.type === 'unlock') return (
    <div className="cmp-card cmp-card--soft">
      <span className="strong">the agent is a plus perk</span>
      <span className="muted small">{c.reason}</span>
      <button className="btn btn--dark btn--sm btn--block" onClick={() => onGo('/plus')}>see wifly plus</button>
    </div>
  )
  if (c.type === 'swap') return (
    <div className="cmp-card">
      <div className="cmp-card__row"><span className="muted small">swap</span><span className="strong">{c.dir === 'eth2wif' ? `${n(c.amount)} eth → wif` : `${n(c.amount)} wif → eth`}</span></div>
      {c.out != null && <div className="cmp-card__row"><span className="muted small">quote</span><span className="num">≈ {n(c.out)} {c.dir === 'eth2wif' ? 'wif' : 'eth'}</span></div>}
      <button className="btn btn--dark btn--sm btn--block" onClick={() => onGo('/swap')}>review on the swap screen</button>
      <span className="muted tiny">you confirm the swap in your wallet there.</span>
    </div>
  )
  if (c.type === 'dca') {
    const d = c.draft
    const q = new URLSearchParams({ every: d.every, hour: String(d.hour), minute: String(d.minute), ...(d.weekday != null ? { weekday: String(d.weekday) } : {}),
      ...(d.perBuy.usd ? { usd: String(d.perBuy.usd) } : {}), ...(d.perBuy.eth ? { eth: String(d.perBuy.eth) } : {}), ...(d.depositEth ? { deposit: String(d.depositEth) } : {}) })
    return (
      <div className="cmp-card">
        <div className="cmp-card__row"><span className="muted small">recurring buy</span><span className="strong">{d.perBuy.usd ? `$${n(d.perBuy.usd)}` : `${d.perBuy.eth} eth`} of wif</span></div>
        <div className="cmp-card__row"><span className="muted small">when</span><span>{d.every === 'week' && d.weekday != null ? `every ${DAYS[d.weekday]}` : `every ${d.every}`}{d.every === 'hour' ? '' : ` at ${String(d.hour).padStart(2, '0')}:${String(d.minute).padStart(2, '0')}`}</span></div>
        <button className="btn btn--dark btn--sm btn--block" onClick={() => onGo(`/dca?${q}`)}>set the deposit and confirm</button>
      </div>
    )
  }
  if (c.type === 'dca_manage') return (
    <div className="cmp-card">
      <div className="cmp-card__row"><span className="muted small">{c.action} plan</span><span className="strong">{c.plan.perBuyUsd ? `$${n(c.plan.perBuyUsd)}` : `${c.plan.perBuyEth} eth`} · {c.plan.status.replace('_', ' ')}</span></div>
      <button className="btn btn--dark btn--sm btn--block" onClick={() => onGo('/dca')}>{c.action} on the DCA screen</button>
    </div>
  )
  if (c.type === 'creators') return <div className="cmp-sugg cmp-sugg--inline">{c.users.slice(0, 5).map((u, i) => u.handle && <button key={i} className="chip chip--sm" onClick={() => onGo(profilePath(u.handle ?? ""))}>@{u.handle}</button>)}</div>
  return null
}

/** "My agent" (Plus, checked by the server onchain): plans and recent actions. Non-Plus sees the unlock card. */
function MyAgentPane({ onGo }: { onGo: (to: string) => void }) {
  const q = useMyAgent(true)
  if (q.isLoading) return <Loading />
  const d = q.data
  return (
    <div className="cmp-pane">
      {!d || d.locked ? (
        <div className="cmp-card cmp-card--soft">
          <span className="strong">your own agent comes with plus</span>
          <span className="muted small">it prepares tips, swaps, recurring buys and memberships from a message, and you confirm each one. chat questions stay free.</span>
          <button className="btn btn--dark btn--sm btn--block" onClick={() => onGo('/plus')}>see wifly plus</button>
        </div>
      ) : (
        <>
          <h3 className="cmp-pane__title">my agent</h3>
          <p className="muted small">plus {d.plus.state === 'grace' ? '(grace period)' : 'active'}. recurring buys:</p>
          {d.dca?.plans.length ? d.dca.plans.map(p => <div key={p.id} className="cmp-card__row"><span>{p.perBuyUsd ? `$${n(p.perBuyUsd)}` : `${p.perBuyEth} eth`} · {p.buysLeft} left</span><span className="muted small">{p.status.replace('_', ' ')}</span></div>) : <span className="muted small">none yet.</span>}
          <button className="btn btn--ghost btn--sm" onClick={() => onGo('/dca')}>open recurring buys</button>
          {!!d.actions?.length && <><p className="muted small">recent</p>{d.actions.slice(0, 5).map(a => <div key={a.id} className="cmp-card__row"><span className="small clamp-1">{a.command}</span><span className="muted tiny">{a.status}</span></div>)}</>}
        </>
      )}
      <RentAgentCard />
    </div>
  )
}

/** Coming soon: renting a dedicated AI agent. Disabled on purpose; nothing to buy yet. */
export function RentAgentCard() {
  return (
    <div className="rent-agent" aria-disabled="true">
      <div className="rent-agent__head"><span className="strong">rent an ai agent</span><span className="rent-agent__soon">coming soon</span></div>
      <p className="muted small">a dedicated agent that works your wifly account around the clock, on rules you set.</p>
      <button className="btn btn--ghost btn--sm" disabled>rent an agent</button>
    </div>
  )
}

function Meters({ st, onCap, onTopUp }: { st?: AgentState; onCap: () => void; onTopUp: () => void }) {
  return (
    <div className="cmp-meters">
      <button className="cmp-meter" onClick={onTopUp}><span className="muted small">deposited</span><b className="num">{st ? n(st.deposited) : '…'} <small>wif</small></b></button>
      <button className="cmp-meter" onClick={onCap}><span className="muted small">daily cap</span><b className="num">{st ? (st.enabled ? n(st.cap) : 'off') : '…'}{st?.enabled && <small> wif</small>}</b></button>
      <button className="cmp-meter" onClick={onCap}><span className="muted small">left today</span><b className="num">{st ? n(st.remaining) : '…'} <small>wif</small></b></button>
    </div>
  )
}

function ConfirmCard({ p, st, result, busy, onConfirm, onTopUp }: { p: Planned; st?: AgentState; result?: Executed; busy: boolean; onConfirm: () => void; onTopUp: (shortfall: number) => void }) {
  const cur = st ?? p.state
  const remainingAfter = Math.max(0, cur.remaining - (p.amount ?? 0))
  const done = !!result
  return (
    <motion.div className={`cmp-card ${done ? `is-${result!.status}` : ''}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 30 }}>
      <div className="cmp-card__row"><span className="muted small">action</span><span className="strong">{FN_WORDS[p.call?.fn ?? ''] ?? p.kind}</span></div>
      {p.recipient && (
        <div className="cmp-card__row cmp-card__row--to">
          <span className="muted small">to</span>
          <span className="cmp-card__to"><b>{p.recipient.label}</b>
            <span className="mono small">{p.recipient.address ? short(p.recipient.address) : 'no wallet'}</span>
            <span className="muted tiny">{p.recipient.kind === 'wif' ? (p.recipient.source === 'chain' ? 'resolved onchain · resolve()' : 'resolved by the names mirror') : p.recipient.kind === 'handle' ? 'wifly username' : 'address'}</span>
          </span>
        </div>
      )}
      <div className="cmp-card__row"><span className="muted small">amount</span><span className="cmp-card__amt"><b className="num">{n(p.amount ?? 0)} wif</b><Usd value={p.usd ?? undefined} className="small muted" /></span></div>
      {(p.kind === 'tip' || p.kind === 'subscribe' || p.kind === 'promote') && (p.amount ?? 0) > 0 && (() => {
        const fee = (p.amount ?? 0) * (p.kind === 'promote' ? TOPSPOT_FEE_SHARE : FEE_BPS / 10_000), parts = splitFee(fee)
        return <div className="cmp-card__row" title={`every fee: ${FEE_SPLIT_LABEL}`}><span className="muted small">fee · {p.kind === 'promote' ? `${Math.round(TOPSPOT_FEE_SHARE * 100)}% of bid` : FEE_PERCENT_LABEL}</span>
          <span className="cmp-card__amt"><span className="num">{n(fee)} wif</span><span className="muted tiny">{parts.treasury > 0 ? `${n(parts.treasury)} treasury · ` : ''}{n(parts.pot)} pot · {n(parts.burn)} burned</span></span></div>
      })()}
      <div className="cmp-card__row"><span className="muted small">from deposited</span><span className="num">{n(cur.deposited)} wif</span></div>
      <div className="cmp-card__row"><span className="muted small">cap left today</span><span className="num">{n(cur.remaining)} → {n(remainingAfter)} wif</span></div>
      {p.call && <div className="cmp-card__fn mono tiny">{p.call.fn}(you, {p.call.args.slice(1).map(a => (a.startsWith('0x') && a.length === 42 ? short(a) : a.length > 18 ? `${a.slice(0, 6)}…` : a)).join(', ')})</div>}
      {done ? (
        <div className={`cmp-card__status is-${result!.status}`}>
          <Icon name={result!.status === 'sent' || result!.status === 'preview' ? 'check' : 'close'} size={14} />
          {result!.status === 'sent' ? <>sent · <a href={`https://robinhoodchain.blockscout.com/tx/${result!.hash}`} target="_blank" rel="noreferrer">view transaction</a></> : result!.status === 'preview' ? 'not live yet: nothing was sent' : result!.reason}
        </div>
      ) : p.needsTopUp ? (
        <button className="btn btn--dark btn--block btn--sm" onClick={() => onTopUp(p.needsTopUp!.shortfall)}>top up {n(p.needsTopUp.shortfall)} wif</button>
      ) : p.ok ? (
        <button className="btn btn--dark btn--block btn--sm" onClick={onConfirm} disabled={busy}>{busy ? 'sending…' : `confirm ${FN_WORDS[p.call?.fn ?? ''] ?? ''}`}</button>
      ) : null}
    </motion.div>
  )
}

function TopUp({ st, suggested, onDone, onBack }: { st: AgentState; suggested: number; onDone: () => void; onBack: () => void }) {
  const [amount, setAmount] = useState(Math.max(suggested, 0) || 100)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const send = useSendPlan()
  const refresh = useAgentRefresh()
  const go = async () => {
    setBusy(true); setErr(null)
    try {
      let txHash: string | undefined
      if (LIVE) { const r = await send(plans.deposit(amount)); if (!r.sent) { setErr(`${failTitle(r)}: ${r.reason}`); return } txHash = r.hash }
      const s = await call<AgentState & { error?: string }>('/agent/deposit', 'POST', { amount, txHash })
      if (s.error) { setErr(s.error); return }
      refresh(s); onDone()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="cmp-pane">
      <button className="cmp-back small" onClick={onBack}><Icon name="back" size={14} /> back</button>
      <h3 className="cmp-pane__title">top up your wifly balance</h3>
      <p className="muted small">the agent spends only from here. you approve exactly this amount, then deposit it. you can withdraw it any time from your wallet; the agent can’t.</p>
      <div className="cmp-amount">
        <input inputMode="decimal" value={amount || ''} onChange={e => setAmount(Number(e.target.value.replace(/[^0-9.]/g, '')) || 0)} aria-label="top up amount" />
        <span>wif</span>
      </div>
      <div className="cmp-presets">{[...(suggested ? [suggested] : []), 100, 500, 1000].filter((v, i, a) => a.indexOf(v) === i).map(v => <button key={v} className={`chip chip--sm ${amount === v ? 'is-on' : ''}`} onClick={() => setAmount(v)}>{v === suggested ? `${n(v)} (needed)` : n(v)}</button>)}</div>
      <div className="cmp-card__row"><span className="muted small">balance after</span><span className="num strong">{n(st.deposited + amount)} wif</span></div>
      <TxSteps pull={amount} action={`deposit ${n(amount)} wif`} />
      {err && <p className="cmp-err small">{err}</p>}
      <button className="btn btn--dark btn--block" disabled={!amount || busy} onClick={go}>{busy ? 'depositing…' : `approve ${n(amount)} + deposit`}</button>
      {!LIVE && <p className="preview-note"><Icon name="shield" size={14} /> payments aren’t live yet. confirming sends nothing.</p>}
    </div>
  )
}

function CapSheet({ st }: { st: AgentState }) {
  const [cap, setCap] = useState(st.enabled ? st.cap : Math.min(100, st.maxCap))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const send = useSendPlan()
  const refresh = useAgentRefresh()
  // the server's signer address first (it is the one that sends); the build's VITE_WIFLY_AGENT_ADDRESS as a fallback.
  // if both are set and disagree, block: authorising the wrong address would let nobody (or someone else) spend.
  const agentAddr = st.agentAddress ?? WIFLY_AGENT_ADDRESS ?? null
  const mismatch = !!(st.agentAddress && WIFLY_AGENT_ADDRESS && st.agentAddress.toLowerCase() !== WIFLY_AGENT_ADDRESS.toLowerCase())
  const save = async (value: number) => {
    setBusy(true); setErr(null)
    try {
      let txHash: string | undefined
      if (st.live) {
        if (value > 0 && (!agentAddr || mismatch)) { setErr(mismatch ? 'the agent address doesn’t match the server’s. nothing was sent' : 'the agent address isn’t set yet. nothing was sent'); return }
        const r = await send(value > 0 ? plans.setAgent(agentAddr as `0x${string}`, value) : plans.revokeAgent())
        if (!r.sent) { setErr(`${failTitle(r)}: ${r.reason}`); return }
        txHash = r.hash
      }
      const s = await call<AgentState & { error?: string }>('/agent/cap', 'PUT', { cap: value, txHash })
      if (s.error) { setErr(s.error); return }
      refresh(s); companion.say(value > 0 ? `daily cap set to ${n(value)} wif` : 'agent off. it can’t spend anything now', value > 0 ? 'happy' : 'calm')
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const pct = st.maxCap ? cap / st.maxCap : 0
  const used = st.cap ? Math.min(1, st.spentToday / st.cap) : 0
  return (
    <div className="cmp-pane">
      <h3 className="cmp-pane__title">daily cap</h3>
      <p className="muted small">the most the agent can spend for you each utc day, from your deposited balance. it can never withdraw.</p>
      <div className="capbar" aria-label={`${st.spentToday} of ${st.cap} wif spent today`}><motion.span className="capbar__fill" animate={{ width: `${used * 100}%` }} /></div>
      <div className="capbar__legend small"><span><b className="num">{n(st.spentToday)}</b> spent today</span><span><b className="num">{n(st.remaining)}</b> left{st.enabled ? ` of ${n(st.cap)}` : ''} wif</span></div>
      <div className="cmp-amount"><input inputMode="numeric" value={cap || ''} onChange={e => setCap(Math.min(st.maxCap, Number(e.target.value.replace(/\D/g, '')) || 0))} aria-label="daily cap in wif" /><span>wif / day</span></div>
      <input className="range" type="range" min={0} max={st.maxCap} step={st.maxCap > 500 ? 50 : 10} value={cap} onChange={e => setCap(Number(e.target.value))} style={{ '--pct': `${pct * 100}%` } as React.CSSProperties} aria-label="daily cap" />
      <p className="muted tiny">up to {n(st.maxCap)} wif a day{st.maxCap <= 500 ? ' (5,000 with plus)' : ''}. agent: <span className="mono">{agentAddr ? short(agentAddr) : 'not set yet'}</span></p>
      <TxSteps pull={0} action={cap > 0 ? `setAgent with a ${n(cap)} wif daily cap` : 'revokeAgent'} />
      {err && <p className="cmp-err small">{err}</p>}
      <div className="cmp-row">
        <button className="btn btn--dark" disabled={busy || cap <= 0 || (st.live && (!agentAddr || mismatch)) || (st.enabled && cap === st.cap)} onClick={() => save(cap)}>{busy ? 'saving…' : !st.enabled ? 'turn on' : cap > st.cap ? 'raise cap' : 'lower cap'}</button>
        {st.enabled && <button className="btn btn--ghost" disabled={busy} onClick={() => save(0)}><Icon name="power" size={14} /> revoke</button>}
      </div>
      {!st.live && <p className="preview-note"><Icon name="shield" size={14} /> payments aren’t live yet. nothing is sent.</p>}
    </div>
  )
}

function ActivityLog() {
  const q = useActivity(true)
  const { usd } = useWifPrice()
  if (q.isLoading) return <Loading />
  const items = q.data?.items ?? []
  if (!items.length) return <Empty title="nothing yet" body="what the agent does for you shows up here, with a link to every transaction." />
  return (
    <ul className="cmp-log">
      {items.map(a => (
        <li key={a.id} className={`cmp-log__row is-${a.status}`}>
          <span className={`cmp-log__dot is-${a.status}`} aria-hidden="true" />
          <div className="cmp-log__copy">
            <div className="small strong clamp-1">{a.command}</div>
            <div className="muted tiny">{new Date(a.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · {a.status}{a.recipient ? ` · ${a.recipient}` : ''}{a.reason && a.status !== 'sent' ? ` · ${a.reason}` : ''}</div>
            {a.txHash && <a className="tiny" href={`https://robinhoodchain.blockscout.com/tx/${a.txHash}`} target="_blank" rel="noreferrer">view transaction</a>}
          </div>
          {a.amount > 0 && <span className="num small strong">−{n(a.amount)}{usd ? <span className="muted tiny"> ≈ ${usdText(a.amount * usd)}</span> : null}</span>}
        </li>
      ))}
    </ul>
  )
}

/** Spending is off on this build (AGENT_READY false): one calm card instead of the cap slider, setAgent step and deposit. */
function SpendingOff() {
  return <Empty title="spending is off for now" body="chat works, and you’ll set a daily cap here when it opens." />
}

function SignInNote({ onSignIn }: { onSignIn: () => void }) {
  return <Empty title="sign in first" body="the agent works from your own wifly balance, so it needs your account." action={<button className="btn btn--dark btn--sm" onClick={onSignIn}>sign in</button>} />
}

/** Shared empty state with the companion face. */
export function Empty({ title, body, action, mood = 'calm' }: { title: string; body?: string; action?: React.ReactNode; mood?: Mood }) {
  return (
    <div className="cmp-empty">
      <Mascot size={64} mood={mood} />
      <div className="strong">{title}</div>
      {body && <p className="muted small">{body}</p>}
      {action}
    </div>
  )
}

/** Loading state: the face scans side to side while it thinks. */
export function Loading({ label = 'one moment…' }: { label?: string }) {
  return <div className="cmp-loading" role="status"><Mascot size={48} mood="think" /><span className="muted small">{label}</span></div>
}
