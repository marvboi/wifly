/** Shared @username rules (keep in sync with config NAME_MIN / NAME_MAX). */
export const HANDLE_MIN = 3, HANDLE_MAX = 20

export type HandleCheck = {
  handle: string; available: boolean; reason?: 'invalid' | 'reserved' | 'taken' | 'listed' | 'x-reserved' | 'wif-owned' | 'yours'
  message?: string; price?: number; suggestions: string[]; claimFee: number; wifFree?: boolean
}

export const cleanHandle = (s: string) => s.trim().replace(/^@/, '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, HANDLE_MAX)

export type HandleUi = 'idle' | 'checking' | 'ok' | 'bad'

export function handleFieldState(value: string, checking: boolean, check?: HandleCheck): HandleUi {
  if (!value) return 'idle'
  if (checking) return 'checking'
  if (check?.available) return 'ok'
  return 'bad'
}

const LABEL: Record<string, string> = { reserved: 'reserved', taken: 'taken', listed: 'taken · for sale', 'x-reserved': 'taken', 'wif-owned': 'taken onchain', invalid: 'not valid', yours: 'yours' }

/** One short line under the field, only when something is wrong. Reuses existing error wording. */
export function handleFieldError(check: HandleCheck | undefined, state: HandleUi): string | null {
  if (state !== 'bad' || !check) return null
  const label = LABEL[check.reason ?? 'invalid'] ?? 'not valid'
  const msg = (check.message ?? '').trim()
  if (msg && msg.toLowerCase() !== label.toLowerCase()) {
    return `${msg}${check.price ? ` for ${check.price.toLocaleString()} wif` : ''}`
  }
  return label
}

/** Mood of the tiny picker logo (same mapping ClaimBox uses for taken / reserved). */
export type HandleFaceMood = 'calm' | 'happy' | 'think' | 'oops'

export function handleFaceMood(value: string, state: HandleUi, reason?: HandleCheck['reason']): HandleFaceMood {
  if (state === 'ok') return 'happy'
  if (reason === 'reserved' || reason === 'taken' || reason === 'x-reserved' || reason === 'listed' || reason === 'wif-owned') return 'oops'
  if (!value) return 'calm'
  if (state === 'checking' || (reason === 'invalid' && value.length < HANDLE_MIN) || value.length < HANDLE_MIN) return 'think'
  return 'oops'
}

/** Reserved / taken drop their short status word; the picker logo speaks for them. */
export function handleLogoReplacesError(reason?: HandleCheck['reason']): boolean {
  return reason === 'reserved' || reason === 'taken' || reason === 'x-reserved'
}
