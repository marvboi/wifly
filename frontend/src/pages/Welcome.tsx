/** First-run onboarding: you (name + a free @username), optional "make it yours onchain" (.wif), follows, optional links. The Wifly companion hosts every step. */
import { FEED_PATH } from '../lib/hosts'
import { at } from '../lib/format'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useQuery } from '@tanstack/react-query'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { api, uploadAvatar, type ApiUser } from '../api/client'
import { useSession } from '../api/session'
import { privyEnabled, usePrivyState } from '../auth/privyBridge'
import { useConnect } from 'wagmi'
import { HandleField, useHandleCheck } from '../components/HandleField'
import { Avatar, Wordmark } from '../components/Bits'
import { AvatarPicker } from '../components/AvatarPicker'
import { Icon } from '../components/Icon'
import { Mascot, type LookPoint, type Mood } from '../components/Mascot'
import { NAME_MIN } from '../config'
import { useStore } from '../state/store'
import { ClaimBox, ClaimSoon, NAMES_LIVE, type ClaimState } from './Names'

type Onb = { suggestedHandle: string | null; x: { username: string } | null; wallet: string | null; email: boolean; users: ApiUser[]; tags: string[] }
const STEPS = ['you', 'wif', 'follow', 'link'] as const
const TITLES = ['about you', 'onchain name', 'your feed', 'links']

export function Welcome() {
  const { me, ready, setMe, refresh } = useSession()
  const { toast } = useStore()
  const nav = useNavigate()
  const [sp] = useSearchParams()
  const privy = usePrivyState()
  const onb = useQuery({ queryKey: ['onboarding'], queryFn: () => api<Onb>('/onboarding'), enabled: !!me })
  const want = sp.get('step') === 'username' ? 'you' : sp.get('step') ?? 'you'
  const [step, setStep] = useState(Math.max(0, STEPS.indexOf(want as typeof STEPS[number])))
  const [handle, setHandle] = useState(sp.get('h') ?? '')
  const [name, setName] = useState(sp.get('name') ?? '')
  const [avatar, setAvatar] = useState<string | null>(null)
  const [follow, setFollow] = useState<Set<string>>(new Set())
  const [tags, setTags] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [wifState, setWifState] = useState<{ s: ClaimState; label: string }>({ s: 'idle', label: '' })
  const [claimed, setClaimed] = useState<string | null>(null)
  const [hop, setHop] = useState(0)
  const { check, checking } = useHandleCheck(handle)
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches)
  useEffect(() => { const m = window.matchMedia('(max-width: 760px)'); const f = () => setNarrow(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f) }, [])

  // No @name is filled in for you: an X sign-in gets its X handle offered as a tap-to-use suggestion, that's all.
  const suggestion = (onb.data?.x?.username ?? onb.data?.suggestedHandle ?? '').toLowerCase()
  // an older account that only ever had an auto-made @name: pick one, then straight back to the feed
  const renaming = !!me?.renaming
  // Prefill once from a real name (an X display name). The server's placeholder ("new on wifly") and wallet
  // addresses never prefill, and clearing the field never brings them back.
  const prefilled = useRef(false)
  useEffect(() => {
    if (prefilled.current || !me) return
    prefilled.current = true
    if (!sp.get('name') && !name && me.name && !/^(0x|~)/i.test(me.name) && !isPlaceholderName(me.name) && me.name !== me.handle) setName(me.name)
  }, [me, name, sp])
  useEffect(() => { if (onb.data && !follow.size) setFollow(new Set(onb.data.users.slice(0, 3).map(u => u.handle))) }, [onb.data, follow.size])
  // Reactions: a happy hop when the @name (or .wif) comes back available, a small "hmm" shake when it's taken.
  const [shake, setShake] = useState(0)
  const settledBad = step === 0 && !!handle && !checking && !!check && !check.available && !(check.reason === 'invalid' && handle.length < NAME_MIN)
  useEffect(() => { setHop(h => h + 1) }, [step, check?.available, wifState.s === 'available', claimed])
  useEffect(() => { if (settledBad) setShake(n => n + 1) }, [settledBad, check?.handle])
  // While a field is focused the mascot watches the caret; leaving it hands the eyes back to the cursor and idle glances.
  const lookAt = useRef<LookPoint>(null)
  const watch = (el: HTMLInputElement) => { lookAt.current = caretPoint(el) }
  const watchProps = {
    onFocus: (e: { currentTarget: HTMLInputElement }) => watch(e.currentTarget),
    onBlur: () => { lookAt.current = null },
  }
  const watchInput = (e: { currentTarget: HTMLInputElement }) => { if (document.activeElement === e.currentTarget) watch(e.currentTarget) }

  // Linking (step 4): through the session, so a guest or wallet account can add X or a wallet too.
  const { linkX, linkWallet } = useSession()
  const { connectAsync, connectors } = useConnect()
  const linkState: 'ready' | 'unavailable' = privyEnabled ? 'ready' : 'unavailable'
  const [linking, setLinking] = useState<'twitter' | 'wallet' | null>(null)
  const doLink = async (kind: 'twitter' | 'wallet') => {
    if (linking) return
    setLinking(kind)
    try {
      if (kind === 'twitter') { if (!(await linkX())) return }
      else {
        const c = connectors[0]; if (!c) throw new Error('no wallet found in this browser')
        const addr = (await connectAsync({ connector: c })).accounts[0]
        await linkWallet(addr)
      }
      await onb.refetch()
      toast(kind === 'twitter' ? 'x linked' : 'wallet linked', undefined, 'ok')
    } catch (e) {
      toast((e as Error).message || 'couldn’t link right now. try again in a moment', undefined, 'warn')
    } finally { setLinking(null) }
  }
  const walletAddr = privy.embeddedWallet ?? me?.address ?? null

  // The companion reacts to every choice.
  const host = useMemo((): { mood: Mood; line: string } => {
    const first = name.trim().split(/\s+/)[0]
    if (step === 0) {
      if (!handle) return { mood: 'calm', line: first ? `nice to meet you, ${first}. now pick a username.` : 'hi, i’m your wifly companion. what should people call you?' }
      if (checking) return { mood: 'think', line: `checking @${handle}…` }
      if (check?.available) return { mood: 'happy', line: check.reason === 'x-reserved' || onb.data?.x?.username === handle ? `${at(handle)}, straight from X. good pick.` : `${at(handle)} is free. good pick${first ? `, ${first}` : ''}.` }
      if (check?.reason === 'reserved') return { mood: 'oops', line: `${at(handle)} isn’t available. try a twist on it?` }
      if (check?.reason === 'wif-owned') return { mood: 'oops', line: `someone owns ${handle}.wif onchain, and a .wif owner gets the matching @. try a twist on it?` }
      if (check?.reason === 'invalid') return { mood: handle.length < NAME_MIN ? 'calm' : 'oops', line: check.message ?? '3–20 characters: a–z, 0–9 and _' }
      return { mood: 'oops', line: `${at(handle)} is taken. one of the suggestions?` }
    }
    if (step === 1) {
      if (!NAMES_LIVE) return { mood: 'calm', line: `@${handle} is yours. .wif names open soon.` }
      if (claimed) return { mood: 'wow', line: `${claimed}.wif is yours and it’s your main name. people can send WIF straight to it.` }
      const l = wifState.label
      if (wifState.s === 'available') return { mood: 'wow', line: `${l}.wif is open. want it too? or maybe later, it’s up to you.` }
      if (wifState.s === 'taken') return { mood: 'calm', line: `someone already holds ${l}.wif. your @${handle} stays yours. a close one, or maybe later?` }
      if (wifState.s === 'reserved') return { mood: 'oops', line: `${l}.wif isn’t available.` }
      if (wifState.s === 'yours') return { mood: 'happy', line: `you already hold ${l}.wif.` }
      return { mood: 'think', line: `your @${handle} is free already. ${handle}.wif is the onchain version. you can skip this.` }
    }
    if (step === 2) return follow.size ? { mood: 'happy', line: `following ${follow.size}. your feed’s warming up.` } : { mood: 'calm', line: 'follow a few people so your feed isn’t empty.' }
    return linkState === 'ready' ? { mood: 'calm', line: 'all optional. link x to show your handle on your profile.' } : { mood: 'calm', line: 'all optional. you can link accounts later in settings.' }
  }, [step, handle, check, checking, name, wifState, claimed, follow.size, onb.data, linkState])

  if (ready && !me) return <Navigate to="/" replace />
  if (me?.onboarded && !me.needsHandle && !sp.get('step') && !sp.get('h')) return <Navigate to={FEED_PATH} replace />

  const okHandle = !!check?.available
  const next = () => setStep(s => Math.min(STEPS.length - 1, s + 1))
  const back = () => setStep(s => Math.max(0, s - 1))
  const finish = async () => {
    setBusy(true)
    try {
      const r = await api<{ me?: ApiUser }>('/onboarding', { method: 'POST', json: { handle, name: name.trim() || undefined, avatar, follow: [...follow], tags: [...tags] } })
      if (r.me) setMe({ ...r.me, onboarded: true })
      refresh()
      nav(FEED_PATH, { replace: true })
    } catch (e) { toast('couldn’t save', (e as Error).message); setStep(0) } finally { setBusy(false) }
  }
  const saveName = async () => {
    setBusy(true)
    try {
      const r = await api<{ me: ApiUser & { onboarded?: boolean } }>('/me', { method: 'PATCH', json: { handle, ...(name.trim() ? { name: name.trim() } : {}), ...(avatar ? { avatar } : {}) } })
      setMe(r.me); refresh(); toast(`you’re @${r.me.handle} now`, undefined, 'ok')
      nav(FEED_PATH, { replace: true })
    } catch (e) { toast('couldn’t save', (e as Error).message) } finally { setBusy(false) }
  }
  const pick = async (f: File) => {
    try { setAvatar(await uploadAvatar(f)) } catch (e) { toast('couldn’t add that photo', (e as Error).message) }
  }
  const toggle = (set: Set<string>, v: string, put: (s: Set<string>) => void) => { const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); put(n) }

  return (
    <div className="welcome">
      <header className="welcome__top">
        <Wordmark to="/" size="sm" />
        {!renaming && <ol className="welcome__dots" aria-label={`step ${step + 1} of ${STEPS.length}`}>{STEPS.map((s, i) => <li key={s} className={i < step ? 'is-done' : i === step ? 'is-current' : ''} aria-current={i === step ? 'step' : undefined} />)}</ol>}
      </header>
      <div className="welcome__stage">
        <div className="welcome__host">
          <Mascot size={narrow ? 64 : 128} mood={host.mood} pulse={hop} shake={shake} lookAt={lookAt} />
          <p className="sr-only" aria-live="polite">{host.line}</p>
        </div>
        <AnimatePresence mode="wait">
          <motion.section key={step} className="welcome__card" aria-label={TITLES[step]} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
            {step === 0 && <>
              <h1>{renaming ? 'pick your @name' : 'who are you?'}</h1>
              {renaming && <p className="welcome__sub">your account got a made-up @name when it started. choose the one you want. everything else stays.</p>}
              <div className="welcome__profile">
                <AvatarPicker size={72} src={avatar} name={name} handle={handle} onPick={pick} onRemove={() => setAvatar(null)} onError={m => toast('couldn’t add that photo', m)} />
                <label className="field"><span className="field__label">display name</span>
                  <input className="field__input" value={name} maxLength={50} placeholder="your name" autoComplete="name" {...watchProps}
                    onChange={e => { setName(e.target.value); watchInput(e) }} onKeyUp={watchInput} onSelect={watchInput} />
                </label>
              </div>
              <div className="welcome__handle">
                <HandleField quiet value={handle} onChange={v => { setHandle(v); requestAnimationFrame(() => { const el = document.activeElement; if (el instanceof HTMLInputElement) watchInput({ currentTarget: el }) }) }} autoFocus {...watchProps} />
                <p className="welcome__sub">free, and yours. make it onchain later.</p>
                {suggestion && handle !== suggestion && <p className="welcome__sub">{onb.data?.x ? 'from your x: ' : 'idea: '}<button className="linkbtn" onClick={() => setHandle(suggestion)}>@{suggestion}</button></p>}
              </div>
              <button className="btn btn--dark btn--lg btn--block" disabled={!okHandle || busy} onClick={renaming ? saveName : next}>{renaming ? (busy ? 'saving…' : 'save my @name') : 'continue'}</button>
            </>}
            {step === 1 && (NAMES_LIVE ? <>
              <h1>want {handle}.wif too?</h1>
              <p className="welcome__sub">the onchain version of @{handle}. optional.</p>
              <ClaimBox compact andPrimary initial={handle} onState={(s, label) => setWifState({ s, label })} onClaimed={l => setClaimed(l)} />
              <button className={`btn btn--lg btn--block ${claimed ? 'btn--dark' : 'btn--ghost'}`} onClick={next}>{claimed ? 'continue' : 'skip, you can claim one later.'}</button>
              <div className="welcome__foot"><button className="linkbtn" onClick={back}>back</button></div>
            </> : <>
              <h1>your .wif name</h1>
              <ClaimSoon handle={handle} />
              <button className="btn btn--dark btn--lg btn--block" onClick={next}>continue</button>
              <div className="welcome__foot"><button className="linkbtn" onClick={back}>back</button></div>
            </>)}
            {step === 2 && <>
              <h1>follow a few people</h1>
              <p className="welcome__sub">your feed starts with them.</p>
              <ul className="welcome__people">
                {(onb.data?.users ?? []).map(u => (
                  <li key={u.handle}>
                    <Avatar handle={u.handle} size={40} />
                    <div className="welcome__who"><b>{u.name}</b><span className="muted small">{at(u.handle)}</span></div>
                    <button className={`btn btn--sm ${follow.has(u.handle) ? 'btn--ghost' : 'btn--dark'}`} aria-pressed={follow.has(u.handle)} onClick={() => toggle(follow, u.handle, setFollow)}>{follow.has(u.handle) ? 'following' : 'follow'}</button>
                  </li>
                ))}
              </ul>
              {!!onb.data?.tags.length && <div className="welcome__tags">{onb.data.tags.map(t => <button key={t} className={`chip ${tags.has(t) ? 'is-on' : ''}`} aria-pressed={tags.has(t)} onClick={() => toggle(tags, t, setTags)}>#{t}</button>)}</div>}
              <button className="btn btn--dark btn--lg btn--block" onClick={next}>continue</button>
              <div className="welcome__foot"><button className="linkbtn" onClick={back}>back</button></div>
            </>}
            {step === 3 && <>
              <h1>link your accounts</h1>
              <p className="welcome__sub">optional. you can do this later in settings.</p>
              <div className="welcome__links">
                <LinkRow icon="x" title="link x" done={me?.links?.x ?? privy.xUsername ?? onb.data?.x?.username ?? null} status={linkState} busy={linking === 'twitter'} onClick={() => doLink('twitter')} />
                <LinkRow icon="wallet" title="link a wallet" done={(() => { const w = me?.links?.wallets?.[0] ?? privy.linkedWallet; return w ? `${w.slice(0, 6)}…${w.slice(-4)}` : null })()} status="ready" busy={linking === 'wallet'} onClick={() => doLink('wallet')} />
                {walletAddr && <WalletRow address={walletAddr} />}
              </div>
              <button className="btn btn--dark btn--lg btn--block" disabled={busy} onClick={finish}>{busy ? 'saving…' : 'go to my feed'}</button>
              <div className="welcome__foot"><button className="linkbtn" onClick={back}>back</button><button className="linkbtn" disabled={busy} onClick={finish}>skip for now</button></div>
            </>}
          </motion.section>
        </AnimatePresence>
      </div>
    </div>
  )
}

/** Screen point of the caret inside a text input (measured with the input's own font), clamped to the field. */
let measurer: CanvasRenderingContext2D | null = null
function caretPoint(el: HTMLInputElement): LookPoint {
  const r = el.getBoundingClientRect(), cs = getComputedStyle(el)
  measurer ??= document.createElement('canvas').getContext('2d')
  let w = 0
  if (measurer) { measurer.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; w = measurer.measureText(el.value.slice(0, el.selectionStart ?? el.value.length)).width }
  const x = Math.min(r.right - 8, r.left + parseFloat(cs.paddingLeft || '0') + w - el.scrollLeft)
  return { x, y: r.top + r.height / 2 }
}

function LinkRow({ icon, title, done, status, busy, onClick }: { icon: 'x' | 'wallet'; title: string; done: string | null; status: 'checking' | 'ready' | 'no-session' | 'unavailable'; busy: boolean; onClick: () => void }) {
  const can = status === 'ready' && !done && !busy
  return (
    <button className={`linkrow ${done ? 'is-done' : ''}`} disabled={!can} onClick={onClick}>
      <span className="linkrow__icon"><Icon name={icon} size={18} /></span>
      <span className="linkrow__title">{title}</span>
      <span className="linkrow__state">{done ? <><Icon name="check" size={14} /> {done}</> : busy ? 'linking…' : status === 'checking' ? 'checking…' : status === 'ready' ? <>link <Icon name="chevron" size={14} /></> : 'soon'}</span>
    </button>
  )
}

function WalletRow({ address }: { address: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => { try { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1600) } catch { /* clipboard blocked */ } }
  return (
    <div className="walletrow">
      <span className="walletrow__icon"><Icon name="wallet" size={16} /></span>
      <div className="walletrow__copy"><span className="small strong">your wifly wallet</span><span className="tiny muted mono">{address.slice(0, 6)}…{address.slice(-4)} · no seed phrase</span></div>
      <button className="btn btn--ghost btn--sm" onClick={copy} aria-label="copy wallet address"><Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? 'copied' : 'copy'}</button>
    </div>
  )
}

/** Names the server gave new accounts before they picked one (older accounts carry "new on wifly"). */
const isPlaceholderName = (n: string) => /^new on wifly$/i.test(n.trim())
