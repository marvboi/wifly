import { useLinked } from '../components/LinkAccounts'
import { ListNameButton } from '../components/ListName'
import { NameCard, nameArtUrl } from '../components/WifName'
import { BumpNotice } from '../components/Identity'
import { at } from '../lib/format'
import { PlusMark, TipJar } from '../components/BrandSlots'
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Sheet } from '../sheets/Sheets'
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
import { MetaItem } from '../components/Meta'
import { GuestWall } from '../components/GuestWall'
import { Mascot } from '../components/Mascot'
import { FollowButton, RichText, Sentinel, UserRow, useNeedLink } from '../components/Social'
import { Blank, PostSkel, ProfileSkel, SkelRows } from '../components/Delight'
import { AnimatedNumber } from '../components/Motion'
import { useReadContract } from 'wagmi'
import { zeroAddress } from 'viem'
import { NAMES_ADDRESS, robinhoodChain } from '../config'
import { namesAbi } from '../contracts/namesAbi'
import { CopyBtn } from '../components/WalletsSection'
import { shortAddr } from '../components/WalletProofs'
import { userError } from '../lib/txError'

/** the wallet that holds the .wif onchain (ownerOfName), else the profile's main wallet. */
function NameHolder({ name, fallback }: { name: string; fallback?: string | null }) {
  const q = useReadContract({ address: NAMES_ADDRESS ?? zeroAddress, abi: namesAbi, functionName: 'ownerOfName', args: [name], chainId: robinhoodChain.id, query: { enabled: !!NAMES_ADDRESS } })
  const onchain = typeof q.data === 'string' && q.data !== zeroAddress ? q.data.toLowerCase() : null
  const a = onchain ?? fallback?.toLowerCase() ?? null
  if (!a) return null
  return <p className="muted small wifsheet__held" data-testid="wif-holder"><span>held in <span className="mono">{shortAddr(a)}</span></span><CopyBtn text={a} label={`copy ${shortAddr(a)}`} /></p>
}

type Tab = 'drops' | 'replies' | 'media' | 'names' | 'shop' | 'support'

const EMPTY = {
  drops: ['no drops yet', 'your first drop shows up here.', 'nothing posted yet.'],
  replies: ['no replies yet', 'replies you make show up here.', 'no replies yet.'],
  media: ['no images yet', 'drops with photos collect here.', 'no photos yet.'],
} as const
function DropList({ handle, tab, mine }: { handle: string; tab: 'drops' | 'replies' | 'media'; mine?: boolean }) {
  const q = usePaged(['udrops', handle, tab], `/users/${handle}/drops?tab=${tab}`)
  const { openSheet } = useStore()
  if (q.isLoading) return <PostSkel n={3} />
  if (!q.rows.length) return (
    <div className="pro-empty" data-testid={`empty-${tab}`}>
      <p className="strong">{EMPTY[tab][0]}</p>
      <p className="muted small">{mine ? EMPTY[tab][1] : EMPTY[tab][2]}</p>
      {mine && tab === 'drops' && <button className="btn btn--ghost btn--sm" onClick={() => openSheet({ type: 'compose' })}>write a drop</button>}
    </div>
  )
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

type HeldName = { name: string; display: string; current: boolean; minted: boolean; theme: number; listing: { price: number } | null }

/** The "names" tab: every .wif this person holds, their current name first. */
function NamesTab({ handle, mine }: { handle: string; mine: boolean }) {
  const q = useQuery({ queryKey: ['unames', handle], queryFn: () => api<{ names: HeldName[] }>(`/users/${handle}/names`) })
  if (q.isLoading) return <SkelRows n={2} />
  const names = q.data?.names ?? []
  if (!names.length) return (
    <div className="pro-empty" data-testid="names-empty">
      <p className="strong">{mine ? 'no .wif names yet' : 'no .wif names yet'}</p>
      <p className="muted small">{mine ? 'a .wif is your name, onchain. it can go with you anywhere.' : `${at(handle)} doesn’t hold a .wif yet.`}</p>
      {mine && <Link className="btn btn--ghost btn--sm" to="/names">get a .wif</Link>}
    </div>
  )
  return (
    <ul className="pro-names" data-testid="names-tab">
      {names.map(n => (
        <li key={n.name}>
          <Link to={`/n/${n.name}`} className="pro-names__row">
            <img className="pro-names__art" src={nameArtUrl(n.name, n.theme)} alt="" loading="lazy" width={56} height={56} />
            <span className="pro-names__txt"><b>{n.name}<span className="wifsfx">.wif</span></b>
              <span className="muted tiny">{n.current ? 'current name' : n.listing ? `for sale · ${n.listing.price} wif` : 'held'}</span></span>
            <Icon name="chevron" size={16} />
          </Link>
        </li>
      ))}
    </ul>
  )
}

/** "..." on a profile: the quieter actions, in a small menu. */
function MoreMenu({ items }: { items: Array<{ label: string; icon: Parameters<typeof Icon>[0]['name']; on: () => void; pressed?: boolean }> }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', off); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc) }
  }, [open])
  return (
    <div className="pro-more" ref={box}>
      <button type="button" className="btn btn--ghost btn--icon pro-act" aria-label="more" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(o => !o)}><Icon name="more" size={18} /></button>
      {open && <div className="pro-more__menu" role="menu">
        {items.map(i => <button key={i.label} role="menuitem" type="button" aria-pressed={i.pressed} onClick={() => { setOpen(false); i.on() }}><Icon name={i.icon} size={16} /> {i.label}</button>)}
      </div>}
    </div>
  )
}

function ProfileOf({ handle }: { handle: string }) {
  const q = useProfile(handle)
  const u = useUser(handle)
  const { subs, openSheet, toast } = useStore()
  const { me: session } = useSession()
  const qc = useQueryClient()
  const nav = useNavigate()
  const need = useNeedLink()
  const [tab, setTab] = useState<Tab>('drops')
  const [wifOpen, setWifOpen] = useState(false)
  const moved = (q.error as { redirect?: string } | null)?.redirect
  if (moved) return <Navigate to={profilePath(moved)} replace />
  if (!u && q.isLoading) return <><PageHead title="profile" back /><div className="profile"><ProfileSkel /><PostSkel n={2} /></div></>
  if (!u) return <><PageHead title="profile" back /><NotFound kind="profile" handle={handle} /></>
  const me = !!session && u.handle === session.handle
  const live = !!q.data
  const sub = subs[u.handle]
  const subTier = u.tiers?.find(t => t.id === sub)
  const tabs: Array<[Tab, string]> = [['drops', 'drops'], ['replies', 'replies'], ['media', 'media'], ['names', 'names'], ...(u.shop ? [['shop', 'shop'] as [Tab, string]] : []), ...(u.tiers ? [['support', 'tiers'] as [Tab, string]] : [])]
  const mute = async () => {
    if (!session) { openSheet({ type: 'signin' }); return }
    try {
      const r = await api<{ user: ApiUser }>(`/users/${u.handle}/mute`, { method: u.muted ? 'DELETE' : 'POST' })
      adoptUser(r.user); qc.invalidateQueries({ queryKey: ['feed'] }); toast(r.user.muted ? `muted @${u.handle}. you won’t see their drops.` : `unmuted @${u.handle}`)
    } catch (e) { toast('that didn’t go through', userError(e)) }
  }
  const message = () => need(() => nav(`/messages/${u.handle}`), 'sign in to message')
  const canDm = live && !u.blocked && !u.blocksYou
  const share = async () => {
    const url = `${location.origin}${profilePath(u.handle)}`
    try {
      if (navigator.share) await navigator.share({ url, title: u.wifName ? `${u.wifName}.wif` : u.name })
      else { await navigator.clipboard.writeText(url); toast('link copied') }
    } catch { /* closed the share sheet */ }
  }
  const stat = (n: number, label: string) => <><b className="num"><AnimatedNumber from={0} value={n} /></b> {label}</>

  return (
    <>
      <PageHead title={u.wifName ? `${u.wifName}.wif` : u.name || 'profile'} back />
      <div className="profile">
        <section className="pro" data-testid="profile-head">
          <div className="pro__cover" aria-hidden="true"><FlatDisc className="pro__disc" /></div>
          <div className="pro__top">
            <motion.span className="pro__av" initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 380, damping: 22 }}><Avatar handle={u.handle} size={92} /></motion.span>
            <div className="pro__acts" data-testid="profile-actions">
              {me ? <>
                <button className="btn btn--ghost pro-act" onClick={() => openSheet({ type: 'profile' })}>edit profile</button>
                <button className="btn btn--ghost btn--icon pro-act" aria-label="share profile" title="share" onClick={share}><Icon name="share" size={17} /></button>
                <Link className="btn btn--ghost btn--icon pro-act" to="/settings" aria-label="settings" title="settings"><Icon name="settings" size={18} /></Link>
              </> : <>
                {live && <FollowButton handle={u.handle} />}
                {canDm && <button className="btn btn--ghost btn--icon pro-act" aria-label={`message ${at(u.handle)}`} title="message" data-testid="profile-message" onClick={message}><Icon name="mail" size={17} /></button>}
                <button className="btn btn--ghost btn--icon pro-act" aria-label={`tip ${at(u.handle)}`} title="tip" onClick={() => openSheet({ type: 'tip', to: u.handle })}><TipJar size={17} title="" /></button>
                <button className="btn btn--ghost btn--icon pro-act" aria-label="share profile" title="share" onClick={share}><Icon name="share" size={17} /></button>
                <MoreMenu items={[
                  { label: 'vote', icon: 'vote', on: () => openSheet({ type: 'vote', handle: u.handle }) },
                  ...(live ? [{ label: u.muted ? 'unmute' : 'mute', icon: 'mute' as const, on: mute, pressed: !!u.muted }] : []),
                ]} />
              </>}
            </div>
          </div>
          <div className="pro__id">
            <h1 className="pro__name" data-testid="profile-name">
              {u.wifName
                ? <button type="button" className="pro__wif" data-testid="wif-name" onClick={() => setWifOpen(true)} aria-label={`${u.wifName}.wif, open the name card`}>{u.wifName}<span className="wifsfx">.wif</span></button>
                : <span className="clamp-1">{u.name}</span>}
              {u.plus && <PlusMark size={20} />}
            </h1>
            <div className="pro__handle">{at(u.handle)}{u.followsYou && <span className="chip-soft">follows you</span>}</div>
            {u.wifName && q.data?.formerly && <div className="muted tiny">formerly @{q.data.formerly.name}</div>}
            {u.bio && <RichText text={u.bio} className="pro__bio" />}
            <div className="pro__row" data-testid="profile-stats">
              <span className="pro__stat">{stat(u.drops ?? 0, 'drops')}</span>
              <Link className="pro__stat" to={followPath(u.handle, 'followers')}>{stat(u.followers, u.followers === 1 ? 'follower' : 'followers')}</Link>
              <Link className="pro__stat" to={followPath(u.handle, 'following')}>{stat(u.following, 'following')}</Link>
              {u.supporters !== undefined && <span className="pro__stat">{stat(u.supporters, 'supporters')}</span>}
              <MetaItem icon="calendar" className="pro__stat pro__stat--quiet">joined {u.joined.toLowerCase()}</MetaItem>
              {u.location && <MetaItem icon="mapPin" className="pro__stat pro__stat--quiet">{u.location}</MetaItem>}
            </div>
          </div>
          {me && <KeepNudge />}
          <AnimatePresence>{wifOpen && u.wifName && (
            <Sheet title={`${u.wifName}.wif`} onClose={() => setWifOpen(false)}
              footer={<div className="listsheet__acts">
                <Link className="btn btn--dark btn--block" to={`/n/${u.wifName}`} onClick={() => setWifOpen(false)}>open the name page</Link>
                {me && <ListNameButton name={u.wifName} />}</div>}>
              <div className="profile__wifsheet" data-testid="wif-card"><NameCard size="md" label={u.wifName} state={me ? 'yours' : 'idle'} theme={(u as { wifTheme?: number }).wifTheme} />
                <NameHolder name={u.wifName} fallback={u.address} /></div>
            </Sheet>)}</AnimatePresence>
        </section>

        {u.tiers && !me && (
          <div className="sub-cta">
            <div>
              <div className="strong">{subTier ? `you’re a ${subTier.name.toLowerCase()}` : `support ${u.name.split(' ')[0]}`}</div>
              <div className="muted small">{subTier ? 'renews monthly. your agent can handle it.' : `from ${u.tiers[0].price} wif a month. supporter posts, a badge and the supporter chat.`}</div>
            </div>
            <button className="btn btn--dark" onClick={() => openSheet({ type: 'subscribe', handle: u.handle })}>{subTier ? 'manage' : 'subscribe'}</button>
          </div>
        )}

        {me && <BumpNotice />}

        <div className="pro-tabs" role="tablist" aria-label="profile sections">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'is-on' : ''} onClick={() => setTab(id)}>
              {label}{tab === id && <motion.span layoutId="profile-tab" className="pro-tabs__bar" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
            </button>
          ))}
        </div>

        {(tab === 'drops' || tab === 'replies' || tab === 'media') && (live ? <DropList key={tab} handle={u.handle} tab={tab} mine={me} /> : <p className="empty">no drops yet.</p>)}
        {tab === 'names' && <NamesTab handle={u.handle} mine={me} />}

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

const NUDGE_KEY = 'wifly:keep-nudge-off'
/** Your own profile, one way in so far (a guest key, or just one of x / email / wallet): one slim, dismissible line. */
function KeepNudge() {
  const { me, login } = useSession()
  const { x, wallets } = useLinked()
  const [off, setOff] = useState(() => { try { return localStorage.getItem(NUDGE_KEY) === '1' } catch { return false } })
  const ways = (x ? 1 : 0) + wallets.length + (login?.method === 'email' ? 1 : 0)
  if (off || !me || ways > 1) return null
  return (
    <div className="pro-nudge" data-testid="keep-nudge">
      <p className="pro-nudge__text small">link x or a wallet to keep this account.<Link className="linkbtn" to="/settings#accounts">link</Link></p>
      <button type="button" className="pro-nudge__x" aria-label="dismiss" onClick={() => { setOff(true); try { localStorage.setItem(NUDGE_KEY, '1') } catch { /* private mode */ } }}><Icon name="close" size={14} /></button>
    </div>
  )
}
