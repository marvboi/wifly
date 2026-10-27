import { LinkList, useLinked } from '../components/LinkAccounts'
import { NameCard, WifName } from '../components/WifName'
import { BumpNotice, MakeItYours } from '../components/Identity'
import { at } from '../lib/format'
import { PlusMark, TipJar } from '../components/BrandSlots'
import { BadgeShelf } from '../components/Badges'
import { useState } from 'react'
import { motion } from 'motion/react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { followPath, profilePath } from '../lib/paths'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { users } from '../state/registry'
import { useStore } from '../state/store'
import { useSession, useUser } from '../api/session'
import { usePaged, useProfile } from '../api/hooks'
import { NotFound } from './NotFound'
import { adoptUser, api, type ApiUser } from '../api/client'
import { PostCard } from '../components/PostCard'
import { Amount, Avatar, FlatDisc } from '../components/Bits'
import { PageHead } from '../components/Shell'
import { Icon } from '../components/Icon'
import { GuestWall } from '../components/GuestWall'
import { Mascot } from '../components/Mascot'
import { FollowButton, RichText, Sentinel, UserRow } from '../components/Social'
import { Blank, PostSkel, ProfileSkel, SkelRows } from '../components/Delight'
import { AnimatedNumber } from '../components/Motion'

type Tab = 'drops' | 'replies' | 'media' | 'likes' | 'badges' | 'shop' | 'support'

function DropList({ handle, tab }: { handle: string; tab: 'drops' | 'replies' | 'media' | 'likes' }) {
  const q = usePaged(['udrops', handle, tab], `/users/${handle}/drops?tab=${tab}`)
  if (q.isLoading) return <PostSkel n={3} />
  if (!q.rows.length) return <Blank size={56} title={{ drops: 'no drops yet', replies: 'no replies yet', media: 'no images yet', likes: 'no likes yet' }[tab]} />
  return (
    <>
      <div className="feed">{q.rows.map(r => <div className="feed__item" key={r.key}><PostCard post={r.post} passedBy={r.passedBy} /></div>)}</div>
      {q.guest?.more && <GuestWall line={`see everything ${at(handle)} posts, and follow along.`} />}
      <Sentinel active={!!q.hasNextPage} onMore={() => { if (!q.isFetchingNextPage) q.fetchNextPage() }} />
    </>
  )
}

/** /@you: your own profile when signed in, a sign-in card when not. */
function You() {
  const { me, ready } = useSession()
  const { openSheet } = useStore()
  if (me) return <Navigate to={profilePath(me.handle)} replace />
  if (!ready) return null
  return (
    <>
      <PageHead title="you" back />
      <div className="empty empty--card">
        <Mascot size={72} />
        <p className="strong">you’re not signed in.</p>
        <p className="muted small">sign a message (not a transaction) and you get a profile, a feed that learns what you like, and people to follow.</p>
        <button className="btn btn--dark" onClick={() => openSheet({ type: 'signin' })}>sign in</button>
      </div>
    </>
  )
}

export function Profile(props: { handle?: string }) {
  const params = useParams()
  const handle = props.handle ?? params.handle ?? 'you'
  if (handle === 'you') return <You />
  return <ProfileOf key={handle} handle={handle} />
}

function ProfileOf({ handle }: { handle: string }) {
  const q = useProfile(handle)
  const u = useUser(handle)
  const { subs, openSheet, paidDms, toast } = useStore()
  const { me: session } = useSession()
  const qc = useQueryClient()
  const nav = useNavigate()
  const [tab, setTab] = useState<Tab>('drops')
  const moved = (q.error as { redirect?: string } | null)?.redirect
  if (moved) return <Navigate to={profilePath(moved)} replace />
  if (!u && q.isLoading) return <><PageHead title="profile" back /><div className="profile"><ProfileSkel /><PostSkel n={2} /></div></>
  if (!u) return <><PageHead title="profile" back /><NotFound kind="profile" handle={handle} /></>
  const me = !!session && u.handle === session.handle
  const live = !!q.data
  const isFollowing = !!u.youFollow
  const sub = subs[u.handle]
  const subTier = u.tiers?.find(t => t.id === sub)
  const tabs: Array<[Tab, string]> = [['drops', 'drops'], ['replies', 'replies'], ['media', 'media'], ['likes', 'likes'], ['badges', 'badges'], ...(u.shop ? [['shop', 'shop'] as [Tab, string]] : []), ...(u.tiers ? [['support', 'tiers'] as [Tab, string]] : [])]
  const mute = async () => {
    if (!session) { openSheet({ type: 'signin' }); return }
    try {
      const r = await api<{ user: ApiUser }>(`/users/${u.handle}/mute`, { method: u.muted ? 'DELETE' : 'POST' })
      adoptUser(r.user); qc.invalidateQueries({ queryKey: ['feed'] }); toast(r.user.muted ? `muted @${u.handle}. you won’t see their drops.` : `unmuted @${u.handle}`)
    } catch (e) { toast('that didn’t go through', (e as Error).message) }
  }

  const message = () => {
    if (u.dmPrice && !u.followsYou && !paidDms.has(u.handle)) openSheet({ type: 'paydm', handle: u.handle })
    else nav(`/messages/${u.handle}`)
  }

  return (
    <>
      <PageHead title="profile" back />
      <div className="profile">
        <section className="pcard">
          <div className="pcard__banner" aria-hidden="true">
            <FlatDisc className="pcard__disc" />
            <span className="pcard__stamp">{u.creator ? 'creator since' : 'since'} {u.joined.toLowerCase()}</span>
          </div>
          <div className="pcard__body">
            <div className="pcard__id">
              <motion.span className="pcard__av" initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 380, damping: 18 }}><Avatar handle={u.handle} size={84} /></motion.span>
              <div className="pcard__names">
                <h2 className="profile__name">{u.name} {u.plus && <PlusMark size={20} />}</h2>
                {u.wifName && <div className="profile__wif"><WifName label={u.wifName} /></div>}
                <div className="muted small">{at(u.handle)} {u.followsYou && <span className="chip-soft">follows you</span>}</div>
                {u.wifName && q.data?.formerly && <div className="muted tiny profile__formerly">formerly @{q.data.formerly.name}</div>}
              </div>
            </div>
            {u.wifName && <div className="profile__wifcard"><NameCard size="sm" label={u.wifName} state="yours" theme={(u as { wifTheme?: number }).wifTheme} /></div>}
            {u.bio && <RichText text={u.bio} className="profile__bio" />}
            <div className="profile__meta muted small">
              {u.location && <span><Icon name="globe" size={14} /> {u.location}</span>}
              <span><Icon name="calendar" size={14} /> joined {u.joined.toLowerCase()}</span>
              {u.dmPrice && <span><Icon name="mail" size={14} /> messages {u.dmPrice} WIF</span>}
            </div>
            <div className="pcard__stats">
              <div><b className="num"><AnimatedNumber from={0} value={u.drops ?? 0} /></b><span>drops</span></div>
              <Link to={followPath(u.handle, 'followers')}><b className="num"><AnimatedNumber from={0} value={u.followers} /></b><span>followers</span></Link>
              <Link to={followPath(u.handle, 'following')}><b className="num"><AnimatedNumber from={0} value={u.following} /></b><span>following</span></Link>
              {u.supporters !== undefined && <div><b className="num"><AnimatedNumber from={0} value={u.supporters} /></b><span>supporters</span></div>}
            </div>
            <div className="pcard__actions">
              {me ? (
                <><button className="btn btn--ghost" onClick={() => openSheet({ type: 'profile' })}>edit profile</button><Link className="btn btn--ghost btn--icon" to="/settings" aria-label="settings" title="settings"><Icon name="more" size={18} /></Link>{!u.wifName && <MakeItYours />}</>
              ) : (
                <>
                  {live && <FollowButton handle={u.handle} />}
                  {!live && <span className="muted small">{isFollowing ? 'following' : ''}</span>}
                  <button className="chip chip--tip" onClick={() => openSheet({ type: 'tip', to: u.handle })}><TipJar size={15} title="" /> tip</button>
                  <button className="chip chip--vote" onClick={() => openSheet({ type: 'vote', handle: u.handle })}><Icon name="vote" size={15} /> vote</button>
                  <button className="chip" onClick={message}><Icon name="mail" size={15} /> message</button>
                  {live && <motion.button whileTap={{ scale: 0.95 }} className={`chip ${u.muted ? 'is-on' : ''}`} onClick={mute} aria-pressed={!!u.muted}><Icon name="mute" size={15} /> {u.muted ? 'muted' : 'mute'}</motion.button>}
                </>
              )}
            </div>
            {me && <OwnLinks />}
          </div>
        </section>

        {u.tiers && !me && (
          <div className="sub-cta">
            <div>
              <div className="strong">{subTier ? `you’re a ${subTier.name.toLowerCase()}` : `support ${u.name.split(' ')[0]}`}</div>
              <div className="muted small">{subTier ? 'renews monthly. your agent can handle it.' : `from ${u.tiers[0].price} WIF a month. supporter posts, a badge and the supporter chat.`}</div>
            </div>
            <button className="btn btn--dark" onClick={() => openSheet({ type: 'subscribe', handle: u.handle })}>{subTier ? 'manage' : 'subscribe'}</button>
          </div>
        )}

        {me && <BumpNotice />}


        <div className="feed-switch">
          <div className="seg seg--feed" role="tablist" aria-label="profile sections">
            {tabs.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'is-on' : ''} onClick={() => setTab(id)}>
                {tab === id && <motion.span layoutId="profile-tab" className="seg__pill" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
                <span className="seg__label">{label}</span>
              </button>
            ))}
          </div>
        </div>

        {(tab === 'drops' || tab === 'replies' || tab === 'media' || tab === 'likes') && (live ? <DropList key={tab} handle={u.handle} tab={tab} /> : <p className="empty">no drops yet.</p>)}

        {tab === 'badges' && <BadgeShelf handle={u.handle} mine={me} />}

        {tab === 'shop' && u.shop && (
          <div className="shop">
            {u.shop.map(i => (
              <div key={i.id} className="shop-item">
                <span className="shop-item__thumb"><Icon name={i.kind === 'Digital' ? 'image' : 'calendar'} size={24} /></span>
                <div className="shop-item__body">
                  <span className="chip-soft">{i.kind}</span>
                  <div className="strong">{i.title}</div>
                  <div className="muted small">{i.detail}</div>
                  <div className="muted small"><span className="num">{i.sold}</span> sold</div>
                </div>
                <div className="shop-item__buy">
                  <Amount value={i.price} size={16} />
                  <button className="btn btn--dark btn--sm" onClick={() => openSheet({ type: 'buy', handle: u.handle, itemId: i.id })}>buy</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'support' && u.tiers && (
          <div className="tiers tiers--page">
            {u.tiers.map(t => (
              <div key={t.id} className={`tier ${sub === t.id ? 'is-on' : ''}`}>
                <div className="tier__top"><span className="tier__name">{t.name}</span><span className="tier__price"><Amount value={t.price} size={16} /><span className="muted small">/mo</span></span></div>
                <ul>{t.perks.map(p => <li key={p}><Icon name="check" size={14} /> {p}</li>)}</ul>
                <button className={`btn ${sub === t.id ? 'btn--ghost' : 'btn--dark'} btn--block`} onClick={() => openSheet({ type: 'subscribe', handle: u.handle, tierId: t.id })}>{sub === t.id ? 'current tier' : `choose ${t.name}`}</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

/** /@handle/followers and /@handle/following */
export function FollowList({ kind, handle: given }: { kind: 'followers' | 'following'; handle?: string }) {
  const params = useParams()
  const handle = given ?? params.handle ?? ''
  const q = useQuery({ queryKey: ['ulist', handle, kind], queryFn: async () => {
    const r = await api<{ users: ApiUser[] }>(`/users/${handle}/${kind}`); r.users.forEach(adoptUser); return r.users
  } })
  const name = users[handle]?.name ?? handle
  return (
    <>
      <PageHead title={kind} back sub={`${name} · @${handle}`} />
      <div className="seg seg--feed follow-tabs" role="tablist">
        <Link role="tab" aria-selected={kind === 'followers'} className={kind === 'followers' ? 'is-on' : ''} to={followPath(handle, 'followers')} replace>followers</Link>
        <Link role="tab" aria-selected={kind === 'following'} className={kind === 'following' ? 'is-on' : ''} to={followPath(handle, 'following')} replace>following</Link>
      </div>
      <div className="ulist">
        {q.isLoading && <SkelRows n={4} />}
        {q.data?.length === 0 && <Blank size={56} title={kind === 'followers' ? 'no followers yet' : 'not following anyone yet'} />}
        {q.data?.map(u => <UserRow key={u.handle} user={u} />)}
      </div>
    </>
  )
}

/** On your own profile: link x or a wallet right here until both are linked. */
function OwnLinks() {
  const { all } = useLinked()
  if (all) return null
  return <div className="profile__links" data-testid="profile-links"><p className="tiny muted">link x or a wallet so you can always get back into this account.</p><LinkList compact /></div>
}
