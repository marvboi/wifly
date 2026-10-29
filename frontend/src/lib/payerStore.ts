/** 11.8.5: the wallet that pays, app-wide. PayerSync works it out; useSendPlan, the wallet menu and every "paying from" row read it. */
import { useSyncExternalStore } from 'react'
import type { PayerOption } from './payer'

export type PayerState = { user: string | null; options: PayerOption[]; address: string | null }
let state: PayerState = { user: null, options: [], address: null }
const subs = new Set<() => void>()
const KEY = (user: string) => `wifly-payer:${user.toLowerCase()}`

export const payerStore = {
  get: () => state,
  subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn) } },
  set(next: PayerState) {
    if (next.user === state.user && next.address === state.address && JSON.stringify(next.options) === JSON.stringify(state.options)) return
    state = next; subs.forEach(f => f())
  },
  saved(user: string): string | null { try { return localStorage.getItem(KEY(user)) } catch { return null } },
  /** The user's pick sticks per account. Only an address that's already one of their wallets. */
  choose(address: string) {
    const a = address.toLowerCase()
    if (!state.user || !state.options.some(o => o.address === a)) return false
    try { localStorage.setItem(KEY(state.user), a) } catch { /* private mode: it lasts for this visit */ }
    payerStore.set({ ...state, address: a })
    return true
  },
  current(): PayerOption | null { return state.options.find(o => o.address === state.address) ?? null },
}

export const OPEN_WALLET_EVENT = 'wifly:open-wallet'
export const openWalletMenu = () => window.dispatchEvent(new Event(OPEN_WALLET_EVENT))
export function usePayerState() { return useSyncExternalStore(payerStore.subscribe, payerStore.get) }
