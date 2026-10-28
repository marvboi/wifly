/** dca keeper is safe to turn on: it waits (sends nothing) until it is an allowed keeper on an unpaused WiflyDCA, it falls back to
 * KEEPER_PRIVATE_KEY, and two loops sharing one key never reuse a nonce. throwaway keys + a local mock rpc only. `npm test` */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTransaction, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const dir = mkdtempSync(join(tmpdir(), 'wifly-dcaready-'))
process.env.DATABASE_URL = `file:${join(dir, 'wifly.db')}`
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret'
delete process.env.REDIS_URL; delete process.env.DCA_KEEPER_ENABLED; delete process.env.WIFLY_KEEPER_PRIVATE_KEY; delete process.env.KEEPER_SIGNER

// mock rpc: getTransactionCount always says 0 (a lagging node), so only a local nonce manager keeps sends apart
const nonces: number[] = []
const srv = createServer((req, res) => {
  let b = ''; req.on('data', c => (b += c)); req.on('end', async () => {
    const one = (m: any) => {
      const r = (v: unknown) => ({ jsonrpc: '2.0', id: m.id, result: v })
      switch (m.method) {
        case 'eth_chainId': return r('0x1237')
        case 'eth_getTransactionCount': return r('0x0')
        case 'eth_estimateGas': return r('0x5208')
        case 'eth_gasPrice': case 'eth_maxPriorityFeePerGas': return r('0x1')
        case 'eth_getBlockByNumber': return r({ number: '0x1', baseFeePerGas: '0x1', timestamp: '0x1', hash: '0x' + '0'.repeat(64), transactions: [] })
        case 'eth_sendRawTransaction': { nonces.push(parseTransaction(m.params[0] as Hex).nonce ?? -1); return r('0x' + nonces.length.toString(16).padStart(64, '0')) }
        default: return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } }
      }
    }
    const m = JSON.parse(b); await new Promise(r => setTimeout(r, 5))
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(Array.isArray(m) ? m.map(one) : one(m)))
  })
})
await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
process.env.RPC_URL = `http://127.0.0.1:${(srv.address() as any).port}`

const { app } = await import('../src/app')
const { migrate } = await import('../src/db')
const dca = await import('../src/dca')
const { envSigner } = await import('../src/agent/signer')
await migrate()
const status = async () => (await app.request('/api/dca/keeper', { headers: { host: 'localhost:5173', 'x-wifly': '1' } })).json() as Promise<any>
const me = privateKeyToAccount(generatePrivateKey())

test('preflight: not a keeper or paused means wait, with a plain reason', async () => {
  const no = await dca.dcaPreflight({ isKeeper: async () => false, paused: async () => false }, me.address)
  assert.equal(no.ok, false); assert.match(no.reason!, /setKeeper\(0x[0-9a-fA-F]{40}, true\)/)
  const paused = await dca.dcaPreflight({ isKeeper: async () => true, paused: async () => true }, me.address)
  assert.equal(paused.ok, false); assert.match(paused.reason!, /paused/)
  const err = await dca.dcaPreflight({ isKeeper: async () => { throw new Error('rpc down') }, paused: async () => false }, me.address)
  assert.equal(err.ok, false); assert.match(err.reason!, /couldn’t read/)
  assert.deepEqual(await dca.dcaPreflight({ isKeeper: async () => true, paused: async () => false }, me.address), { ok: true, reason: null })
})

test('status only says enabled once the keeper really can buy', async () => {
  dca.setKeeperReadyForTest({ ok: false, reason: 'keeper x is not allowed on WiflyDCA yet' })
  let k = await status(); assert.equal(k.enabled, false); assert.equal(k.ready, false); assert.match(k.waiting, /not allowed/)
  dca.setKeeperReadyForTest({ ok: true, reason: null })
  k = await status(); assert.equal(k.enabled, true); assert.equal(k.waiting, null)
  dca.setKeeperReadyForTest({ ok: false, reason: 'not checked yet' }, 'off')
  assert.equal((await status()).enabled, false)
})

test('dca keeper falls back to KEEPER_PRIVATE_KEY, never the agent key', () => {
  process.env.DCA_KEEPER_ENABLED = 'true'; process.env.DCA_CONTRACT_ADDRESS = '0x3D1E4966f73e2dFf4f7A520Ce7E4d638cA55C109'
  process.env.AGENT_PRIVATE_KEY = generatePrivateKey(); delete process.env.KEEPER_PRIVATE_KEY
  dca.setDcaKeeperSigner(undefined)
  assert.equal(dca.startDcaKeeper(), 'no-signer', 'the agent key alone does not run the dca keeper')
  process.env.KEEPER_PRIVATE_KEY = generatePrivateKey(); dca.setDcaKeeperSigner(undefined)
  assert.equal(dca.startDcaKeeper(), 'started'); dca.stopDcaKeeper()
  delete process.env.DCA_KEEPER_ENABLED; delete process.env.KEEPER_PRIVATE_KEY; delete process.env.AGENT_PRIVATE_KEY; dca.setDcaKeeperSigner(undefined)
})

test('two signers on one key send one at a time with fresh nonces', async () => {
  process.env.K1 = process.env.K2 = generatePrivateKey()
  const a = envSigner('K1', 'week-keeper')!, b = envSigner('K2', 'dca-keeper')!
  nonces.length = 0
  await Promise.all([a.send(a.address, '0x'), b.send(b.address, '0x'), a.send(a.address, '0x'), b.send(b.address, '0x')])
  assert.deepEqual([...nonces].sort(), [0, 1, 2, 3], `nonces ${nonces}`)
  srv.close()
})
