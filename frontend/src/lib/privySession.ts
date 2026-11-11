/** Privy *session* keys only — not embedded-wallet material. */
export const PRIVY_SESSION_KEYS = /^privy:(token|refresh_token|id_token|pat|connections|state_code|code_verifier|headless_oauth)/
export type KVStore = { length: number; key(i: number): string | null; removeItem(k: string): void }

/** Drop Privy session tokens only (not embedded-wallet keys). Safe to call when the SDK never loaded. */
export function clearPrivySessionStorage(stores?: KVStore[]) {
  const list = stores ?? (typeof window === 'undefined' ? [] : [localStorage, sessionStorage])
  for (const st of list) {
    try {
      const drop: string[] = []
      for (let i = 0; i < st.length; i++) { const k = st.key(i) ?? ''; if (PRIVY_SESSION_KEYS.test(k)) drop.push(k) }
      drop.forEach(k => st.removeItem(k))
    } catch { /* storage off */ }
  }
  if (!stores && typeof document !== 'undefined') {
    try {
      for (const part of document.cookie.split(';')) {
        const name = part.split('=')[0].trim()
        if (/^privy-/i.test(name)) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`
      }
    } catch { /* cookies off */ }
  }
}
