// Copies the ABIs (and the deploy artifacts for /deploy) from contracts/out. Read-only on contracts/.
//   npm run abi                      (reads ../contracts/out)
//   ABI_OUT=/tmp/wifly-out npm run abi  (a build made with forge --out /tmp/wifly-out)
// Writes: src/contracts/{wiflyAbi,namesAbi,badgesAbi,wiflyDca}.ts, ../backend/src/abi/wiflyDca.ts, src/deploy/artifacts.json
// Every Wifly contract except WiflyNameRenderer is a UUPS proxy: the app always talks to the PROXY
// address; the implementation ABI is the one to use with it (calls go through the proxy's delegatecall).
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const OUT = resolve(process.env.ABI_OUT ?? new URL('../../contracts/out', import.meta.url).pathname)
const art = (name, file = `${name}.sol`) => JSON.parse(readFileSync(`${OUT}/${file}/${name}.json`, 'utf8'))
const head = name => `/**\n * ${name} ABI (implementation behind the proxy), copied from the build output: contracts/out/${name}.sol/${name}.json\n * Use it with the PROXY address from env. Regenerate after a contract change: cd ../contracts && forge build && cd ../frontend && npm run abi\n */\n`
const strip = abi => abi.filter(x => x.type !== 'constructor')
const ts = [['Wifly', 'wiflyAbi', 'src/contracts/wiflyAbi.ts'], ['WiflyNames', 'namesAbi', 'src/contracts/namesAbi.ts'], ['WiflyBadges', 'badgesAbi', 'src/contracts/badgesAbi.ts'],
  ['WiflyDCA', 'WIFLY_DCA_ABI', 'src/contracts/wiflyDca.ts'], ['WiflyDCA', 'WIFLY_DCA_ABI', '../backend/src/abi/wiflyDca.ts']]
for (const [name, v, file] of ts) {
  const { abi } = art(name)
  writeFileSync(new URL(`../${file}`, import.meta.url), `${head(name)}export const ${v} = ${JSON.stringify(strip(abi), null, 2)} as const\n`)
  console.log(`${file}: ${name} ${abi.length} entries`)
}
// /deploy: implementation bytecode + initialize ABI per contract, the renderer (plain) and the ERC1967Proxy.
const pick = (name, file) => { const a = art(name, file); return { abi: a.abi.filter(x => ['constructor', 'function'].includes(x.type) && (x.type === 'constructor' || ['initialize', 'setRenderer', 'setPot', 'reserve', 'setKeeper', 'owner', 'proxiableUUID', 'UPGRADE_INTERFACE_VERSION'].includes(x.name))), bytecode: a.bytecode.object } }
const artifacts = { source: 'contracts/out', kind: 'uups-proxy',
  ERC1967Proxy: pick('ERC1967Proxy'), Wifly: pick('Wifly'), WiflyNames: pick('WiflyNames'), WiflyGlyphs: pick('WiflyGlyphs'),
  WiflyNameRenderer: pick('WiflyNameRenderer'), WiflyBadges: pick('WiflyBadges'), WiflyDCA: pick('WiflyDCA') }
writeFileSync(new URL('../src/deploy/artifacts.json', import.meta.url), JSON.stringify(artifacts))
console.log('src/deploy/artifacts.json:', Object.keys(artifacts).filter(k => typeof artifacts[k] === 'object').join(', '))
