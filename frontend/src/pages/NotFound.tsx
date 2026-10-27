import { motion } from 'motion/react'
import { Mascot } from '../components/Mascot'
import { FEED_PATH } from '../lib/hosts'
import { Link } from 'react-router-dom'
import { Corners } from '../components/Bits'

type Kind = 'page' | 'profile' | 'post'

/** 404 in three flavours: an unknown route, a handle no one has, and a drop that doesn't exist (or was deleted). */
export function NotFound({ kind = 'page', handle }: { kind?: Kind; handle?: string }) {
  const copy = kind === 'profile'
    ? { title: 'no one here by that name.', body: handle ? `@${handle} isn’t on wifly. maybe a typo, or they changed their name.` : 'this profile isn’t on wifly.', cta: 'find people', to: '/search?type=people' }
    : kind === 'post'
      ? { title: 'this drop isn’t here.', body: 'it may have been deleted, or the link is wrong.', cta: 'back to the feed', to: FEED_PATH }
      : { title: 'you walked off the edge of the map.', body: 'the world is flat. this page isn’t on it.', cta: 'back to the feed', to: FEED_PATH }
  return (
    <section className={`notfound notfound--${kind}`}>
      <Corners />
      <motion.span className="notfound__face" aria-hidden="true" initial={{ y: 30, opacity: 0, rotate: -8 }} animate={{ y: 0, opacity: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 14, delay: 0.1 }}>
        <Mascot size={96} mood="oops" title="" />
      </motion.span>
      <span className="eyebrow">404</span>
      <h1 className="display">{copy.title}</h1>
      <p className="muted">{copy.body}</p>
      <div className="notfound__actions">
        <Link to={copy.to} className="btn btn--dark">{copy.cta}</Link>
        {kind !== 'page' && copy.to !== FEED_PATH && <Link to={FEED_PATH} className="btn btn--ghost">back to the feed</Link>}
      </div>
    </section>
  )
}
