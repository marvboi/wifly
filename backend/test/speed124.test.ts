/** speed.12.4: official tab icons, in-site confirm, clean errors, tooltip portal, explabs env docs. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { UserRejectedRequestError } from 'viem'
import {
  CANCELLED_LINE, GENERIC_LINE, WIF_LINE, NETWORK_LINE, looksRaw, txErrorLine, userError,
} from '../../frontend/src/lib/txError'

const root = join(import.meta.dirname, '../..')
const FE = join(root, 'frontend')
const src = (r: string) => readFileSync(join(FE, 'src', r), 'utf8')
const pub = (r: string) => readFileSync(join(FE, 'public', r))
const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')

test('package version is 0.12.4 lineage (accepts 12.5 ship)', () => {
  assert.match(readFileSync(join(root, 'frontend/package.json'), 'utf8'), /"version": "0\.12\.\d+(\.\d+)?"/)
  assert.match(readFileSync(join(root, 'backend/package.json'), 'utf8'), /"version": "0\.12\.\d+(\.\d+)?"/)
})

test('tab, apple-touch and manifest icons are the official logo with cache-bust', () => {
  const html = readFileSync(join(FE, 'index.html'), 'utf8')
  for (const href of ['/favicon.ico?v=12.4', '/favicon.svg?v=12.4', '/favicon-16.png?v=12.4', '/favicon-32.png?v=12.4', '/favicon-48.png?v=12.4', '/apple-touch-icon.png?v=12.4', '/manifest.webmanifest?v=12.4']) {
    assert.match(html, new RegExp(href.replace(/[.?]/g, '\\$&')))
  }
  const manifest = readFileSync(join(FE, 'public/manifest.webmanifest'), 'utf8')
  assert.match(manifest, /favicon-192\.png\?v=12\.4/)
  assert.match(manifest, /favicon-512\.png\?v=12\.4/)
  const official = join(root, 'brand/final')
  assert.equal(sha(pub('favicon.svg')), sha(readFileSync(join(official, 'favicon.svg'))))
  assert.equal(sha(pub('favicon.ico')), sha(readFileSync(join(official, 'favicon.ico'))))
  assert.equal(sha(pub('favicon-32.png')), sha(readFileSync(join(official, 'png/favicon-32.png'))))
  assert.equal(sha(pub('apple-touch-icon.png')), sha(readFileSync(join(official, 'png/favicon-180.png'))))
  const svg = pub('favicon.svg').toString('utf8')
  assert.match(svg, /#CCFF00/i)
  assert.doesNotMatch(svg, /#0d0d0d/)
})

test('PostCard, DCA and Deploy use the in-site confirm, not window.confirm', () => {
  for (const f of ['components/PostCard.tsx', 'pages/DCA.tsx', 'pages/Deploy.tsx']) {
    const s = src(f)
    assert.match(s, /useConfirm/)
    assert.doesNotMatch(s, /window\.confirm/)
  }
  const dlg = src('components/ConfirmDialog.tsx')
  assert.match(dlg, /createPortal/)
  assert.match(dlg, /Escape/)
  assert.match(dlg, /aria-modal/)
  assert.match(dlg, /btn--danger/)
  assert.match(dlg, /no-scroll/)
  assert.match(src('main.tsx'), /ConfirmProvider/)
})

test('userError maps raw wallet, rpc and wif failures to short wifly lines and logs at debug only', () => {
  assert.equal(CANCELLED_LINE, 'you cancelled in your wallet')
  assert.equal(WIF_LINE, 'not enough wif in your wifly balance')
  assert.equal(NETWORK_LINE, 'network busy, try again')
  let debugs = 0, warns = 0
  const d = console.debug, w = console.warn
  console.debug = () => { debugs++ }
  console.warn = () => { warns++ }
  try {
    assert.equal(userError(new UserRejectedRequestError(new Error('User rejected the request.'))), CANCELLED_LINE)
    assert.equal(userError(new Error('transfer amount exceeds balance')), WIF_LINE)
    assert.equal(userError(new Error('Failed to fetch')), NETWORK_LINE)
    assert.equal(userError(new Error('HTTP 503')), NETWORK_LINE)
    const raw = 'Error: execution reverted: 0xdeadbeef\nRequest Arguments:\n  from: 0x' + 'ab'.repeat(20)
    assert.ok(looksRaw(raw))
    assert.equal(userError(new Error(raw)), GENERIC_LINE)
    assert.equal(txErrorLine(new Error(raw)).line, GENERIC_LINE)
  } finally { console.debug = d; console.warn = w }
  assert.ok(debugs >= 1, 'raw details go to console.debug')
  assert.equal(warns, 0, 'raw details must not go to console.warn')
})

test('InfoTip portals to the body and clamps in the viewport', () => {
  const s = src('components/InfoTip.tsx')
  assert.match(s, /createPortal/)
  assert.match(s, /document\.body/)
  assert.match(s, /infotip__pop--float/)
  assert.match(s, /export \{ placePop as placeInfoTip \}/)
})

test('subscribe pay page and locked cards keep their features with the new layout classes', () => {
  const sub = src('sheets/Sheets.tsx')
  assert.match(sub, /className="subpay"/)
  assert.match(sub, /FeeSplit/)
  assert.match(sub, /LowBalance/)
  assert.match(sub, /TxSteps/)
  const card = src('components/PostCard.tsx')
  assert.match(card, /locked__preview/)
  assert.match(card, /locked__frost/)
  assert.match(card, /locked__price/)
  assert.match(card, /drop__unlocked/)
  assert.match(src('styles/app.css'), /\.subpay/)
  assert.match(src('styles/app.css'), /\.btn--danger/)
  assert.match(src('styles/app.css'), /\.cmp-confirm/)
})

test('companion confirm card keeps every field and adds a local cancel', () => {
  const s = src('companion/Companion.tsx')
  assert.match(s, /cmp-confirm/)
  assert.match(s, /cmp-confirm__title/)
  assert.match(s, /cmp-confirm__foot/)
  assert.match(s, /setDismissed/)
  assert.match(s, /from deposited/)
  assert.match(s, /cap left today/)
  assert.match(s, /p\.call\.fn/)
  assert.match(s, /needsTopUp/)
  assert.match(s, /onConfirm/)
})

test('Experimental Labs is documented and the key is only read from env', () => {
  const llm = readFileSync(join(root, 'backend/src/llm/index.ts'), 'utf8')
  assert.match(llm, /EXPLABS_API_KEY/)
  assert.match(llm, /gpt-6-luna/)
  assert.match(llm, /api\.experientiallabs\.ai\/v1\/chat\/completions/)
  assert.match(llm, /EXPLABS_TIMEOUT_MS = 10_000/)
  assert.doesNotMatch(llm, /sk-[A-Za-z0-9]{10,}/)
  const env = readFileSync(join(root, 'RAILWAY_ENV.md'), 'utf8')
  assert.match(env, /EXPLABS_API_KEY/)
  assert.match(env, /EXPLABS_MODEL/)
  assert.ok(existsSync(join(root, 'backend/test/speed124-llm.test.ts')))
})

test('PayingFrom is used in every pay flow; gas note is one short line plus address and copy', () => {
  for (const f of ['pages/DCA.tsx', 'pages/Plus.tsx', 'pages/Names.tsx', 'pages/Agent.tsx', 'components/Swap.tsx', 'components/TxSteps.tsx', 'components/WeeklyPot.tsx']) {
    assert.match(src(f), /PayingFrom/)
  }
  const payer = src('components/Payer.tsx')
  assert.match(payer, /function PayerGas/)
  assert.match(payer, /EMBEDDED_FUND_LINE/)
  assert.match(payer, /CopyAddr/)
  assert.match(payer, /<PayerGas /)
  const sheets = src('sheets/Sheets.tsx')
  assert.match(sheets, /title="send a tip"/)
  assert.match(sheets, /title="unlock drop"/)
  assert.match(sheets, /title=\{`support \$\{u\.name\}`\}/)
  assert.match(sheets, /title="checkout"/)
  assert.match(src('components/TxSteps.tsx'), /<PayingFrom \/>/)
  const sw = src('components/Swap.tsx')
  assert.match(sw, /TOPUP_LABEL/)
  assert.match(sw, /topUpNote/)
  assert.match(sw, /CopyAddr address=\{choice.embedded\}/)
  const wal = src('components/WalletsSection.tsx')
  assert.match(wal, /data-testid="wallet-withdraw"/)
  assert.match(wal, /data-testid="wallet-export"/)
  assert.match(wal, /data-testid="wallet-deposit"/)
  assert.match(wal, /CopyBtn text=\{from\}/)
  assert.match(src('components/WalletProofs.tsx'), /tip-destination/)
  assert.match(src('pages/Welcome.tsx'), /your wifly wallet/)
  assert.match(src('pages/Welcome.tsx'), /no seed phrase/)
  assert.match(src('components/SignInForm.tsx'), /you sign a message to prove it.s you\. nothing is sent or spent\./)
  assert.match(src('components/SignInForm.tsx'), /a guest key lives in this browser only/)
  assert.match(src('components/SignInForm.tsx'), /it takes about a minute/)
})
