// Writes public/badges/<id>.svg (earned + locked) from src/lib/medal.ts — run with `npm run badges:svg`.
import { writeFileSync, mkdirSync } from 'node:fs'
const { medalSvg } = await import('../src/lib/medal.ts')
const LEVELS = [
  { id: 'first-light', min: 1_000, name: 'first light' }, { id: 'flat-earther', min: 10_000, name: 'flat earther' },
  { id: 'edge-walker', min: 100_000, name: 'edge walker' }, { id: 'the-disc', min: 1_000_000, name: 'the disc' },
]
mkdirSync('public/badges', { recursive: true })
for (const [i, l] of LEVELS.entries()) {
  const svg = medalSvg(l, { earned: true })
  writeFileSync(`public/badges/${l.id}.svg`, svg)
  // WiflyBadges ids are 0-based (thresholds[i]). ERC-1155 metadata: uri "<host>/badges/meta/{id}.json", {id} = 64 hex chars.
  const hex = i.toString(16).padStart(64, '0')
  mkdirSync('public/badges/meta', { recursive: true })
  writeFileSync(`public/badges/meta/${hex}.json`, JSON.stringify({
    name: `Wifly burn badge: ${l.name}`,
    description: `Earned by burning ${l.min.toLocaleString('en-US')} $WIF on Wifly. Soulbound.`,
    image: `${process.env.BADGE_BASE_URL ?? ""}/badges/${l.id}.svg`, // set BADGE_BASE_URL=https://<app host> before deploy
    attributes: [{ trait_type: 'burned', value: l.min }, { trait_type: 'tier', value: i + 1 }],
  }, null, 2))
  writeFileSync(`public/badges/${l.id}-locked.svg`, medalSvg(l, { earned: false }))
  console.log(l.id, svg.length, 'bytes')
}
