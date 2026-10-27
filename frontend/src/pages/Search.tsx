import { motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useDebounced, useSearch, usePaged, type SearchType } from '../api/hooks'
import { useSession } from '../api/session'
import { useStore } from '../state/store'
import { PostCard } from '../components/PostCard'
import { PageHead } from '../components/Shell'
import { Icon } from '../components/Icon'
import { Mascot } from '../components/Mascot'
import { Creators, Sentinel, Trending, UserRow } from '../components/Social'
import { Blank, PostSkel, SkelRows } from '../components/Delight'

const types: Array<[SearchType, string]> = [['top', 'top'], ['people', 'people'], ['drops', 'latest'], ['tags', 'tags']]

export function Search() {
  const [params, setParams] = useSearchParams()
  const urlQ = params.get('q') ?? ''
  const type = (params.get('type') as SearchType) || 'top'
  const [text, setText] = useState(urlQ)
  useEffect(() => { setText(urlQ) }, [urlQ])
  const q = useDebounced(text.trim(), 250)
  useEffect(() => {
    if (q === urlQ) return
    const p = new URLSearchParams(params); if (q) p.set('q', q); else p.delete('q')
    setParams(p, { replace: true })
  }, [q]) // eslint-disable-line react-hooks/exhaustive-deps
  const input = useRef<HTMLInputElement>(null)
  const res = useSearch(q, type)
  const pages = res.data?.pages ?? []
  const people = pages.flatMap(p => p.users)
  const tags = pages[0]?.tags ?? []
  const drops = pages.flatMap(p => p.posts)
  const setType = (t: SearchType) => { const p = new URLSearchParams(params); if (t === 'top') p.delete('type'); else p.set('type', t); setParams(p, { replace: true }) }
  const empty = res.isSuccess && !people.length && !tags.length && !drops.length

  return (
    <>
      <PageHead title="search" />
      <div className="search-box">
        <Icon name="search" size={18} />
        <input ref={input} value={text} onChange={e => setText(e.target.value)} placeholder="search people, drops, #tags" aria-label="search" autoFocus={!urlQ} enterKeyHint="search" />
        {text && <button className="icon-btn" aria-label="clear" onClick={() => { setText(''); input.current?.focus() }}><Icon name="close" size={16} /></button>}
      </div>
      <div className="feed-switch feed-switch--search">
        <div className="seg seg--feed" role="tablist" aria-label="results">
          {types.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={type === id} className={type === id ? 'is-on' : ''} onClick={() => setType(id)}>
              {type === id && <motion.span layoutId="search-tab" className="seg__pill" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
              <span className="seg__label">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {!q && type !== 'people' && <div className="search-start"><Trending limit={8} /><Creators limit={6} /></div>}
      {!q && type === 'people' && <div className="search-start"><Creators limit={10} /></div>}
      {res.isLoading && q && <SkelRows n={3} />}
      {empty && q && <Blank mood="think" title={`nothing for “${q}” yet`} body="try another word, a @name or a #tag." />}

      {(type === 'top' || type === 'tags') && tags.length > 0 && (
        <section className="side-card">
          <h3 className="side-card__title">tags</h3>
          <div className="tag-cloud">{tags.map(t => <Link key={t.tag} to={`/search?q=${encodeURIComponent('#' + t.tag)}&type=drops`} className="chip"><b>#{t.tag}</b> <span className="muted num">{t.drops}</span></Link>)}</div>
        </section>
      )}
      {(type === 'top' || type === 'people') && people.length > 0 && (
        <section className="side-card">
          {type === 'top' && <h3 className="side-card__title">people</h3>}
          {(type === 'top' ? people.slice(0, 3) : people).map(u => <UserRow key={u.handle} user={u} />)}
          {type === 'top' && people.length > 3 && <button className="side-card__more small" onClick={() => setType('people')}>see all people</button>}
        </section>
      )}
      {(type === 'top' || type === 'drops') && drops.length > 0 && (
        <>
          {type === 'top' && <div className="section-label">drops</div>}
          <div className="feed">{drops.map(p => <div className="feed__item" key={p.id}><PostCard post={p} /></div>)}</div>
        </>
      )}
      {(drops.length > 0 || people.length > 0) && <Sentinel active={!!res.hasNextPage && !!q} onMore={() => { if (!res.isFetchingNextPage) res.fetchNextPage() }} />}
    </>
  )
}

export function Bookmarks() {
  const { me, ready } = useSession()
  const { openSheet } = useStore()
  const q = usePaged(['bookmarks'], '/bookmarks', !!me)
  if (ready && !me) return <><PageHead title="bookmarks" back /><div className="empty empty--card"><Mascot size={64} /><p className="strong">save drops for later.</p><button className="btn btn--dark btn--sm" onClick={() => openSheet({ type: 'signin' })}>sign in</button></div></>
  return (
    <>
      <PageHead title="bookmarks" back sub="only you can see these" />
      {q.isLoading && <PostSkel n={3} />}
      {q.isSuccess && !q.rows.length && <Blank title="nothing saved yet" body="tap the bookmark on any drop and it lands here." />}
      <div className="feed">{q.rows.map(r => <div className="feed__item" key={r.key}><PostCard post={r.post} /></div>)}</div>
      <Sentinel active={!!q.hasNextPage} onMore={() => { if (!q.isFetchingNextPage) q.fetchNextPage() }} />
    </>
  )
}
