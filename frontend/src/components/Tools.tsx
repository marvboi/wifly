import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { useSession } from '../api/session'
import { api } from '../api/client'
import { useStore } from '../state/store'
import { useCommunityPot } from '../lib/wifly'
import { useWifBalance } from '../lib/chain'
import { call } from '../companion/agentApi'
import { AGENT_READY, DCA_ADDRESS, DCA_READY } from '../config'
import { Sheet } from '../sheets/Sheets'
import { Icon } from './Icon'

/**
 * Shortcuts to the money tools: the home row under the composer, the phone "more" sheet and the desktop rail.
 * Icons are drawn like the wifly face: a soft filled body with round-capped lime features.
 */
export type ToolId = 'swap' | 'tip' | 'names' | 'plus' | 'jar' | 'dca' | 'messages' | 'agent'
type Tool = { id: ToolId; label: string; line: string; to?: string }
export const TOOLS: Record<ToolId, Tool> = {
  swap: { id: 'swap', label: 'swap', line: 'swap ETH for $WIF', to: '/swap' },
  tip: { id: 'tip', label: 'tip', line: 'send $WIF to a member, a name.wif or a wallet' },
  names: { id: 'names', label: 'names', line: 'claim or manage your name.wif', to: '/names' },
  plus: { id: 'plus', label: 'plus', line: 'the plus check and more, paid in $WIF', to: '/plus' },
  jar: { id: 'jar', label: 'jar', line: 'the weekly community pot', to: '/vote#pot' },
  dca: { id: 'dca', label: 'scheduled buys', line: 'buy $WIF on a schedule', to: '/dca' },
  messages: { id: 'messages', label: 'messages', line: 'chat with people on wifly', to: '/messages' },
  agent: { id: 'agent', label: 'agent', line: 'coming soon', to: '/agent' },
}
/** Direct messages ship in a later release: until then the row says so instead of promising a chat. */
const DMS_LIVE = false
const MORE: ToolId[] = ['swap', 'tip', 'names', 'plus', 'jar', 'messages', 'agent', 'dca']
/** A calm grey "soon" tag for tools that aren't switched on yet. */
const soonTag = (id: ToolId) => (id === 'messages' && !DMS_LIVE) || (id === 'dca' && !DCA_READY) || (id === 'agent' && !AGENT_READY)
const SHORT: ToolId[] = ['swap', 'tip', 'names', 'plus', 'jar']
const RAIL: ToolId[] = ['swap', 'names', 'plus', 'jar', 'dca']

const blob = 'M12 2.6c5.9 0 9.4 3.4 9.4 9.4s-3.5 9.4-9.4 9.4S2.6 17.9 2.6 12 6.1 2.6 12 2.6Z'
const coin = 'M12 2.4a9.6 9.6 0 1 1 0 19.2 9.6 9.6 0 0 1 0-19.2Z'
const art: Record<ToolId, { body: string; feat: ReactNode }> = {
  swap: { body: blob, feat: <path d="M7.6 9.6h8.6M13.8 7.2l2.4 2.4-2.4 2.4M16.4 14.4H7.8M10.2 12l-2.4 2.4 2.4 2.4" /> },
  tip: { body: coin, feat: <path d="M14.7 9.3c-.5-.9-1.5-1.5-2.7-1.5-1.5 0-2.6.8-2.6 1.9 0 2.6 5.6 1.3 5.6 4.3 0 1.2-1.2 2-2.8 2-1.3 0-2.4-.6-2.9-1.6M12 6.2v1.6M12 15.9v1.7" /> },
  names: {
    body: 'M3 8c0-2.8 2.2-5 5-5h4.6c1.3 0 2.5.5 3.4 1.4l4.4 4.4c1.9 1.9 1.9 5 0 6.9l-4.6 4.6c-1.9 1.9-5 1.9-6.9 0l-4.5-4.4C3.5 15 3 13.8 3 12.5Z',
    feat: <><circle cx="8.6" cy="8.6" r="1.5" /><path d="M10.6 15.4c1.4 1.1 3.2 1 4.6-.3" /></>,
  },
  plus: { body: blob, feat: <path d="M12 7.6v8.8M7.6 12h8.8" /> },
  jar: {
    body: 'M8.2 2.8h7.6c.8 0 1.4.6 1.4 1.4v.8c0 .5-.3 1-.7 1.2 2.1 1.3 3.5 3.5 3.5 6.3v2.6c0 3.5-2.8 6.3-6.3 6.3h-3.4c-3.5 0-6.3-2.8-6.3-6.3v-2.6c0-2.8 1.4-5 3.5-6.3-.4-.2-.7-.7-.7-1.2v-.8c0-.8.6-1.4 1.4-1.4Z',
    feat: <path d="M9.7 12.3v1.3M14.3 12.3v1.3M9.4 16.3c1.5 1.3 3.7 1.3 5.2 0" />,
  },
  dca: { body: coin, feat: <path d="M12 7v5.2l3.2 2" /> },
  messages: {
    body: 'M12 3c5.4 0 9 3.1 9 7.9s-3.6 7.9-9 7.9c-.9 0-1.8-.1-2.6-.3L5.6 20.4c-.6.3-1.2-.2-1.1-.8l.6-3C3.8 15.2 3 13.2 3 10.9 3 6.1 6.6 3 12 3Z',
    feat: <path d="M8.6 9.8v1M15.4 9.8v1M9.4 13.4c1.5 1.2 3.7 1.2 5.2 0" />,
  },
  agent: {
    body: 'M12 2.4c.6 0 1 .4 1 1v1.4c4.4.4 7.4 3.4 7.4 7.8 0 4.9-3.4 8-8.4 8s-8.4-3.1-8.4-8c0-4.4 3-7.4 7.4-7.8V3.4c0-.6.4-1 1-1Z',
    feat: <path d="M9.2 11.4v1.4M14.8 11.4v1.4M9.4 16c1.5 1 3.7 1 5.2 0" />,
  },
}

export function ToolIcon({ id, size = 26 }: { id: ToolId; size?: number }) {
  const a = art[id]
  return (
    <svg className="toolicon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path className="toolicon__body" d={a.body} />
      <g className="toolicon__feat" fill="none" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">{a.feat}</g>
    </svg>
  )
}

/** Opens a tool: a page, or the tip sheet (guests get the sign-up step from the sheet itself). */
function useOpenTool() {
  const nav = useNavigate()
  const { openSheet } = useStore()
  return (id: ToolId, before?: () => void) => {
    before?.()
    const t = TOOLS[id]
    if (id === 'tip') openSheet({ type: 'tip' })
    else if (t.to) nav(t.to)
  }
}

/** Home: round shortcuts under the composer. Fades away while scrolling down (no layout shift), back on the way up. */
export function ShortcutRow() {
  const open = useOpenTool()
  const [hidden, setHidden] = useState(false)
  const last = useRef(0)
  useEffect(() => {
    last.current = window.scrollY
    let raf = 0
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const y = window.scrollY
        const d = y - last.current
        if (Math.abs(d) < 6) return
        setHidden(d > 0 && y > 120)
        last.current = y
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf) }
  }, [])
  return (
    <nav className={`shortcuts${hidden ? ' shortcuts--hidden' : ''}`} aria-label="shortcuts" data-testid="shortcuts" aria-hidden={hidden || undefined}>
      {SHORT.map(id => (
        <button key={id} type="button" className="shortcut" onClick={() => open(id)} tabIndex={hidden ? -1 : undefined}>
          <span className="shortcut__disc"><ToolIcon id={id} /></span>
          <span className="shortcut__label">{TOOLS[id].label}</span>
        </button>
      ))}
    </nav>
  )
}

/** Phone: the "more" sheet from the bottom bar. The same five tools, plus the pages that only fit the wide dock. */
export function MoreSheet({ onClose }: { onClose: () => void }) {
  const open = useOpenTool()
  return (
    <Sheet title="more" onClose={onClose} className="sheet--more">
      <ul className="moresheet" data-testid="more-sheet">
        {MORE.map(id => {
          const soon = soonTag(id)
          return (
            <li key={id}>
              <button type="button" className="moresheet__row" data-testid={`more-row-${id}`} onClick={() => open(id, onClose)}>
                <span className="moresheet__disc"><ToolIcon id={id} size={30} /></span>
                <span className="moresheet__text">
                  <span className="moresheet__title"><b>{TOOLS[id].label}</b>{soon && <span className="moresheet__soon">soon</span>}</span>
                  <span className="moresheet__hint">{TOOLS[id].line}</span>
                </span>
                <Icon name="chevron" size={18} className="moresheet__go" />
              </button>
            </li>
          )
        })}
      </ul>
    </Sheet>
  )
}

type PlusView = { state: 'none' | 'active' | 'grace' | 'expired'; signedOut?: boolean }
type Mine = { names: unknown[] }
type DcaState = { plans: { status: string }[] }
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 2 })

/** Live state per tool, from the same reads the pages use. Nothing while loading or unknown: never a made-up number. */
function useToolState(): Partial<Record<ToolId, string>> {
  const { me } = useSession()
  const on = !!me && !me.guest
  const plus = useQuery({ queryKey: ['plus', me?.handle], queryFn: () => api<PlusView>('/plus'), enabled: on, staleTime: 60_000 })
  const names = useQuery({ queryKey: ['names', 'mine'], queryFn: () => api<Mine>('/names/mine'), enabled: on, staleTime: 60_000 })
  const dca = useQuery({ queryKey: ['dca', me?.handle], queryFn: () => call<DcaState>('/dca'), enabled: on && !!DCA_ADDRESS, staleTime: 60_000 })
  const pot = useCommunityPot()
  const wif = useWifBalance(on && me?.address ? (me.address as Address) : undefined).value
  const s: Partial<Record<ToolId, string>> = {}
  if (wif !== undefined) s.swap = `${fmt(wif)} WIF`
  const n = names.data?.names?.length
  if (n !== undefined) s.names = n === 0 ? 'none yet' : `${n} ${n === 1 ? 'name' : 'names'}`
  const p = plus.data && !plus.data.signedOut ? plus.data.state : undefined
  if (p) s.plus = p === 'active' ? 'plus active' : p === 'grace' ? 'in grace' : p === 'expired' ? 'expired' : 'not active'
  if (pot !== undefined) s.jar = `${fmt(pot)} WIF`
  if (!DCA_READY) s.dca = 'soon'
  else if (dca.data?.plans) { const a = dca.data.plans.filter(x => x.status === 'active').length; s.dca = a ? `${a} active` : 'none yet' }
  return s
}

/** Desktop side menu: the tools with their live state. */
export function ToolsRail() {
  const st = useToolState()
  return (
    <section className="side-card tools" aria-label="tools" data-testid="tools-rail">
      <h3 className="side-card__title">tools</h3>
      <ul className="tools__list">
        {RAIL.map(id => (
          <li key={id}>
            <Link to={TOOLS[id].to!} className="tools__row" title={TOOLS[id].line}>
              <ToolIcon id={id} size={24} />
              <span className="tools__label">{TOOLS[id].label}</span>
              {st[id] && <span className={`tools__state${id === 'plus' && st.plus === 'plus active' ? ' tools__state--on' : ''}${st[id] === 'soon' ? ' tools__state--soon' : ''}`} data-testid={`tool-state-${id}`}>{st[id]}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
