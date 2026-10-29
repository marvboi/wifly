import { Link } from 'react-router-dom'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AnimatedNumber, Odometer, fmtDur, useClock } from './Motion'
import { posts, users } from '../state/registry'
import { useStore } from '../state/store'
import { FEE_SPLIT_LABEL, topSpotMinBid } from '../lib/fees'
import { useBurnStats } from '../api/hooks'
import { useEpochState } from '../lib/wifly'
import { FEE_SPLIT, LIVE } from '../config'
import { Icon } from './Icon'

/** The world strip: this week's vote, the Top Spot and the burn counter, in one band above the feed.
 *  Every number is read from the chain. When there is nothing to show yet, each tile says so plainly. */
// The strip's last height, so a repeat visit reserves exactly that much while its numbers load (no jump above the feed).
const WORLD_H = 'wifly_world_h'
const lastWorldH = (() => { try { const s = localStorage.getItem(WORLD_H); const v = s === null ? NaN : Number(s); return Number.isFinite(v) && v >= 0 && v < 800 ? v : null } catch { return null } })()
const saveWorldH = (h: number) => { try { localStorage.setItem(WORLD_H, String(Math.round(h))) } catch { /* storage off */ } }

export function WorldStrip() {
  const { topSpot, openSheet } = useStore()
  const ep = useEpochState()
  const burn = useBurnStats()
  const burnedViaWifly = burn.viaWifly
  const post = topSpot.postId ? posts.find(p => p.id === topSpot.postId) : undefined
  const holder = topSpot.holder ? users[topSpot.holder] : undefined
  const now = useClock(1000)
  const endsAt = ep?.endsAt ? ep.endsAt * 1000 : undefined
  const spotKey = `${topSpot.holder}:${topSpot.paid}`
  const [since, setSince] = useState(() => Date.now())
  const prev = useRef(spotKey)
  useEffect(() => {
    if (prev.current === spotKey) return
    prev.current = spotKey
    setSince(Date.now())
  }, [spotKey])
  const potNow = ep?.pot && ep.pot > 0 ? Math.round(ep.pot) : 0
  // only tiles with something real in them: an empty strip is noise above the feed
  const showVote = potNow > 0, showSpot = !!post, showBurn = (burn.value ?? 0) > 0
  // still loading: the burn total from the api, and (live chain only) the epoch, for a few seconds at most
  const [waited, setWaited] = useState(false)
  useEffect(() => { const t = setTimeout(() => setWaited(true), 4000); return () => clearTimeout(t) }, [])
  const settling = !waited && (burn.pending || (LIVE && !ep))
  const empty = !showVote && !showSpot && !showBurn
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (settling) return
    if (empty) saveWorldH(0); else if (ref.current) saveWorldH(ref.current.offsetHeight)
  })
  if (settling) {
    const h = lastWorldH ?? 128 // a burn-only strip on a first visit
    if (h === 0) return null
    return <section className="world world--skel" aria-busy="true" aria-label="this week on wifly, loading"><div className="world__tile skel" style={{ height: h }} /></section>
  }
  if (empty) return null

  return (
    <section ref={ref} className={`world world--n${[showVote, showSpot, showBurn].filter(Boolean).length}`} aria-label="this week on wifly">
      {showVote && <article className="world__tile world__tile--vote">
        <div className="world__head"><span className="world__k">creator of the week</span>{endsAt && <span className="world__meta num">ends in {fmtDur((endsAt - now) / 1000)}</span>}</div>
        <Link to="/vote" className="world__who">
          <div><div className="strong">weekly community pot is open</div><div className="muted small">vote for a creator you like. the week’s pick shares the weekly community pot.</div></div>
        </Link>
        <div className="world__foot">
          <span className="small muted">weekly community pot <b className="world__ink"><AnimatedNumber value={potNow} /></b> wif</span>
          <Link to="/vote" className="chip chip--ink"><Icon name="vote" size={14} /> vote</Link>
        </div>
      </article>}

      {showSpot && <article className="world__tile world__tile--spot">
        <div className="world__head"><span className="world__k">top spot · promoted</span>{post && <span className="world__meta num">held {fmtDur((now - since) / 1000)}</span>}</div>
        <div className="world__flip">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div key={spotKey} initial={{ rotateX: -80, y: 18, opacity: 0 }} animate={{ rotateX: 0, y: 0, opacity: 1 }}
              exit={{ rotateX: 70, y: -16, opacity: 0, transition: { duration: 0.22, ease: 'easeIn' } }}
              transition={{ type: 'spring', stiffness: 260, damping: 22 }} style={{ transformOrigin: '50% 0%' }}>
              {post ? (
                <Link to={`/post/${post.id}`} className="world__quote">
                  <span className="strong small">{holder?.name ?? post.author}</span>
                  <p>{post.text}</p>
                </Link>
              ) : (
                <div className="world__quote"><span className="strong small">no promotion yet</span><p className="muted">be the first to pin a drop here.</p></div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="world__foot">
          <span className="small muted">{topSpot.paid > 0 ? <>next bid <b className="world__ink"><AnimatedNumber value={topSpotMinBid(topSpot.paid)} /></b> wif</> : 'empty right now'}</span>
          <motion.button whileTap={{ scale: 0.9 }} className="chip chip--ink" onClick={() => openSheet({ type: 'bid' })}><Icon name="pin" size={14} /> {post ? 'take it' : 'promote'}</motion.button>
        </div>
      </article>}

      {showBurn && <article className="world__tile world__tile--burn">
        <div className="world__head"><span className="world__k">burned forever</span>{burn.value !== undefined && <span className="world__meta"><span className="live-dot" aria-hidden="true" /> onchain</span>}</div>
        <div className="world__big">{burn.value !== undefined ? <Odometer value={burn.value} label="wif burned forever" /> : '…'}</div>
        <div className="world__foot">
          {burnedViaWifly !== undefined && burnedViaWifly > 0 ? <span className="small muted">via wifly <b className="world__ink"><AnimatedNumber value={Math.round(burnedViaWifly)} /></b></span> : <span className="small muted">wif sent to the burn address</span>}
          <span className="small muted" title={`every fee: ${FEE_SPLIT_LABEL}`}>fees: {FEE_SPLIT.burn}% burned</span>
        </div>
      </article>}
    </section>
  )
}

