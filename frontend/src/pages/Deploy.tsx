/**
 * /deploy: admin-only, not linked anywhere. the owner connects the treasury (or another admin) wallet and deploys the
 * contracts one step at a time, signing each himself. Mirrors contracts/script/DeployWifly.s.sol (UUPS proxy version):
 * every Wifly contract except the renderer is an implementation + an ERC1967Proxy whose constructor calls
 * initialize(...) in the same transaction (so nobody can front-run initialization). The owner of every proxy (the only
 * one who can upgrade) defaults to the treasury. Works only while the contract addresses are unset, or with VITE_DEPLOY_PAGE=true.
 *
 * The steps are data (CONTRACTS below + src/deploy/artifacts.json from `npm run abi`), so a new script or ABI
 * means regenerating the artifacts and editing the init args here, not the page.
 * Order: Wifly → WiflyNames → WiflyGlyphs → WiflyNameRenderer(glyphs proxy) → WiflyBadges → setRenderer, setPot(wifly),
 * reserve brand names → WiflyDCA → setKeeper.
 * Addresses only come from mined receipts. The app and Railway env always get the PROXY addresses; the implementation
 * addresses are shown for the record. Nothing here holds a key: the wallet signs.
 */
import { useEffect, useMemo, useState } from 'react'
import { encodeAbiParameters, encodeFunctionData, isAddress, type Abi, type Address, type Hex } from 'viem'
import { useAccount, useChainId, usePublicClient, useSwitchChain, useWalletClient } from 'wagmi'
import { ADMIN_ADDRESSES, DEPLOY_PAGE_ON, EXPLORER, robinhoodChain, TREASURY, UNISWAP, WIF_TOKEN } from '../config'
import { NotFound } from './NotFound'
import { PageHead } from '../components/Shell'
import { explainError } from '../lib/wifly'
import { useConfirm } from '../components/ConfirmDialog'

type Art = { abi: Abi; bytecode: Hex }
type ArtName = 'ERC1967Proxy' | 'Wifly' | 'WiflyNames' | 'WiflyGlyphs' | 'WiflyNameRenderer' | 'WiflyBadges' | 'WiflyDCA'
type Arts = Record<ArtName, Art> & { kind?: string; source?: string }
type Upg = 'wifly' | 'names' | 'glyphs' | 'badges' | 'dca'
type Key = Upg | `${Upg}Impl` | 'renderer' | 'setRenderer' | 'setPot' | 'reserve_wifly' | 'reserve_marv' | 'reserve_wif' | 'setKeeper'
/** init: the initialize calldata each proxy was built with; block: the block each step mined in (both for Blockscout verification). */
type Saved = { addr: Partial<Record<Key, Address>>; tx: Partial<Record<Key, Hex>>; init?: Partial<Record<Upg, Hex>>; block?: Partial<Record<Key, string>>; deployer?: Address; owner?: Address }
const STORE = 'wifly.deploy.v2' // v1 was the constructor-based version
const E18 = 10n ** 18n
const RESERVED = ['wifly', 'marv', 'wif'] as const
const BADGE_URI = 'https://wifly.fun/badges/{id}.json'
const THRESHOLDS = [1_000n * E18, 10_000n * E18, 100_000n * E18, 1_000_000n * E18]

type Inputs = { owner: string; attester: string; treasury: string; keeper: string }
type Step = { key: Key; title: string; note: string; kind: 'impl' | 'proxy' | 'plain' | 'call'; ready: boolean; skip?: string }
type Ctx = { owner: Address; treasury: Address; attester: Address; a: Saved['addr'] }

/** One entry per upgradeable contract: the artifact and its initialize(...) args (same as DeployWifly.s.sol). */
const CONTRACTS: Record<Upg, { art: ArtName; init: (c: Ctx) => unknown[]; note: string; needs: (i: { ownerOk: boolean; attesterOk: boolean; treasuryOk: boolean }) => boolean }> = {
  wifly: { art: 'Wifly', init: c => [WIF_TOKEN, true, c.owner, c.attester, c.treasury, 100n * E18], note: 'initialize(wif, burn = true, owner, attester, treasury, top spot floor 100 wif)', needs: i => i.ownerOk && i.attesterOk && i.treasuryOk },
  names: { art: 'WiflyNames', init: c => [WIF_TOKEN, true, c.owner, c.treasury, 100n * E18, 1000n * E18], note: 'initialize(wif, burn = true, owner, treasury, claim fee 100 wif, short fee 1,000 wif)', needs: i => i.ownerOk && i.treasuryOk },
  glyphs: { art: 'WiflyGlyphs', init: c => [c.owner], note: 'initialize(owner). WIF Par outlines for the onchain name art', needs: i => i.ownerOk },
  badges: { art: 'WiflyBadges', init: c => [WIF_TOKEN, true, c.owner, BADGE_URI, THRESHOLDS], note: `initialize(wif, burn = true, owner, "${BADGE_URI}", [1k, 10k, 100k, 1M wif])`, needs: i => i.ownerOk },
  dca: { art: 'WiflyDCA', init: c => [c.owner, UNISWAP.universalRouter, UNISWAP.v4Quoter, WIF_TOKEN, UNISWAP.poolKey.hooks, UNISWAP.poolKey.fee, UNISWAP.poolKey.tickSpacing], note: 'initialize(owner, universal router, v4 quoter, wif, pool hooks, fee 0, tick spacing 200)', needs: i => i.ownerOk },
}
const LABEL: Record<Upg, string> = { wifly: 'Wifly', names: 'WiflyNames', glyphs: 'WiflyGlyphs', badges: 'WiflyBadges', dca: 'WiflyDCA' }

function load(): Saved { try { return { addr: {}, tx: {}, ...JSON.parse(localStorage.getItem(STORE) || '{}') } } catch { return { addr: {}, tx: {} } } }

function Copy({ text, label = 'copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return <button className="btn btn--ghost btn--sm" onClick={() => { void navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200) }}>{done ? 'copied' : label}</button>
}

export default function Deploy() {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { switchChain } = useSwitchChain()
  const { data: wallet } = useWalletClient({ chainId: robinhoodChain.id })
  const client = usePublicClient({ chainId: robinhoodChain.id })
  const [arts, setArts] = useState<Arts | null>(null)
  const [saved, setSaved] = useState<Saved>(load)
  const [inp, setInp] = useState<Inputs>({ owner: TREASURY, attester: '', treasury: TREASURY, keeper: '' })
  const [busy, setBusy] = useState<Key | null>(null)
  const [err, setErr] = useState('')
  const confirmIn = useConfirm()
  const [checks, setChecks] = useState<{ wif: boolean; uni: boolean } | null>(null)

  useEffect(() => { if (!DEPLOY_PAGE_ON) return; const m = document.createElement('meta'); m.name = 'robots'; m.content = 'noindex,nofollow'; document.head.appendChild(m); return () => { m.remove() } }, [])
  useEffect(() => { if (DEPLOY_PAGE_ON) import('../deploy/artifacts.json').then(m => setArts(m.default as unknown as Arts)) }, [])
  useEffect(() => { localStorage.setItem(STORE, JSON.stringify(saved)) }, [saved])
  useEffect(() => {
    if (!client) return
    Promise.all([client.getCode({ address: WIF_TOKEN }), client.getCode({ address: UNISWAP.universalRouter }), client.getCode({ address: UNISWAP.v4Quoter })])
      .then(([w, r, q]) => setChecks({ wif: !!w && w !== '0x', uni: !!r && r !== '0x' && !!q && q !== '0x' })).catch(() => setChecks(null))
  }, [client])

  const admin = !!address && ADMIN_ADDRESSES.includes(address.toLowerCase())
  const onChain = chainId === robinhoodChain.id
  const ownerOk = isAddress(inp.owner), attesterOk = isAddress(inp.attester), treasuryOk = isAddress(inp.treasury), keeperOk = !inp.keeper || isAddress(inp.keeper)
  const ownerIsMe = ownerOk && !!address && inp.owner.toLowerCase() === address.toLowerCase()
  const a = saved.addr
  const ok = { ownerOk, attesterOk, treasuryOk }
  const ownerSkip = ownerIsMe ? undefined : 'the owner wallet sends this'

  const steps: Step[] = useMemo(() => {
    const upg = (c: Upg, extra = true): Step[] => [
      { key: `${c}Impl`, title: `${LABEL[c]}: implementation`, note: 'the logic contract. no constructor args; it can’t be initialized directly.', kind: 'impl', ready: extra },
      { key: c, title: `${LABEL[c]}: proxy + initialize`, note: `ERC1967Proxy(implementation, ${CONTRACTS[c].note}). this is the address the app uses.`, kind: 'proxy', ready: extra && !!a[`${c}Impl`] && CONTRACTS[c].needs(ok) },
    ]
    return [
      ...upg('wifly'), ...upg('names'), ...upg('glyphs'),
      { key: 'renderer', title: 'WiflyNameRenderer', note: 'plain contract (not a proxy), constructor(glyphs proxy). WiflyNames.setRenderer can swap it later.', kind: 'plain', ready: !!a.glyphs },
      ...upg('badges'),
      { key: 'setRenderer', title: 'names.setRenderer(renderer)', note: 'owner only.', kind: 'call', ready: !!a.names && !!a.renderer, skip: ownerSkip },
      { key: 'setPot', title: 'names.setPot(wifly)', note: 'name claim fees go 50% to the weekly community pot (until then that half also goes to the treasury). owner only.', kind: 'call', ready: !!a.names && !!a.wifly, skip: ownerSkip },
      ...RESERVED.map(n => ({ key: `reserve_${n}` as Key, title: `names.reserve("${n}", owner)`, note: `${n}.wif is reserved for the team. owner only.`, kind: 'call' as const, ready: !!a.names, skip: ownerSkip })),
      ...upg('dca', checks?.uni !== false),
      { key: 'setKeeper', title: 'dca.setKeeper(keeper, true)', note: 'lets the keeper wallet run scheduled buys. owner only. without it the keeper can’t buy.', kind: 'call', ready: !!a.dca && !!inp.keeper && keeperOk, skip: !inp.keeper ? 'no keeper address yet' : ownerSkip },
    ]
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, ownerOk, attesterOk, treasuryOk, keeperOk, ownerIsMe, inp.keeper, checks])

  const run = async (s: Step) => {
    if (!arts || !wallet || !client || !address) return
    setErr(''); setBusy(s.key)
    try {
      const ctx: Ctx = { owner: inp.owner as Address, treasury: inp.treasury as Address, attester: inp.attester as Address, a }
      let hash: Hex
      if (s.kind === 'impl') {
        const art = arts[CONTRACTS[s.key.replace('Impl', '') as Upg].art]
        hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [], account: address, chain: robinhoodChain })
      } else if (s.kind === 'proxy') {
        const c = CONTRACTS[s.key as Upg], impl = a[`${s.key as Upg}Impl`]!
        const init = encodeFunctionData({ abi: arts[c.art].abi, functionName: 'initialize', args: c.init(ctx) })
        setSaved(v => ({ ...v, init: { ...v.init, [s.key]: init } }))
        hash = await wallet.deployContract({ abi: arts.ERC1967Proxy.abi, bytecode: arts.ERC1967Proxy.bytecode, args: [impl, init], account: address, chain: robinhoodChain })
      } else if (s.kind === 'plain') {
        hash = await wallet.deployContract({ abi: arts.WiflyNameRenderer.abi, bytecode: arts.WiflyNameRenderer.bytecode, args: [a.glyphs], account: address, chain: robinhoodChain })
      } else {
        const call = (to: Address, abi: Abi, functionName: string, args: unknown[]) =>
          wallet.sendTransaction({ to, data: encodeFunctionData({ abi, functionName, args }), account: address, chain: robinhoodChain })
        if (s.key === 'setRenderer') hash = await call(a.names!, arts.WiflyNames.abi, 'setRenderer', [a.renderer])
        else if (s.key === 'setPot') hash = await call(a.names!, arts.WiflyNames.abi, 'setPot', [a.wifly])
        else if (s.key.startsWith('reserve_')) hash = await call(a.names!, arts.WiflyNames.abi, 'reserve', [s.key.slice(8), ctx.owner])
        else hash = await call(a.dca!, arts.WiflyDCA.abi, 'setKeeper', [inp.keeper as Address, true])
      }
      setSaved(v => ({ ...v, tx: { ...v.tx, [s.key]: hash }, deployer: address, owner: ctx.owner }))
      const rc = await client.waitForTransactionReceipt({ hash })
      setSaved(v => ({ ...v, block: { ...v.block, [s.key]: rc.blockNumber.toString() } }))
      if (rc.status !== 'success') throw new Error('it reverted on chain. nothing changed except gas.')
      if (s.kind !== 'call') {
        if (!rc.contractAddress) throw new Error('no contract address in the receipt')
        if (s.kind === 'proxy') {
          // the proxy ran initialize: its owner must be the owner we asked for
          const got = await client.readContract({ address: rc.contractAddress, abi: arts[CONTRACTS[s.key as Upg].art].abi, functionName: 'owner' }) as Address
          if (got.toLowerCase() !== ctx.owner.toLowerCase()) throw new Error(`the proxy’s owner is ${got}, not ${ctx.owner}. don’t use it; check the implementation.`)
        }
        setSaved(v => ({ ...v, addr: { ...v.addr, [s.key]: rc.contractAddress! } }))
      } else setSaved(v => ({ ...v, addr: { ...v.addr, [s.key]: (s.key === 'setKeeper' ? a.dca : a.names) } }))
    } catch (e) { setErr(explainError(e)) } finally { setBusy(null) }
  }

  if (!DEPLOY_PAGE_ON) return <NotFound />

  const envBlock = [
    ['WIFLY_CONTRACT_ADDRESS', 'VITE_WIFLY_ADDRESS', a.wifly], ['NAMES_CONTRACT_ADDRESS', 'VITE_NAMES_ADDRESS', a.names],
    ['BADGES_CONTRACT_ADDRESS', 'VITE_BADGES_ADDRESS', a.badges], ['DCA_CONTRACT_ADDRESS', 'VITE_DCA_ADDRESS', a.dca],
  ].filter(r => r[2]).flatMap(([b, f, v]) => [`${b}=${v}`, `${f}=${v}`]).join('\n')
  const contracts: [string, Address | undefined, Address | undefined][] = (['wifly', 'names', 'badges', 'dca', 'glyphs'] as Upg[]).map(c => [LABEL[c], a[c], a[`${c}Impl`]] as [string, Address | undefined, Address | undefined])
  contracts.push(['WiflyNameRenderer (plain)', a.renderer, undefined])

  // Verification record: implementation + proxy + tx hash per contract, and the exact constructor args Blockscout asks for.
  const proxyArgs = (c: Upg) => a[`${c}Impl`] && saved.init?.[c] ? encodeAbiParameters([{ type: 'address' }, { type: 'bytes' }], [a[`${c}Impl`]!, saved.init[c]!]) : null
  const deployments = {
    chainId: robinhoodChain.id, explorer: EXPLORER, kind: 'uups-proxy', source: arts?.source ?? null, deployer: saved.deployer ?? null, owner: saved.owner ?? null,
    contracts: Object.fromEntries((['wifly', 'names', 'glyphs', 'badges', 'dca'] as Upg[]).map(c => [LABEL[c], {
      proxy: a[c] ?? null, implementation: a[`${c}Impl`] ?? null,
      proxyTx: saved.tx[c] ?? null, implementationTx: saved.tx[`${c}Impl`] ?? null,
      proxyBlock: saved.block?.[c] ?? null, implementationBlock: saved.block?.[`${c}Impl`] ?? null,
      initializeCalldata: saved.init?.[c] ?? null,
      proxyConstructorArgs: proxyArgs(c), implementationConstructorArgs: '0x',
      verify: { implementation: `${CONTRACTS[c].art} (contracts/src, no constructor args)`, proxy: 'ERC1967Proxy (OpenZeppelin), constructor(address implementation, bytes data)' },
    }])),
    WiflyNameRenderer: { address: a.renderer ?? null, tx: saved.tx.renderer ?? null, block: saved.block?.renderer ?? null,
      constructorArgs: a.glyphs ? encodeAbiParameters([{ type: 'address' }], [a.glyphs]) : null, note: 'plain contract, constructor(address glyphs proxy)' },
    wiring: Object.fromEntries((['setRenderer', 'setPot', 'reserve_wifly', 'reserve_marv', 'reserve_wif', 'setKeeper'] as Key[]).map(k => [k, saved.tx[k] ?? null])),
  }
  const deploymentsJson = JSON.stringify(deployments, null, 2)
  const download = () => {
    const url = URL.createObjectURL(new Blob([deploymentsJson], { type: 'application/json' }))
    const el = document.createElement('a'); el.href = url; el.download = `deployments-${robinhoodChain.id}.json`; el.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const anyDeployed = Object.keys(a).length > 0

  return (
    <>
      <PageHead title="deploy contracts" />
      <div className="deploy">
        <p className="muted">admin only. each step opens your wallet and you sign it yourself. every contract except the renderer is an upgradeable proxy owned by the owner below (the treasury by default): first the implementation, then the proxy, which runs initialize in the same transaction. progress is kept in this browser.</p>
        {!isConnected ? <div className="card card--paper"><b>connect the treasury wallet</b><span className="muted">{TREASURY}</span></div>
          : !admin ? <div className="card card--paper"><b>this wallet isn’t an admin</b><span className="muted">connected {address}. switch to {TREASURY} or set VITE_ADMIN_ADDRESSES.</span></div>
          : !onChain ? <div className="card card--paper"><b>switch to the right network</b><button className="btn btn--dark btn--sm" onClick={() => switchChain({ chainId: robinhoodChain.id })}>switch network</button></div>
          : null}
        {checks && !checks.wif && <div className="card card--paper"><b>wif has no code on this chain</b><span className="muted">check the network before deploying.</span></div>}
        {checks && !checks.uni && <div className="card card--paper"><b>Uniswap v4 isn’t on this chain</b><span className="muted">WiflyDCA can’t deploy here.</span></div>}

        <div className="card">
          <b>settings</b>
          {([['owner', 'owner of every proxy (admin + the only one who can upgrade). defaults to the treasury', ownerOk], ['attester', 'attester (X link signer). required, paste its address', attesterOk], ['treasury', 'treasury (50% of .wif name claims; no share of other fees)', treasuryOk], ['keeper', 'DCA keeper (optional, the address of WIFLY_KEEPER_PRIVATE_KEY)', keeperOk]] as const).map(([k, label, ok]) => (
            <label key={k} className="field">
              <span className="field__label">{label}</span>
              <span className="field__input" style={inp[k] && !ok ? { borderColor: 'var(--neon, #c33)' } : undefined}>
                <input value={inp[k]} onChange={e => setInp(i => ({ ...i, [k]: e.target.value.trim() }))} placeholder="0x…" spellCheck={false} />
              </span>
            </label>
          ))}
          {!ownerIsMe && ownerOk && <span className="muted">the owner isn’t this wallet, so the owner-only calls (setRenderer, setPot, reserve, setKeeper) are sent later from the owner wallet.</span>}
        </div>

        <ol className="deploy__steps">
          {steps.map((s, i) => {
            const done = !!a[s.key], tx = saved.tx[s.key]
            const can = !!arts && admin && onChain && !!wallet && s.ready && !s.skip && !busy && !done
            return (
              <li key={s.key} className={`deploy__step ${done ? 'is-done' : ''}`}>
                <span className="deploy__n">{done ? '✓' : i + 1}</span>
                <div className="deploy__body">
                  <b>{s.title}</b>
                  <span className="muted">{s.note}</span>
                  {done && s.kind !== 'call' && <span className="deploy__addr"><code>{a[s.key]}</code><Copy text={a[s.key]!} /></span>}
                  {tx && <a className="muted" href={`${EXPLORER}/tx/${tx}`} target="_blank" rel="noreferrer">view tx</a>}
                  {s.skip && !done && <span className="muted">skipped: {s.skip}</span>}
                </div>
                {!done && <button className="btn btn--dark btn--sm" disabled={!can} onClick={() => run(s)}>{busy === s.key ? 'waiting…' : s.kind === 'call' ? 'send' : 'deploy'}</button>}
              </li>
            )
          })}
        </ol>
        {err && <div className="card card--paper"><b>not done</b><span className="muted">{err}</span></div>}

        <div className="card">
          <b>addresses for Railway</b>
          {contracts.map(([n, v, impl]) => (
            <span key={n} className="deploy__addr"><span>{n}</span><code>{v ?? '—'}</code>{v && <Copy text={v} />}{impl && <span className="muted">impl <code>{impl}</code></span>}</span>
          ))}
          {envBlock && <><pre className="deploy__env">{envBlock}</pre><Copy text={envBlock} label="copy all as env" /></>}
          <span className="muted">these are the PROXY addresses: the app always uses those, and they never change on an upgrade. the impl addresses are for the record only. paste the env lines into the backend and frontend services on Railway. the private keys stay with you and never go here.</span>
        </div>
        <details className="card deploy__verify">
          <summary><b>Verification</b> <span className="muted">implementation + proxy addresses for Blockscout</span></summary>
          {(['wifly', 'names', 'glyphs', 'badges', 'dca'] as Upg[]).map(c => (
            <div key={c} className="deploy__vrow">
              <b>{LABEL[c]}</b>
              <span className="deploy__addr"><span className="muted">implementation</span><code>{a[`${c}Impl`] ?? '—'}</code>{a[`${c}Impl`] && <Copy text={a[`${c}Impl`]!} />}{saved.tx[`${c}Impl`] && <a className="muted" href={`${EXPLORER}/tx/${saved.tx[`${c}Impl`]}`} target="_blank" rel="noreferrer">tx</a>}</span>
              <span className="deploy__addr"><span className="muted">proxy</span><code>{a[c] ?? '—'}</code>{a[c] && <Copy text={a[c]!} />}{saved.tx[c] && <a className="muted" href={`${EXPLORER}/tx/${saved.tx[c]}`} target="_blank" rel="noreferrer">tx</a>}</span>
              {proxyArgs(c) && <span className="deploy__addr"><span className="muted">proxy constructor args</span><code className="deploy__long">{proxyArgs(c)}</code><Copy text={proxyArgs(c)!} /></span>}
            </div>
          ))}
          <div className="deploy__vrow"><b>WiflyNameRenderer</b><span className="deploy__addr"><span className="muted">address</span><code>{a.renderer ?? '—'}</code>{a.renderer && <Copy text={a.renderer} />}</span></div>
          <span className="muted">on Blockscout, verify each implementation as its contract from contracts/src (no constructor args), and each proxy as OpenZeppelin ERC1967Proxy with the constructor args above, then mark it as a proxy. compiler: solc 0.8.28, optimizer on, 200 runs, evm cancun (contracts/foundry.toml).</span>
          <div className="cmp-row"><button className="btn btn--dark btn--sm" disabled={!anyDeployed} onClick={download}>download deployments.json</button><Copy text={deploymentsJson} label="copy JSON" /></div>
        </details>
        {(a.wiflyImpl || a.wifly) && <button className="btn btn--ghost btn--sm" onClick={() => { void (async () => { if (await confirmIn({ title: 'clear saved progress?', hint: 'the contracts stay deployed.', confirmLabel: 'clear', cancelLabel: 'keep' })) setSaved({ addr: {}, tx: {} }) })() }}>clear saved progress</button>}
      </div>
    </>
  )
}
