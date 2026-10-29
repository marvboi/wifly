/**
 * The Wifly companion's event bus. Anything in the app can make the face react:
 *   companion.say('checking that name…', 'think')
 *   companion.celebrate('tip', 'tip landed')   // only after a receipt says success (or in preview)
 * The dock (components/Companion.tsx) and the onboarding host listen with useCompanionFeed().
 */
import { useEffect, useRef, useState } from 'react'
import type { Mood } from '../components/Mascot'

export type Celebration = 'tip' | 'vote' | 'name' | 'plus' | 'burn' | 'agent'
export type CompanionEvent = { mood?: Mood; say?: string; celebrate?: Celebration; ms?: number }
const subs = new Set<(e: CompanionEvent) => void>()

export const companion = {
  emit: (e: CompanionEvent) => subs.forEach(f => f(e)),
  say: (say: string, mood: Mood = 'calm', ms = 3200) => companion.emit({ say, mood, ms }),
  celebrate: (kind: Celebration, say?: string) => companion.emit({ celebrate: kind, mood: 'happy', say: say ?? CHEERS[kind], ms: 3400 }),
}
const CHEERS: Record<Celebration, string> = {
  tip: 'tip landed. that made their day',
  vote: 'votes counted. the crowd decides',
  name: 'your .wif name is yours',
  plus: 'welcome to plus ✓',
  burn: 'burned for good. badge earned',
  agent: 'done. logged in your activity',
}
export function subscribeCompanion(f: (e: CompanionEvent) => void) { subs.add(f); return () => { subs.delete(f) } }

/** Current mood, a speech bubble and a celebration pulse. Falls back to `base` mood after each event. */
export function useCompanionFeed(base: Mood = 'calm') {
  const [mood, setMood] = useState<Mood>(base)
  const [bubble, setBubble] = useState<string | null>(null)
  const [pulse, setPulse] = useState(0)
  const [party, setParty] = useState<Celebration | null>(null)
  const t = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => { setMood(base) }, [base])
  useEffect(() => subscribeCompanion(e => {
    clearTimeout(t.current)
    if (e.mood) setMood(e.mood)
    if (e.say !== undefined) setBubble(e.say || null)
    if (e.celebrate) { setPulse(Date.now()); setParty(e.celebrate) }
    t.current = setTimeout(() => { setMood(base); setBubble(null); setParty(null) }, e.ms ?? 3000)
  }), [base])
  return { mood, bubble, pulse, party }
}
