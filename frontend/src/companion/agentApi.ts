/** Thin client for the companion's agent endpoints (backend/src/agent). The agent key never leaves the server. */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { checkEpoch, epochSignal, LINK_REQUIRED_EVENT, sessionEpoch } from '../api/client'

export type AgentState = {
  enabled: boolean; cap: number; spentToday: number; remaining: number; deposited: number; maxCap: number
  source: 'chain' | 'app'; live: boolean; sending: boolean; agentAddress: string | null; authorized: boolean
  whitelist: string[]; functions: string[]
}
export type Recipient = { input: string; kind: 'wif' | 'handle' | 'address'; label: string; address: string | null; source: string }
export type Planned = {
  ok: boolean; kind: 'tip' | 'subscribe' | 'renew_plus' | 'promote' | 'refuse'; summary: string; command: string
  recipient?: Recipient | null; amount?: number; usd?: number | null; plan?: 'month' | 'year'; tier?: number
  call?: { fn: string; args: string[] }; refuse?: string; needsTopUp?: { shortfall: number } | null; state: AgentState
}
export type Executed = { ok: boolean; status: 'sent' | 'preview' | 'refused' | 'failed'; reason?: string; hash?: string; id?: number; action: Planned; state?: AgentState }
export type Activity = { id: number; kind: string; command: string; recipient: string | null; address: string | null; amount: number; status: Executed['status']; reason: string | null; txHash: string | null; at: number }

/** Like api(), but hands back the JSON body for 4xx/5xx too (refusals carry a reason). */
export async function call<T>(path: string, method = 'GET', json?: unknown): Promise<T> {
  const started = sessionEpoch()
  const res = await fetch(`/api${path}`, {
    method, credentials: 'same-origin', signal: epochSignal(),
    headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-wifly': '1' } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  })
  const body = await res.json().catch(() => ({ error: res.statusText }))
  checkEpoch(started)
  // a guest account: the server says link_required and the link sheet opens (same as api())
  if (res.status === 403 && body?.code === 'link_required') window.dispatchEvent(new CustomEvent(LINK_REQUIRED_EVENT))
  if (!res.ok && !('status' in body)) throw new Error(body.error ?? res.statusText)
  return body as T
}

export function useAgent(enabled: boolean) {
  return useQuery({ queryKey: ['agent'], queryFn: () => call<AgentState>('/agent'), enabled, refetchInterval: 30_000 })
}
export function useActivity(enabled: boolean) {
  return useQuery({ queryKey: ['agent', 'activity'], queryFn: () => call<{ items: Activity[] }>('/agent/activity'), enabled })
}
export function useAgentRefresh() {
  const qc = useQueryClient()
  return (s?: AgentState) => { if (s) qc.setQueryData(['agent'], s); qc.invalidateQueries({ queryKey: ['agent'] }) }
}

// ---------------------------------------------------------------- companion chat (POST /api/companion/chat)
export type PlusAccess = { ok: boolean; state: 'active' | 'grace' | 'none' | 'expired' | 'unknown'; source: 'chain' | 'app'; graceEndsAt: number | null; reason?: string }
export type DcaDraftCard = { perBuy: { usd?: number; eth?: number }; every: 'hour' | 'day' | 'week' | 'month'; weekday: number | null; hour: number; minute: number; summary: string; depositEth: number | null }
export type ChatCard =
  | { type: 'action'; plan: Planned }
  | { type: 'swap'; dir: 'eth2wif' | 'wif2eth'; amount: number; out: number | null; usd: number | null }
  | { type: 'dca'; draft: DcaDraftCard }
  | { type: 'dca_manage'; action: 'pause' | 'resume' | 'withdraw'; plan: { id: number; perBuyUsd: number | null; perBuyEth: number; status: string } }
  | { type: 'creators'; users: Array<{ handle?: string; name?: string }> }
  | { type: 'unlock'; reason: string }
  | { type: 'suggest'; label: string; text: string; fixes: { from: string; to: string }[] }
  | { type: 'suggestions'; options: string[] }
export type ChatReply = { reply: string; cards: ChatCard[]; source: 'model' | 'app'; model?: string; plus: PlusAccess; chatOn: boolean; freeLeft: number | null; busy?: boolean; error?: string }
export type CompanionInfo = { plus: PlusAccess; chatOn: boolean; freeLeft: number | null; freePerDay: number }
export type MyAgent = { locked: boolean; plus: PlusAccess; dca?: { live: boolean; plans: Array<{ id: number; perBuyUsd: number | null; perBuyEth: number; intervalS: number; buysLeft: number; status: string; nextAt: number | null }> }; actions?: Activity[] }

export function useCompanionInfo(enabled: boolean) {
  return useQuery({ queryKey: ['companion'], queryFn: () => call<CompanionInfo>('/companion'), enabled, refetchInterval: 60_000 })
}
export function useMyAgent(enabled: boolean) {
  return useQuery({ queryKey: ['companion', 'my-agent'], queryFn: () => call<MyAgent>('/companion/my-agent').catch(() => ({ locked: true } as MyAgent)), enabled })
}
