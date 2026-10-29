/**
 * 11.8.5: which wallet pays for a user transaction. pure, so node tests can use it.
 * options = the wallets already on this account: linked external wallets and the privy embedded one (never a guest key,
 * never a wallet that isn't on the account; nothing is linked from here).
 */
export type PayerKind = 'embedded' | 'linked'
export type PayerOption = { address: string; kind: PayerKind; ready: boolean }
export type WalletLike = { address: string; kind: string; privy: boolean }

export function payerOptions(list: WalletLike[], s: { signable: string[]; wagmi?: string | null }): PayerOption[] {
  const can = new Set(s.signable.map(a => a.toLowerCase()))
  const wagmi = s.wagmi?.toLowerCase() ?? null
  const seen = new Set<string>(), out: PayerOption[] = []
  for (const w of list) {
    const a = w.address.toLowerCase()
    if (w.kind === 'guest' || seen.has(a) || !/^0x[0-9a-f]{40}$/.test(a)) continue
    seen.add(a)
    out.push({ address: a, kind: w.privy ? 'embedded' : 'linked', ready: can.has(a) || a === wagmi })
  }
  return [...out.filter(o => o.kind === 'linked'), ...out.filter(o => o.kind === 'embedded')]
}

/**
 * The saved pick if it's still on the account. Otherwise a connected linked external wallet holding wif or eth (that's
 * usually where the user's wif is; an embedded wallet often has none), then any linked wallet with gas, then the embedded one.
 */
export function defaultPayer(opts: PayerOption[], bal: Record<string, { eth?: bigint; wif?: bigint } | undefined>, saved?: string | null): string | null {
  const s = saved?.toLowerCase()
  if (s && opts.some(o => o.address === s)) return s
  const eth = (a: string) => bal[a]?.eth ?? 0n, wif = (a: string) => bal[a]?.wif ?? 0n
  const linked = opts.filter(o => o.kind === 'linked')
  const pick = linked.find(o => o.ready && (eth(o.address) > 0n || wif(o.address) > 0n))
    ?? linked.find(o => o.ready && !opts.some(e => e.kind === 'embedded'))
    ?? linked.find(o => eth(o.address) > 0n && !opts.some(e => e.kind === 'embedded' && e.ready))
  if (pick) return pick.address
  return opts.find(o => o.kind === 'embedded')?.address ?? opts[0]?.address ?? null
}

/** How a send goes out from the payer: the connected wagmi wallet, privy (embedded or a privy-connected external), or not yet. */
export function sendRoute(payer: string, s: { wagmi?: string | null; privyHas: (a: string) => boolean }): 'wagmi' | 'privy' | 'none' {
  const a = payer.toLowerCase()
  if (s.wagmi && s.wagmi.toLowerCase() === a) return 'wagmi'
  return s.privyHas(a) ? 'privy' : 'none'
}

export const PAYER_GAS_LINE = 'this wallet needs a little eth for gas'
export const EMBEDDED_GAS_HINT = 'add a little eth here for gas'
export const EMBEDDED_FUND_LINE = 'fund your embedded wallet with a little eth for gas'
export const AGENT_LABEL = 'wifly agent (spends for you, can’t withdraw)'
export const shortA = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
export const payerTag = (k: PayerKind) => (k === 'embedded' ? 'embedded' : 'linked')
export const linkedButton = (a: string) => `use my linked wallet ${shortA(a)}`

/** eth / wif with a few significant digits, lowercase units. */
export function fmtUnits(v: bigint | undefined, unit: 'eth' | 'wif', decimals = 18): string {
  if (v === undefined) return `… ${unit}`
  const n = Number(v) / 10 ** decimals
  const s = n === 0 ? '0' : n < 0.0001 ? '<0.0001' : n.toLocaleString('en-US', { maximumFractionDigits: unit === 'eth' ? 4 : 2 })
  return `${s} ${unit}`
}

// 11.8.5: where swap output lands. Only offered when there's an embedded wallet AND a linked one.
export type ReceiveChoice = { embedded: string; linked: string }
export function receiveChoices(payer: string | null, opts: PayerOption[]): ReceiveChoice | null {
  if (!payer) return null
  const emb = opts.find(o => o.kind === 'embedded')
  if (!emb) return null
  const p = payer.toLowerCase()
  // the linked side is the payer when it's linked, else the first linked wallet
  const lnk = opts.find(o => o.kind === 'linked' && o.address === p) ?? opts.find(o => o.kind === 'linked')
  return lnk ? { embedded: emb.address, linked: lnk.address } : null
}
/** The router recipient: undefined when the output goes back to the payer itself (plain TAKE_ALL). */
export function swapRecipient(payer: string | null, receiveIn: string | null): string | undefined {
  if (!payer || !receiveIn) return undefined
  return receiveIn.toLowerCase() === payer.toLowerCase() ? undefined : receiveIn.toLowerCase()
}
/** "top up gas too": only for buys going to the embedded wallet from another wallet. */
export function canTopUp(side: 'buy' | 'sell', payer: string | null, receiveIn: string | null, embedded: string | null): boolean {
  return side === 'buy' && !!embedded && !!receiveIn && receiveIn.toLowerCase() === embedded.toLowerCase() && !!payer && payer.toLowerCase() !== embedded.toLowerCase()
}
/** On by default when the embedded wallet has no eth and is the recipient. */
export const topUpDefault = (embeddedEth: bigint | undefined, recipientIsEmbedded: boolean) => recipientIsEmbedded && embeddedEth === 0n
export const TOPUP_LABEL = 'top up gas too'
export const topUpNote = (a: string) => `adds 0.0001 eth to ${shortA(a)} so it can pay its own gas`

// 11.8.6: the wallet menu redesign. pure bits so node tests can pin them.
/** Two calm hues from the address (stable per wallet), for the gradient avatar dot. */
export function avatarColors(address: string): [string, string] {
  const a = (address || '').toLowerCase().replace(/^0x/, '')
  let h = 2166136261
  for (let i = 0; i < a.length; i++) { h ^= a.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  const h1 = h % 360, h2 = (h1 + 40 + ((h >>> 9) % 100)) % 360
  return [`hsl(${h1} 62% 62%)`, `hsl(${h2} 58% 46%)`]
}
/** Below this a wallet can still pay, but not for long (a few sends on this chain). */
export const LOW_GAS_WEI = 200_000_000_000_000n // 0.0002 eth
export type GasChip = { tone: 'ok' | 'low' | 'empty' | 'unknown'; label: string }
/** The eth-for-gas chip: green with the amount, amber when low, amber "add eth" at 0. */
export function gasChip(eth: bigint | undefined): GasChip {
  if (eth === undefined) return { tone: 'unknown', label: '… eth' }
  if (eth === 0n) return { tone: 'empty', label: 'add eth' }
  const amt = fmtUnits(eth, 'eth')
  return eth < LOW_GAS_WEI ? { tone: 'low', label: `low gas · ${amt}` } : { tone: 'ok', label: `${amt} for gas` }
}
/** The big number: "1,234.5" (no unit; the menu adds a quiet "wif"). */
export const wifNumber = (v: bigint | undefined) => fmtUnits(v, 'wif').replace(/ wif$/, '')
/** ≈ $ for a wif balance, only with a live price. */
export function wifUsd(v: bigint | undefined, usd: number | undefined): number | undefined {
  if (v === undefined || v === 0n || !usd || !(usd > 0)) return undefined
  return (Number(v) / 1e18) * usd
}
/** Never a blank address: the short form, or a dash if something upstream handed us nothing. */
export const addrLabel = (a: string | null | undefined) => (a && /^0x[0-9a-fA-F]{40}$/.test(a) ? shortA(a) : '—')
