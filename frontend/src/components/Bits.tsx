import { profilePath } from '../lib/paths'
import { useSyncExternalStore } from 'react'
import { Usd, useWifPrice } from '../lib/price'
import { getVersion, subscribe } from '../api/client'
import { PlusMark } from './BrandSlots'
import { Link } from 'react-router-dom'
import { useState } from 'react'
import { APP_NAME, WORDMARK_RATIO, WORDMARK_SRC } from '../brand'
import { explorerAddress } from '../config'
import { users } from '../state/registry'
import { shortAddr, at } from '../lib/format'
import { Icon } from './Icon'
import { HEAD_D, INK, NEON, bodyTransform, eyeBox, mouthD, restState } from '../brand/wiflyFaceCore'

/**
 * LOGO SLOT. Placeholder wordmark: styled text from APP_NAME, set in WIF Par.
 * When the Wifly logo is ready, set WORDMARK_SRC in src/brand.ts and this renders the file instead.
 */
export function Wordmark({ to = '/', size = 'md', tone = 'ink' }: { to?: string; size?: 'sm' | 'md' | 'lg'; tone?: 'ink' | 'paper' }) {
  const h = { sm: 24, md: 28, lg: 40 }[size]
  return (
    <Link to={to} className={`wordmark wordmark--${size} wordmark--${tone}`} aria-label={`${APP_NAME.toLowerCase()} home`} data-logo-slot>
      {WORDMARK_SRC
        ? <img src={WORDMARK_SRC} alt={APP_NAME.toLowerCase()} height={h} width={Math.round(h * WORDMARK_RATIO)} />
        : <span className="wordmark__name">{APP_NAME.toLowerCase()}</span>}
    </Link>
  )
}

/** The World is Flat / World is Fair grid mark, the site's own favicon file (not redrawn). */
export function WifGridMark({ size = 24 }: { size?: number }) {
  return <img className="gridmark" src="/brand/wif-grid-mark-192.png" width={size} height={size} alt="world is flat" />
}

/** A contract address with copy and explorer buttons. */
export function CopyAddress({ address, label, full = false }: { address: string; label?: string; full?: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(address) } catch { /* clipboard blocked: the address is still selectable */ }
    setCopied(true); window.setTimeout(() => setCopied(false), 1600)
  }
  return (
    <div className="addr">
      {label && <span className="addr__label">{label}</span>}
      <code className="addr__value mono" title={address}>{full ? address : shortAddr(address)}</code>
      <button className="addr__btn" onClick={copy} aria-label={`copy ${label ?? 'address'}`}>
        <Icon name={copied ? 'check' : 'copy'} size={16} /><span>{copied ? 'copied' : 'copy'}</span>
      </button>
      <a className="addr__btn" href={explorerAddress(address)} target="_blank" rel="noreferrer" aria-label="open in explorer">
        <Icon name="external" size={16} /><span>explorer</span>
      </a>
    </div>
  )
}

/** The $WIF asset logo (DexScreener listing art, see public/brand/SOURCES.md). */
export function Token({ size = 16, className = '' }: { size?: number; className?: string }) {
  return <img className={`token ${className}`} src={size > 48 ? '/brand/wif-asset-256.png' : '/brand/wif-asset-64.png'} width={size} height={size} alt="" aria-hidden="true" />
}

/** A WIF amount. Shows its live USD value ("≈ $x.xx") unless usd={false}. */
/**
 * PriceTag: the one way to show a WIF amount with its USD value. Coin, number and "WIF" on one baseline, then
 * "≈ $x" (hidden while the price is unknown or stale). `align="end"` right-aligns it in a row.
 */
export function Amount({ value, size = 14, decimals, usd = true, align }: { value: number; size?: number; decimals?: number; usd?: boolean; align?: 'start' | 'end' }) {
  const d = decimals ?? (value >= 100 || Number.isInteger(value) ? 0 : 2)
  return (
    <span className={`wifamt ${align === 'end' ? 'wifamt--end' : ''}`} style={size > 18 ? { fontSize: Math.round(size * 0.72) } : undefined}>
      <span className="amount">
        <Token size={size} />
        <span className="num">{value.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}</span>
        <span className="amount__unit">wif</span>
      </span>
      {usd && <WifUsd wif={value} />}
    </span>
  )
}
export const WifAmount = Amount
export const PriceTag = Amount

/** USD value of a WIF amount at the live price. */
export function WifUsd({ wif, className }: { wif: number; className?: string }) {
  const { usd } = useWifPrice()
  return <Usd value={usd !== undefined ? wif * usd : undefined} className={className} />
}

/** Two letters from the @username: "luna_tiles" -> "LT", "alice" -> "AL". */
export function initialsOf(handle: string) {
  const parts = handle.replace(/^@/, '').split(/[_.\-\s]+/).filter(Boolean)
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] ?? '').slice(0, 2)
  return (s || '?').toUpperCase()
}

const REST = restState(), EYE_L = eyeBox(REST.eyeL), EYE_R = eyeBox(REST.eyeR)
/** The still wifly face on its lime tile: the avatar for anyone who hasn't added a photo. Same geometry as the logo. */
export function WiflyFace({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} aria-hidden="true" focusable="false">
      <rect width="100" height="100" fill={NEON} />
      <g transform="translate(50 50.5) scale(0.62) translate(-50 -52)">
        <g transform={bodyTransform(REST)}>
          <path d={HEAD_D} fill={INK} />
          <rect {...EYE_L} fill={NEON} /><rect {...EYE_R} fill={NEON} />
          <path d={mouthD(REST.mouth)} fill="none" stroke={NEON} strokeWidth={REST.mouthW} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      </g>
    </svg>
  )
}

export function Avatar({ handle, size = 40, ring }: { handle: string; size?: number; ring?: boolean }) {
  useSyncExternalStore(subscribe, getVersion) // re-render when the api registry learns about this user
  const u = users[handle]
  const px = Math.round(size)
  if (u?.avatar) return <img className={`avatar avatar--img ${ring ? 'avatar--ring' : ''}`} src={u.avatar} width={px} height={px} alt="" aria-hidden="true" loading="lazy" decoding="async" />
  return (
    <span className={`avatar avatar--face ${ring ? 'avatar--ring' : ''}`} style={{ width: px, height: px }} aria-hidden="true" data-avatar="face">
      <WiflyFace size={px} />
    </span>
  )
}

/** A display name: someone holding a .wif (server-checked) shows as "name.wif" with a softer suffix. Never "@name.wif". */
export function DisplayName({ user }: { user: { name: string; wifName?: string | null } }) {
  return user.wifName ? <>{user.wifName}<span className="wifsfx">.wif</span></> : <>{user.name}</>
}

export function Name({ handle, showHandle = true }: { handle: string; showHandle?: boolean }) {
  const u = users[handle]
  if (!u) return <span className="name">{at(handle)}</span>
  return (
    <span className="name">
      <Link to={profilePath(u.handle)} className="name__display"><DisplayName user={u} /></Link>
      {u.plus && <PlusMark size={14} />}
      {showHandle && <span className="name__handle">{at(u.handle)}</span>}
    </span>
  )
}

/** Corner brackets: the engraved corner from the worldisflat.fun hackathon frame (inline SVG copied from the site). */
export function Corners() {
  const c = (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 21.5V7.5c0-2.8 2.2-5 5-5h14" /><path d="M6.5 21.5v-11c0-2.2 1.8-4 4-4h11" /><circle cx="10.6" cy="10.6" r="1" />
      </g>
    </svg>
  )
  return (
    <>
      <span className="corner corner--tl">{c}</span><span className="corner corner--tr">{c}</span>
      <span className="corner corner--br">{c}</span><span className="corner corner--bl">{c}</span>
    </>
  )
}

/** The flat world, drawn as a plain azimuthal disc with its ice wall. Line art only. */
export function FlatDisc({ className = '' }: { className?: string }) {
  const rings = [18, 34, 50, 66, 82]
  const meridians = Array.from({ length: 12 }, (_, i) => (i * Math.PI) / 6)
  return (
    <svg className={`flatdisc ${className}`} viewBox="0 0 200 200" aria-hidden="true">
      <g fill="none" stroke="currentColor">
        <circle cx="100" cy="100" r="96" strokeWidth="1.2" />
        <circle cx="100" cy="100" r="92" strokeWidth="0.6" strokeDasharray="1.5 2.5" />
        {rings.map(r => <circle key={r} cx="100" cy="100" r={r} strokeWidth="0.5" />)}
        {meridians.map((a, i) => <line key={i} x1="100" y1="100" x2={100 + 92 * Math.cos(a)} y2={100 + 92 * Math.sin(a)} strokeWidth="0.5" />)}
        <circle cx="100" cy="100" r="2" fill="currentColor" stroke="none" />
      </g>
    </svg>
  )
}

export function Sparkline({ points, w = 520, h = 140 }: { points: number[]; w?: number; h?: number }) {
  const min = Math.min(...points), max = Math.max(...points)
  const xy = points.map((p, i) => [(i / (points.length - 1)) * w, h - 12 - ((p - min) / (max - min || 1)) * (h - 24)])
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const [lx, ly] = xy[xy.length - 1]
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2={w} y1={h - 12} y2={h - 12} className="spark__base" />
      <path d={d} className="spark__line" vectorEffect="non-scaling-stroke" />
      <circle cx={lx} cy={ly} r="4" className="spark__dot" />
    </svg>
  )
}

