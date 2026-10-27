import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Address, Hex } from 'viem'
import { runKeeperOnce, type EpochInfo, type KeeperChain, type KeeperResult } from '../src/keeper'

const A = '0x00000000000000000000000000000000000000a1' as Address
const ZERO = '0x0000000000000000000000000000000000000000' as Address
const HASH = ('0x' + 'ab'.repeat(32)) as Hex // test-only value for a fake chain, never shown in the app

function fakeChain(cur: bigint, epochs: Record<string, EpochInfo>, opts: { failSends?: number; raceOnSend?: boolean } = {}) {
  const sent: bigint[] = []
  let fails = opts.failSends ?? 0
  const chain: KeeperChain = {
    currentEpoch: async () => cur,
    epoch: async e => epochs[String(e)] ?? { leader: ZERO, finalized: false, leaderVotes: 0n },
    simulateFinalize: async (e, w) => {
      const x = epochs[String(e)]
      if (e >= cur) throw new Error('reverted: EpochNotOver()')
      if (x?.finalized) throw new Error('reverted: AlreadyFinalized()')
      if (!x || x.leader === ZERO) throw new Error('reverted: NoVotes()')
      if (w !== x.leader) throw new Error('NotLeader')
    },
    sendFinalize: async e => {
      if (fails > 0) { fails--; throw new Error('rpc timeout') }
      if (opts.raceOnSend) { epochs[String(e)].finalized = true; throw new Error('execution reverted: AlreadyFinalized()') }
      sent.push(e); epochs[String(e)].finalized = true; return HASH
    },
    waitReceipt: async () => 'success',
  }
  return { chain, sent }
}
const noSleep = { sleep: async () => {}, baseDelayMs: 1 }

test('keeper finalizes an ended week with votes, with the tracked leader', async () => {
  const { chain, sent } = fakeChain(10n, { '9': { leader: A, finalized: false, leaderVotes: 5n } })
  const r = await runKeeperOnce(chain, { lookback: 1, ...noSleep })
  assert.deepEqual(sent, [9n])
  assert.equal(r[0].action, 'finalized'); assert.equal(r[0].txHash, HASH)
})

test('keeper is idempotent: a second pass sends nothing', async () => {
  const { chain, sent } = fakeChain(10n, { '9': { leader: A, finalized: false, leaderVotes: 5n } })
  await runKeeperOnce(chain, { lookback: 1, ...noSleep })
  const r2 = await runKeeperOnce(chain, { lookback: 1, ...noSleep })
  assert.equal(sent.length, 1)
  assert.equal(r2[0].action, 'already-closed')
})

test('keeper skips weeks with no votes (pot rolls over) and never touches the current week', async () => {
  const { chain, sent } = fakeChain(10n, { '10': { leader: A, finalized: false, leaderVotes: 1n } })
  const r = await runKeeperOnce(chain, { lookback: 2, ...noSleep })
  assert.deepEqual(sent, [])
  assert.deepEqual(r.map(x => [x.epoch, x.action]), [[8, 'no-votes'], [9, 'no-votes']])
})

test('keeper retries with exponential backoff, then succeeds', async () => {
  const waits: number[] = []
  const { chain, sent } = fakeChain(10n, { '9': { leader: A, finalized: false, leaderVotes: 5n } }, { failSends: 2 })
  const r = await runKeeperOnce(chain, { lookback: 1, baseDelayMs: 100, sleep: async ms => { waits.push(ms) } })
  assert.deepEqual(waits, [100, 200])
  assert.deepEqual(sent, [9n]); assert.equal(r[0].attempts, 3)
})

test('keeper gives up after the retry budget and logs the failure', async () => {
  const logged: KeeperResult[] = []
  const { chain } = fakeChain(10n, { '9': { leader: A, finalized: false, leaderVotes: 5n } }, { failSends: 99 })
  const r = await runKeeperOnce(chain, { lookback: 1, retries: 2, ...noSleep, log: x => { logged.push(x) } })
  assert.equal(r[0].action, 'failed'); assert.equal(r[0].attempts, 3)
  assert.equal(logged.length, 1); assert.match(logged[0].detail ?? '', /rpc timeout/)
})

test('keeper treats a lost race (AlreadyFinalized) as done, not as a failure', async () => {
  const { chain } = fakeChain(10n, { '9': { leader: A, finalized: false, leaderVotes: 5n } }, { raceOnSend: true })
  const r = await runKeeperOnce(chain, { lookback: 1, ...noSleep })
  assert.equal(r[0].action, 'already-closed')
})

test('keeper logs the payablePot() amount it splits (feev2)', async () => {
  const { chain, sent } = fakeChain(10n, { '9': { leader: A, finalized: false, leaderVotes: 5n } })
  chain.payablePot = async () => 1234n * 10n ** 18n
  const r = await runKeeperOnce(chain, { lookback: 1, ...noSleep })
  assert.deepEqual(sent, [9n])
  assert.match(r[0].detail ?? '', /splits 1234 WIF/)
})

test('keeper still finalizes when the payablePot() read fails', async () => {
  const { chain, sent } = fakeChain(10n, { '9': { leader: A, finalized: false, leaderVotes: 5n } })
  chain.payablePot = async () => { throw new Error('rpc down') }
  const r = await runKeeperOnce(chain, { lookback: 1, ...noSleep })
  assert.deepEqual(sent, [9n]); assert.equal(r[0].action, 'finalized')
  assert.doesNotMatch(r[0].detail ?? '', /splits/)
})

test('keeper reads payablePot from the feev2 ABI, not epochPot', async () => {
  const { KEEPER_ABI } = await import('../src/keeper')
  const names: string[] = KEEPER_ABI.filter(x => x.type === 'function').map(x => x.name)
  assert.ok(names.includes('payablePot')); assert.ok(!names.includes('epochPot'))
})

test('keeper is off by default', async () => {
  delete process.env.WEEK_KEEPER_ENABLED
  const { startWeekKeeper } = await import('../src/keeper')
  assert.equal(startWeekKeeper(), 'off')
})
