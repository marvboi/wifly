/** The tolerant command parser: 30+ messy inputs -> confidence + canonical command. No DB, no model. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { editDistance, interpret, normalize, suggestionsFor } from '../src/commandParse'

const H = 'high', M = 'medium', L = 'low'
const TABLE: [string, 'high' | 'medium' | 'low', string | null][] = [
  // DCA
  ['buy $5 of WIF every Monday at 9am', H, 'buy $5 of wif every monday at 9:00'],
  ['by 5 wif evry mondy', M, 'buy $5 of wif every monday at 9:00'],
  ['buy 5usd of wif every mon 9am', H, 'buy $5 of wif every monday at 9:00'],
  ['buy 5 usd wif every monday at 9 am', H, 'buy $5 of wif every monday at 9:00'],
  ['Buy $5 WIF every Monday @ 9am!!', H, 'buy $5 of wif every monday at 9:00'],
  ['buy 5$ of wif mondays 21:00', H, 'buy $5 of wif every monday at 21:00'],
  ['stack 0.01e of wif daily at 21:30', H, 'buy 0.01 eth of wif every day at 21:30'],
  ['buy .01eth wif every day 8pm', H, 'buy 0.01 eth of wif every day at 20:00'],
  ['buy $10 wif evrey tusday at 7:15am', M, 'buy $10 of wif every tuesday at 7:15'],
  ['buy 20 bucks of wif each fri 6pm', H, 'buy $20 of wif every friday at 18:00'],
  ['dca $25 into wif weekly', H, 'buy $25 of wif every week at 9:00'],
  ['buy $3 wif evry hour', M, 'buy $3 of wif every hour'],
  ['buy $50 of wif monthly at 10am', H, 'buy $50 of wif every month at 10:00'],
  ['buy $5 wif every wednsday 9am', M, 'buy $5 of wif every wednesday at 9:00'],
  // swap
  ['swp 0.01 eth to wif', M, 'swap 0.01 eth to wif'],
  ['swap 0.01e to wif', H, 'swap 0.01 eth to wif'],
  ['Swap .5 ETH for $WIF.', H, 'swap 0.5 eth to wif'],
  ['sell 5k wif', H, 'swap 5000 wif to eth'],
  ['sel 5k wif for eth', M, 'swap 5000 wif to eth'],
  ['swap 1.5m wif to eth', H, 'swap 1500000 wif to eth'],
  ['ape 0.02 eth into wif', H, 'swap 0.02 eth to wif'],
  ['convrt 0.1 ether to wif', M, 'swap 0.1 eth to wif'],
  // tips / subs
  ['tipp @marv 50', M, 'tip @marv 50'],
  ['tip @marv 50 wif', H, 'tip @marv 50'],
  ['tip marv.wif 1k', H, 'tip marv.wif 1000'],
  ['TIP @juno 2,500!', H, 'tip @juno 2500'],
  ['send 100 wif to @juno', H, 'tip @juno 100'],
  ['subscrbe @juno', M, 'subscribe @juno'],
  ['sub to @juno', H, 'subscribe @juno'],
  ['renw my plus', M, 'renew my plus'],
  // manage
  ['paus my dca', M, 'pause my scheduled buys'],
  ['pause my dca pls', H, 'pause my scheduled buys'],
  ['resme my dca', M, 'resume my scheduled buys'],
  ['cancle my dca plan', M, 'cancel my scheduled buys'],
  ['stop my recurring buys', H, 'pause my scheduled buys'],
  // balance / pot
  ['bal', H, 'what’s my balance'],
  ['whats my balence', M, 'what’s my balance'],
  ['pot?', H, 'how big is the pot'],
  // not commands
  ['what can you help me with?', L, null],
  ['tell me a story about the flat world', L, null],
  ['how does the pot work?', L, null],
  ['tip someone nice', L, null],
]

test(`interpret: ${TABLE.length} messy inputs`, () => {
  assert.ok(TABLE.length >= 30)
  const bad: string[] = []
  for (const [input, conf, canonical] of TABLE) {
    const r = interpret(input)
    if (r.confidence !== conf || r.canonical !== canonical) bad.push(`${JSON.stringify(input)} -> ${r.confidence} ${JSON.stringify(r.canonical)} (want ${conf} ${JSON.stringify(canonical)}; norm ${JSON.stringify(r.norm.text)})`)
  }
  assert.deepEqual(bad, [])
})

test('canonical commands read back as high confidence (a "Did you mean" tap is exact)', () => {
  for (const [input] of TABLE) {
    const r = interpret(input)
    if (r.canonical && r.intent !== 'balance' && r.intent !== 'pot') assert.equal(interpret(r.canonical).confidence, 'high', r.canonical)
  }
})

test('edit distance, normalization and suggestions', () => {
  assert.equal(editDistance('mondy', 'monday'), 1)
  assert.equal(editDistance('dac', 'dca'), 1, 'transposition counts once')
  assert.equal(editDistance('with', 'wif'), 2)
  assert.equal(normalize('what can you help me with').fixes.length, 0, 'stopwords are never “fixed”')
  assert.equal(normalize('5k wif').text, '5000 wif')
  assert.equal(normalize('9 am').text, 'at 9am')
  const s = suggestionsFor(interpret('tip someone nice'))
  assert.ok(s.length >= 2 && s.length <= 3); assert.ok(s[0].startsWith('tip '))
  assert.equal(suggestionsFor(interpret('asdf qwer')).length, 3)
})
