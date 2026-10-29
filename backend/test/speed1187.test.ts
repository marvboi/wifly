/** 11.8.7: the paying-from row could collapse to its padding (one letter per line) inside the tip sheet's step row, and the
 * tip search showed nothing until you typed. Source checks so neither comes back. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FE = join(import.meta.dirname, '../../frontend/src')
const src = (p: string) => readFileSync(join(FE, p), 'utf8')
const css = src('styles/app.css')
// the last declaration block for a selector wins in the cascade (same specificity), so check the final one
const lastRule = (sel: string) => {
  const re = new RegExp('(^|\\n|\\}|,)\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g')
  let m: RegExpExecArray | null, last = ''
  while ((m = re.exec(css))) last = m[2]
  return last
}

test('TxSteps: paying-from is a full-width row above the steps, never a flex item inside .txsteps', () => {
  const t = src('components/TxSteps.tsx')
  assert.match(t, /className="txblock"/)
  const block = t.slice(t.indexOf('className="txblock"'))
  assert.ok(block.indexOf('<PayingFrom />') > -1 && block.indexOf('<PayingFrom />') < block.indexOf('{steps}'), 'payer before steps')
  const steps = t.slice(t.indexOf('const steps'), t.indexOf('className="txblock"'))
  assert.doesNotMatch(steps, /PayingFrom/, 'no payer inside the steps row')
  assert.match(lastRule('.txblock'), /flex-direction:\s*column/)
})

test('payer css guard: full width, no shrink, text truncates instead of wrapping per letter', () => {
  const p = lastRule('.payer')
  assert.match(p, /width:\s*100%/)
  assert.match(p, /min-width:\s*0/)
  assert.match(p, /flex-shrink:\s*0/)
  const bal = lastRule('.payer .payer__bal')
  assert.match(bal, /white-space:\s*nowrap/)
  assert.match(bal, /text-overflow:\s*ellipsis/)
  assert.doesNotMatch(bal, /overflow-wrap:\s*anywhere/)
  const addr = lastRule('.payer .payer__addr') // 11.8.8: the fixed 6+4 address never truncates; the pill/label give way
  assert.match(addr, /flex:\s*none/)
  assert.doesNotMatch(addr, /text-overflow:\s*ellipsis/)
  assert.match(lastRule('.payer .payer__acts, .payer .payer__copy, .payer .payer__switch'), /flex-shrink:\s*0/)
})

test('tip search: people you follow (or suggested) show before typing, from real endpoints', () => {
  const s = src('sheets/Sheets.tsx')
  assert.match(s, /data-testid="tip-near"/)
  assert.match(s, /\/following/)
  assert.match(s, /\/suggest\/users/)
  assert.match(s, /people you follow/)
  assert.match(s, /'suggested'/)
})
