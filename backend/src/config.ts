import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PORT = Number(process.env.PORT || 8787)
export const DATABASE_URL = process.env.DATABASE_URL || `file:${resolve(ROOT, 'data/wifly.db')}`
export const DATABASE_AUTH_TOKEN = process.env.DATABASE_AUTH_TOKEN || undefined
export const UPLOAD_DIR = resolve(ROOT, 'uploads')
export const COOKIE_SECURE = process.env.COOKIE_SECURE === '1'
export const SIWE_DOMAINS = (process.env.SIWE_DOMAINS || '').split(',').map(s => s.trim()).filter(Boolean)
const originList = (v: string) => v.split(',').map(s => s.trim().replace(/\/+$/, '')).filter(o => /^https?:\/\/[^/]+$/.test(o))
/** The single origin the app ran on before the host split. */
export const DEFAULT_PROD_ORIGIN = 'https://wifly-web-production.up.railway.app'
/**
 * ALLOWED_ORIGINS (comma-separated, full origins) is the one list for CORS, the SIWE domain/URI check and the session
 * cookie. Production value: https://wifly.fun,https://app.wifly.fun,https://wifly-web-production.up.railway.app.
 * Unset: the Railway URL in production, the Vite dev/preview ports locally. CORS_ORIGINS is still read as a fallback.
 */
export const ALLOWED_ORIGINS_SET = !!(process.env.ALLOWED_ORIGINS || process.env.CORS_ORIGINS)
export const ALLOWED_ORIGINS = originList(process.env.ALLOWED_ORIGINS || process.env.CORS_ORIGINS
  || (process.env.NODE_ENV === 'production' ? DEFAULT_PROD_ORIGIN : 'http://localhost:5173,http://localhost:4173'))
export const ALLOWED_HOSTS = ALLOWED_ORIGINS.map(o => new URL(o).host)
/** Kept for older imports: CORS uses the same list. */
export const CORS_ORIGINS = ALLOWED_ORIGINS
/** Optional parent domain for the session cookie (e.g. wifly.fun so wifly.fun and app.wifly.fun share it). Unset = host-only. */
export const COOKIE_DOMAIN = (process.env.COOKIE_DOMAIN || '').trim().replace(/^\./, '')

/**
 * Dev-only paid-feature shortcuts (no seeding: the server never creates demo rows). ALLOW_DEMO_SEED=1 is the only
 * production override, for a throwaway staging database.
 */
export const demoSeedAllowed = () => process.env.NODE_ENV !== 'production' || process.env.ALLOW_DEMO_SEED === '1'

/** Limits shared with the frontend (it reads them from GET /api/config). */
export const LIMITS = { dropChars: 400, bioChars: 160, nameChars: 40, handleMin: 3, handleMax: 20, imageBytes: 5 * 1024 * 1024, pageSize: 20 }
/** Profile photos (avatars) get their own, larger cap. Post media stays at LIMITS.imageBytes. The app shrinks photos before upload. */
export const AVATAR_MAX_BYTES = 20 * 1024 * 1024
export const AVATAR_TOO_BIG = 'photo must be under 20 MB'

/** Session secret: env in production; in local dev a random one is generated once and kept in data/ (gitignored). */
function sessionSecret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET
  if (process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET is required in production')
  const f = resolve(ROOT, 'data/dev-session-secret')
  if (existsSync(f)) return readFileSync(f, 'utf8').trim()
  mkdirSync(dirname(f), { recursive: true })
  const s = randomBytes(32).toString('hex')
  writeFileSync(f, s, { mode: 0o600 })
  return s
}
export const SESSION_SECRET = sessionSecret()

// ------------------------------------------------------------------ chain + Privy (all optional; read at call time so tests can set them)
/** Robinhood Chain JSON-RPC, used only for reads (ERC-1271/6492 signature checks, handleNonce). Never sends transactions. */
export const rpcUrl = () => process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
/** Privy app ID (public) and secret (server only). Both empty = Privy sign-in is off and wallet sign-in stays the default. */
export const privyConfig = () => ({
  appId: process.env.PRIVY_APP_ID || '',
  appSecret: process.env.PRIVY_APP_SECRET || '',
  /** Optional: the dashboard's verification public key (SPKI PEM). When unset the key is fetched from Privy's JWKS. */
  verificationKey: process.env.PRIVY_VERIFICATION_KEY || undefined,
})
/** Attester for Wifly.linkHandle. Key is server only; with no key or contract the attest endpoint answers 503. */
export const attesterConfig = () => ({
  privateKey: (process.env.ATTESTER_PRIVATE_KEY || '') as `0x${string}` | '',
  contract: (process.env.WIFLY_CONTRACT_ADDRESS || '') as `0x${string}` | '',
})

// ------------------------------------------------------------------ usernames, Plus, badges (empty until deployed)
const addr = (v?: string) => (v && /^0x[0-9a-fA-F]{40}$/.test(v.trim()) ? (v.trim() as `0x${string}`) : '')
/** WiflyNames (ERC-721 usernames with a built-in WIF marketplace). */
export const namesContract = () => addr(process.env.NAMES_CONTRACT_ADDRESS)
/** WiflyNameRenderer (onchain name-card art). Unset = run the compiled renderer locally for previews. */
export const namesRendererContract = () => addr(process.env.NAMES_RENDERER_ADDRESS)
/** WiflyBadges (soulbound badges for burning WIF). */
export const badgesContract = () => addr(process.env.BADGES_CONTRACT_ADDRESS)
/** Wifly (Plus renewal lives inside it). */
export const wiflyContract = () => addr(process.env.WIFLY_CONTRACT_ADDRESS)
/** WiflyDCA. Empty = DCA runs as a preview: plans are saved, nothing is sent, no fills. */
export const dcaContract = () => addr(process.env.DCA_CONTRACT_ADDRESS)
export const plusCreator = () => addr(process.env.PLUS_CREATOR_ADDRESS)
/**
 * Plus plans (WIF). Monthly 1,500 WIF / 30 days, yearly 15,000 WIF / 365 days (two months free).
 * Wifly Plus is a creator account run by the team wallet: tier 0, setTier(0, 1_500e18) + setYearlyPrice(0, 15_000e18).
 * Read from Wifly.tierPrices/yearlyPrices(PLUS_CREATOR_ADDRESS) once live; these are the defaults.
 */
export type PlusPlan = 'month' | 'year'
export const plusPlans = () => ({
  month: { id: 'month' as const, price: Number(process.env.PLUS_PRICE_MONTH || 1500), days: 30 },
  year: { id: 'year' as const, price: Number(process.env.PLUS_PRICE_YEAR || 15000), days: 365 },
})
export const PLUS_GRACE_MS = 5 * 86400_000
/** Every fee (tips, subs, plus, unlocks, pay links 2%; name sales 2.5%; promotion bids; votes) splits 90% weekly
 *  community pot (rewards only), 10% burned; the treasury gets nothing. .wif name claims are the exception:
 *  50% treasury, 50% pot, no burn (CLAIM_SPLIT). Badge burns are not a fee: 100% burned. DCA has no fee.
 *  Shares are whole percents, same as the frontend's config. */
export const FEE_SPLIT = { pot: 90, burn: 10 } as const
export const CLAIM_SPLIT = { treasury: 50, pot: 50 } as const
export const splitFee = (fee: number, kind: 'fee' | 'claim' = 'fee') => {
  const s: { treasury?: number; pot?: number; burn?: number } = kind === 'claim' ? CLAIM_SPLIT : FEE_SPLIT
  return { treasury: (fee * (s.treasury ?? 0)) / 100, pot: (fee * (s.pot ?? 0)) / 100, burn: (fee * (s.burn ?? 0)) / 100 }
}
/** WiflyNames: marketplace fee 2.5% (split like every fee, FEE_SPLIT) and the claim fee (CLAIM_SPLIT). */
/** Tip fee (Wifly.sol default feeBps): 2%, split like every fee. The rest goes straight to the creator's wallet. */
export const TIP_FEE_BPS = Number(process.env.TIP_FEE_BPS || 200)
export const NAME_FEE_BPS = Number(process.env.NAMES_FEE_BPS || 250)
export const NAME_CLAIM_FEE = Number(process.env.NAMES_CLAIM_FEE || 100)        // 5-20 chars
export const NAME_SHORT_CLAIM_FEE = Number(process.env.NAMES_SHORT_FEE || 1000) // 3-4 chars
export const nameClaimFee = (name: string) => (name.length <= 4 ? NAME_SHORT_CLAIM_FEE : NAME_CLAIM_FEE)
/** WiflyBadges default thresholds (deploy script): 1k / 10k / 100k / 1M WIF burned, cumulative. Soulbound. */
export const BADGE_TIERS = [
  { id: 'first-light', name: 'first light', min: 1_000 },
  { id: 'flat-earther', name: 'flat earther', min: 10_000 },
  { id: 'edge-walker', name: 'edge walker', min: 100_000 },
  { id: 'the-disc', name: 'the disc', min: 1_000_000 },
] as const

/** Wifly treasury (public address). Gets 50% of .wif name claims (CLAIM_SPLIT) and nothing from other fees. */
export const TREASURY = '0x8E5f84738C0fb29670F370F73E53BD234CEfeF21'
