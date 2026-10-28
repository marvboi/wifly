/** Who can act on a wallet in this browser. A plain wallet signs through the connected wallet app; an embedded
 *  (privy) wallet signs only inside the privy session of the x or email login that created it. */
export type Access = 'yes' | 'loading' | 'off' | 'signin' | 'other'
export type PrivyView = { enabled: boolean; ready: boolean; authenticated: boolean; owns: (address: string) => boolean }

export function walletAccess(w: { address: string; privy: boolean }, p: PrivyView): Access {
  if (!w.privy) return 'yes'
  if (!p.enabled) return 'off'
  if (p.owns(w.address)) return 'yes'
  if (!p.ready) return 'loading'
  return p.authenticated ? 'other' : 'signin'
}

/** The calm line under a wallet this session can't use, and the one-tap button that fixes it (null: no button). */
export function gateCopy(a: Access, owner?: { via: 'x' | 'email'; x: string | null }): { line: string; button: string | null; sub: string | null; via: 'x' | 'email' } {
  const via = owner?.via === 'email' ? 'email' : 'x'
  const who = via === 'x' ? (owner?.x ? `x @${owner.x}` : 'your x login') : 'your email login'
  const button = `verify it’s you with ${via}`
  if (a === 'off') return { line: 'this wallet opens with x or email, which isn’t set up here.', button: null, sub: null, via }
  if (a === 'loading') return { line: 'checking who can use this wallet…', button: null, sub: null, via }
  if (a === 'other' || a === 'signin') return { line: `this wallet opens with ${who}. balances still show here.`, button, sub: 'to use this wallet', via }
  return { line: '', button: null, sub: null, via }
}
