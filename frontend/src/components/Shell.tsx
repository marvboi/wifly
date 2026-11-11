import { ErrorBoundary } from './ErrorBoundary'
import { profilePath } from '../lib/paths'
import { FEED_PATH } from '../lib/hosts'
import { Companion } from '../companion/Companion'
import { NavLink, Link, useLocation, useOutlet } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { useSession } from '../api/session'
import { useStore } from '../state/store'
import { Avatar, Token, Wordmark } from './Bits'
import { Icon, type IconName } from './Icon'
import { WalletChip } from './WalletChip'
import { PlusMark } from './BrandSlots'
import { GuestBanner } from './LinkAccounts'
import { MoreSheet } from './Tools'
import { useDmStream } from '../api/dms'

type DockItem = { to: string; label: string; icon: IconName | 'plusmark'; phone?: boolean }
const left: DockItem[] = [
  { to: FEED_PATH, label: 'home', icon: 'home', phone: true },
  { to: '/search', label: 'search', icon: 'search', phone: true },
  { to: '/vote', label: 'vote', icon: 'vote', phone: true },
  { to: '/messages', label: 'messages', icon: 'mail' },
]
/** Logged out: a read-only dock (no new drop, no private pages) above the join bar. */
const guestDock: DockItem[] = [
  { to: FEED_PATH, label: 'home', icon: 'home', phone: true },
  { to: '/search', label: 'explore', icon: 'search', phone: true },
  { to: '/names', label: '.wif', icon: 'at', phone: true },
  { to: '/vote', label: 'vote', icon: 'vote', phone: true },
  { to: '/plus', label: 'plus', icon: 'plusmark' },
]
const right: DockItem[] = [
  { to: '/agent', label: 'agent', icon: 'agent' },
  { to: '/names', label: '.wif', icon: 'at' },
  { to: '/plus', label: 'plus', icon: 'plusmark' },
  { to: '/@you', label: 'you', icon: 'user', phone: true },
]

function DockLink({ n, badge = 0 }: { n: DockItem; badge?: number }) {
  return (
    <NavLink to={n.to} end={n.to !== '/messages'} className={`dock__link ${n.phone ? '' : 'dock__link--wide'}`} aria-label={badge ? `${n.label}, ${badge} unread` : n.label} title={n.label}>
      {({ isActive }) => <>
        {isActive && <motion.span layoutId="dock-pill" className="dock__pill" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
        {n.icon === 'plusmark' ? <PlusMark size={20} /> : <Icon name={n.icon} size={20} />}
        <span className="dock__label">{n.label}</span>
        {badge > 0 && <span className="dock__badge num" data-testid={`dock-badge-${n.label}`}>{badge > 9 ? '9+' : badge}</span>}
      </>}
    </NavLink>
  )
}

/** Slim calm bar for logged-out visitors, like x: read everything, join or sign in when you want to do something. */
function JoinBar() {
  const { openSheet } = useStore()
  return (
    <motion.aside className="joinbar" aria-label="join wifly" data-testid="joinbar"
      initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 30, delay: 0.25 }}>
      <div className="joinbar__inner">
        <div className="joinbar__copy">
          <span className="joinbar__title">don’t miss what’s happening</span>
          <span className="joinbar__line">people on wifly are the first to know.</span>
        </div>
        <div className="joinbar__actions">
          <button className="joinbar__btn joinbar__btn--main" onClick={() => openSheet({ type: 'signin' })}>sign in</button>
        </div>
      </div>
    </motion.aside>
  )
}

/**
 * App frame: a top bar (wordmark, alerts, wallet) and a floating dock at the bottom, on every screen size.
 * Pages render into one centred column; Home adds the world strip above its feed.
 */
export function AppShell() {
  const { me, unread, ready, dms, guest } = useSession()
  const out = ready && !me
  const dmCount = dms.inbox + dms.requests
  useDmStream(!!me && !guest && !me.needsHandle)
  const { pathname } = useLocation()
  const { openSheet } = useStore()
  const outlet = useOutlet()
  const [more, setMore] = useState(false)
  useEffect(() => { setMore(false) }, [pathname])
  const moreBtn = (
    <button type="button" className={`dock__link dock__more${more ? ' is-on' : ''}`} aria-label={dmCount && !out ? `more, ${dmCount} unread messages` : 'more'} title="more" aria-haspopup="dialog" aria-expanded={more} onClick={() => setMore(true)}>
      <Icon name="grid" size={20} /><span className="dock__label">more</span>
      {dmCount > 0 && !out && <span className="dock__badge num" data-testid="dock-badge-more">{dmCount > 9 ? '9+' : dmCount}</span>}
    </button>
  )
  useEffect(() => { window.scrollTo(0, 0) }, [pathname])
  // public pages are open to everyone, like x. an account without a picked @name browses freely and is
  // sent to the name step only when it acts (useNeedLink / gated sheets); private pages show their own sign-in card.
  // the sign-in sheet never auto-opens on load.
  return (
    <div className={`app${out ? ' app--out' : ''}`} data-route={pathname.split('/')[1] || 'home'}>
      <header className="topbar">
        <div className="topbar__inner">
          <Wordmark to={FEED_PATH} size="sm" />
          <span className="topbar__tag">tips, straight to you</span>
          <div className={`topbar__right${me?.needsHandle ? ' topbar__right--pick' : ''}`}>
            {me ? <>
              <NavLink to="/notifications" className="topbar__btn" aria-label={`notifications${unread ? `, ${unread} new` : ''}`}>
                <Icon name="bell" size={20} />
                {unread > 0 && <span className="topbar__count num">{unread}</span>}
              </NavLink>
              <NavLink to="/bookmarks" className="topbar__btn topbar__btn--wide" aria-label="bookmarks"><Icon name="bookmark" size={20} /></NavLink>
              <WalletChip compact />
              {me.needsHandle
                ? <Link to={`/welcome${me.renaming ? '?step=you' : ''}`} className="btn btn--sm btn--dark topbar__pick">pick <span className="topbar__pick-your">your </span>@name</Link>
                : <Link to={profilePath(me.handle)} className="topbar__me" aria-label="your profile"><Avatar handle={me.handle} size={32} /></Link>}
            </> : ready ? <>
              <button className="btn btn--sm btn--ghost topbar__signin" onClick={() => openSheet({ type: 'signin' })}>sign in</button>
            </> : null}
          </div>
        </div>
      </header>

      <main className="stage">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={pathname} className="page"
            initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8, transition: { duration: 0.14, ease: 'easeIn' } }}
            transition={{ type: 'spring', stiffness: 300, damping: 32 }}
            onAnimationStart={() => window.scrollTo(0, 0)}>
            <GuestBanner />
            <ErrorBoundary label="page">{outlet}</ErrorBoundary>
          </motion.div>
        </AnimatePresence>
      </main>

      {out ? <nav className="dock dock--out" aria-label="main">
        {guestDock.map(n => <DockLink key={n.to} n={n} />)}
        {moreBtn}
      </nav> : <nav className="dock" aria-label="main">
        {left.map(n => <DockLink key={n.to} n={n} badge={n.to === '/messages' ? dmCount : 0} />)}
        <motion.button className="dock__new" whileTap={{ scale: 0.92 }} whileHover={{ y: -2 }} transition={{ type: 'spring', stiffness: 500, damping: 22 }} onClick={() => openSheet({ type: 'compose' })} aria-label="new drop">
          <Icon name="plus" size={20} /><span className="dock__new-label">new drop</span>
        </motion.button>
        {right.map(n => n.to === '/@you' ? null : <DockLink key={n.to} n={n} />)}
        {moreBtn}
        {right.filter(n => n.to === '/@you').map(n => <DockLink key={n.to} n={me && !me.needsHandle ? { ...n, to: profilePath(me.handle) } : n} />)}
      </nav>}
      <AnimatePresence>{more && <MoreSheet key="more" onClose={() => setMore(false)} />}</AnimatePresence>
      {out && <JoinBar />}
      <Companion />
    </div>
  )
}

/** Page title block: big WIF Par title in the column, not a sticky bar. */
export function PageHead({ title, back, right, sub }: { title: string; back?: boolean; right?: React.ReactNode; sub?: string }) {
  return (
    <header className="page-head">
      {back && <button className="page-head__back" onClick={() => history.back()} aria-label="back"><Icon name="back" size={18} /></button>}
      <div className="page-head__titles"><h1 className="page-head__title">{title}</h1>{sub && <div className="muted small">{sub}</div>}</div>
      {right && <div className="page-head__right">{right}</div>}
    </header>
  )
}

export { Token }
