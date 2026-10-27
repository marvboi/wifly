import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { AppLink } from '../components/AppLink'
import { CopyAddress, Wordmark } from '../components/Bits'
import { Icon } from '../components/Icon'
import { ThemeToggle } from '../components/ThemeToggle'
import { useThemedPage } from '../lib/theme'
import {
  AGENT_CAP_FREE, AGENT_CAP_PLUS, AGENT_READY, DCA_READY, FREE_AI_MSGS_PER_DAY_FALLBACK, SWAP_POOL_FEE_BPS,
  BADGE_LEVELS, BADGES_ADDRESS, BURN_ADDRESS, CLAIM_SPLIT, FEE_BPS, FEE_SPLIT, LINKS, NAME_CLAIM_FEE, NAME_FEE_BPS,
  NAME_MAX, NAME_MIN, NAME_SHORT_CLAIM_FEE, NAME_SHORT_LEN, NAMES_ADDRESS, PLUS_PRICE_FALLBACK, PLUS_PRICE_YEAR_FALLBACK, TOPSPOT_FEE_SHARE,
  TOPSPOT_HOLDER_SHARE, TOPSPOT_MIN_RAISE, TREASURY, VOTE_PRICE, WIF_TOKEN, WIFLY_ADDRESS,
} from '../config'
import { SITE_URL } from '../lib/hosts'
import '../styles/docs.css'

const n = (v: number) => v.toLocaleString('en-US')
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`
const FEE = `${FEE_BPS / 100}%`
const SALE_FEE = `${NAME_FEE_BPS / 100}%`
const POOL_FEE = `${SWAP_POOL_FEE_BPS / 100}%`
const SPLIT = `${FEE_SPLIT.pot}% to the weekly community pot and ${FEE_SPLIT.burn}% burned`
const CLAIM = `${CLAIM_SPLIT.treasury}% treasury, ${CLAIM_SPLIT.pot}% weekly community pot`

type Section = { id: string; title: string; body: ReactNode }

/** Contract rows: $WIF and the public treasury and burn addresses always; the wifly contracts only once their address is set. */
const contracts: Array<{ label: string; address?: string }> = [
  { label: '$WIF token', address: WIF_TOKEN },
  { label: 'wifly', address: WIFLY_ADDRESS },
  { label: '.wif names', address: NAMES_ADDRESS },
  { label: 'burn badges', address: BADGES_ADDRESS },
  { label: 'treasury', address: TREASURY },
  { label: 'burn address', address: BURN_ADDRESS },
]

/** smooth scrolling only when the reader hasn't asked for less motion */
/** Bottom edge of the sticky bars (the top bar, plus the "on this page" bar below 860px), in viewport px. */
const stickyBottom = () => {
  let b = 0
  document.querySelectorAll<HTMLElement>('.dx-top, .dx-mnav').forEach(el => {
    if (getComputedStyle(el).display !== 'none') b = Math.max(b, el.getBoundingClientRect().bottom)
  })
  return b
}
/** Gap between the sticky bars and a section's top edge after a jump. */
const JUMP_GAP = 8
const scrollBehavior = (): ScrollBehavior =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'

const sections: Section[] = [
  {
    id: 'what', title: 'what is wifly',
    body: <>
      <p>wifly is a social app where people pay creators directly in $WIF. post drops, get tipped, run subscriptions and sell paid drops.</p>
      <p>payments go straight to the creator’s wallet, minus a small fee. you sign every payment in your own wallet.</p>
      <p>wifly also has a free assistant that answers questions about the app and helps you find your way around.</p>
    </>,
  },
  {
    id: 'start', title: 'getting started',
    body: <>
      <ol className="dx-steps">
        <li>open <AppLink to="/home">app.wifly.fun</AppLink> and sign in with X, email or a wallet.</li>
        <li>pick your @name. it’s free and it’s yours.</li>
        <li>add a photo and follow a few people. both are optional.</li>
        <li>to send tips or pay for things, hold some $WIF and a little ETH for network fees. see <a href="#wif">get $WIF</a>.</li>
      </ol>
    </>,
  },
  {
    id: 'names', title: '@names and .wif names',
    body: <>
      <p><b>@name</b> is your free username. you get one when you sign up.</p>
      <p><b>.wif name</b> is an optional name like <code>you.wif</code>. it’s a transferable NFT that lives in your wallet: it points to whichever wallet holds it, and you can keep it, send it or sell it.</p>
      <ul className="dx-list">
        <li>{NAME_MIN}–{NAME_MAX} characters: a–z, 0–9 and _.</li>
        <li>{n(NAME_CLAIM_FEE)} WIF to claim, or {n(NAME_SHORT_CLAIM_FEE)} WIF for short names of {NAME_MIN}–{NAME_SHORT_LEN} characters. the claim fee goes {CLAIM_SPLIT.treasury}% to the treasury and {CLAIM_SPLIT.pot}% to the weekly community pot.</li>
        <li>sales carry a {SALE_FEE} fee: {SPLIT}.</li>
        <li>when a name is sold or sent, its records reset: address, avatar, X, link and bio are cleared for the new owner.</li>
      </ul>
    </>,
  },
  {
    id: 'tips', title: 'tips',
    body: <>
      <p>tip a drop, a person, or any X account. the tip goes straight to their wallet, minus a {FEE} fee.</p>
      <p>tipping an X account that isn’t on wifly yet? it reaches their wallet as soon as they link that X account.</p>
      <p className="dx-note">the {FEE} fee splits {SPLIT}.</p>
    </>,
  },
  {
    id: 'subs', title: 'subscriptions',
    body: <>
      <p>creators set up to three tiers, each with its own monthly price in WIF and the perks they choose. a subscription runs 30 days at a time.</p>
      <p>subscribers pay the creator directly, minus the {FEE} fee.</p>
    </>,
  },
  {
    id: 'drops', title: 'paid drops',
    body: <>
      <p>put a price on a single drop. people see a preview, pay once to unlock it, and keep it. no subscription needed.</p>
      <p>the creator gets the price minus the {FEE} fee.</p>
    </>,
  },
  {
    id: 'plus', title: 'wifly plus',
    body: <>
      <p><b>{n(PLUS_PRICE_FALLBACK)} WIF a month</b> or <b>{n(PLUS_PRICE_YEAR_FALLBACK)} WIF a year</b>.</p>
      <ul className="dx-list">
        <li>the plus check next to your name.</li>
        <li>unlimited questions to the free assistant. without plus you get {FREE_AI_MSGS_PER_DAY_FALLBACK} a day.</li>
        {AGENT_READY
          ? <>
              <li>rent an AI agent that tips and buys for you. nothing happens until you confirm.</li>
              <li>a higher daily cap for your agent: up to {n(AGENT_CAP_PLUS)} WIF instead of {n(AGENT_CAP_FREE)}. you still set it.</li>
            </>
          : <li>rent an AI agent that tips and buys for you, with a higher daily cap. <span className="dx-soon">coming soon</span></li>}
        <li>scheduled WIF buys, like a set amount every friday.{!DCA_READY && <> <span className="dx-soon">coming soon</span></>}</li>
      </ul>
    </>,
  },
  {
    id: 'promote', title: 'promotion',
    body: <>
      <p>the top spot pins one drop above every feed. to take it, offer at least {pct(TOPSPOT_MIN_RAISE)} more than the current offer.</p>
      <p>when someone takes the spot, the previous holder gets {pct(TOPSPOT_HOLDER_SHARE)} of the new offer. the other {pct(TOPSPOT_FEE_SHARE)} is the promotion fee. the first offer on an empty spot is all fee.</p>
    </>,
  },
  {
    id: 'wif', title: 'get $WIF',
    body: <>
      <p>swap ETH for WIF on the <AppLink to="/swap">swap page</AppLink>. the quote is live and already includes the pool’s {POOL_FEE} fee.</p>
      <p>you can also trade on <a href={LINKS.buy} target="_blank" rel="noreferrer">pons</a>. keep a little ETH for network fees.</p>
    </>,
  },
  {
    id: 'burn', title: 'burn badges',
    body: <>
      <p>burn WIF to earn badges that stay on your profile. every coin you burn goes to the burn address, all of it. there’s no fee.</p>
      <ul className="dx-badges">
        {BADGE_LEVELS.map(b => (
          <li key={b.id}><img src={`/badges/${b.id}.svg`} alt="" width={36} height={36} loading="lazy" /><span>{b.name}</span><span className="num">{n(b.min)} WIF</span></li>
        ))}
      </ul>
      <p className="dx-note">badges count your total burned and can’t be moved.</p>
    </>,
  },
  {
    id: 'fees', title: 'fees',
    body: <>
      <div className="dx-table" role="table" aria-label="fees">
        {[
          ['tips', FEE],
          ['subscriptions', FEE],
          ['paid drops', FEE],
          ['pay links', FEE],
          ['.wif name claim', `${n(NAME_CLAIM_FEE)} WIF (${n(NAME_SHORT_CLAIM_FEE)} for ${NAME_MIN}–${NAME_SHORT_LEN} characters), split ${CLAIM}`],
          ['.wif name sales', SALE_FEE],
          ['top spot', `${pct(TOPSPOT_FEE_SHARE)} of each new offer`],
          ['crowd votes', `${VOTE_PRICE} WIF per vote, all of it a fee`],
          ['wifly plus', `${n(PLUS_PRICE_FALLBACK)} WIF / month, ${n(PLUS_PRICE_YEAR_FALLBACK)} WIF / year, ${FEE} of it the fee`],
          ['burn badges', 'no fee, 100% burned'],
          ['scheduled WIF buys', DCA_READY ? 'no wifly fee' : 'no wifly fee (coming soon)'],
          ['swap', `${POOL_FEE} pool fee, included in the quote`],
        ].map(([k, v]) => <div role="row" key={k}><span role="cell">{k}</span><span role="cell">{v}</span></div>)}
      </div>
      <p>every fee splits the same way, from the {FEE} on tips, subscriptions, plus, paid drops and pay links and the {SALE_FEE} on .wif name sales to the top spot and crowd votes:</p>
      <div className="dx-split" aria-hidden="true"><span className="p" style={{ flex: FEE_SPLIT.pot }} /><span className="b" style={{ flex: FEE_SPLIT.burn }} /></div>
      <ul className="dx-legend"><li><i className="p" /> {FEE_SPLIT.pot}% weekly community pot</li><li><i className="b" /> {FEE_SPLIT.burn}% burned</li></ul>
      <p>the treasury takes nothing from fees. the one exception is a .wif name claim, which splits {CLAIM_SPLIT.treasury}% to the treasury and {CLAIM_SPLIT.pot}% to the weekly community pot, with nothing burned.</p>
      <p className="dx-note">the weekly community pot goes to the creator the crowd votes up most that week and to the people who voted for them.</p>
    </>,
  },
  {
    id: 'safety', title: 'safety',
    body: <>
      <ul className="dx-list">
        <li>never share your seed phrase or private key. wifly will never ask for them.</li>
        <li>signing in only signs a message. it can’t move your funds.</li>
        <li>check the amount and address in your wallet before you confirm. payments can’t be reversed.</li>
        {AGENT_READY && <li>the agent can only spend inside the daily cap you set, and it can never withdraw.</li>}
        <li>the only official sites are wifly.fun and app.wifly.fun.</li>
      </ul>
    </>,
  },
  {
    id: 'contracts', title: 'contract addresses',
    body: <div className="dx-addrs">{contracts.filter(c => c.address).map(c => <CopyAddress key={c.label} address={c.address!} label={c.label} full />)}</div>,
  },
]

export function Docs() {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(sections[0].id)
  const [open, setOpen] = useState(false)
  const [hits, setHits] = useState<Set<string> | null>(null)
  const refs = useRef<Record<string, HTMLElement | null>>({})

  useThemedPage()
  useEffect(() => { document.title = 'wifly docs' }, [])

  // jump to the hash on first load (the section ids are the anchors)
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1))
    if (id && refs.current[id]) requestAnimationFrame(() => {
      const el = refs.current[id]
      if (el) window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - stickyBottom() - JUMP_GAP) })
    })
  }, [])

  // highlight the section being read: the last visible section whose top has reached the sticky bars.
  // (an IntersectionObserver band picked the section above on mobile, where the bars are taller.)
  const pinned = useRef<{ id: string; until: number } | null>(null)
  const measure = useCallback(() => {
    const p = pinned.current
    if (p && Date.now() < p.until) return // a jump is still scrolling: keep the section that was tapped
    const line = stickyBottom() + JUMP_GAP * 2
    const vis = sections.map(s => refs.current[s.id]).filter((el): el is HTMLElement => !!el && !el.hidden)
    if (!vis.length) return
    let cur = vis[0].id
    for (const el of vis) if (el.getBoundingClientRect().top <= line) cur = el.id
    // a short last section can't reach the line: at the very bottom, keep a tapped one or show the last
    const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2
    if (atEnd) cur = p && vis.some(el => el.id === p.id) ? p.id : vis[vis.length - 1].id
    else pinned.current = null
    setActive(cur)
  }, [])
  useEffect(() => {
    let raf = 0
    const on = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure) }
    on()
    window.addEventListener('scroll', on, { passive: true })
    window.addEventListener('resize', on)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('scroll', on); window.removeEventListener('resize', on) }
  }, [hits, measure])

  // search: match the words on each section, title included
  useEffect(() => {
    const t = q.trim().toLowerCase()
    if (!t) return setHits(null)
    setHits(new Set(sections.filter(s => (refs.current[s.id]?.textContent ?? s.title).toLowerCase().includes(t)).map(s => s.id)))
  }, [q])

  const shown = useMemo(() => sections.filter(s => !hits || hits.has(s.id)), [hits])
  // Close the mobile menu first (flushSync commits it now), then measure on the next frame, after the menu's height
  // is gone; scrolling while it was still open landed about one menu height past the section.
  const go = (id: string) => {
    flushSync(() => setOpen(false))
    history.replaceState(null, '', `#${id}`)
    setActive(id)
    requestAnimationFrame(() => {
      const el = refs.current[id]
      if (!el) return
      const top = Math.max(0, el.getBoundingClientRect().top + window.scrollY - stickyBottom() - JUMP_GAP)
      const behavior = scrollBehavior()
      pinned.current = { id, until: Date.now() + (behavior === 'smooth' ? 1200 : 100) }
      window.scrollTo({ top, behavior })
      window.addEventListener('scrollend', () => { if (pinned.current?.id === id) pinned.current.until = 0; measure() }, { once: true })
    })
  }
  const nav = (
    <ul className="dx-nav">
      {shown.map(s => (
        <li key={s.id}><a href={`#${s.id}`} className={active === s.id ? 'is-on' : ''} aria-current={active === s.id ? 'location' : undefined}
          onClick={e => { e.preventDefault(); go(s.id) }}>{s.title}</a></li>
      ))}
    </ul>
  )
  const activeTitle = sections.find(s => s.id === active)?.title ?? ''
  const search = (extra = '') => (
    <label className={`dx-search ${extra}`}>
      <Icon name="search" size={16} />
      <input type="search" placeholder="search" value={q} onChange={e => setQ(e.target.value)} aria-label="search the docs" />
      {q && <button type="button" className="dx-search__clear" onClick={() => setQ('')} aria-label="clear search"><Icon name="close" size={14} /></button>}
    </label>
  )

  return (
    <div className="dx">
      <header className="dx-top">
        <div className="dx-wrap dx-top__in">
          <Wordmark size="sm" />
          <span className="dx-top__tag">docs</span>
          <ThemeToggle className="dx-top__theme" />
          <AppLink to="/home" className="btn btn--dark btn--sm dx-top__cta">open app</AppLink>
        </div>
      </header>

      <div className="dx-mnav">
        <button className="dx-mnav__btn" aria-expanded={open} aria-controls="dx-mnav-list" onClick={() => setOpen(o => !o)}>
          <span className="muted">on this page</span><span className="dx-mnav__cur">{activeTitle}</span><Icon name={open ? 'up' : 'down'} size={16} />
        </button>
        {open && <div id="dx-mnav-list" className="dx-mnav__list">{search('dx-search--m')}{nav}</div>}
      </div>

      <div className="dx-wrap dx-grid">
        <aside className="dx-side" aria-label="docs sections">
          {search()}
          {nav}
        </aside>

        <main className="dx-main">
          <div className="dx-intro">
            <h1>docs</h1>
            <p>everything you need to use wifly, in one page.</p>
          </div>
          {sections.map(s => (
            <section key={s.id} id={s.id} ref={el => { refs.current[s.id] = el }} className="dx-sec" hidden={!!hits && !hits.has(s.id)}>
              <h2><a href={`#${s.id}`} onClick={e => { e.preventDefault(); go(s.id) }}>{s.title}</a></h2>
              {s.body}
            </section>
          ))}
          {hits && hits.size === 0 && <p className="dx-empty">nothing matches “{q}”.</p>}
          <footer className="dx-foot">
            <a href={SITE_URL || '/'}>wifly.fun</a>
            <AppLink to="/home">open the app</AppLink>
            <a href={LINKS.wifSite} target="_blank" rel="noreferrer">world is flat</a>
          </footer>
        </main>
      </div>
    </div>
  )
}
