import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { SECURITY_HEADERS } from './security-headers.mjs'
import { THEME_INIT } from './theme-init.mjs'

declare const process: { env: Record<string, string | undefined> }

// The wifly api (backend/) runs on :8787. Same-origin proxy keeps the session cookie first-party.
const API = process.env.WIFLY_API ?? 'http://localhost:8787'
const proxy = { '/api': { target: API }, '/uploads': { target: API } }

export default defineConfig({
  plugins: [react(), {
    // no-flash theme: the inline script runs before first paint. Its hash is in the CSP (security-headers.mjs).
    name: 'wifly-theme-init',
    // Theme script first (no flash); preload the latin Geist file so body text doesn't reflow on swap.
    transformIndexHtml: (_html, ctx) => {
      const geist = Object.keys(ctx.bundle ?? {}).find(f => /geist-latin-wght-normal-[^/]+\.woff2$/.test(f))
      return [
        { tag: 'script', children: THEME_INIT, injectTo: 'head-prepend' },
        ...(geist ? [{ tag: 'link', attrs: { rel: 'preload', href: `/${geist}`, as: 'font', type: 'font/woff2', crossorigin: '' }, injectTo: 'head' as const }] : []),
      ]
    },
  }],
  server: { port: 5173, host: true, proxy },
  // CSP + X-Frame-Options on the built app (dev keeps Vite's inline HMR scripts working, so no CSP there).
  preview: { port: 4173, host: true, allowedHosts: ['.trycloudflare.com'], proxy, headers: SECURITY_HEADERS },
  build: {
    target: 'es2020', chunkSizeWarningLimit: 900,
    rollupOptions: {
      // Privy's bundles carry /*#__PURE__*/ comments Rollup can't place; harmless, so keep the log readable.
      onwarn(w, warn) { if (w.code === 'INVALID_ANNOTATION' || /contains an annotation/.test(w.message)) return; warn(w) },
    },
  },
})
