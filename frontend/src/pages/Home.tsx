import { PostSkel } from '../components/Delight'
import { motion } from 'motion/react'
import { Fragment, useEffect, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useStore } from '../state/store'
import { useSession } from '../api/session'
import { useFeed, useNewDrops, type FeedTab } from '../api/hooks'
import { PostCard } from '../components/PostCard'
import { Composer } from '../components/Composer'
import { NewPill, Sentinel, Trending, WhoToFollow } from '../components/Social'
import { WorldStrip } from '../components/TopSpot'
import { Icon } from '../components/Icon'
import { GuestNudge, GuestWall } from '../components/GuestWall'
import { Mascot } from '../components/Mascot'
import { BumpNotice, NameNudge } from '../components/Identity'
import { FEE_SPLIT } from '../config'
import { ShortcutRow, ToolsRail } from '../components/Tools'

const tabs: Array<{ id: FeedTab; label: string }> = [
  { id: 'foryou', label: 'for you' },
  { id: 'following', label: 'following' },
  { id: 'crowd', label: 'most voted' },
]

function FeedSkeleton() {
  return <PostSkel n={4} />
}

export function Home() {
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as FeedTab) || 'foryou'
  const { openSheet } = useStore()
  const { me, ready } = useSession()
  useEffect(() => {
    if (params.get('compose')) { openSheet({ type: 'compose' }); setParams({}, { replace: true }) }
  }, [params, openSheet, setParams])

  const feed = useFeed(tab)
  const since = useMemo(() => {
    const top = feed.rows.find(r => !r.passedBy)?.post.createdAt
    return Math.max(feed.snapshot ?? 0, top ?? 0) || undefined
  }, [feed.rows, feed.snapshot])
  const fresh = useNewDrops(tab, tab === 'crowd' ? undefined : since)
  const showNew = async () => { window.scrollTo({ top: 0, behavior: 'smooth' }); await fresh.refresh() }

  return (
    <>
      <div className="home-grid">
        <div className="column">
          <header className="home-head">
            <h1 className="home-head__title">post anything. get tipped in $wif.</h1>
          </header>
          <div className="home-compose home-compose--first"><Composer compact /></div>
          <ShortcutRow />
          {me && <div className="home-id"><BumpNotice /><NameNudge /></div>}
          <WorldStrip />
          <div className="feed-switch">
            <div className="seg seg--feed" role="tablist" aria-label="feeds">
              {tabs.map(t => (
                <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'is-on' : ''}
                  onClick={() => { if (t.id === tab) { window.scrollTo({ top: 0, behavior: 'smooth' }); feed.refetch() } else setParams(t.id === 'foryou' ? {} : { tab: t.id }, { replace: true }) }}>
                  {tab === t.id && <motion.span layoutId="feed-tab" className="seg__pill" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
                  <span className="seg__label">{t.label}</span>
                </button>
              ))}
            </div>
            <NewPill count={fresh.count} avatars={fresh.authors} onClick={showNew} />
          </div>

          {tab === 'crowd' && (
            <div className="crowd-note">
              <Icon name="vote" size={18} />
              <p><b>the crowd decides what rises.</b> each vote costs wif — {FEE_SPLIT.pot}% to the weekly pot, {FEE_SPLIT.burn}% burned.</p>
            </div>
          )}

          {feed.isError && (
            <div className="empty empty--card">
              <Mascot size={56} mood="oops" />
              <p className="strong">couldn’t load the feed.</p>
              <p className="muted small">check your connection, then try again.</p>
              <button className="btn btn--ghost btn--sm" onClick={() => feed.refetch()}>try again</button>
            </div>
          )}

          {tab === 'following' && feed.signedOut && (
            <div className="empty empty--card">
              <Mascot size={64} />
              <p className="strong">your following feed lives here.</p>
              <p className="muted small">sign in and follow a few people. their drops show up here, newest first.</p>
              <button className="btn btn--dark btn--sm" onClick={() => openSheet({ type: 'signin' })}>sign in</button>
            </div>
          )}
          {tab === 'following' && !feed.signedOut && feed.isSuccess && feed.rows.length === 0 && (
            <div className="empty empty--card">
              <p className="strong">nobody here yet.</p>
              <p className="muted small">follow people and their drops land here in order, newest first.</p>
              <WhoToFollow limit={4} title="start with these" />
            </div>
          )}

          {tab !== 'following' && feed.isSuccess && feed.rows.length === 0 && (
            <div className="empty empty--card">
              <Mascot size={64} mood={tab === 'crowd' ? 'think' : 'calm'} />
              <p className="strong">{tab === 'crowd' ? 'no votes yet.' : 'no posts yet. be the first.'}</p>
              <p className="muted small">{tab === 'crowd' ? 'drops with the most votes show up here.' : me ? 'whatever people post shows up here, newest and best first.' : 'sign in at the top to post the first drop.'}</p>
              {tab !== 'crowd' && me && <button className="btn btn--dark btn--sm" onClick={() => openSheet({ type: 'compose' })}>write a drop</button>}
            </div>
          )}

          <div className="feed">
            {feed.isLoading && <FeedSkeleton />}
            {feed.rows.map((r, i) => (
              <Fragment key={`${tab}-${r.key}`}>
                <div className="feed__item">
                  <PostCard post={r.post} passedBy={r.passedBy} why={tab === 'foryou' ? r.why : undefined} rank={tab === 'crowd' ? i + 1 : undefined} />
                </div>
                {i === 2 && tab !== 'crowd' && <div className="feed__item feed__inline"><WhoToFollow limit={3} /></div>}
                {i === 8 && <div className="feed__item feed__inline"><Trending limit={5} /></div>}
                {i === 4 && ready && !me && <div className="feed__item feed__inline"><GuestNudge /></div>}
              </Fragment>
            ))}
          </div>
          {feed.guest?.more && <GuestWall line="the rest of the feed, the people and the weekly community pot are a sign-up away." />}
          {feed.rows.length > 0 && !feed.guest && (
            <Sentinel active={!!feed.hasNextPage} onMore={() => { if (!feed.isFetchingNextPage) feed.fetchNextPage() }}
              done={<div className="feed-end muted small">you’re all caught up. {me ? <Link to="/search" className="rt-link">find more people</Link> : null}</div>} />
          )}
        </div>

        <aside className="rail" aria-label="discover">
          <Link to="/search" className="rail__search"><Icon name="search" size={18} /> search wifly</Link>
          <Trending limit={6} />
          <WhoToFollow limit={3} />
          <ToolsRail />
        </aside>
      </div>
    </>
  )
}
