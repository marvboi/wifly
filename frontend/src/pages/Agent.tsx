import { useAnyAccount } from '../auth/privyBridge'
import { motion } from 'motion/react'
import { Link } from 'react-router-dom'
import { AnimatedNumber } from '../components/Motion'
import { useEffect, useRef, useState } from 'react'
import { PayingFrom } from '../components/Payer'
import { usePayerState } from '../lib/payerStore'
import { AGENT_CAP_FREE, AGENT_CAP_PLUS, AGENT_READY, LIVE, WIFLY_AGENT_ADDRESS } from '../config'
import { PREVIEW_NOTE, useStore } from '../state/store'
import { failArgs, plans, useAgentOnChain, usePlusStatus, useInAppBalance, useSendPlan, type Plan } from '../lib/wifly'
import { shortAddr } from '../lib/format'
import { PageHead } from '../components/Shell'
import { TxSteps } from '../components/TxSteps'
import { useSession } from '../api/session'
import { Mascot } from '../components/Mascot'
import { Icon, type IconName } from '../components/Icon'

function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`switch ${on ? 'is-on' : ''}`} onClick={() => onChange(!on)}>
      <span className="switch__knob" />
    </button>
  )
}

const toggleRows: Array<{ key: 'autoTip' | 'renewSubs' | 'dailySummary'; icon: IconName; title: string; body: string }> = [
  { key: 'autoTip', icon: 'tip', title: 'tip what you’d like', body: 'small tips on posts that match what you tip by hand.' },
  { key: 'renewSubs', icon: 'calendar', title: 'renew memberships', body: 'keeps the memberships you pay for running each month.' },
  { key: 'dailySummary', icon: 'sparkle', title: 'summarize my feed', body: 'a short morning read. free, no spending.' },
]
// the agent can only spend once the contracts and payments are live; until then the page says so once, at the top
const READY = AGENT_READY

export function Agent() {
  const { agent, setAgent, toast, plus: localPlus, openSheet } = useStore()
  const { me, guest } = useSession()
  const chat = () => window.dispatchEvent(new Event('wifly:companion'))
  const plus = usePlusStatus(localPlus).active
  const { address: account } = useAnyAccount()
  // 11.8.8: everything onchain is read for the CURRENT payer wallet (the one turn on / cap / deposit pay from), not
  // whichever account wagmi happens to hold. switching payer changes the query key, so it re-reads.
  const payer = usePayerState()
  const address = (payer.address ?? account ?? undefined) as `0x${string}` | undefined
  const chainQ = useAgentOnChain(address)
  const chainAgent = chainQ.data
  const deposited = useInAppBalance(address)
  const send = useSendPlan()
  const [deposit, setDeposit] = useState(500)
  // free agents go up to 500 WIF a day; plus raises it to 5,000 (matches the plus page)
  const maxCap = plus ? AGENT_CAP_PLUS : AGENT_CAP_FREE
  // live: the chain is the source of truth for on/off, cap, spent today and what's left. the local store is only the
  // slider draft (and the whole state in preview). while the read is in flight the page says so instead of "off".
  const reading = LIVE && (chainQ.loading || (!address && !!account))
  const readFailed = LIVE && !reading && chainQ.error
  const synced = useRef('')
  useEffect(() => { // the slider starts at the onchain cap, once per wallet + cap (a drag isn't undone by a re-read)
    if (!chainAgent || !address) return
    const k = `${address.toLowerCase()}:${chainAgent.dailyCap}:${chainAgent.enabled}`
    if (synced.current === k) return
    synced.current = k
    setAgent(a => ({ ...a, enabled: chainAgent.enabled, dailyCap: chainAgent.enabled && chainAgent.dailyCap > 0 ? chainAgent.dailyCap : a.dailyCap, spentToday: chainAgent.spentToday }))
  }, [chainAgent, address, setAgent])
  const cap = Math.min(agent.dailyCap, maxCap) // the draft the slider edits and save sends
  const pct = maxCap ? cap / maxCap : 0
  const [dragging, setDragging] = useState(false)
  const liveCap = LIVE ? (chainAgent?.dailyCap ?? 0) : cap
  const spent = LIVE ? (chainAgent?.spentToday ?? 0) : Math.min(agent.spentToday, cap)
  const remaining = LIVE ? (chainAgent?.remaining ?? 0) : Math.max(0, cap - spent)
  const on = LIVE ? !!chainAgent?.enabled : agent.enabled

  // 11.8.5: one send at a time (a second tap while the wallet is open does nothing), so an error shows once
  const [sending, setSending] = useState(false)
  const busyRef = useRef(false)
  const go = async (plan: Plan, title: string, local: () => void) => {
    if (!LIVE) { local(); toast(title, PREVIEW_NOTE); return }
    if (busyRef.current) return
    busyRef.current = true; setSending(true)
    try {
      const r = await send(plan)
      if (r.sent) { local(); toast(title, 'confirmed onchain'); synced.current = ''; void chainQ.refetch() } else toast(...failArgs(r))
    } finally { busyRef.current = false; setSending(false) }
  }
  const save = () => {
    if (!WIFLY_AGENT_ADDRESS && LIVE) { toast('not sent', 'the agent isn’t ready yet'); return }
    go(plans.setAgent(WIFLY_AGENT_ADDRESS ?? '0x0000000000000000000000000000000000000000', cap), `agent cap set to ${cap} wif a day`, () => setAgent(a => ({ ...a, enabled: true })))
  }
  const turnOff = () => go(plans.revokeAgent(), 'agent turned off', () => setAgent(a => ({ ...a, enabled: false })))

  if (!me) return (
    <>
      <PageHead title="agent" back sub="spends for you, inside a daily cap" />
      <div className="empty empty--card">
        <Mascot size={64} />
        <p className="strong">your agent lives here.</p>
        <p className="muted small">it can tip and renew memberships for you, inside a daily cap you set. sign up to turn it on.</p>
        <button className="btn btn--dark btn--sm" onClick={() => openSheet({ type: 'signin', reason: 'sign up to set up your agent' })}>sign up</button>
      </div>
    </>
  )

  if (guest) return (
    <>
      <PageHead title="agent" back sub="your free ai helper" />
      <div className="empty empty--card" data-testid="agent-guest">
        <Mascot size={64} />
        <p className="strong">link an account to chat with your agent.</p>
        <p className="muted small">link a wallet, x or email first — so chats and caps stay with you.</p>
        <button className="btn btn--dark btn--sm" onClick={() => openSheet({ type: 'link', then: chat })}>link an account</button>
      </div>
    </>
  )

  return (
    <>
      <PageHead title="agent" back sub={READY ? 'spends for you, inside a daily cap' : 'your free ai helper'} />
      <section className="card agent-chat" data-testid="agent-chat-card">
        <span className="agent-chat__face" aria-hidden="true"><Mascot size={44} /></span>
        <div className="agent-chat__copy"><div className="strong">chat with your agent</div><div className="muted small">ask about your feed, tips, names or scheduled buys. free models only{READY ? '' : ', and it never spends'}.</div></div>
        <button className="btn btn--dark btn--sm" data-testid="agent-chat-open" onClick={chat}>open chat</button>
      </section>
      {!READY && <p className="soon-line small muted" role="note">spending is off. your agent chats and suggests, and never sends anything.</p>}
      <section className={`agent-hero ${on || reading ? '' : 'is-off'}${reading ? ' is-reading' : ''}`} data-testid="agent-hero" data-state={reading ? 'reading' : readFailed ? 'error' : on ? 'on' : 'off'} aria-busy={reading || undefined}>
        <div className="agent-hero__top">
          <div>
            {chainAgent?.agent && <span className="tiny muted mono">{shortAddr(chainAgent.agent)}</span>}
            <h2 className="display">{reading ? 'checking your agent…' : readFailed ? 'couldn’t read your agent.' : on ? 'your agent is working.' : READY ? 'your agent is off.' : 'spending is off.'}</h2>
          </div>
          {reading
            ? <span className="power is-on power--reading" data-testid="agent-power" aria-disabled="true"><span className="spin-dot" aria-hidden="true" /> checking…</span>
            : readFailed
            ? <button className="power is-on" onClick={() => void chainQ.refetch()} data-testid="agent-power">try again</button>
            : READY || on
            ? <button className={`power ${on ? 'is-on' : ''}`} onClick={on ? turnOff : save} aria-pressed={on} disabled={sending} data-testid="agent-power">
                <Icon name="power" size={20} /> {sending ? 'waiting…' : on ? 'turn off' : 'turn on'}
              </button>
            : <span className="agent-hero__nap" title="spending is off"><Mascot size={64} mood="calm" title="spending is off" /></span>}
        </div>
        {(READY || on) && <PayingFrom className="agent-payer" />}{/* the one paying-from row on this page: turn on, cap and deposit all pay from it */}
        <div className="capbar" aria-label={reading ? 'reading today’s spend' : `${spent} of ${liveCap} wif spent today`}>
          <motion.span className="capbar__fill" initial={{ width: 0 }} animate={{ width: `${liveCap && !reading ? Math.min(1, spent / liveCap) * 100 : 0}%` }} transition={{ type: 'spring', stiffness: 120, damping: 20 }} />
        </div>
        <div className="capbar__legend small">
          {reading ? <span className="muted" data-testid="agent-reading">reading from the chain…</span> : <>
          <span data-testid="agent-spent"><b><AnimatedNumber value={spent} /></b> spent today</span>
          <span data-testid="agent-left"><b><AnimatedNumber value={Math.round(remaining)} /></b> left of <b><AnimatedNumber value={liveCap} /></b> wif</span></>}
        </div>
        <ul className="agent-promises small">
          <li><Icon name="shield" size={14} /> it can never withdraw your money. only you can.</li>
          <li><Icon name="shield" size={14} /> it only spends what you’ve deposited, and never past the cap.</li>
          <li><Icon name="power" size={14} /> one tap turns it off, everywhere.</li>
        </ul>
      </section>

      <section className="card settings">
        <div className="settings__row settings__row--cap">
          <div><div className="strong">daily cap</div><div className="muted small">resets daily</div></div>
          <span className="strong"><AnimatedNumber value={cap} duration={0.35} /> wif</span>
        </div>
        <div className="range-wrap">
          <motion.output className="range__bubble num" aria-hidden="true" style={{ left: `calc(${pct * 100}% + ${11 - pct * 22}px)` }}
            animate={{ scale: dragging ? 1.12 : 1, y: dragging ? -4 : 0 }} transition={{ type: 'spring', stiffness: 500, damping: 26 }}>
            {cap.toLocaleString()}
          </motion.output>
          <input className="range" type="range" min={0} max={maxCap} step={plus ? 50 : 10} value={cap} disabled={!on}
            style={{ '--pct': `${pct * 100}%` } as React.CSSProperties}
            onPointerDown={() => setDragging(true)} onPointerUp={() => setDragging(false)} onBlur={() => setDragging(false)}
            onChange={e => setAgent(a => ({ ...a, dailyCap: Number(e.target.value) }))} aria-label="daily cap in wif" />
        </div>
        <div className="range__ticks small muted">{[0, 0.25, 0.5, 0.75, 1].map(f => <span key={f}>{(maxCap * f).toLocaleString()}</span>)}</div>
        {!plus && <p className="muted small range__note">up to {AGENT_CAP_FREE.toLocaleString('en-US')} wif a day. with <Link to="/plus">plus</Link>, {AGENT_CAP_PLUS.toLocaleString('en-US')} wif a day.</p>}
        {toggleRows.map(t => (
          <div key={t.key} className="settings__row">
            <span className="settings__icon"><Icon name={t.icon} size={20} /></span>
            <div className="settings__copy"><div className="strong">{t.title}</div><div className="muted small">{t.body}</div></div>
            <Toggle label={t.title} on={on && agent.toggles[t.key]} disabled={!on}
              onChange={v => setAgent(a => ({ ...a, toggles: { ...a.toggles, [t.key]: v } }))} />
          </div>
        ))}
        <div className="settings__save">
          {READY && <TxSteps pull={0} action={`save a ${cap} wif daily cap`} payer={false} />}
          <button className="btn btn--dark btn--block" onClick={save} disabled={!on || !READY}>save cap</button>
        </div>
      </section>

      <section className="card settings">
        <div className="settings__row">
          <span className="settings__icon"><Icon name="wallet" size={20} /></span>
          <div className="settings__copy"><div className="strong">agent balance</div><div className="muted small">the agent spends from here. withdraw any time.</div></div>
          <span className="num strong">{deposited !== undefined ? `${deposited.toLocaleString()} wif` : LIVE ? '…' : '0 wif'}</span>
        </div>
        <div className="deposit">
          <input inputMode="decimal" value={deposit || ''} onChange={e => setDeposit(Number(e.target.value.replace(/[^0-9.]/g, '')) || 0)} aria-label="deposit amount" />
          <button className="btn btn--ghost" disabled={!deposit || !READY} onClick={() => go(plans.deposit(deposit), `deposited ${deposit} wif`, () => {})}>deposit</button>
          <button className="btn btn--ghost" disabled={!READY} onClick={() => go(plans.withdraw(), 'withdrew your whole balance', () => {})}>withdraw all</button>
        </div>
        {READY && <TxSteps pull={deposit} action="add to your balance" payer={false} />}
      </section>

      <section className="card">
        <div className="card__head"><span className="eyebrow">this morning’s summary</span>{!plus && <span className="muted small">smarter with wifly plus</span>}</div>
        {agent.summary.length ? <ul className="summary">{agent.summary.map(s => <li key={s}>{s}</li>)}</ul>
          : <p className="muted small">no summary yet.</p>}
      </section>

      <section className="card">
        <div className="card__head"><span className="eyebrow">activity</span></div>
        {!agent.log.length && <p className="muted small">nothing yet.</p>}
        {agent.log.map(l => (
          <div key={l.id} className="log-row">
            <span className="muted small num">{l.time}</span><span className="small">{l.text}</span>
            {l.amount ? <span className="num small strong">−{l.amount}</span> : <span />}
          </div>
        ))}
      </section>
    </>
  )
}
