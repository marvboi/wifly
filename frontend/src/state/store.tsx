import { GENERIC_LINE, looksRaw } from '../lib/txError'
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

export type AgentLog = { id: string; text: string; amount?: number; time: string }
/** Local agent settings before anything is saved on chain. No spending, no history until there is real activity. */
export const agentDefaults = {
  enabled: false,
  dailyCap: 250,
  spentToday: 0,
  toggles: { autoTip: true, renewSubs: true, defendTopSpot: false, dailySummary: true },
  maxDefendBid: 5000,
  tipPerPost: 10,
  log: [] as AgentLog[],
  summary: [] as string[],
}

export type SheetState =
  | { type: 'tip'; to?: string; postId?: string; dm?: boolean }
  | { type: 'unlock'; postId: string }
  | { type: 'subscribe'; handle: string; tierId?: string }
  | { type: 'bid' }
  | { type: 'buy'; handle: string; itemId: string }
  | { type: 'paydm'; handle: string }
  | { type: 'vote'; handle: string; postId?: string }
  | { type: 'swap'; wifOut?: number; reason?: string }
  | { type: 'burn'; amount?: number }
  | { type: 'drop' }
  | { type: 'tiers' }
  | { type: 'compose'; replyTo?: string; quoteOf?: string }
  | { type: 'signin'; reason?: string }
  /** guests: link a wallet, x or email, then `then` runs (gated sheets reopen on their own) */
  | { type: 'link'; then?: () => void }
  | { type: 'badge'; id: string; handle?: string }
  | { type: 'profile' }
  | null

export type ToastTone = 'ok' | 'warn' | 'info'
type Toast = { id: number; title: string; body?: string; tone: ToastTone; /** a wallet address to show short with a copy button (gas toasts) */ copy?: string }
/** Tone from the wording when the caller doesn't say: problems get the warning style, never a green check. */
const WARN_RE = /couldn|can.t|cannot|didn.t|failed|fail|not sent|error|wrong|denied|rejected|declined|too (big|many|long|low)|must|over |sign in first|blocked|expired|not enough|unavailable|try again|isn.t/i
const INFO_RE = /^(preview|heads up|note|cancelled|one moment)|soon\b|copied/i
export const toneOf = (title: string, body?: string): ToastTone => WARN_RE.test(title) || WARN_RE.test(body ?? '') && !/^(sent|saved|done|confirmed)/i.test(title) ? 'warn' : INFO_RE.test(title) ? 'info' : 'ok'

/** The api's link_required message: never toasted, the link sheet opens instead. */
const LINK_LINE = /^link a wallet, x or email to continue$/i

type AgentState = typeof agentDefaults

type Store = {
  liked: Set<string>; toggleLike: (id: string) => void
  reposted: Set<string>; toggleRepost: (id: string) => void
  unlocked: Set<string>; unlock: (id: string) => void
  subs: Record<string, string>; subscribe: (handle: string, tierId: string) => void
  following: Set<string>; toggleFollow: (h: string) => void
  paidDms: Set<string>; payDm: (h: string) => void
  votes: Record<string, number>; addVotes: (key: string, n: number) => void
  plus: boolean; setPlus: (v: boolean) => void
  topSpot: { postId: string; holder: string; paid: number }; takeTopSpot: (postId: string, amount: number) => void
  agent: AgentState; setAgent: (fn: (a: AgentState) => AgentState) => void
  sheet: SheetState; openSheet: (s: SheetState) => void; closeSheet: () => void
  toasts: Toast[]; toast: (title: string, body?: string, tone?: ToastTone, copy?: string) => void
}

const Ctx = createContext<Store | null>(null)

function useSet(initial: string[] = []) {
  const [s, setS] = useState(() => new Set(initial))
  const toggle = useCallback((k: string) => setS(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n }), [])
  const add = useCallback((k: string) => setS(prev => new Set(prev).add(k)), [])
  return [s, toggle, add] as const
}

export function StoreProvider({ children, initialSheet = null }: { children: ReactNode; initialSheet?: SheetState }) {
  const [liked, toggleLike] = useSet()
  const [reposted, toggleRepost] = useSet()
  const [unlocked, , unlock] = useSet()
  const [following, toggleFollow] = useSet()
  const [paidDms, , payDm] = useSet()
  const [subs, setSubs] = useState<Record<string, string>>({})
  const [plus, setPlus] = useState(false)
  const [votes, setVotes] = useState<Record<string, number>>({})
  const [topSpot, setTopSpot] = useState({ postId: '', holder: '', paid: 0 })
  const [agent, setAgentState] = useState<AgentState>(agentDefaults)
  const [sheet, setSheet] = useState<SheetState>(initialSheet)
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const toast = useCallback((title: string, body?: string, tone?: ToastTone, copy?: string) => {
    if (LINK_LINE.test(title) || LINK_LINE.test(body ?? '')) return // the link sheet already says it
    // 11.8.5: never a raw wall of text (it goes to the console), and each message shows once: a repeat replaces the old one
    if (body && looksRaw(body)) { console.warn('[wifly] toast', body); body = GENERIC_LINE }
    const id = nextId.current++
    const tn = tone ?? toneOf(title, body)
    setToasts(t => [...t.filter(x => !(x.title === title && x.body === body)).slice(-2), { id, title, body, tone: tn, copy }])
    window.setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), copy ? 9000 : tn === 'warn' ? 5200 : 3600)
  }, [])

  const value = useMemo<Store>(() => ({
    liked, toggleLike, reposted, toggleRepost, unlocked, unlock,
    subs, subscribe: (h, t) => setSubs(s => ({ ...s, [h]: t })),
    following, toggleFollow, paidDms, payDm, plus, setPlus,
    votes, addVotes: (k, n) => setVotes(v => ({ ...v, [k]: (v[k] ?? 0) + n })),
    topSpot, takeTopSpot: (postId, amount) => setTopSpot({ postId, holder: 'you', paid: amount }),
    agent, setAgent: fn => setAgentState(fn),
    sheet, openSheet: setSheet, closeSheet: () => setSheet(null),
    toasts, toast,
  }), [liked, toggleLike, reposted, toggleRepost, unlocked, unlock, subs, following, toggleFollow, paidDms, payDm, plus, votes, topSpot, agent, sheet, toasts, toast])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore() {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore outside StoreProvider')
  return s
}

/** Shown when payments aren't switched on yet: nothing is sent. */
export const PREVIEW_NOTE = 'payments aren’t live yet, so nothing was sent.'
