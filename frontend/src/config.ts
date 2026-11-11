import { defineChain, type Address } from 'viem'

/** Robinhood Chain mainnet. */
export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood.drpc.org', 'https://robinhood-rpc.publicnode.com'] } },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
})

/** $WIF on Robinhood Chain (18 decimals). */
export const WIF_TOKEN: Address = '0x5173b8eA6923c2d40267890D45C46a3480954773'
export const WIF_DECIMALS = 18
export const BURN_ADDRESS: Address = '0x000000000000000000000000000000000000dEaD'

/**
 * The one fee rule. A small platform fee on every tip, subscription, plus, unlock, pay link, vote and promotion bid (2%,
 * Top Spot is its own slice below) and on .wif name sales (2.5%). Every fee splits the same way: 90% to the weekly
 * community pot (rewards only), 10% burned. The treasury takes nothing from fees.
 * .wif name claims are the one exception: 50% treasury, 50% weekly community pot, nothing burned (CLAIM_SPLIT).
 * Badge burns are not a fee: they stay 100% burned. Scheduled WIF buys (DCA) have no fee.
 * Shares are whole percents.
 */
export const FEE_BPS = 200 // 2%
export const FEE_SPLIT = { pot: 90, burn: 10 } as const
export const CLAIM_SPLIT = { treasury: 50, pot: 50 } as const

/** Top Spot (a paid promotion): the outbid holder gets 90% of the new bid back; the other 10% is the promotion fee
 *  (split like every fee, see FEE_SPLIT). The first bid on an empty spot is all fee. */
export const TOPSPOT_HOLDER_SHARE = 0.9
export const TOPSPOT_FEE_SHARE = 0.1
export const TOPSPOT_MIN_RAISE = 0.1 // each bid must be 10% higher

export const LINKS = {
  wifSite: 'https://worldisflat.fun',
  wifX: 'https://x.com/WIFonRH',
  token: `https://robinhoodchain.blockscout.com/token/${'0x5173b8eA6923c2d40267890D45C46a3480954773'}`,
  buy: 'https://www.ponsfamily.com/launchpad/0x5173b8eA6923c2d40267890D45C46a3480954773',
}

/** Crowd votes: each vote costs this much WIF; the whole vote is a fee (split like every fee, see FEE_SPLIT). */
export const VOTE_PRICE = 10

/**
 * Uniswap v4 on Robinhood Chain (from Uniswap's deployments list for chain 4663, checked on chain).
 * The WIF/ETH pool key below comes from the PoolManager's Initialize event for pool id 0x71ef…8c79.
 * The pool charges no LP fee of its own (fee 0) and has a hook contract, which takes its cut inside the swap.
 * The quote comes from V4Quoter through eth_call, so it already includes the hook's cut.
 */
export const UNISWAP = {
  universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904' as Address, // Universal Router 2.1.1
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951' as Address,
  v4Quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94' as Address,
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address,
  poolId: '0x71ef4106340f0a3b9c19ec994eef4fc44a1d2513f38faac39d7636b156548c79',
  poolKey: {
    currency0: '0x0000000000000000000000000000000000000000' as Address, // native ETH
    currency1: '0x5173b8eA6923c2d40267890D45C46a3480954773' as Address, // WIF
    fee: 0,
    tickSpacing: 200,
    hooks: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044' as Address,
  },
} as const

export const EXPLORER = 'https://robinhoodchain.blockscout.com'
export const explorerAddress = (a: string) => `${EXPLORER}/address/${a}`
export const DEXSCREENER = 'https://dexscreener.com/robinhood/0x71ef4106340f0a3b9c19ec994eef4fc44a1d2513f38faac39d7636b156548c79'

/**
 * Wifly contract (contracts/src/Wifly.sol). NOT DEPLOYED YET, so this is empty.
 * Set VITE_WIFLY_ADDRESS in frontend/.env.local after deploy. While it's empty, contract reads return nothing and screens show empty states.
 */
const envAddr = (v: unknown): Address | undefined =>
  typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v.trim()) ? (v.trim() as Address) : undefined
export const WIFLY_ADDRESS: Address | undefined = envAddr(import.meta.env.VITE_WIFLY_ADDRESS)
/** The Wifly agent's address, used by setAgent. Also empty until the agent service exists. */
export const WIFLY_AGENT_ADDRESS: Address | undefined = envAddr(import.meta.env.VITE_WIFLY_AGENT_ADDRESS)
/**
 * Wifly team wallet, registered as a creator whose tier PLUS_TIER is Wifly Plus.
 * Buying Plus = subscribe(WIFLY_TEAM_WALLET, PLUS_TIER); perks are on while isSubscribed(user, WIFLY_TEAM_WALLET) is active.
 */
export const WIFLY_TEAM_WALLET: Address | undefined = envAddr(import.meta.env.VITE_WIFLY_TEAM_WALLET)
/** Tier index (0-2) on the team wallet that is Plus. */
export const PLUS_TIER = 0
/** Shown until tierPrices(teamWallet) can be read. */
export const PLUS_PRICE_FALLBACK = 1500
/** Yearly Plus (plan 1). */
export const PLUS_PRICE_YEAR_FALLBACK = 15000
/** true once a contract address is set: reads come from the contract instead of showing empty states. */
export const LIVE = !!WIFLY_ADDRESS
/**
 * Hard off switch for writes. Every approve and contract call goes through lib/wifly.ts → sendPlan(),
 * which refuses to send while this is false. Flip it only after the contract is deployed and reviewed.
 */
export const TX_ENABLED = import.meta.env.VITE_TX_ENABLED === 'true' // on in the live service's build env; off in local builds unless set

/** WiflyNames (ERC-721 usernames) and WiflyBadges (soulbound burn badges). Empty until deployed. */
export const NAMES_ADDRESS: Address | undefined = envAddr(import.meta.env.VITE_NAMES_ADDRESS)
export const BADGES_ADDRESS: Address | undefined = envAddr(import.meta.env.VITE_BADGES_ADDRESS)
/** Treasury: receives 50% of .wif name claims (CLAIM_SPLIT) and nothing from other fees. Public address. */
export const TREASURY: Address = '0x8E5f84738C0fb29670F370F73E53BD234CEfeF21'
/** Same rules as WiflyNames.isValidName and the backend. */
export const NAME_MIN = 3, NAME_MAX = 20, NAME_SHORT_LEN = 4
export const NAME_CLAIM_FEE = 100, NAME_SHORT_CLAIM_FEE = 1000, NAME_FEE_BPS = 250
export const RESERVED_NAMES = ['wifly', 'marv', 'wif']
export const claimFeeOf = (n: string) => n.length <= NAME_SHORT_LEN ? NAME_SHORT_CLAIM_FEE : NAME_CLAIM_FEE
/** WiflyBadges levels: cumulative WIF burned. */
export const BADGE_LEVELS = [
  { id: 'first-light', min: 1_000, name: 'first light' }, { id: 'flat-earther', min: 10_000, name: 'flat earther' },
  { id: 'edge-walker', min: 100_000, name: 'edge walker' }, { id: 'the-disc', min: 1_000_000, name: 'the disc' },
]

/** WiflyDCA proxy on chain 4663 (public address). VITE_DCA_ADDRESS overrides it. Sends still need VITE_TX_ENABLED and the backend's DCA_CONTRACT_ADDRESS; without those, plans are previews and nothing is sent. */
export const DCA_ADDRESS: Address = envAddr(import.meta.env.VITE_DCA_ADDRESS) ?? '0x3D1E4966f73e2dFf4f7A520Ce7E4d638cA55C109'

/** The rentable AI agent is live only with the contract, txs on and its address set. Agent page, landing and docs all read this. */
export const AGENT_READY = LIVE && TX_ENABLED && !!WIFLY_AGENT_ADDRESS
/** Scheduled WIF buys are open. */
export const DCA_READY = true
/** Agent daily caps in WIF: free accounts / plus. */
export const AGENT_CAP_FREE = 500
export const AGENT_CAP_PLUS = 5000
/** Free assistant questions a day (the backend's FREE_AI_MSGS_PER_DAY default). */
export const FREE_AI_MSGS_PER_DAY_FALLBACK = 3
/** The $WIF pool hook's cut on every swap, already inside each quote. */
export const SWAP_POOL_FEE_BPS = 100
/** Wallets allowed on the hidden /deploy page (default: the treasury). */
export const ADMIN_ADDRESSES: string[] = String(import.meta.env.VITE_ADMIN_ADDRESSES ?? '').split(',').map(s => s.trim().toLowerCase()).filter(s => /^0x[0-9a-f]{40}$/.test(s))
if (!ADMIN_ADDRESSES.length) ADMIN_ADDRESSES.push(TREASURY.toLowerCase())
/** /deploy exists only when VITE_DEPLOY_PAGE=true. */
export const DEPLOY_PAGE_ON = import.meta.env.VITE_DEPLOY_PAGE === 'true'
