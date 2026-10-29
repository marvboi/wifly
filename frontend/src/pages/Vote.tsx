import { profilePath } from '../lib/paths'
import { useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { api, adoptUser, type ApiUser } from '../api/client'
import { useSession } from '../api/session'
import { useStore } from '../state/store'
import { Avatar } from '../components/Bits'
import { Icon } from '../components/Icon'
import { PlusMark } from '../components/BrandSlots'
import { at } from '../lib/format'
import { FEE_SPLIT, VOTE_PRICE } from '../config'
import { useEpochState } from '../lib/wifly'
import { ClaimRewards, WeekPotCard } from '../components/WeeklyPot'
import { Corners } from '../components/Bits'
import { PageHead } from '../components/Shell'
import { Mascot } from '../components/Mascot'
import { Blank, SkelRows } from '../components/Delight'


/** Creator of the week. The pot fills with FEE_SPLIT.pot of every fee plus CLAIM_SPLIT.pot of name claims (fundPot).
 *  finalizeEpoch pays payablePot(): the pot minus what arrived this week.
 *  Standings come from the chain only. Until votes exist the page says so instead of showing a leaderboard. */
export function Vote() {
  const ep = useEpochState()
  const { hash } = useLocation()
  // /pot lands here as /vote#pot; the shell scrolls to the top on navigation, so scroll after it
  useEffect(() => {
    if (hash !== '#pot') return
    const t = setTimeout(() => document.getElementById('pot')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 350)
    return () => clearTimeout(t)
  }, [hash])
  const winnerShare = ep?.winnerShare ?? 0.5
  const voterShare = ep?.voterShare ?? 0.5
  const liveLeader = ep?.leader && !/^0x0{40}$/i.test(ep.leader) ? ep.leader : undefined

  return (
    <>
      <PageHead title="vote" back />
      <section className="vote-hero">
        <Corners />
        <div className="vote-hero__copy">
          <h2 className="display">back a creator. the top one takes the weekly community pot.</h2>
          <p className="muted">{VOTE_PRICE} wif a vote. the top creator takes {Math.round(winnerShare * 100)}%, their voters share {Math.round(voterShare * 100)}%.</p>
        </div>
        <div className="vote-hero__peek" aria-hidden="true">
          <motion.span className="vote-hero__face" initial={{ y: '70%' }} animate={{ y: '18%' }} whileHover={{ y: '4%' }}
            transition={{ type: 'spring', stiffness: 160, damping: 16, delay: 0.25 }}>
            <Mascot size={132} mood="think" title="" />
          </motion.span>
        </div>
      </section>

      <div id="pot"><WeekPotCard /></div>
      <ClaimRewards />

      {liveLeader && <p className="small vote-leader">leading right now: <span className="mono">{liveLeader.slice(0, 6)}…{liveLeader.slice(-4)}</span></p>}
      <VoteList />

      <details className="vote-split card">
        <summary><span className="strong">where your vote goes</span><Icon name="chevron" size={16} /></summary>
        <ul className="vote-split__list small">
          <li><b className="num">{FEE_SPLIT.pot}%</b> weekly community pot</li>
          <li><b className="num">{FEE_SPLIT.burn}%</b> burned forever</li>
        </ul>
      </details>

      <section className="rules">
        <h3 className="section-title">how it works</h3>
        <ul className="rules__list">
          <li><span className="num">01</span><p>vote as many times as you like.</p></li>
          <li><span className="num">02</span><p>you can’t vote for yourself. weeks run on a fixed 7-day clock.</p></li>
        </ul>
      </section>

      <section className="past">
        <h3 className="section-title">past winners</h3>
        <p className="muted small">no weeks have closed yet.</p>
      </section>
    </>
  )
}

/** Creators with real recent activity, each with its own vote button. Nothing is listed until people have posted. */
function VoteList() {
  const { me } = useSession()
  const { openSheet } = useStore()
  const q = useQuery({ queryKey: ['creators', 12, me?.handle], queryFn: async () => {
    const r = await api<{ users: (ApiUser & { drops: number })[] }>('/creators?limit=12')
    r.users.forEach(adoptUser); return r.users
  } })
  if (q.isLoading) return <section className="vote-list card"><SkelRows n={3} /></section>
  if (!q.data?.length) return (
    <section className="standings-empty">
      <Blank mood="think" size={56} title="no creators to vote for yet" action={<Link to="/search?type=people" className="btn btn--ghost btn--sm">find creators</Link>} />
    </section>
  )
  return (
    <section className="vote-list card" aria-label="vote for a creator">
      <h3 className="section-title">vote for a creator</h3>
      <ul>
        {q.data.map((u, i) => (
          <motion.li key={u.handle} className="vote-row" layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 26, delay: Math.min(i, 8) * 0.045 }}>
            <Link to={profilePath(u.handle)} className="vote-row__who">
              <Avatar handle={u.handle} size={40} />
              <span className="vote-row__main">
                <span className="vote-row__name"><span className="clamp-1">{u.name}</span>{u.plus && <PlusMark size={14} />}</span>
                <span className="muted small clamp-1">{at(u.handle)} · {u.drops} {u.drops === 1 ? 'drop' : 'drops'} lately</span>
              </span>
            </Link>
            <motion.button whileTap={{ scale: 0.94 }} className="btn btn--ghost btn--sm" aria-label={`vote for ${u.name}`}
              onClick={() => me ? openSheet({ type: 'vote', handle: u.handle }) : openSheet({ type: 'signin' })}>
              <Icon name="vote" size={14} /> vote
            </motion.button>
          </motion.li>
        ))}
      </ul>
    </section>
  )
}
