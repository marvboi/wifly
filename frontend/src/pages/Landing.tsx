import { motion, useReducedMotion } from 'motion/react'
import { Link } from 'react-router-dom'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { AppLink } from '../components/AppLink'
import { Mascot, type LookPoint, type Mood } from '../components/Mascot'
import { Odometer } from '../components/Motion'
import { PlusMark } from '../components/BrandSlots'
import { Token, Wordmark } from '../components/Bits'
import { Icon } from '../components/Icon'
import { ThemeToggle } from '../components/ThemeToggle'
import { nameArtUrl } from '../components/WifName'
import {
  AGENT_READY, BADGE_LEVELS, CLAIM_SPLIT, FEE_BPS, FEE_SPLIT, LINKS, NAME_CLAIM_FEE, NAME_FEE_BPS, NAME_SHORT_CLAIM_FEE,
  PLUS_PRICE_FALLBACK, TOPSPOT_HOLDER_SHARE, TOPSPOT_MIN_RAISE, VOTE_PRICE,
} from '../config'
import { useBurnStats } from '../api/hooks'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useThemedPage } from '../lib/theme'
import '../styles/landing.css'

const FEE = `${FEE_BPS / 100}%`
const KEEP = `${100 - FEE_BPS / 100}%`
const SALE_FEE = `${NAME_FEE_BPS / 100}%`
const pct = (x: number) => `${Math.round(x * 100)}%`
const ease = [0.22, 1, 0.36, 1] as const
const TIPS = [100, 500, 1000]
const COIN = '/brand/wif-coin-96.webp'
/** The landing's one real post (GET /api/landing/featured: FEATURED_POST_ID or the admin setting, default 88stVCX0GF). Null while loading or on any failure: then the card is simply not shown. */
type Featured = { id: string; text: string; likes: number; tipped: number; author: { handle: string; name: string; avatar: string | null } }
function useFeatured(): Featured | null {
  const q = useQuery({ queryKey: ['landing', 'featured'], queryFn: () => api<{ featured: Featured }>('/landing/featured').then(r => r.featured), retry: 1, staleTime: 30_000, refetchInterval: 60_000 })
  const f = q.data
  return f && f.author?.handle && f.text ? f : null
}
/** A real profile photo; falls back to the first letter if the image can't load. Never a grey placeholder. */
function Pfp({ user, size }: { user: Featured['author']; size: number }) {
  const [bad, setBad] = useState(false)
  return user.avatar && !bad
    ? <img className="lp-pfp" src={user.avatar} alt="" width={size} height={size} decoding="async" onError={() => setBad(true)} />
    : <span className="lp-pfp lp-pfp--letter" style={{ width: size, height: size }} aria-hidden="true">{(user.name || user.handle).slice(0, 1).toLowerCase()}</span>
}
const compact = (n: number) => n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString()

const isReduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Fades and lifts a block once as it scrolls into view. Transform + opacity only, so nothing around it moves. */
function Reveal({ children, className, delay = 0, style }: { children: ReactNode; className?: string; delay?: number; style?: CSSProperties }) {
  return (
    <motion.div className={className} style={style} initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -60px 0px' }} transition={{ duration: 0.7, ease, delay }}>
      {children}
    </motion.div>
  )
}

/** Official $WIF coins falling inside their container. Remounts on each `run`. */
function Coins({ run, count = 12 }: { run: number; count?: number }) {
  const coins = useMemo(() => Array.from({ length: count }, (_, i) => ({
    x: 4 + ((i * 41 + run * 17) % 90), size: 20 + ((i * 13) % 20), delay: (i % 6) * 0.08, rot: ((i * 53) % 140) - 70, dur: 1.4 + ((i * 7) % 5) / 10,
  })), [count, run])
  if (!run) return null
  return (
    <div className="lp-coins" aria-hidden="true" key={run}>
      {coins.map((c, i) => (
        <motion.img key={i} src={COIN} alt="" width={c.size} height={c.size} className="lp-coins__coin" style={{ left: `${c.x}%` }}
          initial={{ y: -60, opacity: 0, rotate: 0 }} animate={{ y: 560, opacity: [0, 1, 1, 0], rotate: c.rot }}
          transition={{ duration: c.dur, delay: c.delay, ease: [0.3, 0, 0.7, 1] }} />
      ))}
    </div>
  )
}

/** True while the element is on screen and the tab is visible. */
function useOnScreen<T extends Element>(threshold = 0.25) {
  const ref = useRef<T>(null)
  const [on, setOn] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    let seen = false
    const sync = () => setOn(seen && !document.hidden)
    const io = new IntersectionObserver(([e]) => { seen = e.isIntersecting; sync() }, { threshold })
    io.observe(el)
    document.addEventListener('visibilitychange', sync)
    return () => { io.disconnect(); document.removeEventListener('visibilitychange', sync) }
  }, [threshold])
  return [ref, on] as const
}

/** A soft light that follows the pointer over a card (CSS vars, no re-render). */
const spot = (e: RPointerEvent<HTMLElement>) => {
  const r = e.currentTarget.getBoundingClientRect()
  e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`)
  e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`)
}

/** Point on a quadratic curve. */
const qb = (a: number, c: number, b: number, t: number) => (1 - t) * (1 - t) * a + 2 * (1 - t) * t * c + t * t * b

/**
 * The signature moment: a tip leaves the drop and flies into the wallet as $WIF coins. The mascot watches the lead
 * coin, hops when it lands, and leans as you scroll. Plays once when first seen; the tip button replays it.
 * The card is a real post (live likes and tips); the amounts are the app's tip presets and the wallet is a demo, labelled as such.
 * No post (loading or the fetch failed): no card at all, never stand-in content.
 * Reduced motion: no flight, no scroll lean, the wallet just shows the tip as received.
 */
function TipStage({ post }: { post: Featured | null }) {
  const reduced = useReducedMotion()
  const [ref, on] = useOnScreen<HTMLDivElement>(0.5)
  const btn = useRef<HTMLButtonElement>(null)
  const wallet = useRef<HTMLDivElement>(null)
  const lean = useRef<HTMLDivElement>(null)
  const look = useRef<LookPoint>(null)
  const busy = useRef(false)
  const played = useRef(false)
  const [mood, setMood] = useState<Mood>('calm')
  const [hop, setHop] = useState(0)
  const [got, setGot] = useState(0)
  const [pick, setPick] = useState(1)

  // The mascot leans and drifts with the scroll, and says "wow" when you scroll fast.
  useEffect(() => {
    if (reduced) return
    let raf = 0, last = scrollY, lastT = performance.now(), wowUntil = 0
    const tick = () => {
      raf = 0
      const y = scrollY, now = performance.now()
      const v = Math.abs(y - last) / Math.max(1, now - lastT)
      last = y; lastT = now
      const p = Math.min(1, y / 700)
      if (lean.current) lean.current.style.transform = `translate3d(0, ${(p * 36).toFixed(1)}px, 0) rotate(${(-6 + p * 18).toFixed(2)}deg)`
      if (v > 2.2 && !busy.current) { wowUntil = now + 700; setMood('wow') }
      else if (wowUntil && now > wowUntil && !busy.current) { wowUntil = 0; setMood('calm') }
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(tick) }
    addEventListener('scroll', onScroll, { passive: true })
    return () => { removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf) }
  }, [reduced])

  const send = () => {
    const stage = ref.current, a = btn.current, b = wallet.current
    if (busy.current || !stage || !a || !b) return
    if (isReduced()) { setGot(g => g + 1); return }
    busy.current = true
    setMood('wow')
    const s = stage.getBoundingClientRect(), ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
    const x0 = ra.left + ra.width / 2 - s.left, y0 = ra.top + ra.height / 2 - s.top
    const x1 = rb.left + rb.width * 0.5 - s.left, y1 = rb.top + rb.height * 0.42 - s.top
    const n = [5, 7, 10][pick]
    let landed = 0, raf = 0
    for (let i = 0; i < n; i++) {
      const size = 26 + ((i * 7) % 3) * 4
      const img = document.createElement('img')
      img.src = COIN; img.alt = ''; img.className = 'lp-fly'; img.width = size; img.height = size
      img.style.left = `${x0 - size / 2}px`; img.style.top = `${y0 - size / 2}px`
      stage.appendChild(img)
      const cx = (x0 + x1) / 2 + ((i % 3) - 1) * 26, cy = Math.min(y0, y1) - 120 - (i % 4) * 16
      const spin = (i % 2 ? 1 : -1) * (300 + i * 20)
      const frames = Array.from({ length: 13 }, (_, k) => {
        const t = k / 12
        return {
          transform: `translate(${(qb(x0, cx, x1, t) - x0).toFixed(1)}px, ${(qb(y0, cy, y1, t) - y0).toFixed(1)}px) rotate(${(spin * t).toFixed(0)}deg) scale(${(1 - 0.35 * t).toFixed(3)})`,
          opacity: k === 0 ? 0 : k === 12 ? 0 : 1,
        }
      })
      const anim = img.animate(frames, { duration: 920 + i * 30, delay: i * 75, easing: 'cubic-bezier(.45,.05,.3,1)', fill: 'both' })
      if (i === 0) {
        const follow = () => {
          const r = img.getBoundingClientRect()
          look.current = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
          raf = requestAnimationFrame(follow)
        }
        raf = requestAnimationFrame(follow)
      }
      anim.finished.catch(() => {}).then(() => {
        img.remove()
        landed++
        b.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.035)' }, { transform: 'scale(1)' }], { duration: 240, easing: 'ease-out' })
        if (landed === 1) { cancelAnimationFrame(raf); look.current = null }
        if (landed === n) {
          busy.current = false
          setGot(g => g + 1); setMood('happy'); setHop(h => h + 1)
          window.setTimeout(() => { if (!busy.current) setMood('calm') }, 2200)
        }
      })
    }
  }

  // Play once when the stage is first well in view.
  useEffect(() => {
    if (!on || !post || played.current) return
    played.current = true
    if (reduced) { setGot(1); return }
    const t = window.setTimeout(send, 900)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, reduced, post])

  return (
    <div className="lp-stage" ref={ref}>
      <div className="lp-stage__grid" aria-hidden="true" />
      <div className="lp-stage__mascot" ref={lean}>
        <Mascot size={128} title="wifly" mood={mood} pulse={hop} lookAt={look} />
      </div>

      {post && <motion.div className="lp-dropcard" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease }} data-testid="featured-post">
        <AppLink to={`/post/${post.id}`} className="lp-dropcard__post">
          <span className="lp-dropcard__head">
            <Pfp user={post.author} size={36} />
            <span className="lp-dropcard__who"><b>{post.author.name || post.author.handle}</b><span>@{post.author.handle}</span></span>
          </span>
          <span className="lp-dropcard__text">{post.text}</span>
          <span className="lp-dropcard__stats">
            <span><Icon name="heart" size={13} /> <b className="num">{compact(post.likes)}</b> {post.likes === 1 ? 'like' : 'likes'}</span>
            <span><Token size={13} /> <b className="num">{compact(post.tipped)}</b> WIF tipped</span>
          </span>
        </AppLink>
        <div className="lp-dropcard__tips" role="group" aria-label="tip amount">
          {TIPS.map((v, i) => (
            <button key={v} type="button" className={`lp-chip${pick === i ? ' is-on' : ''}`} aria-pressed={pick === i} onClick={() => setPick(i)}>
              <Token size={14} /> {v.toLocaleString()}
            </button>
          ))}
        </div>
        <button ref={btn} type="button" className="lp-tipbtn" onClick={send}
          onPointerEnter={() => { if (!busy.current) setMood('wow') }} onPointerLeave={() => { if (!busy.current) setMood('calm') }}>
          <Icon name="tip" size={16} /> send a tip
        </button>
      </motion.div>}

      <div className={`lp-wallet${got ? ' is-got' : ''}`} ref={wallet}>
        <span className="lp-wallet__icon"><Icon name="wallet" size={22} /></span>
        <span className="lp-wallet__label">{post ? `@${post.author.handle}'s wallet` : 'their wallet'}</span>
        <span className="lp-wallet__state" aria-live="polite">
          {got ? <><Icon name="check" size={14} /> {TIPS[pick].toLocaleString()} WIF would land here</> : 'tips land here'}
        </span>
        <div className="lp-wallet__split" aria-hidden="true"><span style={{ flex: 100 - FEE_BPS / 100 }} /><span style={{ flex: FEE_BPS / 100 }} /></div>
        <span className="lp-wallet__row"><span>they keep <b>{KEEP}</b></span><span>fee <b>{FEE}</b></span></span>
      </div>
    </div>
  )
}

/** The fee, living: one stream splits into the weekly community pot and the burn. Widths follow FEE_SPLIT. */
function FeeFlow() {
  const wPot = 4 + FEE_SPLIT.pot * 0.16, wBurn = 4 + FEE_SPLIT.burn * 0.16
  return (
    <svg className="lp-flow" viewBox="0 0 560 300" role="img" aria-label={`every fee: ${FEE_SPLIT.pot}% to the weekly community pot, ${FEE_SPLIT.burn}% burned`}>
      <defs>
        <clipPath id="lp-jar"><rect x="414" y="44" width="92" height="96" rx="20" /></clipPath>
      </defs>
      <path className="lp-flow__track" d="M104 150 C 230 150, 260 92, 400 92" strokeWidth={wPot} />
      <path className="lp-flow__track" d="M104 150 C 230 150, 260 222, 400 222" strokeWidth={wBurn} />
      <path className="lp-flow__run lp-flow__run--pot" d="M104 150 C 230 150, 260 92, 400 92" strokeWidth={wPot} />
      <path className="lp-flow__run lp-flow__run--burn" d="M104 150 C 230 150, 260 222, 400 222" strokeWidth={wBurn} />
      <circle cx="66" cy="150" r="40" className="lp-flow__src" />
      <image href={COIN} x="40" y="124" width="52" height="52" />
      <text x="66" y="214" textAnchor="middle" className="lp-flow__t">fee {FEE}</text>
      <rect x="414" y="44" width="92" height="96" rx="20" className="lp-flow__jar" />
      <g clipPath="url(#lp-jar)">
        <path className="lp-flow__wave" d="M380 96 q 15 -8 30 0 t 30 0 t 30 0 t 30 0 t 30 0 t 30 0 t 30 0 V 160 H 380 Z" />
      </g>
      <text x="460" y="166" textAnchor="middle" className="lp-flow__t">{FEE_SPLIT.pot}% weekly pot</text>
      <g transform="translate(436 196)" className="lp-flow__flame"><path d="M24 50c-7 0-12-5-12-11.2 0-7.8 6.8-10.8 7.8-18.8 5.2 3 7.2 7.6 6.8 11.2 2-1 3.2-3.2 3.6-5.6 3.6 3.2 5.6 8 5.6 13.2C35.8 45 31 50 24 50Z" /></g>
      <text x="460" y="272" textAnchor="middle" className="lp-flow__t">{FEE_SPLIT.burn}% burned</text>
    </svg>
  )
}

const CAPTION = 'my full $WIF chart notes for the week are in this drop. levels, the world is flat thesis, what i\'m watching next. unlock once for 50 WIF and it stays yours.'
/** Chapter 01: a composer typing a real-sounding paid drop. Author is the same live featured user; without one it reads as "you". */
function ComposeMock({ author }: { author: Featured['author'] | null }) {
  const reduced = useReducedMotion()
  const [ref, on] = useOnScreen<HTMLDivElement>(0.4)
  const [n, setN] = useState(0)
  useEffect(() => {
    if (reduced) { setN(CAPTION.length); return }
    if (!on || n >= CAPTION.length) return
    const ch = CAPTION[n]
    const t = window.setTimeout(() => setN(x => x + 1), ch === ' ' ? 45 : /[.,]/.test(ch) ? 260 : 28 + ((n * 7) % 30))
    return () => window.clearTimeout(t)
  }, [on, n, reduced])
  return (
    <div className="lp-art lp-compose" ref={ref} aria-label={`a paid drop: ${CAPTION}`} role="img">
      <div className="lp-compose__top">
        {author ? <Pfp user={author} size={32} /> : <span className="lp-pfp lp-pfp--you" aria-hidden="true"><Mascot size={30} /></span>}
        <span className="lp-compose__who"><b>{author ? author.name || author.handle : 'you'}</b><span>{author ? `@${author.handle}` : 'new drop'}</span></span>
      </div>
      <div className="lp-compose__body">
        <p className="lp-compose__text"><span>{CAPTION.slice(0, n)}</span><span className="lp-compose__caret" aria-hidden="true" /><span className="lp-compose__ghost" aria-hidden="true">{CAPTION.slice(n)}</span></p>
      </div>
      <div className="lp-compose__media"><img src="/brand/wif-asset-256.png" alt="" width={72} height={72} loading="lazy" /></div>
      <div className="lp-compose__row">
        <span className="lp-switch is-on"><i /></span><span>paid drop</span>
        <span className="lp-compose__price"><Icon name="lock" size={13} /> <Token size={13} /> <b className="num">50</b> WIF</span>
        <span className="lp-compose__post">post</span>
      </div>
    </div>
  )
}

function NameCards() {
  const tilt = (e: RPointerEvent<HTMLDivElement>) => {
    if (isReduced()) return
    const r = e.currentTarget.getBoundingClientRect()
    e.currentTarget.style.setProperty('--rx', `${(((e.clientY - r.top) / r.height) - 0.5) * -10}deg`)
    e.currentTarget.style.setProperty('--ry', `${(((e.clientX - r.left) / r.width) - 0.5) * 12}deg`)
  }
  const reset = (e: RPointerEvent<HTMLDivElement>) => { e.currentTarget.style.removeProperty('--rx'); e.currentTarget.style.removeProperty('--ry') }
  return (
    <div className="lp-cards" onPointerMove={tilt} onPointerLeave={reset}>
      <figure className="lp-ncard lp-ncard--back"><img src={nameArtUrl('yourname', 2)} alt="yourname.wif card, green" width={1000} height={1000} loading="lazy" decoding="async" /></figure>
      <figure className="lp-ncard lp-ncard--front"><img src={nameArtUrl('yourname', 1)} alt="yourname.wif card, white" width={1000} height={1000} loading="lazy" decoding="async" /></figure>
    </div>
  )
}

function Chapter({ n, title, children, art, id }: { n: string; title: string; children: ReactNode; art: ReactNode; id?: string }) {
  return (
    <article className="lp-ch" id={id}>
      <Reveal className="lp-ch__text">
        <span className="lp-ch__n">{n}</span>
        <h3 className="lp-ch__title">{title}</h3>
        {children}
      </Reveal>
      <Reveal className="lp-ch__art" delay={0.08}>{art}</Reveal>
    </article>
  )
}

/** Example tier names and prices a creator might set (any three, any price). */
const TIER_EXAMPLES = [{ name: 'supporter', price: 100 }, { name: 'inner circle', price: 500 }, { name: 'front row', price: 1000 }]

const BENTO: { icon: Parameters<typeof Icon>[0]['name']; title: string; body: string; cls?: string }[] = [
  { icon: 'pot', title: 'weekly community pot', body: `vote for the creators you like, ${VOTE_PRICE} WIF a vote. each week the pot goes to the creator voted up most and to the people who voted for them.`, cls: 'lp-b--wide' },
  { icon: 'pin', title: 'top spot', body: `pin a drop above every feed. outbid by ${pct(TOPSPOT_MIN_RAISE)} or more and the last holder gets ${pct(TOPSPOT_HOLDER_SHARE)} of your offer.` },
  { icon: 'lock', title: 'paid drops', body: 'set a price. a drop unlocks once and stays unlocked.' },
  { icon: 'link', title: 'pay links', body: 'one link anyone can pay in $WIF.' },
  { icon: 'flame', title: 'burn badges', body: 'burn WIF for badges on your profile. all of it goes to the burn address.', cls: 'lp-b--badges' },
  { icon: 'repost', title: 'get $WIF', body: 'swap into $WIF without leaving the app.' },
  { icon: 'agent', title: AGENT_READY ? 'the agent' : 'the agent · coming soon', body: AGENT_READY ? 'an agent that tips and buys on your say, within the cap you set.' : 'an agent that tips and buys on your say. not live yet.', cls: AGENT_READY ? 'lp-b--wide' : 'lp-b--wide lp-b--soon' },
]

export function Landing() {
  useThemedPage()
  const burn = useBurnStats()
  const featured = useFeatured()
  const burned = burn.value !== undefined && burn.value > 0 ? burn.value : undefined
  const [ctaRef, ctaOn] = useOnScreen<HTMLElement>()
  const [ctaRain, setCtaRain] = useState(0)
  const reduced = useReducedMotion()
  useEffect(() => { if (ctaOn && !reduced) setCtaRain(r => r || 1) }, [ctaOn, reduced])
  useEffect(() => { document.title = 'wifly · get paid for what you post' }, [])

  return (
    <div className="lp">
      <header className="lp-nav">
        <div className="lp-wrap lp-nav__in">
          <Link to="/" className="lp-nav__brand" aria-label="wifly home"><Wordmark size="md" /></Link>
          <nav className="lp-nav__links" aria-label="sections">
            <a href="#how">how it works</a>
            <a href="#names">names</a>
            <a href="#fees">fees</a>
            <Link to="/docs">docs</Link>
          </nav>
          <div className="lp-nav__end">
            <ThemeToggle />
            <AppLink to="/home" className="btn btn--dark btn--sm lp-nav__cta">open app</AppLink>
          </div>
        </div>
      </header>

      <main>
        <section className="lp-hero">
          <div className="lp-wrap lp-hero__grid">
            <div className="lp-hero__copy">
              <span className="lp-eyebrow"><Token size={16} /> runs on $WIF</span>
              <h1 className="lp-title" aria-label="post. get tipped. keep it.">
                <span className="lp-title__l" aria-hidden="true"><span>post.</span></span>
                <span className="lp-title__l" aria-hidden="true"><span>get <em>tipped.</em></span></span>
                <span className="lp-title__l" aria-hidden="true"><span>keep it.</span></span>
              </h1>
              <p className="lp-hero__lede">tips, subscriptions and paid drops in $WIF, straight to your wallet. start with a free @name.</p>
              <div className="lp-hero__ctas">
                <AppLink to="/home" className="btn btn--dark btn--lg lp-magnet">open wifly <Icon name="chevron" size={18} /></AppLink>
                <a href="#how" className="btn btn--ghost btn--lg">how it works</a>
              </div>
            </div>
            <div className="lp-hero__art"><TipStage post={featured} /></div>
          </div>
        </section>

        <section className="lp-sec lp-story" id="how">
          <div className="lp-wrap">
            <Reveal className="lp-head">
              <span className="lp-kicker">how it works</span>
              <h2 className="lp-h2">five things, one wallet.</h2>
            </Reveal>
            <div className="lp-story__list">
              <span className="lp-story__rail" aria-hidden="true"><i /></span>

              <Chapter n="01" title="post a drop." art={
<ComposeMock author={featured?.author ?? null} />
              }>
                <p>words, an image, or a paid drop. set a price and it unlocks once, then stays unlocked for whoever paid.</p>
              </Chapter>

              <Chapter n="02" title="get tipped, straight to your wallet." art={
                <div className="lp-art lp-path" aria-hidden="true">
                  <img className="lp-path__coin" src="/brand/wif-token-3d.webp" alt="" width={112} height={112} loading="lazy" />
                  <svg className="lp-path__line" viewBox="0 0 200 60" preserveAspectRatio="none"><path d="M2 30 C 60 -4, 140 64, 198 30" /></svg>
                  <span className="lp-path__wallet"><Icon name="wallet" size={30} /></span>
                  <div className="lp-path__split"><div className="lp-wallet__split"><span style={{ flex: 100 - FEE_BPS / 100 }} /><span style={{ flex: FEE_BPS / 100 }} /></div>
                    <span className="lp-wallet__row"><span>to their wallet <b>{KEEP}</b></span><span>fee <b>{FEE}</b></span></span></div>
                </div>
              }>
                <p>anyone can tip a drop, a member, a name.wif or a wallet. {KEEP} lands in their wallet the moment it's sent. no payout button, no waiting.</p>
              </Chapter>

              <Chapter id="names" n="03" title="own your .wif name." art={<NameCards />}>
                <p>your @name is free. a .wif name is an NFT you hold: keep it, send it or sell it. the card is drawn onchain, fits any length, in white or green.</p>
                <ul className="lp-facts">
                  <li><b className="num">{NAME_CLAIM_FEE.toLocaleString()} WIF</b> to claim</li>
                  <li><b className="num">{NAME_SHORT_CLAIM_FEE.toLocaleString()} WIF</b> for short names</li>
                  <li><b className="num">{SALE_FEE}</b> on sales</li>
                </ul>
                <a className="lp-opensea" href="https://opensea.io/collection/wif-names" target="_blank" rel="noopener noreferrer" data-testid="opensea-link">
                  <img src="/brand/opensea-logomark.svg" alt="" width={18} height={18} loading="lazy" decoding="async" />
                  <span>wif names on opensea</span><span aria-hidden="true" className="lp-opensea__arrow">↗</span>
                </a>
              </Chapter>

              <Chapter n="04" title="subscribe, or go plus." art={
                <div className="lp-art lp-plusart" aria-hidden="true">
                  <div className="lp-tiers">
                    {TIER_EXAMPLES.map((t, i) => (
                      <div key={t.name} className="lp-tier"><span className="lp-tier__n">{i + 1}</span><span className="lp-tier__name">{t.name}</span><span className="lp-tier__price"><b className="num">{t.price.toLocaleString()}</b> WIF / mo</span><Icon name="lock" size={14} /></div>
                    ))}
                  </div>
                  <div className="lp-pluscard">
                    <span className="lp-pluscard__mark"><PlusMark size={22} /></span>
                    <span className="lp-pluscard__price"><span className="num">{PLUS_PRICE_FALLBACK.toLocaleString()}</span> WIF / month</span>
                    <span className="lp-pluscard__soon">{AGENT_READY ? 'agent included' : 'agent · coming soon'}</span>
                  </div>
                </div>
              }>
                <p>up to three monthly tiers at prices you set. plus adds the check next to your name and unlimited questions to the assistant.{AGENT_READY ? ' it also unlocks the agent.' : ' the agent comes later.'}</p>
              </Chapter>

              <Chapter id="fees" n="05" title="one small fee. it all goes back." art={
                <div className="lp-art lp-feeart">
                  <FeeFlow />
                  <div className="lp-claims">
                    <span className="lp-claims__label">.wif claims</span>
                    <div className="lp-claims__bar" aria-hidden="true"><span style={{ flex: CLAIM_SPLIT.treasury }} /><span style={{ flex: CLAIM_SPLIT.pot }} /></div>
                    <span className="lp-claims__legend">{CLAIM_SPLIT.treasury}% treasury · {CLAIM_SPLIT.pot}% pot</span>
                  </div>
                </div>
              }>
                <p>{FEE} on tips, subscriptions, plus, paid drops and pay links, {SALE_FEE} on .wif name sales. {FEE_SPLIT.pot}% of every fee fills the weekly community pot and {FEE_SPLIT.burn}% is burned for good.</p>
                <div className="lp-burn">
                  <div className="lp-badges" aria-hidden="true">
                    {BADGE_LEVELS.map(b => <img key={b.id} src={`/badges/${b.id}.svg`} alt="" width={32} height={32} loading="lazy" />)}
                  </div>
                  <span>badges burn 100%.</span>
                </div>
                <p className="lp-live">{burned !== undefined
                  ? <><span className="live-dot" aria-hidden="true" /> <Odometer value={burned} label="WIF burned" /> WIF burned so far</>
                  : <Link to="/docs#fees">all fees <Icon name="chevron" size={14} /></Link>}</p>
              </Chapter>
            </div>
          </div>
        </section>

        <section className="lp-sec" id="features">
          <div className="lp-wrap">
            <Reveal className="lp-head">
              <span className="lp-kicker">and the rest</span>
              <h2 className="lp-h2">everything else you'd want.</h2>
            </Reveal>
            <div className="lp-bento">
              {BENTO.map((b, i) => (
                <Reveal key={b.title} className={`lp-b ${b.cls ?? ''}`} delay={(i % 3) * 0.05}>
                  <div className="lp-b__in" onPointerMove={spot}>
                    <span className="lp-b__icon"><Icon name={b.icon} size={20} /></span>
                    <h3>{b.title}</h3>
                    <p>{b.body}</p>
                    {b.icon === 'pot' && <div className="lp-b__pot" aria-hidden="true">{[0, 1, 2, 3, 4].map(k => <img key={k} src={COIN} alt="" width={28} height={28} loading="lazy" />)}</div>}
                    {b.cls === 'lp-b--badges' && <div className="lp-b__badges" aria-hidden="true">{BADGE_LEVELS.slice(0, 4).map(x => <img key={x.id} src={`/badges/${x.id}.svg`} alt="" width={28} height={28} loading="lazy" />)}</div>}
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        <section className="lp-cta" ref={ctaRef}>
          <Coins run={ctaRain} count={16} />
          <div className="lp-wrap lp-cta__in">
            <Reveal className="lp-cta__face"><Mascot size={104} title="wifly" mood={ctaOn ? 'happy' : 'calm'} /></Reveal>
            <Reveal delay={0.05}><h2 className="lp-cta__title">start with a free <span>@name.</span></h2></Reveal>
            <Reveal delay={0.1}><p className="lp-cta__lede">sign in, pick a name, post your first drop.</p></Reveal>
            <Reveal delay={0.15} className="lp-cta__btns">
              <AppLink to="/home" className="btn btn--neon btn--lg lp-magnet">open wifly <Icon name="chevron" size={18} /></AppLink>
              <AppLink to="/swap" className="btn btn--ghost-inv btn--lg">get $WIF</AppLink>
            </Reveal>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-wrap">
          <div className="lp-foot__top">
            <div className="lp-foot__brand">
              <Wordmark size="md" />
              <p>get paid for what you post.</p>
            </div>
            <nav className="lp-foot__cols" aria-label="footer">
              <div><span>product</span><AppLink to="/home">app</AppLink><Link to="/docs">docs</Link><a href="#fees">fees</a></div>
              <div><span>$WIF</span><AppLink to="/swap">get $WIF</AppLink><a href={LINKS.wifX} target="_blank" rel="noreferrer">$WIF on x</a><a href={LINKS.wifSite} target="_blank" rel="noreferrer">world is flat</a></div>
            </nav>
          </div>
          <div className="lp-foot__bot">
            <span className="lp-foot__runs"><Token size={14} /> runs on $WIF</span>
            <ThemeToggle />
          </div>
        </div>
      </footer>
    </div>
  )
}
