/**
 * Client registry: users and drops that came back from the wifly api, kept by handle / id so sheets (tip, unlock,
 * vote …) can find them. It starts empty. Nothing in the app invents users, drops or numbers.
 */

export type Tier = { id: string; name: string; price: number; perks: string[] }
export type ShopItem = { id: string; title: string; kind: 'Digital' | 'Service'; price: number; detail: string; sold: number }

export type User = {
  handle: string
  /** Onchain wallet, from the api. */
  address?: `0x${string}`
  name: string
  bio: string
  location?: string
  joined: string
  followers: number
  following: number
  supporters?: number
  plus?: boolean
  creator?: boolean
  tone: number // avatar shade index, 0–5
  dmPrice?: number // WIF a stranger pays to open a DM
  tiers?: Tier[]
  shop?: ShopItem[]
  followsYou?: boolean
  youFollow?: boolean
  /** Set for profiles that come from the wifly api. */
  avatar?: string | null
  drops?: number
  muted?: boolean
  you?: boolean
  seed?: boolean
  /** Primary WIF Name, verified with reverseName(address): shown as "label.wif ✓". Label only, no suffix. */
  wifName?: string | null
  plusGrace?: boolean
  badge?: string | null
  /** you blocked them / they blocked you (messages only) */
  blocked?: boolean
  blocksYou?: boolean
}

export type Media =
  | { kind: 'chart'; label: string; change: number; points: number[] }
  | { kind: 'map'; caption: string }
  | { kind: 'file'; name: string; size: string }

export type Post = {
  id: string
  author: string
  text: string
  time: string
  likes: number
  reposts: number
  replies: number
  tipped: number
  votes: number // crowd votes this week; each vote costs WIF (a fee, split per FEE_SPLIT: 90% pot, 10% burned)
  feed: Array<'following' | 'foryou'>
  media?: Media
  locked?: { price: number; teaser: string; unlocks: number }
  supportersOnly?: string // tier name
  replyTo?: string
  repostedBy?: string
  // ---- set for drops that come from the wifly api (see src/api) ----
  server?: boolean
  image?: string | null
  quote?: Post | null
  quoteMissing?: boolean
  replyToHandle?: string | null
  createdAt?: number
  quotes?: number
  liked?: boolean
  passed?: boolean
  bookmarked?: boolean
  mine?: boolean
  deleted?: boolean
  tags?: string[]
  seed?: boolean
}

export type Message = { from: string; text: string; time: string; amount?: number }

export const users: Record<string, User> = {}
export const posts: Post[] = []
