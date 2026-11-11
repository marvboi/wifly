import { MotionConfig } from 'motion/react'
import React, { lazy, Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider, keepPreviousData } from '@tanstack/react-query'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles/app.css'
import './styles/theme.css'
import './styles/dark.css'
import { wagmiConfig } from './wagmi'
import { StoreProvider, type SheetState } from './state/store'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ConfirmProvider } from './components/ConfirmDialog'
import { SessionProvider } from './api/session'
import { privyEnabled, usePrivyWanted } from './auth/privyBridge'

/** Privy loads in its own chunk, only when VITE_PRIVY_APP_ID is set and something wants it (see wantPrivy):
 *  a sign-in tap, a link, or a session to restore. It sits beside the app, not around it. */
const PrivyMount = privyEnabled ? lazy(() => import('./auth/PrivyMount')) : null
function LazyPrivy() {
  const wanted = usePrivyWanted()
  return PrivyMount && wanted ? <Suspense fallback={null}><PrivyMount /></Suspense> : null
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      // speed.12: keep showing last-good while a refresh runs; retry transient failures
      retry: (n, e) => { const s = (e as { status?: number })?.status; return n < 2 && s !== 404 && s !== 401 && s !== 403 },
      retryDelay: n => 400 * (n + 1),
      refetchOnWindowFocus: false,
      placeholderData: keepPreviousData,
    },
  },
})

/** Deep links for reviews and screenshots: ?sheet=tip&to=<handle>, ?sheet=swap, ?sheet=vote&handle=<handle> … (sheets that need a person open only when one is given) */
/** fixed lines only: a link can't put its own words in the sign-in sheet */
function sheetFromUrl(): SheetState {
  const p = new URLSearchParams(location.search)
  const g = (k: string) => p.get(k) ?? undefined
  switch (p.get('sheet')) {
    case 'tip': return { type: 'tip', to: g('to'), postId: g('post') }
    case 'unlock': return g('post') ? { type: 'unlock', postId: g('post')! } : null
    case 'subscribe': return g('handle') ? { type: 'subscribe', handle: g('handle')!, tierId: g('tier') } : null
    case 'bid': return { type: 'bid' }
    case 'buy': return g('handle') && g('item') ? { type: 'buy', handle: g('handle')!, itemId: g('item')! } : null
    case 'paydm': return g('handle') ? { type: 'paydm', handle: g('handle')! } : null
    case 'vote': return g('handle') ? { type: 'vote', handle: g('handle')!, postId: g('post') } : null
    case 'swap': return { type: 'swap', wifOut: g('out') ? Number(g('out')) : undefined, reason: g('reason') }
    case 'burn': return { type: 'burn', amount: g('amount') ? Number(g('amount')) : undefined }
    case 'badge': return { type: 'badge', id: g('id') ?? 'first-light', handle: g('handle') }
    case 'drop': return { type: 'drop' }
    case 'tiers': return { type: 'tiers' }
    case 'compose': return { type: 'compose', replyTo: g('replyTo'), quoteOf: g('quote') }
    case 'signin': return { type: 'signin' }
    case 'profile': return { type: 'profile' }
    case 'link': return { type: 'link' }
    default: return null
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <BrowserRouter>
            <StoreProvider initialSheet={sheetFromUrl()}>
              <ConfirmProvider>
                <MotionConfig reducedMotion="user">
                  <ErrorBoundary label="app"><App /></ErrorBoundary>
                </MotionConfig>
                <LazyPrivy />
              </ConfirmProvider>
            </StoreProvider>
          </BrowserRouter>
        </SessionProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
)
