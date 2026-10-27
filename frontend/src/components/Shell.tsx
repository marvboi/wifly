import { profilePath } from '../lib/paths'
import { FEED_PATH } from '../lib/hosts'
import { Companion } from '../companion/Companion'
import { NavLink, Link, Navigate, useLocation, useOutlet } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect } from 'react'
import { useSession } from '../api/session'
import { useStore } from '../state/store'
import { Avatar, Token, Wordmark } from './Bits'
import { Icon, type IconName } from './Icon'
import { WalletChip } from './WalletChip'
import { PlusMark } from './BrandSlots'
import { GuestBanner } from './LinkAccounts'

type DockItem = { to: string; label: string; icon: IconName | 'plusmark'; phone?: boolean }
const left: DockItem[] = [
  { to: FEED_PATH, label: 'home', icon: 'home', phone: true },
  { to: '/search', label: 'search', icon: 'search', phone: true },
  { to: '/vote', label: 'vote', icon: 'vote', phone: true },
  { to: '/messages', label: 'messages', icon: 'mail' },
]
const right: DockItem[] = [
  { to: '/agent', label: 'agent', icon: 'agent' },
  { to: '/names', label: '.wif', icon: 'at' },
  { to: '/plus', label: 'plus', icon: 'plusmark' },
  { to: '/@you', label: 'you', icon: 'user', phone: true },
]

function DockLink({ n }: { n: DockItem }) {
  return (
    <NavLink to={n.to} end className={`dock__link ${n.phone ? '' : 'dock__link--wide'}`} aria-label={n.label} title={n.label}>
      {({ isActive }) => <>
        {isActive && <motion.span layoutId="dock-pill" className="dock__pill" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
        {n.icon === 'plusmark' ? <PlusMark size={20} /> : <Icon name={n.icon} size={20} />}
        <span className="dock__label">{n.label}</span>
      </>}
    </NavLink>
  )
}

/**
 * App frame: a top bar (wordmark, alerts, wallet) and a floating dock at the bottom, on every screen size.
 * Pages render into one centred column; Home adds the world strip above its feed.
 */
export function AppShell() {
  const { me, unread } = useSession()
  const { pathname } = useLocation()
  const { openSheet } = useStore()
  const outlet = useOutlet()
  useEffect(() => { window.scrollTo(0, 0) }, [pathname])
  // no public placeholder @names: a signed-in account without a picked @name goes to the name step first
  if (me?.needsHandle && pathname !== '/settings') return <Navigate to={`/welcome${me.renaming ? '?step=you' : ''}`} replace />
  return (
    <div className="app" data-route={pathname.split('/')[1] || 'home'}>
      <header className="topbar">
        <div className="topbar__inner">
          <Wordmark to={FEED_PATH} size="sm" />
          <span className="topbar__tag">the world is fair</span>
          <div className="topbar__right">
            {me ? <>
              <NavLink to="/notifications" className="topbar__btn" aria-label={`notifications${unread ? `, ${unread} new` : ''}`}>
                <Icon name="bell" size={20} />
                {unread > 0 && <span className="topbar__count num">{unread}</span>}
              </NavLink>
              <NavLink to="/bookmarks" className="topbar__btn topbar__btn--wide" aria-label="bookmarks"><Icon name="bookmark" size={20} /></NavLink>
              <WalletChip compact />
              <Link to={profilePath(me.handle)} className="topbar__me" aria-label="your profile"><Avatar handle={me.handle} size={32} /></Link>
            </> : <button className="btn btn--sm btn--dark" onClick={() => openSheet({ type: 'signin' })}>sign in</button>}
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
            {outlet}
          </motion.div>
        </AnimatePresence>
      </main>

      <nav className="dock" aria-label="main">
        {left.map(n => <DockLink key={n.to} n={n} />)}
        <motion.button className="dock__new" whileTap={{ scale: 0.92 }} whileHover={{ y: -2 }} transition={{ type: 'spring', stiffness: 500, damping: 22 }} onClick={() => openSheet({ type: 'compose' })} aria-label="new drop">
          <Icon name="plus" size={20} /><span className="dock__new-label">new drop</span>
        </motion.button>
        {right.map(n => <DockLink key={n.to} n={n.to === '/@you' && me ? { ...n, to: profilePath(me.handle) } : n} />)}
      </nav>
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
