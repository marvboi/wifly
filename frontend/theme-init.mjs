// The no-flash theme script, inlined first in <head> by vite.config.ts. Its sha256 goes into script-src
// (security-headers.mjs -> Caddyfile); `npm run check:csp` fails if the built index.html and the CSP disagree.
// Sets data-theme (light | dark) and data-themed, which turns the theme tokens on for every page. Runs before the
// first paint, so there is no flash. ES5, no deps.
// Light is the default. Only an explicit pick changes it: 'light' / 'dark' in 'wifly-theme', or 'system' (auto)
// saved together with the 'wifly-theme-picked' marker. A 'system' / 'auto' without the marker was never chosen by
// the person (an old default), so it falls back to light.
export const THEME_KEY = 'wifly-theme'
export const THEME_PICKED_KEY = 'wifly-theme-picked'
export const THEME_INIT = "(function(){var d=document.documentElement,p=null,k=null;try{p=localStorage.getItem('" + THEME_KEY + "');k=localStorage.getItem('" + THEME_PICKED_KEY + "')}catch(e){}" +
  "var t=p==='dark'?'dark':(p==='system'&&k==='1'&&window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');" +
  "d.setAttribute('data-theme',t);d.setAttribute('data-themed','');d.style.colorScheme=t;" +
  "d.style.backgroundColor=t==='dark'?'#0D0C0A':'#FFFFFF'})()"

/** The saved choice, as the app reads it: light unless 'dark' was picked, or auto was picked (with the marker). */
export function themePrefFrom(stored, picked) {
  if (stored === 'dark' || stored === 'light') return stored
  if (stored === 'system' && picked === '1') return 'system'
  return 'light'
}
