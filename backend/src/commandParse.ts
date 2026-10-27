/**
 * The companion's deterministic command parser, tolerant of typos and slang. No model call.
 *
 * interpret(raw):
 *  1. normalize: lowercase, smart quotes, strip punctuation (keeps @ $ . : _ for handles, names, decimals and times),
 *     glue/unglue units ($5, 5usd, 5 bucks -> $5; 0.01e / .01eth -> 0.01 eth; 5k -> 5000; 9 am -> 9am), day
 *     abbreviations (mon -> monday), slang (bal -> balance, ape/cop/grab -> buy, sub -> subscribe).
 *  2. fuzzy-fix words against the command vocabulary (Damerau edit distance <= 2; <= 1 for 3-4 letter words;
 *     never stopwords, handles, names or numbers; first letter has to match unless it's a swap of the first two).
 *  3. run the strict parsers on the normalized text and rebuild one canonical command string.
 * Confidence: high = the text parsed with formatting fixes only. medium = it parsed only after spelling fixes or a
 * guess (e.g. "5 wif" in a schedule read as $5): show "Did you mean …?" first. low = no command: the model gets the
 * ORIGINAL text, or, when it's off, 2-3 tappable suggestions. Even a high-confidence parse only builds a confirm card.
 */
import { parseCommand } from './agent'
import { parseDca } from './dca'

export function parseSwap(raw: string): { dir: 'eth2wif' | 'wif2eth'; amount: number } | null {
  const t = raw.toLowerCase().replace(/,/g, '').replace(/[.!?]+$/, '').trim()
  const m = t.match(/^(?:please )?(swap|buy|sell|convert|trade|get)(?: me)? (\d+(?:\.\d+)?)(k|m)? ?(eth|wif)(?: (?:to|for|into|of|worth of) ?(eth|wif)?)?(?: now)?$/)
  if (!m) return null
  const amount = Number(m[2]) * (m[3] === 'k' ? 1e3 : m[3] === 'm' ? 1e6 : 1)
  const from = m[4], to = m[5]
  if (!(amount > 0)) return null
  if (m[1] === 'sell') return from === 'wif' ? { dir: 'wif2eth', amount } : null
  if (to && to === from) return null
  if (m[1] === 'buy' || m[1] === 'get') return from === 'eth' ? { dir: 'eth2wif', amount } : null // "buy 5000 wif" needs an ETH amount: let the screen quote it
  return { dir: from === 'eth' ? 'eth2wif' : 'wif2eth', amount }
}
/** "pause my dca", "cancel the monday plan", "resume dca", "stop buying wif". */
export function parseDcaManage(raw: string): { action: 'pause' | 'resume' | 'withdraw' } | null {
  const t = raw.toLowerCase()
  if (!/\b(dca|plan|plans|recurring|schedule|buys|buying)\b/.test(t)) return null
  if (/\b(cancel|withdraw|close|end|delete)\b/.test(t)) return { action: 'withdraw' }
  if (/\b(resume|restart|unpause|continue)\b/.test(t)) return { action: 'resume' }
  if (/\b(pause|stop|hold)\b/.test(t)) return { action: 'pause' }
  return null
}

export type Fix = { from: string; to: string; why: 'spelling' | 'guess' }
export type Normalized = { text: string; fixes: Fix[] }
export type Intent = 'dca' | 'swap' | 'tip' | 'subscribe' | 'plus' | 'promote' | 'manage' | 'balance' | 'pot'
export type Interpreted = {
  confidence: 'high' | 'medium' | 'low'
  intent: Intent | null
  /** A command string the strict parsers accept as-is (what a "Did you mean" tap sends). */
  canonical: string | null
  /** Human label, e.g. "buy $5 of WIF every Monday at 9:00". */
  label: string | null
  norm: Normalized
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const VOCAB = ['buy', 'swap', 'sell', 'convert', 'trade', 'tip', 'send', 'give', 'subscribe', 'renew', 'promote', 'pause', 'resume', 'unpause', 'cancel', 'withdraw',
  'stop', 'every', 'each', 'daily', 'weekly', 'monthly', 'hourly', 'hour', 'day', 'week', 'month', 'morning', 'night', 'eth', 'wif', 'dca', 'plan', 'plans',
  'balance', 'pot', 'plus', 'latest', 'drop', 'post', 'tier', 'yearly', 'stack', 'recurring', ...DAYS]
const STOP = new Set(['the', 'a', 'an', 'me', 'i', 'im', 'of', 'for', 'into', 'on', 'in', 'it', 'is', 'and', 'or', 'some', 'worth', 'now', 'am', 'pm', 'my', 'all',
  'to', 'at', 'with', 'what', 'whats', 'how', 'can', 'you', 'your', 'help', 'does', 'do', 'work', 'tell', 'about', 'this', 'that', 'there', 'their', 'they', 'then',
  'than', 'from', 'when', 'why', 'who', 'where', 'which', 'will', 'would', 'should', 'could', 'just', 'like', 'get', 'got', 'want', 'need', 'make', 'much', 'many',
  'more', 'less', 'last', 'next', 'please', 'thanks', 'thank', 'hey', 'hi', 'yo', 'gm', 'ok', 'okay', 'yes', 'no', 'not', 'be', 'are', 'was', 'were', 'have', 'has',
  'had', 'if', 'so', 'up', 'out', 'by', 'off', 'as', 'pls', 'plz', 'sub', 'bal', 'world', 'flat', 'name', 'names', 'badge', 'badges', 'story', 'times', 'time',
  'show', 'list', 'find', 'creators', 'creator', 'people', 'stats', 'price', 'much', 'best', 'top', 'spot', 'vote', 'votes', 'wallet', 'money', 'fee', 'fees', 'ether'])
const DAY_ABBR: Record<string, string> = { sun: 'sunday', mon: 'monday', tue: 'tuesday', tues: 'tuesday', wed: 'wednesday', weds: 'wednesday', thu: 'thursday',
  thur: 'thursday', thurs: 'thursday', fri: 'friday', sat: 'saturday' }
const SLANG: Record<string, string> = { bal: 'balance', bals: 'balance', ape: 'buy', cop: 'buy', grab: 'buy', purchase: 'buy', sub: 'subscribe', subs: 'subscribe',
  ethereum: 'eth', ether: 'eth', '$wif': 'wif', '$eth': 'eth', wifs: 'wif', unsub: 'cancel', halt: 'pause', everyday: 'daily', nite: 'night', tmrw: 'tomorrow',
  pls: '', plz: '', please: '', kindly: '', yo: '', hey: '', gm: '' }

/** Optimal-string-alignment (Damerau) distance, early exit above `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      rowMin = Math.min(rowMin, d[i][j])
    }
    if (rowMin > max) return max + 1
  }
  return d[a.length][b.length]
}

function fuzzyWord(w: string): string | null {
  if (w.length < 3 || STOP.has(w) || VOCAB.includes(w) || (w.endsWith('s') && VOCAB.includes(w.slice(0, -1))) || !/^[a-z]+$/.test(w)) return null
  const max = w.length <= 4 ? 1 : 2
  let best: string | null = null, bestD = max + 1, tie = false
  for (const v of VOCAB) {
    if (v[0] !== w[0] && !(v[0] === w[1] && v[1] === w[0])) continue
    const dd = editDistance(w, v, max)
    if (dd < bestD) { best = v; bestD = dd; tie = false }
    else if (dd === bestD && best && v !== best) {
      // equal distance: a word the typo is a prefix of wins ("paus" -> pause, not plus); otherwise it's a tie
      const vp = v.startsWith(w), bp = best!.startsWith(w)
      if (vp && !bp) { best = v; tie = false } else if (vp === bp) tie = true
    }
  }
  return best && bestD <= max && !tie ? best : null
}

const NUMK = (n: string, k?: string) => String(Number(n.replace(/,/g, '')) * (k === 'k' ? 1e3 : k === 'm' ? 1e6 : 1))
const TIME = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/

export function normalize(raw: string): Normalized {
  const fixes: Fix[] = []
  let t = String(raw ?? '').toLowerCase().slice(0, 400)
    .replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"').replace(/'/g, '')
    .replace(/(\d),(\d{3})\b/g, '$1$2')                       // 1,000 -> 1000
    .replace(/[^a-z0-9@$.:_\s]/g, ' ')                         // strip other punctuation
    .replace(/(^|\s)\.(\d)/g, '$10.$2')                        // .01 -> 0.01
    .replace(/\.(?=\s|$)/g, ' ')                               // sentence dots (not decimals or names)
    .replace(/@\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)(?=\s|$)/g, 'at $1') // "@ 9am" / "@9am" -> at 9am
    .replace(/(\d)\s+(am|pm)\b/g, '$1$2')                      // 9 am -> 9am
    .replace(/\$\s*(\d+(?:\.\d+)?)\s*(k|m)?\b/g, (_, n, k) => `$${NUMK(n, k)}`)
    .replace(/\b(\d+(?:\.\d+)?)\s*(k|m)?\s*\$/g, (_, n, k) => `$${NUMK(n, k)}`)          // 5$ -> $5
    .replace(/\b(\d+(?:\.\d+)?)\s*(k|m)?\s*(usd|usdc|dollars?|bucks?|dolla)\b/g, (_, n, k) => `$${NUMK(n, k)}`)
    .replace(/\b(\d+(?:\.\d+)?)\s*(k|m)?\s*(e|eth|ether|ethereum)\b/g, (_, n, k) => `${NUMK(n, k)} eth`)
    .replace(/\b(\d+(?:\.\d+)?)\s*(k|m)?\s*(\$?wif|wifs)\b/g, (_, n, k) => `${NUMK(n, k)} wif`)
    .replace(/\b(\d+(?:\.\d+)?)(k|m)\b/g, (_, n, k) => NUMK(n, k))
    .replace(/\s+/g, ' ').trim()
  const out: string[] = []
  for (const tok of t.split(' ')) {
    if (!tok) continue
    if (tok.startsWith('@') || tok.startsWith('$') || tok.endsWith('.wif') || /\d/.test(tok)) { out.push(tok); continue }
    if (tok in DAY_ABBR) { out.push(DAY_ABBR[tok]); continue }
    if (tok in SLANG) { if (SLANG[tok]) out.push(SLANG[tok]); continue }
    if (/^(.+)s$/.test(tok) && DAYS.includes(tok.slice(0, -1))) { out.push(tok); continue }
    const f = fuzzyWord(tok)
    if (f) { fixes.push({ from: tok, to: f, why: 'spelling' }); out.push(f) } else out.push(tok)
  }
  // "by" as the first word of a buy/stack line is a typo for "buy"
  if (out[0] === 'by' && out.some(w => w === 'wif' || w.startsWith('$') || w === 'eth')) { fixes.push({ from: 'by', to: 'buy', why: 'spelling' }); out[0] = 'buy' }
  // schedule words: a bare day gets "every", a bare time gets "at"
  for (let i = 0; i < out.length; i++) {
    const w = out[i], prev = out[i - 1]
    const isDay = DAYS.includes(w) || (w.endsWith('s') && DAYS.includes(w.slice(0, -1)))
    if (isDay && !['every', 'each', 'on'].includes(prev ?? '')) { out.splice(i, 0, 'every'); i++ }
    const tm = w.match(TIME)
    if (tm && (tm[2] || tm[3]) && prev !== 'at' && Number(tm[1]) < 24) { out.splice(i, 0, 'at'); i++ }
  }
  return { text: out.join(' '), fixes }
}

const capWord = (s: string) => s[0].toUpperCase() + s.slice(1)
const hm = (h: number, m: number) => `${h}:${String(m).padStart(2, '0')}`
const fmt = (n: number) => String(Number(n.toFixed(8)))

/** Parse a messy message into one canonical command (or say how sure we are that it isn't one). */
export function interpret(raw: string): Interpreted {
  const norm = normalize(raw)
  let t = norm.text
  const res = (intent: Intent, canonical: string, label = canonical): Interpreted =>
    ({ confidence: norm.fixes.length ? 'medium' : 'high', intent, canonical, label, norm })
  // a schedule with a bare WIF amount ("buy 5 wif every monday"): read it as $5 and ask
  if (/\b(buy|stack|dca)\b/.test(t) && /\b(every|each|daily|weekly|monthly|hourly)\b/.test(t) && !/\$\d|\d eth\b/.test(t)) {
    const m1 = t.match(/\b(\d+(?:\.\d+)?) wif\b/), m2 = m1 ? null : t.match(/\b(buy|stack|dca) (\d+(?:\.\d+)?)\b/)
    if (m1) { t = t.replace(m1[0], `$${m1[1]} of wif`); norm.fixes.push({ from: m1[0], to: `$${m1[1]}`, why: 'guess' }) }
    else if (m2) { t = t.replace(m2[0], `${m2[1]} $${m2[2]}`); norm.fixes.push({ from: m2[2], to: `$${m2[2]}`, why: 'guess' }) }
    if (!/\bwif\b/.test(t)) t += ' of wif'
  }
  if (/\b(buy|stack|dca)\b/.test(t) && /\$\d|\d eth\b/.test(t) && /\b(every|each|daily|weekly|monthly|hourly)\b/.test(t) && !/\bwif\b/.test(t)) t += ' of wif'
  const dca = parseDca(t)
  if (dca) {
    const amt = dca.perBuy.usd !== undefined ? `$${fmt(dca.perBuy.usd)}` : `${fmt(dca.perBuy.eth!)} ETH`
    const when = dca.every === 'hour' ? 'every hour' : dca.every === 'week' ? `every ${dca.weekday !== null ? capWord(DAYS[dca.weekday]) : 'week'} at ${hm(dca.hour, dca.minute)}` : `every ${dca.every} at ${hm(dca.hour, dca.minute)}`
    return res('dca', `buy ${amt} of WIF ${when}`)
  }
  const swapT = t.replace(/\b(to|for|into) (eth|wif)\b/, '$1 $2').replace(/^(ape|buy) (\d+(?:\.\d+)?) eth (?:into|in|on) wif$/, 'swap $2 eth to wif')
  const swap = parseSwap(swapT) ?? parseSwap(swapT.replace(/^(swap|sell|convert|trade|buy|get) (\d+(?:\.\d+)?) (eth|wif) .*$/, '$1 $2 $3'))
  if (swap) return res('swap', swap.dir === 'eth2wif' ? `swap ${fmt(swap.amount)} ETH to WIF` : `swap ${fmt(swap.amount)} WIF to ETH`)
  const manage = parseDcaManage(t)
  if (manage) return res('manage', manage.action === 'withdraw' ? 'cancel my DCA' : `${manage.action} my DCA`)
  const cmdT = t.replace(/^(tip|send|give) (\S+) (\d+(?:\.\d+)?) wif$/, '$1 $2 $3').replace(/^(tip|send|give) (\d+(?:\.\d+)?) wif (\S+)$/, '$1 $2 to $3')
  const cmd = parseCommand(cmdT) as { kind: string; to?: string; amount?: number; tier?: number; plan?: string | null }
  if (cmd.kind === 'tip') { const to = cmd.to!.startsWith('@') || cmd.to!.endsWith('.wif') || cmd.to!.startsWith('0x') ? cmd.to! : `@${cmd.to}`; return res('tip', `tip ${to} ${fmt(cmd.amount!)}`) }
  if (cmd.kind === 'subscribe') { const to = cmd.to!.startsWith('@') || cmd.to!.endsWith('.wif') ? cmd.to! : `@${cmd.to}`; return res('subscribe', `subscribe ${to}${cmd.tier && cmd.tier > 1 ? ` tier ${cmd.tier}` : ''}`) }
  if (cmd.kind === 'renew_plus') return res('plus', `renew my plus${cmd.plan ? ` ${cmd.plan === 'year' ? 'yearly' : 'monthly'}` : ''}`)
  if (cmd.kind === 'promote') return res('promote', `promote my latest drop for ${fmt(cmd.amount!)}`)
  if (/^(my )?(wif |eth )?balance( please)?$|^(whats|show|check)( my)? (wif |eth )?balance$|^how much (wif|eth) (do i have|have i got)$/.test(t)) return res('balance', 'what’s my balance', 'what’s my balance')
  if (/^(the |weekly |this weeks )?pot$|^(whats|show|check|how big is)( the)?( weekly)? pot$/.test(t)) return res('pot', 'how big is the pot', 'how big is the pot')
  // not a command we can rebuild: best guess at what it was about (for suggestions), the model gets the original text
  const intent: Intent | null = /\b(every|each|daily|weekly|monthly|hourly|dca|stack|recurring)\b/.test(t) && !/\b(pause|resume|cancel|stop)\b/.test(t) ? 'dca'
    : /\b(swap|sell|convert|trade)\b/.test(t) || (/\bbuy\b/.test(t) && /\b(eth|wif)\b/.test(t)) ? 'swap'
    : /\b(tip|send|give)\b/.test(t) ? 'tip' : /\bsubscribe\b/.test(t) ? 'subscribe' : /\b(pause|resume|cancel|withdraw)\b/.test(t) ? 'manage'
    : /\bbalance\b/.test(t) ? 'balance' : /\bpot\b/.test(t) ? 'pot' : null
  return { confidence: 'low', intent, canonical: null, label: null, norm }
}

/** 2-3 tappable commands for a message we couldn't read, built from what it seemed to be about. */
export function suggestionsFor(it: Interpreted): string[] {
  const t = it.norm.text
  const handle = t.match(/@[a-z0-9_]{3,20}|\b[a-z0-9_]{3,20}\.wif\b/)?.[0] ?? '@name'
  const num = t.match(/\$(\d+(?:\.\d+)?)/)?.[1] ?? t.match(/\b(\d+(?:\.\d+)?)\b/)?.[1]
  const day = DAYS.find(d => t.includes(d))
  const byIntent: Record<Intent, string[]> = {
    dca: [`buy $${num ?? 5} of WIF every ${day ? capWord(day) : 'Monday'} at 9:00`, `buy $${num ?? 5} of WIF every day at 9:00`, 'pause my DCA'],
    swap: [`swap ${num && Number(num) < 10 ? num : '0.01'} ETH to WIF`, `swap ${num && Number(num) >= 10 ? num : '5000'} WIF to ETH`, 'buy $5 of WIF every Monday at 9:00'],
    tip: [`tip ${handle} ${num ?? 50}`, `subscribe ${handle}`, 'what’s my balance'],
    subscribe: [`subscribe ${handle}`, `tip ${handle} ${num ?? 50}`, 'renew my plus'],
    plus: ['renew my plus', 'renew my plus yearly', 'what’s my balance'],
    promote: [`promote my latest drop for ${num ?? 100}`, 'what’s my balance', 'how big is the pot'],
    manage: ['pause my DCA', 'resume my DCA', 'cancel my DCA'],
    balance: ['what’s my balance', 'how big is the pot', 'swap 0.01 ETH to WIF'],
    pot: ['how big is the pot', 'what’s my balance', 'buy $5 of WIF every Monday at 9:00'],
  }
  return (it.intent ? byIntent[it.intent] : ['swap 0.01 ETH to WIF', 'buy $5 of WIF every Monday at 9:00', 'what’s my balance']).slice(0, 3)
}
