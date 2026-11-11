/** After a manual sign-out, block auto-restore of a leftover session until the user signs in again. */
export const SIGNED_OUT = 'wifly_signed_out'
export type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
const localStore = (): KV | null => { try { return localStorage } catch { return null } }
export function blockSessionRestore(store?: KV) {
  try { (store ?? localStore())?.setItem(SIGNED_OUT, '1') } catch { /* storage off */ }
}
export function sessionRestoreBlocked(store?: KV): boolean {
  try { return (store ?? localStore())?.getItem(SIGNED_OUT) === '1' } catch { return false }
}
export function allowSessionRestore(store?: KV) {
  try { (store ?? localStore())?.removeItem(SIGNED_OUT) } catch { /* storage off */ }
}
