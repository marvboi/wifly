/**
 * Shared optimistic state for like / pass / bookmark.
 *
 * A stale feed or thread refetch used to overwrite a newer tap once the write's
 * in-flight counter hit zero. Intent is held until a *matching* snapshot arrives,
 * and only the latest request per drop+kind may commit or roll back.
 */
export const TOGGLE_FIELD = {
  like: ['liked', 'likes'],
  pass: ['passed', 'reposts'],
  bookmark: ['bookmarked', null],
} as const

export type ToggleKind = keyof typeof TOGGLE_FIELD
export type Flag = 'liked' | 'passed' | 'bookmarked'
export type FlagState = {
  liked?: boolean
  passed?: boolean
  bookmarked?: boolean
  likes?: number
  reposts?: number
}

type Intent = Partial<Record<Flag, boolean>>

const FLAGS = ['liked', 'passed', 'bookmarked'] as const

export function createToggles() {
  const intent = new Map<string, Intent>()
  const gen = new Map<string, number>()

  const key = (id: string, kind: ToggleKind) => `${id}:${kind}`

  function withIntent<T extends FlagState>(id: string, p: T): T {
    const i = intent.get(id)
    if (!i) return p
    const next = { ...p }
    for (const [flag, count] of Object.values(TOGGLE_FIELD)) {
      if (i[flag] === undefined || next[flag] === i[flag]) continue
      if (count) next[count] = Math.max(0, (p[count] ?? 0) + (i[flag] ? 1 : -1) - (p[flag] ? 1 : 0))
      next[flag] = i[flag]
    }
    return next
  }

  function setIntent(id: string, flag: Flag, on: boolean) {
    intent.set(id, { ...intent.get(id), [flag]: on })
  }

  /** Drop flags the snapshot already agrees with. Call only for GET/list adopts, not write echoes. */
  function settle(id: string, p: FlagState) {
    const i = intent.get(id)
    if (!i) return
    const rest: Intent = { ...i }
    for (const flag of FLAGS) {
      if (rest[flag] !== undefined && p[flag] === rest[flag]) delete rest[flag]
    }
    if (!FLAGS.some(f => rest[f] !== undefined)) intent.delete(id)
    else intent.set(id, rest)
  }

  function nextGen(id: string, kind: ToggleKind) {
    const g = (gen.get(key(id, kind)) ?? 0) + 1
    gen.set(key(id, kind), g)
    return g
  }

  function isCurrent(id: string, kind: ToggleKind, g: number) {
    return gen.get(key(id, kind)) === g
  }

  function revertIntent(id: string, flag: Flag, on: boolean) {
    const i = intent.get(id)
    if (!i || i[flag] !== on) return
    const rest: Intent = { ...i }
    delete rest[flag]
    if (!FLAGS.some(f => rest[f] !== undefined)) intent.delete(id)
    else intent.set(id, rest)
  }

  function adopt<T extends FlagState>(id: string, snapshot: T): T {
    settle(id, snapshot)
    return withIntent(id, snapshot)
  }

  return { withIntent, setIntent, settle, nextGen, isCurrent, revertIntent, adopt, intent, gen }
}

export const toggles = createToggles()
