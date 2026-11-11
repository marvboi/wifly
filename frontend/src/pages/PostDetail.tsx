import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { adoptDrops, api, type ApiDrop } from '../api/client'
import { useRegistry } from '../api/session'
import { useThread } from '../api/hooks'
import type { Post } from '../state/registry'
import { users } from '../state/registry'
import { PostCard } from '../components/PostCard'
import { Composer } from '../components/Composer'
import { PageHead } from '../components/Shell'
import { Sentinel } from '../components/Social'
import { NotFound } from './NotFound'
import { Blank, PostSkel } from '../components/Delight'

export function PostDetail() {
  const { id = '' } = useParams()
  useRegistry()
  const q = useThread(id)
  const [more, setMore] = useState<{ posts: Post[]; next: string | null } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  if (q.isError) return (q.error as { status?: number }).status === 404
    ? <><PageHead title="drop" back /><NotFound kind="post" /></>
    : <><PageHead title="drop" back /><div className="empty empty--card"><p className="strong">couldn’t open this drop.</p><p className="muted small">check your connection, then go back and try again.</p></div></>
  if (!q.data) return <><PageHead title="drop" back /><PostSkel n={1} media={false} /><div className="section-label">replies</div><div className="feed"><PostSkel n={2} media={false} /></div></>

  const { drop, ancestors } = q.data
  const list = [...q.data.replies, ...(more?.posts ?? [])].filter((p, i, a) => a.findIndex(x => x.id === p.id) === i)
  const next = more ? more.next : q.data.next
  const loadMore = async () => {
    if (!next || loadingMore) return
    setLoadingMore(true)
    try {
      const r = await api<{ replies: ApiDrop[]; next: string | null }>(`/drops/${id}/replies?cursor=${encodeURIComponent(next)}`)
      setMore(m => ({ posts: [...(m?.posts ?? []), ...adoptDrops(r.replies)], next: r.next }))
    } finally { setLoadingMore(false) }
  }
  return (
    <>
      <PageHead title={drop.replyTo ? 'reply' : 'drop'} back sub={`by ${users[drop.author]?.name ?? drop.author}`} />
      {ancestors.length > 0 && (
        <div className="thread-up">
          {ancestors.map(a => <PostCard key={a.id} post={a} variant="thread" line />)}
        </div>
      )}
      <PostCard post={drop} variant="focal" showReplyTo />
      <div className="thread-reply"><Composer replyTo={drop.id} compact placeholder={`reply to @${drop.author}`} /></div>
      <div className="section-label">{drop.replies ? `${drop.replies} ${drop.replies === 1 ? 'reply' : 'replies'}` : 'replies'}</div>
      <div className="feed">
        {list.length ? list.map(r => <div className="feed__item" key={r.id}><PostCard post={r} showReplyTo={false} /></div>) : <Blank size={48} title="no replies yet" body="start the thread." />}
      </div>
      {list.length > 0 && <Sentinel active={!!next} onMore={loadMore} />}
    </>
  )
}
