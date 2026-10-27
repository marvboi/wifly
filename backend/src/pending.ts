/** Accounts without a picked @name. New accounts get a hidden placeholder ('~' never passes HANDLE_RE) until onboarding. */
import { randomBytes } from 'node:crypto'
import { one } from './db'

export const pendingHandle = () => `~${randomBytes(8).toString('hex')}`
export const isPendingHandle = (h: string | null | undefined) => !!h && h.startsWith('~')
/** Names older builds made up at sign-up (wif_ + address/did bits). Their owners pick a real one at next sign-in. */
export const AUTO_HANDLE_RE = /^wif_(u\d+|[0-9a-z]{6,10})$/

export function needsHandle(row: { handle: string; extras?: string | null } | null | undefined): boolean {
  if (!row) return false
  if (isPendingHandle(row.handle)) return true
  if (!AUTO_HANDLE_RE.test(row.handle)) return false
  try { return !JSON.parse(row.extras || '{}').handlePicked } catch { return true }
}
export async function needsHandleFor(uid: number) {
  return needsHandle(await one<{ handle: string; extras: string | null }>('SELECT handle, extras FROM users WHERE id = ?', [uid]))
}
