import { Blank } from '../components/Delight'
import { GuestWall } from '../components/GuestWall'
import { at } from '../lib/format'
import { useSession, useUser } from '../api/session'
import { Mascot } from '../components/Mascot'
import { PlusMark, TipJar } from '../components/BrandSlots'
import { Link, useParams } from 'react-router-dom'
import { useStore } from '../state/store'
import { Avatar } from '../components/Bits'
import { PageHead } from '../components/Shell'
import { Icon } from '../components/Icon'

export function Inbox() {
  const { me, ready } = useSession()
  if (ready && !me) return <><PageHead title="messages" /><GuestWall line="message people on wifly directly. messages are on the way, and you’ll need an account to send one." /></>
  return <InboxInner />
}
function InboxInner() {
  return (
    <>
      <PageHead title="messages" />
      <div className="empty empty--card">
        <Mascot size={64} />
        <p className="strong">no messages yet.</p>
        <p className="muted small">direct messages are on the way. until then, you can tip or follow people from their profile.</p>
        <Link to="/search?type=people" className="btn btn--ghost btn--sm">find people</Link>
      </div>
    </>
  )
}

export function Thread() {
  const { me, ready } = useSession()
  if (ready && !me) return <><PageHead title="messages" back /><GuestWall line="message people on wifly directly. messages are on the way, and you’ll need an account to send one." /></>
  return <ThreadInner />
}
function ThreadInner() {
  const { handle = '' } = useParams()
  const { paidDms, openSheet } = useStore()
  const u = useUser(handle)
  const needsPay = !!u?.dmPrice && !u.followsYou && !paidDms.has(handle)
  if (!u) return <><PageHead title="messages" back /><Blank title="no one here by that name." body="maybe a typo, or they changed their name." mood="oops" action={<Link to="/search?type=people" className="btn btn--ghost btn--sm">find people</Link>} /></>
  return (
    <div className="dm">
      <PageHead title={u.name} back sub={`${at(u.handle)}`} right={<button className="icon-btn" aria-label="tip" onClick={() => openSheet({ type: 'tip', to: handle })}><TipJar size={17} title="" /></button>} />
      <div className="dm__scroll">
        <div className="dm__intro"><Avatar handle={handle} size={64} /><div className="strong">{u.name}{u.plus && <PlusMark size={14} />}</div><div className="muted small">{at(u.handle)} · {u.followers.toLocaleString()} followers</div></div>
        <p className="muted small dm__note">no messages yet. direct messages are on the way.</p>
      </div>
      {needsPay ? (
        <div className="paywall">
          <span className="paywall__icon"><Icon name="lock" size={18} /></span>
          <div><div className="strong">{u.name} charges {u.dmPrice} WIF for a first message</div><div className="muted small">from people they don’t follow. replies are free after that.</div></div>
          <button className="btn btn--dark" onClick={() => openSheet({ type: 'paydm', handle })}>pay {u.dmPrice} WIF</button>
        </div>
      ) : (
        <div className="dm__compose">
          <button className="btn btn--dark btn--block" onClick={() => openSheet({ type: 'tip', to: handle })}><Icon name="tip" size={18} /> send a tip</button>
        </div>
      )}
    </div>
  )
}
