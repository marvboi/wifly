/** 11.8.5: calm tx errors (never viem's raw wall of text), the gas pre-check, and the app-wide paying wallet. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { BaseError, InsufficientFundsError, NonceTooLowError, UserRejectedRequestError } from 'viem'
import { CANCELLED_LINE, GAS_LINE, GENERIC_LINE, PENDING_LINE, classifyTxError, looksRaw, shortOnGas, txErrorLine } from '../../frontend/src/lib/txError'
import { AGENT_LABEL, EMBEDDED_GAS_HINT, PAYER_GAS_LINE, defaultPayer, fmtUnits, linkedButton, payerOptions, sendRoute } from '../../frontend/src/lib/payer'

const RAW = `The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.

This error could arise when the account does not have enough funds to:
 - pay for the total gas fee,
 - pay for the value to send.

Request Arguments:
  from:  0x9ccf000000000000000000000000000000cf1e
  to:    0x1111111111111111111111111111111111111111
  data:  0x7e3e5b1c00000000000000000000000000000000000000000000000000000000000001f4

Details: insufficient funds for gas * price + value: balance 0, tx cost 31200000000000
Version: viem@2.57.11`

const quiet = <T>(fn: () => T): T => { const w = console.warn, d = console.debug; console.warn = () => {}; console.debug = () => {}; try { return fn() } finally { console.warn = w; console.debug = d } }

test('insufficient funds: real viem errors, wrapped errors and the raw string all map to the gas line', () => {
  const inner = new InsufficientFundsError({ cause: new BaseError('insufficient funds for gas * price + value') })
  assert.equal(classifyTxError(inner), 'gas')
  assert.equal(classifyTxError(new BaseError('Transaction failed', { cause: inner })), 'gas')
  assert.equal(classifyTxError(new Error(RAW)), 'gas')
  assert.equal(txErrorLine(new Error(RAW)).line, GAS_LINE)
  assert.equal(GAS_LINE, 'not enough eth for gas in this wallet. add a little and try again')
})

test('user rejected = cancelled, nonce / replacement = pending, anything else = short generic line (raw only in the console)', () => {
  assert.equal(classifyTxError(new UserRejectedRequestError(new Error('User rejected the request.'))), 'rejected')
  assert.equal(classifyTxError({ code: 4001, message: 'denied' }), 'rejected')
  assert.equal(classifyTxError({ code: 'ACTION_REJECTED' }), 'rejected')
  assert.equal(classifyTxError(new NonceTooLowError({ nonce: 3 })), 'pending')
  assert.equal(classifyTxError(new Error('replacement transaction underpriced')), 'pending')
  assert.equal(txErrorLine(new Error('replacement transaction underpriced')).line, PENDING_LINE)
  assert.equal(CANCELLED_LINE, 'you cancelled in your wallet')
  let logged = 0
  const d = console.debug; console.debug = () => { logged++ }
  try {
    const r = txErrorLine(new BaseError('execution reverted: 0xdeadbeef', { details: 'Request Arguments: from: 0x…' }))
    assert.equal(r.line, GENERIC_LINE)
  } finally { console.debug = d }
  assert.ok(logged >= 1, 'raw text goes to the console')
})

test('txErrorLine never returns raw text: short, one line, lowercase', () => {
  const samples: unknown[] = [new Error(RAW), new BaseError('Internal JSON-RPC error.', { details: 'x'.repeat(400) }), { message: 'a\nb' }, 'execution reverted', null, undefined, 42]
  for (const e of samples) {
    const { line } = quiet(() => txErrorLine(e))
    assert.ok(line.length <= 120, line)
    assert.ok(!line.includes('\n'))
    assert.equal(line, line.toLowerCase())
    assert.ok(!looksRaw(line))
  }
  assert.equal(quiet(() => txErrorLine(new Error('raw'), 'that name is taken')).line, 'that name is taken')
  assert.equal(quiet(() => txErrorLine(new Error('raw'), RAW)).line, GENERIC_LINE, 'a raw-looking known text is never shown')
})

test('looksRaw and shortOnGas', () => {
  assert.ok(looksRaw(RAW))
  assert.ok(looksRaw('Version: viem@2.57.11'))
  assert.ok(!looksRaw('nothing was sent.'))
  assert.equal(shortOnGas(0n, null), true)
  assert.equal(shortOnGas(10n, null), false)
  assert.equal(shortOnGas(10n, 11n), true)
  assert.equal(shortOnGas(100n, 11n, 50n), false)
  assert.equal(shortOnGas(100n, 60n, 50n), true)
})

const E = '0x' + 'e'.repeat(40), L = '0x' + '1'.repeat(40), L2 = '0x' + '2'.repeat(40), G = '0x' + '9'.repeat(40)
const list = [
  { address: E.toUpperCase().replace('0X', '0x'), kind: 'privy', privy: true },
  { address: L, kind: 'main', privy: false },
  { address: L2, kind: 'linked', privy: false },
  { address: G, kind: 'guest', privy: false },
  { address: 'nope', kind: 'linked', privy: false },
]

test('payer options: only wallets already on the account, never a guest key; linked first, then embedded', () => {
  const o = payerOptions(list, { signable: [E], wagmi: null })
  assert.deepEqual(o.map(x => [x.address, x.kind, x.ready]), [[L, 'linked', false], [L2, 'linked', false], [E, 'embedded', true]])
  const w = payerOptions(list, { signable: [], wagmi: L2.toUpperCase().replace('0X', '0x') })
  assert.equal(w.find(x => x.address === L2)!.ready, true)
})

test('default payer: saved pick, else a connected linked wallet with wif or eth, else the embedded one', () => {
  const none = payerOptions(list, { signable: [E], wagmi: null })
  // Marv's case: embedded has 0 wif, linked holds the wif but isn't connected yet -> embedded until it connects
  const bal = { [E]: { eth: 0n, wif: 0n }, [L]: { eth: 0n, wif: 2000n } }
  assert.equal(defaultPayer(none, bal, null), E)
  const conn = payerOptions(list, { signable: [E, L], wagmi: null })
  assert.equal(defaultPayer(conn, bal, null), L, 'once connected, the linked wallet holding wif pays')
  assert.equal(defaultPayer(conn, { [L2]: { eth: 5n } }, null), E, 'connected linked with nothing -> embedded')
  assert.equal(defaultPayer(conn, bal, L2), L2, 'the saved pick sticks')
  assert.equal(defaultPayer(conn, bal, G), L, 'a saved address that is not on the account is ignored')
  const noEmbedded = payerOptions(list.filter(w => !w.privy), { signable: [], wagmi: null })
  assert.equal(defaultPayer(noEmbedded, { [L2]: { eth: 1n } }, null), L2, 'no embedded: a linked wallet with gas')
  assert.equal(defaultPayer([], {}, null), null)
})

test('send route: the connected wagmi wallet, else privy, else not connected yet', () => {
  assert.equal(sendRoute(L, { wagmi: L.toUpperCase().replace('0X', '0x'), privyHas: () => true }), 'wagmi')
  assert.equal(sendRoute(E, { wagmi: L, privyHas: a => a === E }), 'privy')
  assert.equal(sendRoute(L2, { wagmi: L, privyHas: () => false }), 'none')
})

test('copy is lowercase and calm', () => {
  for (const s of [PAYER_GAS_LINE, EMBEDDED_GAS_HINT, AGENT_LABEL, linkedButton(L), GAS_LINE, PENDING_LINE, GENERIC_LINE]) assert.equal(s, s.toLowerCase())
  assert.equal(PAYER_GAS_LINE, 'this wallet needs a little eth for gas')
  assert.equal(EMBEDDED_GAS_HINT, 'add a little eth here for gas')
  assert.equal(AGENT_LABEL, 'wifly agent (spends for you, can’t withdraw)')
  assert.equal(linkedButton(L), 'use my linked wallet 0x1111…1111')
  assert.equal(fmtUnits(0n, 'eth'), '0 eth')
  assert.equal(fmtUnits(1234500000000000000n, 'eth'), '1.2345 eth')
  assert.equal(fmtUnits(undefined, 'wif'), '… wif')
})

const SRC = join(import.meta.dirname, '../../frontend/src')
const files = (d: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [] })
const src = (p: string) => readFileSync(join(SRC, p), 'utf8')

test('sends never show "title: raw reason"; toasts use failArgs and inline errors are calm', () => {
  for (const f of files(SRC)) {
    const s = readFileSync(f, 'utf8')
    assert.ok(!/\$\{failTitle\(r\)\}: \$\{r\.reason\}/.test(s), f)
    assert.ok(!/toast\(failTitle\(r\), r\.reason\)/.test(s), f)
  }
  assert.match(src('companion/Companion.tsx'), /<TxErrorNote line=\{err\?\.line/)
  assert.match(src('components/Swap.tsx'), /setErr\(explainError\(e\)\)/)
  assert.match(src('styles/app.css'), /-webkit-line-clamp: 3/)
})

test('the gas pre-check runs before the wallet opens, after the "sending isn’t switched on" check', () => {
  const w = src('lib/wifly.ts')
  const off = w.indexOf("if (!TX_ENABLED) return { sent: false, kind: 'off'"), pre = w.indexOf('shortOnGas(balance, est'), confirm = w.indexOf('const confirm = async')
  assert.ok(off > 0 && pre > off && confirm > pre)
  assert.match(src('components/Swap.tsx'), /shortOnGas\(eth, null/)
})

test('one paying wallet app-wide: sends, swap, wallet menu and the "paying from" rows read the same pick', () => {
  const w = src('lib/wifly.ts')
  assert.match(w, /export function usePayerRoute\(\)/)
  assert.match(w, /export function useSendPlan\(\) \{\n  const \{ address, picked, route, viaPrivy \} = usePayerRoute\(\)/)
  assert.match(w, /privyBridge\.sendFrom\(picked\.address/)
  assert.match(src('components/Swap.tsx'), /usePayerRoute\(\)/)
  assert.match(src('components/WalletChip.tsx'), /<WalletMenuPayer \/>/)
  assert.match(src('components/TxSteps.tsx'), /<PayingFrom \/>/)
  for (const p of ['pages/DCA.tsx', 'pages/Plus.tsx', 'components/WeeklyPot.tsx']) assert.match(src(p), /<PayingFrom \/>/, p)
  assert.match(src('App.tsx'), /<PayerSync \/>/)
  assert.match(src('auth/privyBridge.ts'), /const payer = usePayerState\(\)\.address/)
  assert.match(src('lib/payerStore.ts'), /wifly-payer:/)
})

test('connecting a linked wallet only connects (privy connectWallet), never links, and checks the exact address', () => {
  const m = src('auth/PrivyMount.tsx'), b = src('auth/privyBridge.ts'), p = src('components/Payer.tsx')
  assert.match(m, /useConnectWallet\(/)
  assert.match(m, /suggestedAddress: address/)
  assert.match(m, /wallet already on your account/)
  assert.match(b, /got\.toLowerCase\(\) === address\.toLowerCase\(\) \? 'ok' : 'other'/)
  assert.ok(!/linkWallet|linkTwitter|\/auth\/link/.test(p), 'the payer UI never links')
  assert.match(src('lib/payerStore.ts'), /!state\.options\.some\(o => o\.address === a\)/)
})

test('my agent explains who pays, with the agent address', () => {
  const c = src('companion/Companion.tsx')
  assert.match(c, /you deposit wif and set a daily cap from your wallet\. one small gas fee each\./)
  assert.match(c, /after that the agent pays its own gas when it acts for you\./)
  assert.match(c, /it can never withdraw\./)
  assert.match(c, /\{AGENT_LABEL\}/)
})

// ---- steering 6/7: receive in, gas top-up, one toast per error, agent page single-flight ----
import { decodeAbiParameters } from 'viem'
import { GAS_TOPUP_WEI, MAX_GAS_TOPUP, UR_TRANSFER, buildSwap } from '../../frontend/src/lib/wifSwap'
import { buildBuyExactOut } from '../../frontend/src/lib/wifSwapOut'
import { EMBEDDED_FUND_LINE, TOPUP_LABEL, canTopUp, receiveChoices, swapRecipient, topUpDefault, topUpNote } from '../../frontend/src/lib/payer'

const EMB = '0x00000000000000000000000000000000000e1b0d'
const LNK = '0x000000000000000000000000000000000011ced0'
const v4Actions = (input: `0x${string}`) => {
  const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], input)
  return { actions: actions.slice(2).match(/../g)!.map(h => parseInt(h, 16)), params }
}
const fread = src

test('swap recipient: TAKE(currency, recipient, open delta) instead of TAKE_ALL; no recipient keeps TAKE_ALL', () => {
  const plain = buildSwap('buy', 10n ** 15n, 5n)
  assert.equal(plain.args[0], '0x10'); assert.equal(plain.value, 10n ** 15n)
  assert.deepEqual(v4Actions(plain.args[1][0]).actions, [0x06, 0x0c, 0x0f])
  const to = buildSwap('buy', 10n ** 15n, 5n, 600, { recipient: EMB })
  const { actions, params } = v4Actions(to.args[1][0])
  assert.deepEqual(actions, [0x06, 0x0c, 0x0e])
  const [cur, rcpt, amt] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], params[2])
  assert.equal(cur.toLowerCase(), '0x5173b8ea6923c2d40267890d45c46a3480954773'); assert.equal(rcpt.toLowerCase(), EMB); assert.equal(amt, 0n)
})

test('gas top-up: buys add exactly 0.0001 eth in msg.value and a UR TRANSFER of eth to the embedded wallet; sells ignore it', () => {
  const b = buildSwap('buy', 10n ** 15n, 5n, 600, { recipient: EMB, gasTopUp: { to: EMB, wei: GAS_TOPUP_WEI } })
  assert.equal(GAS_TOPUP_WEI, 100_000_000_000_000n)
  assert.equal(b.value, 10n ** 15n + GAS_TOPUP_WEI)
  assert.equal(b.args[0], '0x10' + UR_TRANSFER.toString(16).padStart(2, '0'))
  const [tok, to, wei] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], b.args[1][1])
  assert.equal(tok, '0x0000000000000000000000000000000000000000'); assert.equal(to.toLowerCase(), EMB); assert.equal(wei, GAS_TOPUP_WEI)
  const s = buildSwap('sell', 10n ** 18n, 5n, 600, { recipient: EMB, gasTopUp: { to: EMB, wei: GAS_TOPUP_WEI } })
  assert.equal(s.value, 0n); assert.equal(s.args[0], '0x10')
  assert.throws(() => buildSwap('buy', 1n, 1n, 600, { gasTopUp: { to: EMB, wei: MAX_GAS_TOPUP + 1n } }))
})

test('exact-out buy: WIF to the recipient, top-up before SWEEP, unused eth still swept back to the payer', () => {
  const c = buildBuyExactOut(100n, 1000n, LNK, 600, { recipient: EMB, gasTopUp: { to: EMB, wei: GAS_TOPUP_WEI } })
  assert.equal(c.args[0], '0x100504'); assert.equal(c.value, 1000n + GAS_TOPUP_WEI)
  assert.deepEqual(v4Actions(c.args[1][0]).actions, [0x08, 0x0c, 0x0e])
  const [, sweepTo] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], c.args[1][2])
  assert.equal(sweepTo.toLowerCase(), LNK)
  const plain = buildBuyExactOut(100n, 1000n, LNK)
  assert.equal(plain.args[0], '0x1004'); assert.equal(plain.value, 1000n)
  assert.deepEqual(v4Actions(plain.args[1][0]).actions, [0x08, 0x0c, 0x0f])
})

test('receive in: only with an embedded and a linked wallet, defaults to embedded; top-up rules', () => {
  const opts = [{ address: LNK, kind: 'linked' as const, ready: true }, { address: EMB, kind: 'embedded' as const, ready: true }]
  assert.deepEqual(receiveChoices(LNK, opts), { embedded: EMB, linked: LNK })
  assert.deepEqual(receiveChoices(EMB, opts), { embedded: EMB, linked: LNK })
  assert.equal(receiveChoices(LNK, [opts[0]]), null)
  assert.equal(receiveChoices(null, opts), null)
  assert.equal(swapRecipient(LNK, EMB), EMB); assert.equal(swapRecipient(LNK, LNK), undefined)
  assert.equal(canTopUp('buy', LNK, EMB, EMB), true)
  assert.equal(canTopUp('sell', LNK, EMB, EMB), false)
  assert.equal(canTopUp('buy', EMB, EMB, EMB), false) // paying from the embedded wallet itself
  assert.equal(canTopUp('buy', LNK, LNK, EMB), false)
  assert.equal(topUpDefault(0n, true), true); assert.equal(topUpDefault(1n, true), false); assert.equal(topUpDefault(0n, false), false); assert.equal(topUpDefault(undefined, true), false)
  for (const t of [TOPUP_LABEL, topUpNote(EMB), EMBEDDED_FUND_LINE]) assert.equal(t, t.toLowerCase())
  const sw = fread('components/Swap.tsx')
  assert.match(sw, /data-testid="receive-in"/); assert.match(sw, /shortOnGas\(eth, null, call\.value\)/); assert.match(sw, /swapOpts\)/)
})

test('one toast per error: repeats replace, raw text never toasts; the agent page sends one at a time', () => {
  const st = fread('state/store.tsx')
  assert.match(st, /x\.title === title && x\.body === body/)
  assert.match(st, /looksRaw\(body\)[^\n]*GENERIC_LINE/)
  const ag = fread('pages/Agent.tsx')
  assert.match(ag, /if \(busyRef\.current\) return/)
  assert.match(ag, /disabled=\{sending\}/)
  assert.match(ag, /toast\(\.\.\.failArgs\(r\)\)/)
  assert.doesNotMatch(ag, /toast\([^)]*r\.reason\)/)
  assert.match(ag, /<PayingFrom/)
  const p = fread('components/Payer.tsx')
  assert.match(p, /fundEmbedded && <p className="small" data-testid="embedded-fund">\{EMBEDDED_FUND_LINE\}/)
  assert.match(p, /showEmbeddedFundLine/)
})

test('agent page shows one paying-from row; the embedded note is just the fund line + address + copy', () => {
  const ag = fread('pages/Agent.tsx')
  assert.equal((ag.match(/<PayingFrom/g) || []).length, 1)
  for (const m of ag.match(/<TxSteps[^>]*>/g) || []) assert.match(m, /payer=\{false\}/)
  const tx = fread('components/TxSteps.tsx')
  assert.match(tx, /payer = true/)
  // 11.8.7: payer={false} returns the bare steps; otherwise the payer row sits above them in .txblock
  assert.match(tx, /if \(!payer\) return steps/)
  assert.match(tx, /<div className="txblock"[^>]*><PayingFrom \/>\{steps\}<\/div>/)
  const p = fread('components/Payer.tsx')
  assert.match(p, /empty && o\.kind !== 'embedded' && <p className="small">\{PAYER_GAS_LINE\}/)
  assert.doesNotMatch(p, /EMBEDDED_GAS_HINT/)
})
