import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { handleFromSegment, legacyProfileRedirect } from './lib/paths'
import { useEffect, useState } from 'react'
import { APP_URL, HOST_ROLE } from './lib/hosts'
import { Welcome } from './pages/Welcome'
import { Names } from './pages/Names'
import { ManageName, PublicName } from './pages/NamePages'
import { AppShell } from './components/Shell'
import { Toasts } from './components/Toasts'
import { Sheets } from './sheets/Sheets'
import { Landing } from './pages/Landing'
import { Home } from './pages/Home'
import { PostDetail } from './pages/PostDetail'
import { FollowList, Profile } from './pages/Profile'
import { Bookmarks, Search } from './pages/Search'
import { Notifications } from './pages/Notifications'
import { Inbox, Thread } from './pages/Messages'
import { Agent } from './pages/Agent'
import { Plus } from './pages/Plus'
import { Vote } from './pages/Vote'
import GetWif from './pages/GetWif'
import { PayLink } from './pages/PayLink'
import { NotFound } from './pages/NotFound'
import { AdminAccounts } from './pages/AdminAccounts'
import { Settings } from './pages/Settings'
import { lazy, Suspense } from 'react'
import { DCA } from './pages/DCA'
// admin-only, not linked anywhere; the bytecode bundle loads only on this route
const Deploy = lazy(() => import('./pages/Deploy'))
// docs: its own chunk, served on both hosts
const Docs = lazy(() => import('./pages/Docs').then(m => ({ default: m.Docs })))
const docs = <Suspense fallback={null}><Docs /></Suspense>

/** Main host: every app path moves to the same path on the app host. */
function ToAppHost() {
  const { pathname, search, hash } = useLocation()
  useEffect(() => {
    const p = pathname === '/home' ? '/' : pathname
    window.location.replace(`${APP_URL}${p}${search}${hash}`)
  }, [pathname, search, hash])
  return null
}

/** /home on the app host: the feed is at "/". Keeps the query string and hash. */
function HomeToRoot() {
  const { search, hash } = useLocation()
  return <Navigate to={`/${search}${hash}`} replace />
}

/** Old /u/name links move to /@name (Caddy answers them with a 301 before the app loads). */
function LegacyProfile() {
  const { pathname, search, hash } = useLocation()
  // worked out once: during the page exit animation this copy re-renders with the new /@ path
  const [to] = useState(() => `${legacyProfileRedirect(pathname) ?? '/'}${search}${hash}`)
  return <Navigate to={to} replace />
}
/** /@name, or /name when it isn't a route word. */
function AtProfile() {
  const h = handleFromSegment(useParams().seg)
  return h ? <Profile handle={h} /> : <NotFound />
}
function AtFollow({ kind }: { kind: 'followers' | 'following' }) {
  const h = handleFromSegment(useParams().seg)
  return h ? <FollowList kind={kind} handle={h} /> : <NotFound />
}
function AtPost() {
  return handleFromSegment(useParams().seg) ? <PostDetail /> : <NotFound />
}

export function App() {
  if (HOST_ROLE === 'site') {
    return (
      <>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/docs" element={docs} />
          <Route path="*" element={<ToAppHost />} />
        </Routes>
        <Sheets />
        <Toasts />
      </>
    )
  }
  const app = HOST_ROLE === 'app'
  return (
    <>
      <Routes>
        {!app && <Route path="/" element={<Landing />} />}
        <Route path="/docs" element={docs} />
        <Route path="/pay/:id" element={<PayLink />} />
        <Route path="/welcome" element={<Welcome />} />
        <Route path="/pot" element={<Navigate to="/vote#pot" replace />} />
        {app && <Route path="/home" element={<HomeToRoot />} />}
        <Route element={<AppShell />}>
          <Route path={app ? '/' : '/home'} element={<Home />} />
          <Route path="/post/:id" element={<PostDetail />} />
          <Route path="/u/*" element={<LegacyProfile />} />
          <Route path="/:seg" element={<AtProfile />} />
          <Route path="/:seg/followers" element={<AtFollow kind="followers" />} />
          <Route path="/:seg/following" element={<AtFollow kind="following" />} />
          <Route path="/:seg/post/:id" element={<AtPost />} />
          <Route path="/search" element={<Search />} />
          <Route path="/bookmarks" element={<Bookmarks />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/agent" element={<Agent />} />
          <Route path="/plus" element={<Plus />} />
          <Route path="/names" element={<Names />} />
          <Route path="/names/:name/manage" element={<ManageName />} />
          <Route path="/n/:name" element={<PublicName />} />
          <Route path="/vote" element={<Vote />} />
          <Route path="/swap" element={<GetWif />} />
          <Route path="/dca" element={<DCA />} />
          <Route path="/deploy" element={<Suspense fallback={null}><Deploy /></Suspense>} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/accounts" element={<AdminAccounts />} />
          <Route path="/messages" element={<Inbox />} />
          <Route path="/messages/:handle" element={<Thread />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
      <Sheets />
      <Toasts />
    </>
  )
}
