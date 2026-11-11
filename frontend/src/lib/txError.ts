/**
 * One place that turns a wallet / rpc / viem / http error into a short, calm, lowercase line.
 * the raw text never reaches the screen; it goes to console.debug only (speed.12.4).
 * pure (no viem import): it walks the error's cause chain and reads name / code / message, so node tests can use it.
 */
export type TxErrorKind = 'gas' | 'rejected' | 'pending' | 'other'
export const GAS_LINE = 'not enough eth for gas in this wallet. add a little and try again'
export const PENDING_LINE = 'a transaction is already pending. try again in a moment'
export const CANCELLED_LINE = 'you cancelled in your wallet'
export const GENERIC_LINE = 'that didn’t go through. nothing was sent. try again in a moment'
export const WIF_LINE = 'not enough wif in your wifly balance'
export const NETWORK_LINE = 'network busy, try again'
/** the most any error line may be (anything longer is treated as raw and replaced). */
export const MAX_LINE = 120

type Node = { name?: unknown; code?: unknown; message?: unknown; shortMessage?: unknown; details?: unknown; cause?: unknown }
function chain(e: unknown): Node[] {
  const out: Node[] = []
  let cur: unknown = e
  for (let i = 0; i < 12 && cur && typeof cur === 'object' && !out.includes(cur as Node); i++) { out.push(cur as Node); cur = (cur as Node).cause }
  if (typeof e === 'string') out.push({ message: e })
  return out
}
const text = (n: Node) => [n.shortMessage, n.details, n.message].filter(x => typeof x === 'string').join(' \n ')
const blobOf = (e: unknown) => chain(e).map(text).join(' \n ')

const REJECT_NAMES = /^(UserRejectedRequestError)$/
const REJECT_RE = /user (rejected|denied|cancel+ed|disapproved)|rejected the request|request rejected|denied transaction signature|user closed|cancel+ed by user|exited the (wallet|modal)/i
const GAS_NAMES = /^(InsufficientFundsError)$/
const GAS_RE = /insufficient funds|total cost \(gas \* gas fee \+ value\)|exceeds the balance of the account|gas required exceeds allowance|not enough (eth|funds|balance) (for|to cover) (gas|fees?)|insufficient balance for (gas|transfer)|sender doesn.t have enough funds/i
const PENDING_NAMES = /^(NonceTooLowError|NonceTooHighError|NonceMaxValueError)$/
const PENDING_RE = /nonce too (low|high)|nonce has already been used|invalid nonce|replacement (transaction )?underpriced|replacement fee too low|already known|known transaction|transaction already imported|already pending|pending (transaction|request)|request of type .* already pending/i
const WIF_RE = /insufficient(balance| token| wif)|transfer amount exceeds balance|erc20: transfer amount exceeds|exceeds allowance|not enough (\$)?wif|InsufficientBalance/i
const NETWORK_RE = /failed to fetch|network ?error|network request failed|econnreset|etimedout|enetunreach|econnrefused|too many requests|\b429\b|\b503\b|\b502\b|gateway time|internal json-rpc|rpc (error|timeout)|httprequesterror|fetch failed/i

export function classifyTxError(e: unknown): TxErrorKind {
  const nodes = chain(e)
  if (nodes.some(n => n.code === 4001 || n.code === 'ACTION_REJECTED' || REJECT_NAMES.test(String(n.name ?? '')) || REJECT_RE.test(text(n)))) return 'rejected'
  if (nodes.some(n => GAS_NAMES.test(String(n.name ?? '')) || GAS_RE.test(text(n)))) return 'gas'
  if (nodes.some(n => PENDING_NAMES.test(String(n.name ?? '')) || n.code === -32002 || PENDING_RE.test(text(n)))) return 'pending'
  return 'other'
}

/** Looks like a raw library / rpc dump rather than a line written for people. */
export function looksRaw(s: string): boolean {
  return s.length > MAX_LINE
    || /\n|request arguments|details:|version: (viem|ethers)|docs: http|contract call:|0x[0-9a-f]{24,}|\bgas \* gas fee\b|rpc error|execution reverted|internal json-rpc|^(error|typeerror|rangeerror|syntaxerror|aggregateerror|apierror|baseerror):|\bstack\b|^\s*at \w+|\{\s*"|\[\s*\{/i.test(s)
}

function tidy(s: string): string {
  return s.replace(/^(error:\s*)+/i, '').replace(/\s+/g, ' ').trim()
}

function logRaw(e: unknown) {
  try { console.debug('[wifly] error', e) } catch { /* no console */ }
}

/**
 * The line for an error. `known` is the caller's own calm text when it has one (a decoded contract error);
 * for anything unrecognised the raw text goes to console.debug and people see GENERIC_LINE.
 */
export function txErrorLine(e: unknown, known?: string | null, opts?: { silent?: boolean }): { kind: TxErrorKind; line: string } {
  const kind = classifyTxError(e)
  if (kind === 'rejected') return { kind, line: CANCELLED_LINE }
  if (kind === 'gas') return { kind, line: GAS_LINE }
  if (kind === 'pending') return { kind, line: PENDING_LINE }
  const blob = [known ?? '', blobOf(e)].join(' \n ')
  if (WIF_RE.test(blob)) return { kind, line: WIF_LINE }
  if (NETWORK_RE.test(blob)) return { kind, line: NETWORK_LINE }
  if (known && !looksRaw(known)) return { kind, line: tidy(known) }
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  const cleaned = tidy(msg)
  if (!known && cleaned && !looksRaw(cleaned) && !(e as Node)?.shortMessage) return { kind, line: cleaned } // a short line written by us or the server
  if (!opts?.silent) logRaw(e)
  return { kind, line: GENERIC_LINE }
}

/** The line to show a person. Always logs the raw value at console.debug, never on screen. */
export function userError(e: unknown, known?: string | null): string {
  logRaw(e)
  return txErrorLine(e, known, { silent: true }).line
}

/** Gas pre-check: true when the wallet can't cover an estimated cost (plus any eth value being sent). */
export function shortOnGas(balance: bigint, estCost: bigint | null, value = 0n): boolean {
  if (balance <= 0n) return true
  if (estCost == null) return false // couldn't estimate: let the wallet decide
  return balance < estCost + value
}
