/** 11.8.8: lowercase site-wide (tickers too), a fixed 6+4 payer address, names payer above the buy button, the dark
 * "turn on" fill, "resets daily", and the agent page reading on/off, cap, spent and left from the chain for the current
 * payer wallet (it showed "off" after a refresh while the agent was on). */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'wifly-1188-'))
process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
delete process.env.WIFLY_CONTRACT_ADDRESS; delete process.env.REDIS_URL
after(() => rmSync(dir, { recursive: true, force: true }))

const { decodeAgent, chainDay } = await import('../../frontend/src/lib/agentChain')
const { addrLabel } = await import('../../frontend/src/lib/payer')
const { interpret, suggestionsFor } = await import('../src/commandParse')
const { parseDca } = await import('../src/dca')
const { calm, potLine } = await import('../src/companion')

const FE = join(import.meta.dirname, '../../frontend/src')
const src = (p: string) => readFileSync(join(FE, p), 'utf8')
const css = src('styles/app.css'), dark = src('styles/dark.css')
const lastRule = (sheet: string, sel: string) => {
  const re = new RegExp('(^|\\n|\\}|,)\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g')
  let m: RegExpExecArray | null, last = ''
  while ((m = re.exec(sheet))) last = m[2]
  return last
}
const E = (n: number) => BigInt(n) * 10n ** 18n
const AGENT = '0xfE7205768D26189A9D65D6E59dD55CF7F445402d' as const

// ------------------------------------------------------------------ agent: chain is the source of truth

test('decodeAgent: the reported wallet reads on, cap 250, 100 spent today, 150 left (not off / 0 / 2,300)', () => {
  const a = decodeAgent([AGENT, E(250), E(100), 20755n], E(150), 20755)
  assert.deepEqual(a, { agent: AGENT, enabled: true, dailyCap: 250, spentToday: 100, day: 20755, remaining: 150 })
})

test('decodeAgent: yesterday’s spend doesn’t count today; a zero agent is off with nothing left', () => {
  const y = decodeAgent([AGENT, E(250), E(100), 20754n], E(250), 20755)
  assert.equal(y.enabled, true); assert.equal(y.spentToday, 0); assert.equal(y.remaining, 250)
  const off = decodeAgent(['0x0000000000000000000000000000000000000000', 0n, 0n, 0n], 0n, 20755)
  assert.equal(off.enabled, false); assert.equal(off.dailyCap, 0); assert.equal(off.remaining, 0); assert.equal(off.agent, undefined)
  assert.equal(chainDay(Date.UTC(2026, 9, 29, 5)), 20755) // block.timestamp / 1 days
})

test('agent page: on/off, cap, spent and left come from the chain for the current payer, with a reading state', () => {
  const a = src('pages/Agent.tsx')
  assert.match(a, /usePayerState\(\)/)
  assert.match(a, /payer\.address \?\? account/)
  assert.match(a, /useAgentOnChain\(address\)/)
  assert.match(a, /const on = LIVE \? !!chainAgent\?\.enabled : agent\.enabled/)
  assert.match(a, /const spent = LIVE \? \(chainAgent\?\.spentToday \?\? 0\)/)
  assert.match(a, /const remaining = LIVE \? \(chainAgent\?\.remaining \?\? 0\)/)
  assert.match(a, /const liveCap = LIVE \? \(chainAgent\?\.dailyCap \?\? 0\)/)
  assert.match(a, /left of <b><AnimatedNumber value=\{liveCap\} \/>/)
  assert.match(a, /checking your agent…/)
  assert.match(a, /reading \? 'checking your agent…'.*on \? 'your agent is working\.' : READY \? 'your agent is off\.'/)
  assert.match(a, /void chainQ\.refetch\(\)/, 're-read after setAgent / revoke')
  assert.match(a, /dailyCap: chainAgent\.enabled && chainAgent\.dailyCap > 0 \? chainAgent\.dailyCap/, 'slider starts at the onchain cap')
  const w = src('lib/wifly.ts')
  const hook = w.slice(w.indexOf('export function useAgentOnChain'), w.indexOf('export function useWiflyAllowance'))
  assert.match(hook, /functionName: 'agents', args: \[u \?\? zeroAddress\]/)
  assert.match(hook, /functionName: 'agentRemaining'/)
  assert.match(hook, /decodeAgent\(/)
  assert.match(hook, /loading:/)
})

test('backend: a chain read syncs the agent_caps mirror (on + cap), only when it differs', async () => {
  const { migrate, one, run } = await import('../src/db')
  const { syncAgentMirror } = await import('../src/agent')
  await migrate()
  await run(`INSERT INTO users (id, address, handle, name, created_at) VALUES (7, '0x25bb190da7f60e00bf26587cd12f0b3448b6d5d7', 'mirror1188', 'm', 0)`)
  await syncAgentMirror(7, true, 250)
  assert.deepEqual({ ...(await one<{ daily_cap: number; enabled: number }>('SELECT daily_cap, enabled FROM agent_caps WHERE user_id = 7')) }, { daily_cap: 250, enabled: 1 })
  await run('UPDATE agent_caps SET deposited = 457.4 WHERE user_id = 7')
  await syncAgentMirror(7, false, 0)
  const r = await one<{ daily_cap: number; enabled: number; deposited: number }>('SELECT daily_cap, enabled, deposited FROM agent_caps WHERE user_id = 7')
  assert.equal(r?.enabled, 0); assert.equal(r?.daily_cap, 0); assert.equal(r?.deposited, 457.4, 'deposited untouched')
  const a = readFileSync(join(import.meta.dirname, '../src/agent/index.ts'), 'utf8')
  assert.match(a, /await syncAgentMirror\(uid, on, cap\)/)
})

// ------------------------------------------------------------------ the other 11.8.8 items

test('agent daily cap says "resets daily", never "00:00 utc"; dark "turn on" has a real fill', () => {
  const a = src('pages/Agent.tsx')
  assert.match(a, />resets daily</)
  assert.doesNotMatch(a, /00:00|utc/i)
  assert.doesNotMatch(src('companion/Companion.tsx'), /utc day/)
  const on = lastRule(dark, '[data-theme="dark"] .agent-hero .power:not(.is-on)')
  assert.match(on, /background:\s*#F4F2EC/); assert.match(on, /color:\s*#110E08/)
  assert.match(lastRule(dark, '[data-theme="dark"] .agent-hero .power.is-on'), /background:\s*rgba\(244, 242, 236/)
})

test('payer address: fixed 6+4, and the row never truncates it', () => {
  assert.equal(addrLabel('0x7a11000000000000000000000000000000c3d2'.padEnd(42, '0').slice(0, 38) + 'c3d2'), '0x7a11…c3d2')
  const addr = lastRule(css, '.payer .payer__addr')
  assert.match(addr, /flex:\s*none/); assert.doesNotMatch(addr, /ellipsis/)
  assert.match(lastRule(css, '.payer .payer__who .kpill'), /text-overflow:\s*ellipsis/)
})

test('names: paying-from sits above the buy button (name page, listing) and the claim button', () => {
  const l = src('components/ListName.tsx')
  assert.ok(l.indexOf('<TxSteps pull={price}') > 0 && l.indexOf('<TxSteps pull={price}') < l.indexOf('data-testid="buy-name"'), 'name page buy card: payer before buy')
  const n = src('pages/Names.tsx')
  const buy = n.indexOf('`buy for ${fmt(l.price)} wif`'), steps = n.indexOf('<TxSteps pull={l.price}')
  assert.ok(steps > 0 && steps < buy, 'TxSteps (payer + steps) before the buy button')
  const claim = n.indexOf('data-testid="claim-go"'), payer = n.indexOf('<PayingFrom className="names-claim__payer" />')
  assert.ok(payer > 0 && payer < claim, 'payer before the claim button')
})

// ------------------------------------------------------------------ lowercase everywhere

const files = (d: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [] })
const SKIP = new Set(['config.ts', 'lib/wifSwap.ts'])
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')

test('frontend: no uppercase WIF / ETH / USD / UTC left in any UI string', () => {
  const bad: string[] = []
  for (const f of files(FE)) {
    const rel = relative(FE, f).replace(/\\/g, '/')
    if (SKIP.has(rel) || rel.startsWith('contracts/')) continue
    const s = strip(readFileSync(f, 'utf8'))
    for (const m of s.matchAll(/(['"`])((?:(?!\1)[^\n\\]|\\.)*?)\1/g)) {
      const t = m[2]
      if (/^(WIF|ETH)$/.test(t) || /WIF Par/.test(t)) continue // code values ('WIF' | 'ETH') and the font
      if (/\b(WIF|ETH|USD|UTC)\b/.test(t) && /\s/.test(t)) bad.push(`${rel}: ${t.slice(0, 60)}`)
    }
    for (const m of s.matchAll(/>([^<>{}\n]*\b(WIF|ETH|USD|UTC)\b[^<>{}\n]*)</g)) bad.push(`${rel}: jsx ${m[1].trim().slice(0, 60)}`)
  }
  assert.deepEqual(bad, [])
  assert.match(src('components/TxSteps.tsx'), /allow/)
  assert.doesNotMatch(strip(src('components/TxSteps.tsx')), /\bWIF\b/)
  assert.match(src('components/Swap.tsx'), /not enough \$\{inSym\}/)
  assert.match(src('components/Swap.tsx'), /inSym = side === 'buy' \? 'eth' : 'wif'/)
})

test('server-sent summaries and chat copy are lowercase, tickers too', () => {
  for (const t of ['swap 0.01 eth to wif', 'sell 5k wif', 'buy $5 of WIF every Monday at 9am', 'pause my dca']) {
    const it = interpret(t)
    assert.equal(it.canonical, it.canonical?.toLowerCase(), t)
    for (const s of suggestionsFor(it)) assert.equal(s, s.toLowerCase(), s)
  }
  assert.equal(interpret('pause my dca').canonical, 'pause my scheduled buys')
  assert.equal(parseDca('buy $5 of WIF every Monday at 9am')?.summary, 'buy $5 of wif every monday at 9am')
  assert.equal(calm('You have 50 WIF and 0.1 ETH. DCA is on.'), 'you have 50 wif and 0.1 eth. dca is on.')
  const pot = potLine({ live: true, potWif: 10, potUsd: null, paidAtCloseWif: 4, paidAtCloseUsd: null, endsAt: Date.UTC(2026, 10, 2) } as never)
  assert.equal(pot, pot.toLowerCase()); assert.doesNotMatch(pot, /utc/)
  const B = join(import.meta.dirname, '../src')
  for (const f of ['dca.ts', 'agent/index.ts', 'features.ts', 'commandParse.ts', 'og.ts']) {
    const s = strip(readFileSync(join(B, f), 'utf8'))
    const hits = [...s.matchAll(/(['`])([^'`\n]*)\1/g)].map(m => m[2]).filter(t => /\s/.test(t) && /\b(WIF|ETH|UTC)\b/.test(t) && !/WIF Par|\[dca-keeper\]|[A-Z_]{4,}=/.test(t))
    assert.deepEqual(hits, [], f)
  }
})

test('frontend: every shown month / am-pm date is lowercased, and spacing fixes (copy, max)', () => {
  const bad: string[] = []
  for (const f of files(FE)) {
    const s = readFileSync(f, 'utf8')
    for (const line of s.split('\n')) for (const m of line.matchAll(/toLocale(?:Date|Time)?String\([^)]*(?:month|hour)[^)]*\)(?!\.toLowerCase)/g))
      if (!/\.toLowerCase\(\)/.test(line.slice(line.indexOf(m[0])))) bad.push(`${relative(FE, f)}: ${m[0].slice(0, 80)}`) // nested parens: lowercased later on the line
  }
  assert.deepEqual(bad, [])
  assert.match(src('pages/NamePages.tsx'), /<> <button className="linkbtn" onClick=\{\(\) => navigator\.clipboard/)
  assert.match(src('components/Swap.tsx'), /<> · <button className="linkbtn" onClick=\{setMax\}>max/)
})
