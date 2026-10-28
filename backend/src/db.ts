import { createClient, type Client, type InArgs, type Row } from '@libsql/client'
import { DATABASE_AUTH_TOKEN, DATABASE_URL } from './config'

/** libsql (SQLite). Local file in dev, Turso or any libsql server later without code changes. */
export let db: Client = createClient({ url: DATABASE_URL, authToken: DATABASE_AUTH_TOKEN })
export function useDb(c: Client) { db = c }

export async function all<T = Row>(sql: string, args: InArgs = []): Promise<T[]> {
  return (await db.execute({ sql, args })).rows as unknown as T[]
}
export async function one<T = Row>(sql: string, args: InArgs = []): Promise<T | undefined> {
  return (await all<T>(sql, args))[0]
}
/** Called after every successful write with its SQL; the read cache uses it to retire what the write touched. */
let writeHook: ((sql: string) => void) | null = null
export function onWrite(fn: (sql: string) => void) { writeHook = fn }
export async function run(sql: string, args: InArgs = []) {
  const r = await db.execute({ sql, args })
  writeHook?.(sql)
  return r
}

/** One write transaction (BEGIN IMMEDIATE, so concurrent callers serialize). The read cache hears every write after commit. */
export async function writeTx<T>(fn: (exec: (sql: string, args?: InArgs) => Promise<{ rowsAffected: number }>) => Promise<T>): Promise<T> {
  const tx = await db.transaction('write')
  const sqls: string[] = []
  try {
    const out = await fn(async (sql, args = []) => { sqls.push(sql); return tx.execute({ sql, args }) })
    await tx.commit()
    for (const q of sqls) writeHook?.(q)
    return out
  } finally { tx.close() }
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  address TEXT UNIQUE,                 -- lowercase 0x address; NULL for seed users
  handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  avatar TEXT,                         -- /uploads/... url
  location TEXT,
  tone INTEGER NOT NULL DEFAULT 0,     -- avatar shade when there is no image
  plus INTEGER NOT NULL DEFAULT 0,
  creator INTEGER NOT NULL DEFAULT 0,
  extras TEXT NOT NULL DEFAULT '{}',   -- JSON: tiers, shop, dmPrice, supporters ($WIF features)
  onboarded INTEGER NOT NULL DEFAULT 0,
  seed INTEGER NOT NULL DEFAULT 0,     -- 1 = demo seed data
  created_at INTEGER NOT NULL
);
-- extra wallets that sign in to the same account (a guest key after the owner linked a real wallet, or a second wallet)
CREATE TABLE IF NOT EXISTS user_wallets (
  address TEXT PRIMARY KEY,            -- lowercase 0x address
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'linked', -- 'linked' | 'guest'
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drops (
  id TEXT PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL DEFAULT '',
  image TEXT,
  media TEXT,                          -- JSON for seed media cards (chart/map/file)
  locked TEXT,                         -- JSON {price, teaser, unlocks}
  supporters_only TEXT,
  reply_to TEXT REFERENCES drops(id),
  root_id TEXT,
  quote_of TEXT REFERENCES drops(id),
  like_count INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  pass_count INTEGER NOT NULL DEFAULT 0,
  quote_count INTEGER NOT NULL DEFAULT 0,
  bookmark_count INTEGER NOT NULL DEFAULT 0,
  tip_total REAL NOT NULL DEFAULT 0,
  vote_count INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  seed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS drops_created ON drops(created_at DESC);
CREATE INDEX IF NOT EXISTS drops_author ON drops(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS drops_reply ON drops(reply_to, created_at);
CREATE INDEX IF NOT EXISTS drops_quote ON drops(quote_of);
CREATE TABLE IF NOT EXISTS tags (drop_id TEXT NOT NULL REFERENCES drops(id), tag TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (drop_id, tag));
CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag, created_at DESC);
CREATE TABLE IF NOT EXISTS likes (user_id INTEGER NOT NULL, drop_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, drop_id));
CREATE INDEX IF NOT EXISTS likes_drop ON likes(drop_id);
CREATE TABLE IF NOT EXISTS passes (user_id INTEGER NOT NULL, drop_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, drop_id));
CREATE INDEX IF NOT EXISTS passes_user ON passes(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS bookmarks (user_id INTEGER NOT NULL, drop_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, drop_id));
CREATE TABLE IF NOT EXISTS follows (follower_id INTEGER NOT NULL, followee_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (follower_id, followee_id));
CREATE INDEX IF NOT EXISTS follows_followee ON follows(followee_id);
CREATE TABLE IF NOT EXISTS mutes (user_id INTEGER NOT NULL, target_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, target_id));
CREATE TABLE IF NOT EXISTS not_interested (user_id INTEGER NOT NULL, drop_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, drop_id));
CREATE INDEX IF NOT EXISTS not_interested_drop ON not_interested(drop_id);
CREATE TABLE IF NOT EXISTS tips (
  id INTEGER PRIMARY KEY, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, drop_id TEXT, amount REAL NOT NULL,
  tx_hash TEXT, verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, actor_id INTEGER, kind TEXT NOT NULL, drop_id TEXT,
  meta TEXT NOT NULL DEFAULT '{}', read INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notifs_user ON notifications(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE VIRTUAL TABLE IF NOT EXISTS drops_fts USING fts5(text, content='drops', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS drops_ai AFTER INSERT ON drops BEGIN INSERT INTO drops_fts(rowid, text) VALUES (new.rowid, new.text); END;
CREATE TRIGGER IF NOT EXISTS drops_ad AFTER DELETE ON drops BEGIN INSERT INTO drops_fts(drops_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END;
CREATE TRIGGER IF NOT EXISTS drops_au AFTER UPDATE OF text ON drops BEGIN
  INSERT INTO drops_fts(drops_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO drops_fts(rowid, text) VALUES (new.rowid, new.text);
END;
-- Privy sign-in: one row per Privy user (DID). x_user_id is the numeric X id from Privy's verified token.
CREATE TABLE IF NOT EXISTS privy_accounts (
  did TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  x_user_id TEXT,
  x_username TEXT,
  email TEXT,
  wallet TEXT,                         -- smart wallet if present, else the embedded wallet (lowercase)
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS privy_x ON privy_accounts(x_user_id);

-- .wif names (WiflyNames ERC-721 mirror). @names are free and live in users.handle; owning x.wif means you hold @x.
-- token_id = uint256(keccak256(lowercase name)); minted = 1 once the chain has it. The chain is the source of truth.
CREATE TABLE IF NOT EXISTS names (
  name TEXT PRIMARY KEY COLLATE NOCASE, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  minted INTEGER NOT NULL DEFAULT 0, seed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, theme INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS names_owner ON names(owner_id);
-- Your @username is your primary .wif. When you switch, the old one is kept here so old @links redirect for a while
-- and your profile can say "formerly old.wif" for 30 days. Accounts are keyed by id (the wallet), never by name.
CREATE TABLE IF NOT EXISTS handle_history (old_handle TEXT PRIMARY KEY COLLATE NOCASE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, changed_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS handle_history_user ON handle_history(user_id, changed_at DESC);
-- A free @name holder whose matching .wif was claimed by another wallet. They keep @name until rename_by (grace), then
-- they're moved to a fallback; the .wif owner gets @name. Posts, followers and badges never move (accounts are keyed by id).
CREATE TABLE IF NOT EXISTS handle_bumps (handle TEXT PRIMARY KEY COLLATE NOCASE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at INTEGER NOT NULL, rename_by INTEGER NOT NULL, settled_at INTEGER);
CREATE INDEX IF NOT EXISTS handle_bumps_user ON handle_bumps(user_id);
-- .wif records (mirror of WiflyNames resolve + text records). Reset when the name changes hands.
CREATE TABLE IF NOT EXISTS agent_caps (user_id INTEGER PRIMARY KEY, daily_cap REAL NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 0, deposited REAL NOT NULL DEFAULT 0, tx_hash TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agent_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, kind TEXT NOT NULL, command TEXT NOT NULL,
  recipient TEXT, recipient_address TEXT, amount REAL NOT NULL DEFAULT 0, status TEXT NOT NULL, reason TEXT, tx_hash TEXT, day INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS agent_actions_user ON agent_actions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_actions_day ON agent_actions(user_id, day);
CREATE TABLE IF NOT EXISTS dca_plans (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, chain_plan_id TEXT, owner TEXT,
  deposit_eth REAL NOT NULL, per_buy_eth REAL NOT NULL, per_buy_usd REAL, interval_s INTEGER NOT NULL, max_buys INTEGER NOT NULL DEFAULT 0, first_at INTEGER NOT NULL, tz TEXT,
  slippage_bps INTEGER NOT NULL, min_wif_per_eth REAL NOT NULL DEFAULT 0, keeper_tip_eth REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', pause_reason TEXT,
  spent_eth REAL NOT NULL DEFAULT 0, buys_done INTEGER NOT NULL DEFAULT 0, last_fill_at INTEGER, tx_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS dca_plans_user ON dca_plans(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS dca_plans_chain ON dca_plans(chain_plan_id) WHERE chain_plan_id IS NOT NULL;
-- fills come ONLY from Bought events in mined receipts (never invented)
CREATE TABLE IF NOT EXISTS dca_fills (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER, chain_plan_id TEXT NOT NULL, owner TEXT, eth_in REAL NOT NULL, wif_out REAL NOT NULL,
  tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, UNIQUE (tx_hash, log_index));
CREATE INDEX IF NOT EXISTS dca_fills_chain ON dca_fills(chain_plan_id, created_at DESC);
CREATE TABLE IF NOT EXISTS dca_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL, action TEXT NOT NULL, tx_hash TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS llm_usage (user_id INTEGER NOT NULL, day INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day));
CREATE TABLE IF NOT EXISTS keeper_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, epoch INTEGER, action TEXT NOT NULL, detail TEXT, tx_hash TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS keeper_runs_time ON keeper_runs(created_at DESC);
CREATE TABLE IF NOT EXISTS name_records (
  name TEXT PRIMARY KEY COLLATE NOCASE, address TEXT, avatar TEXT, x TEXT, url TEXT, bio TEXT, updated_at INTEGER NOT NULL
);
-- buyer_id set = a private listing made by accepting an offer (only that buyer can buy).
CREATE TABLE IF NOT EXISTS name_listings (
  name TEXT PRIMARY KEY COLLATE NOCASE, seller_id INTEGER NOT NULL, price REAL NOT NULL, buyer_id INTEGER,
  seed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS name_offers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, buyer_id INTEGER NOT NULL, price REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS name_offers_name ON name_offers(name, status);
-- Purchases are onchain. A row is pending (verified = 0) until the indexer reads ownerOf on WiflyNames.
CREATE TABLE IF NOT EXISTS name_sales (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, seller_id INTEGER, buyer_id INTEGER NOT NULL, price REAL NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE, verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
-- Wifly Plus: expiry tracked here (mirrors Wifly.plusExpiry), 5-day grace, opt-in auto-renew at an agreed price.
CREATE TABLE IF NOT EXISTS plus_subs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL DEFAULT 0,
  plan TEXT NOT NULL DEFAULT 'month', auto_renew INTEGER NOT NULL DEFAULT 0, agreed_price REAL, last_renewed_period INTEGER, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plus_payments (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'month', price REAL NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE, verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
-- WiflyBadges burns. Only verified burns count toward badges.
CREATE TABLE IF NOT EXISTS badge_burns (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, amount REAL NOT NULL, tx_hash TEXT NOT NULL UNIQUE,
  verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
-- Paid unlocks of locked drops (filled by the indexer from Wifly Unlocked events).
CREATE TABLE IF NOT EXISTS unlocks (user_id INTEGER NOT NULL, drop_id TEXT NOT NULL, tx_hash TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, drop_id));
-- Uploaded images live in the database so any replica can serve them (local disk is only a cache).
CREATE TABLE IF NOT EXISTS uploads (name TEXT PRIMARY KEY, user_id INTEGER, data BLOB NOT NULL, created_at INTEGER NOT NULL);
-- Feed and lookup indexes (pagination is keyset on created_at/id).
CREATE INDEX IF NOT EXISTS idx_name_listings_created ON name_listings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_name_offers_name ON name_offers(name, status);
CREATE INDEX IF NOT EXISTS idx_names_owner ON names(owner_id);
CREATE INDEX IF NOT EXISTS idx_badge_burns_user ON badge_burns(user_id);
`

export async function migrate() {
  await db.executeMultiple('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;' + SCHEMA)
  // name_records.link became url (WIF Names text key "url").
  const cols = await db.execute('PRAGMA table_info(name_records)')
  if (cols.rows.some(r => r.name === 'link')) await db.execute('ALTER TABLE name_records RENAME COLUMN link TO url')
  // WiflyNames.theme(id): 0 default, 1 white, 2 green. Kept on sale (it is part of the art).
  const ncols = await db.execute('PRAGMA table_info(names)')
  if (!ncols.rows.some(r => r.name === 'theme')) await db.execute('ALTER TABLE names ADD COLUMN theme INTEGER NOT NULL DEFAULT 0')
  // tip tx hashes are stored lowercase and a hash can be verified once. Older rows are normalized; if a
  // hash was ever verified twice, the oldest row keeps it and the rest go back to pending (nothing is deleted).
  await db.executeMultiple(`UPDATE tips SET tx_hash = lower(tx_hash) WHERE tx_hash IS NOT NULL AND tx_hash <> lower(tx_hash);
    UPDATE badge_burns SET tx_hash = lower(tx_hash) WHERE tx_hash <> lower(tx_hash) AND lower(tx_hash) NOT IN (SELECT tx_hash FROM badge_burns);
    UPDATE tips SET verified = 0 WHERE verified = 1 AND tx_hash IS NOT NULL AND id NOT IN (SELECT MIN(id) FROM tips WHERE verified = 1 AND tx_hash IS NOT NULL GROUP BY lower(tx_hash));
    CREATE UNIQUE INDEX IF NOT EXISTS tips_tx_verified ON tips(lower(tx_hash)) WHERE verified = 1;`)
  // soft-deleted accounts (with a backup row), the admin audit log and a small key/value store (sweep cursor).
  const ucols = await db.execute('PRAGMA table_info(users)')
  if (!ucols.rows.some(r => r.name === 'deleted_at')) await db.execute('ALTER TABLE users ADD COLUMN deleted_at INTEGER')
  await db.executeMultiple(`CREATE TABLE IF NOT EXISTS deleted_users (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, row_json TEXT NOT NULL, by_actor TEXT NOT NULL, admin_id INTEGER, deleted_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL, action TEXT NOT NULL, target_id INTEGER, detail TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS revoked_sessions (tok TEXT PRIMARY KEY, exp INTEGER NOT NULL);`)
  await db.executeMultiple(`CREATE TABLE IF NOT EXISTS wallet_proofs (nonce TEXT PRIMARY KEY, user_id INTEGER NOT NULL, purpose TEXT NOT NULL, address TEXT NOT NULL, message TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
    CREATE TABLE IF NOT EXISTS tip_wallet_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, address TEXT NOT NULL, prev TEXT, created_at INTEGER NOT NULL);`)
}
