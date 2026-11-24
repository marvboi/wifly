import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const src = (rel: string) => readFileSync(join(root, 'frontend/src', rel), 'utf8')

test('package and settings version is 0.12.6.17', () => {
  assert.match(readFileSync(join(root, 'frontend/package.json'), 'utf8'), /"version": "0\.12\.6\.17"/)
  assert.match(readFileSync(join(root, 'backend/package.json'), 'utf8'), /"version": "0\.12\.6\.17"/)
  assert.match(src('pages/Settings.tsx'), />0\.12\.6\.17</)
})

test('terms and privacy are routed on the site host and the app host', () => {
  const app = src('App.tsx')
  assert.match(app, /const Terms = lazy\(\(\) => import\('\.\/pages\/Legal'\)\.then\(m => \(\{ default: m\.Terms \}\)\)\)/)
  assert.match(app, /const Privacy = lazy\(\(\) => import\('\.\/pages\/Legal'\)\.then\(m => \(\{ default: m\.Privacy \}\)\)\)/)
  // site host (landing) and the shared app/single tree both declare the routes, before any catch-all or /:seg
  assert.equal([...app.matchAll(/<Route path="\/terms" element=\{terms\} \/>/g)].length, 2)
  assert.equal([...app.matchAll(/<Route path="\/privacy" element=\{privacy\} \/>/g)].length, 2)
  const siteBlock = app.slice(app.indexOf("HOST_ROLE === 'site'"), app.indexOf("HOST_ROLE === 'app'"))
  assert.match(siteBlock, /path="\/terms"/)
  assert.match(siteBlock, /path="\/privacy"/)
  assert.ok(siteBlock.indexOf('path="/terms"') < siteBlock.indexOf('path="*"'))
  const appBlock = app.slice(app.indexOf("const app = HOST_ROLE === 'app'"))
  assert.ok(appBlock.indexOf('path="/terms"') < appBlock.indexOf('path="/:seg"'))
  assert.ok(appBlock.indexOf('path="/privacy"') < appBlock.indexOf('path="/:seg"'))
})

test('landing and docs footers link to terms and privacy', () => {
  const landing = src('pages/Landing.tsx')
  const product = landing.match(/<div><span>product<\/span>.*?<\/div>/)?.[0] ?? ''
  assert.match(product, /<Link to="\/docs">docs<\/Link>/)
  assert.match(product, /<Link to="\/terms">terms<\/Link>/)
  assert.match(product, /<Link to="\/privacy">privacy<\/Link>/)
  const docsFoot = src('pages/Docs.tsx').match(/<footer className="dx-foot">[\s\S]*?<\/footer>/)?.[0] ?? ''
  assert.match(docsFoot, /<Link to="\/terms">terms<\/Link>/)
  assert.match(docsFoot, /<Link to="\/privacy">privacy<\/Link>/)
})

test('terms page covers the required rules in plain site voice', () => {
  const legal = src('pages/Legal.tsx')
  assert.match(legal, /export function Terms\(/)
  assert.match(legal, /title="terms of use"/)
  assert.match(legal, /provided as is/)
  assert.match(legal, /you are responsible for your wallet, your keys and your transactions/)
  assert.match(legal, /actions you sign on robinhood chain are final and irreversible/)
  assert.match(legal, /nothing on wifly is financial, investment or legal advice/)
  assert.match(legal, /don’t use bots, automation, scripts or scraping/)
  assert.match(legal, /create accounts or \.wif names in bulk, wash vote, farm tips or votes/)
  assert.match(legal, /abuse rate limits, faucets or rewards/)
  assert.match(legal, /we can limit your access, remove content, and withhold names or rewards/)
  assert.match(legal, /no spam, impersonation, illegal content or harassment/)
  assert.match(legal, /must not infringe someone else’s trademark/)
  assert.match(legal, /we can change these terms/)
  assert.match(legal, /LINKS\.wifX/)
  assert.doesNotMatch(legal, /\[contact\]/)
  assert.doesNotMatch(legal, /govern(ing|ed) law|jurisdiction|nigeria/i)
})

test('privacy page matches what the backend actually stores', () => {
  const legal = src('pages/Legal.tsx')
  assert.match(legal, /export function Privacy\(/)
  assert.match(legal, /title="privacy policy"/)
  assert.match(legal, /your wallet address/)
  assert.match(legal, /your @name and \.wif names/)
  assert.match(legal, /direct messages \(text and images\) on our servers, in readable form/)
  assert.match(legal, /they are not end-to-end encrypted/)
  assert.match(legal, /deleting your account does not automatically remove messages already sent/)
  assert.match(legal, /uploads you add/)
  assert.match(legal, /session cookie/)
  assert.match(legal, /logs are written without full wallet addresses, emails or tokens/)
  assert.doesNotMatch(legal, /ip address/i)
  assert.doesNotMatch(legal, /those limits live in short-lived memory or redis/)
  assert.match(legal, /we don’t run a third-party analytics product/)
  assert.match(legal, /on-chain data lives on robinhood chain/)
  assert.match(legal, /we use a few trusted services to run wifly, like sign-in, wallet connection, hosting and the in-app assistant/)
  assert.match(legal, /they only get what they need to do their job/)
  assert.match(legal, /we don’t sell your data/)
  assert.doesNotMatch(legal, /each of those has its own privacy policy/)
  assert.doesNotMatch(legal, /privy, for x, email and embedded-wallet sign-in/)
  assert.doesNotMatch(legal, /cloudflare turnstile/)
  assert.doesNotMatch(legal, /railway, which hosts the app and our database/)
  assert.match(legal, /you can delete your account in settings/)
  assert.match(legal, /LINKS\.wifX/)
})

test('legal pages have a back control and stay in the existing docs style', () => {
  const legal = src('pages/Legal.tsx')
  assert.match(legal, /data-testid="legal-back"/)
  assert.match(legal, /aria-label="back"/)
  assert.match(legal, /className="dx dx--legal"/)
  assert.match(legal, /useThemedPage\(\)/)
  assert.match(src('lib/paths.ts'), /'terms', 'privacy'/)
})
