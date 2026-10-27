/**
 * Burn-badge medals (WiflyBadges tiers). Pure SVG strings: crisp at any size, no filters, no glows.
 * One generator feeds the React <BadgeArt/> and the static files in public/badges/<id>.svg
 * (`npm run badges:svg`), which the WiflyBadges ERC1155 metadata URI can point at.
 *
 * Each tier has its own material (bronze, silver, gold, emerald-lime), a notched rim, an engraved ember over the
 * flat-world disc, and the burned amount stamped at the bottom.
 */
export type MedalTier = { id: string; min: number; name: string }
type Metal = { deep: string; mid: string; light: string; edge: string; ink: string; ember: string; emberCore: string }

export const METALS: Record<string, Metal & { material: string }> = {
  'first-light': { material: 'bronze', deep: '#7A4A22', mid: '#B9783F', light: '#E9B98A', edge: '#5C3517', ink: '#4A2A10', ember: '#8E3F14', emberCore: '#F2C08E' },
  'flat-earther': { material: 'silver', deep: '#7E848C', mid: '#BCC2C9', light: '#F2F4F6', edge: '#5F656C', ink: '#3D4248', ember: '#5A6068', emberCore: '#FFFFFF' },
  'edge-walker': { material: 'gold', deep: '#8E6B14', mid: '#D2A73E', light: '#F6E3A1', edge: '#6E5210', ink: '#4E3A0A', ember: '#9A5B10', emberCore: '#FFF1C2' },
  'the-disc': { material: 'emerald-lime', deep: '#1F5E2C', mid: '#4FA63A', light: '#D3F57E', edge: '#164622', ink: '#0F3318', ember: '#1F5E2C', emberCore: '#E8FFB0' },
}

export const fmtBurn = (n: number) => (n >= 1e6 ? `${n / 1e6}M` : n >= 1e3 ? `${n / 1e3}K` : String(n))

function rim(cx: number, cy: number, rOut: number, rIn: number, teeth: number) {
  const pts: string[] = []
  for (let i = 0; i < teeth * 2; i++) {
    const r = i % 2 ? rIn : rOut, a = (Math.PI * i) / teeth - Math.PI / 2
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`)
  }
  return pts.join(' ')
}

/** `uid` keeps gradient ids unique when many medals share a page. */
export function medalSvg(t: MedalTier, o: { earned?: boolean; uid?: string; title?: boolean } = {}) {
  const m = METALS[t.id] ?? METALS['first-light']
  const earned = o.earned ?? true
  const u = (o.uid ?? t.id).replace(/[^a-zA-Z0-9_-]/g, '')
  const g = (k: string) => `${k}-${u}`
  const label = fmtBurn(t.min)
  const teeth = { 'first-light': 12, 'flat-earther': 16, 'edge-walker': 20, 'the-disc': 24 }[t.id] ?? 16
  const title = o.title === false ? '' : `<title>${t.name}: ${t.min.toLocaleString('en-US')} WIF burned${earned ? '' : ' (not earned yet)'}</title>`
  if (!earned) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img">${title}
<polygon points="${rim(32, 32, 30.5, 28.2, teeth)}" fill="#FFFFFF" stroke="#D9D5CC" stroke-width="1"/>
<circle cx="32" cy="32" r="23.5" fill="none" stroke="#D9D5CC" stroke-width="1.2" stroke-dasharray="3 3"/>
<path d="M32 15.5c3.6 4 5.6 7 5.6 10.2a5.6 5.6 0 0 1-11.2 0c0-1.8.8-3.4 2-4.8.3 1.7 1.2 2.7 2.3 2.7-1-2.6-.4-5.4 1.3-8.1z" fill="none" stroke="#CFCAC0" stroke-width="1.2" stroke-linejoin="round"/>
<ellipse cx="32" cy="38.5" rx="13" ry="4.2" fill="none" stroke="#D9D5CC" stroke-width="1.2"/>
<text x="32" y="51.2" text-anchor="middle" font-family="'WIF Par',Inter,system-ui,sans-serif" font-size="6.4" font-weight="700" letter-spacing=".6" fill="#B9B4AA">${label}</text>
</svg>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img">${title}
<defs>
<linearGradient id="${g('rim')}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${m.light}"/><stop offset=".45" stop-color="${m.mid}"/><stop offset="1" stop-color="${m.deep}"/></linearGradient>
<linearGradient id="${g('face')}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${m.light}"/><stop offset=".55" stop-color="${m.mid}"/><stop offset="1" stop-color="${m.deep}"/></linearGradient>
<linearGradient id="${g('bevel')}" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="${m.light}"/><stop offset=".5" stop-color="${m.mid}"/><stop offset="1" stop-color="${m.deep}"/></linearGradient>
<linearGradient id="${g('ember')}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${m.ember}"/><stop offset="1" stop-color="${m.ink}"/></linearGradient>
<linearGradient id="${g('shine')}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<clipPath id="${g('clip')}"><circle cx="32" cy="32" r="24.6"/></clipPath>
</defs>
<polygon points="${rim(32, 32.8, 30.5, 28.2, teeth)}" fill="${m.edge}" opacity=".35"/>
<polygon points="${rim(32, 32, 30.5, 28.2, teeth)}" fill="url(#${g('rim')})" stroke="${m.edge}" stroke-width=".6"/>
<circle cx="32" cy="32" r="26.2" fill="url(#${g('bevel')})" stroke="${m.edge}" stroke-width=".5"/>
<circle cx="32" cy="32" r="24.6" fill="url(#${g('face')})"/>
<g clip-path="url(#${g('clip')})">
<circle cx="32" cy="32" r="22.6" fill="none" stroke="${m.ink}" stroke-opacity=".28" stroke-width=".7"/>
<path d="M32 13.8c4.3 4.7 6.7 8.3 6.7 12.2a6.7 6.7 0 0 1-13.4 0c0-2.2.9-4.1 2.4-5.8.4 2 1.5 3.3 2.8 3.3-1.2-3.1-.5-6.5 1.5-9.7z" fill="url(#${g('ember')})"/>
<path d="M32.3 21.4c1.8 2.1 2.9 3.8 2.9 5.4a3.1 3.1 0 0 1-6.2 0c0-1.1.5-2.1 1.3-3 .2.9.7 1.4 1.3 1.4-.4-1.3-.2-2.6.7-3.8z" fill="${m.emberCore}"/>
<ellipse cx="32" cy="38.6" rx="14.2" ry="4.6" fill="${m.light}" fill-opacity=".55" stroke="${m.ink}" stroke-width="1.1"/>
<ellipse cx="32" cy="38.6" rx="9" ry="2.8" fill="none" stroke="${m.ink}" stroke-opacity=".55" stroke-width=".8"/>
<rect class="medal__shine" x="-30" y="0" width="22" height="64" fill="url(#${g('shine')})" transform="skewX(-18)"/>
</g>
<path d="M14.5 44.5h35" stroke="${m.ink}" stroke-opacity=".25" stroke-width=".6"/>
<text x="32" y="51.3" text-anchor="middle" font-family="'WIF Par',Inter,system-ui,sans-serif" font-size="6.6" font-weight="800" letter-spacing=".7" fill="${m.ink}">${label}</text>
<path d="M20 21.5a14 14 0 0 1 6-6" stroke="#fff" stroke-opacity=".6" stroke-width="1.2" fill="none" stroke-linecap="round"/>
</svg>`
}
