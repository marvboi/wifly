// The no-flash theme script, inlined first in <head> by vite.config.ts. Its sha256 goes into script-src
// (security-headers.mjs -> Caddyfile); `npm run check:csp` fails if the built index.html and the CSP disagree.
// Sets data-theme (light | dark) from localStorage 'wifly-theme' or the system setting, and data-themed on the
// pages that follow the theme (the landing at "/" outside the app host, and /docs). ES5, no dependencies.
export const THEME_KEY = 'wifly-theme'
export const THEME_INIT = "(function(){var d=document.documentElement,p='system';try{p=localStorage.getItem('" + THEME_KEY + "')||'system'}catch(e){}" +
  "var t=p==='light'||p==='dark'?p:(window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');" +
  "d.setAttribute('data-theme',t);var l=location,s=l.pathname;" +
  "if(s.indexOf('/docs')===0||(s==='/'&&l.host.indexOf('app.')!==0))d.setAttribute('data-themed','')})()"
