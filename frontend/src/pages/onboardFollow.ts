/** Onboarding "follow a few people": pure state helpers (11.8.4). Nobody is pre-picked; only real follows and taps count. */
export type Suggested = { handle: string; youFollow?: boolean }

/**
 * Adds people you truly follow already (youFollow from the server) the first time each one shows up.
 * Someone seen before is never added back, so unticking everyone stays unticked.
 */
export function seedFollow(cur: Set<string>, seen: Set<string>, users: Suggested[]): Set<string> {
  let next = cur
  for (const u of users) {
    const h = u.handle.toLowerCase()
    if (seen.has(h)) continue
    seen.add(h)
    if (u.youFollow) { if (next === cur) next = new Set(cur); next.add(u.handle) }
  }
  return next
}

/** Tap: follow ↔ following. */
export function toggleFollow(cur: Set<string>, handle: string): Set<string> {
  const n = new Set(cur)
  if (n.has(handle)) n.delete(handle); else n.add(handle)
  return n
}

/** What finishing onboarding sends: exactly the people picked, nothing else (an empty list is fine). */
export const followPayload = (cur: Set<string>): string[] => [...cur]

export const followLabel = (on: boolean) => on ? 'following' : 'follow'
