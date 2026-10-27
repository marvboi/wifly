/**
 * Name card art, produced by the onchain WiflyNameRenderer itself.
 * - Deployed: NAMES_RENDERER_ADDRESS set -> renderer.svg(name, rare, reserved, theme) read from chain.
 * - Card design C. theme: 0 = default (rare green, others white), 1 = white, 2 = green (WiflyNames.theme(id)).
 * - Not deployed yet: the same compiled runtime bytecode (contracts/out -> renderer.json) runs in an in-process EVM,
 *   so the preview is byte-for-byte what tokenURI will return once deployed. No keys, no network.
 */
import { Lru } from '../lru'
import { createEVM } from '@ethereumjs/evm'
import { createAddressFromString, hexToBytes } from '@ethereumjs/util'
import { decodeFunctionResult, encodeFunctionData, type Hex } from 'viem'
import art from './renderer.json' with { type: 'json' }

const GLYPHS = '0x00000000000000000000000000000000006c7970'
const RENDERER = '0x0000000000000000000000000000000000617274'
const abi = art.abi as readonly unknown[] as typeof SVG_ABI
const SVG_ABI = [{ type: 'function', name: 'svg', stateMutability: 'view', inputs: [{ name: 'name', type: 'string' }, { name: 'rare', type: 'bool' }, { name: 'reserved', type: 'bool' }, { name: 'theme', type: 'uint8' }], outputs: [{ name: '', type: 'string' }] }] as const
export const MAX_THEME = 2
export const defaultTheme = (rare: boolean) => (rare ? 2 : 1) // what theme 0 looks like

let evmP: ReturnType<typeof boot> | null = null
async function boot() {
  const evm = await createEVM()
  let code = art.renderer.slice(2)
  const word = GLYPHS.slice(2).padStart(64, '0') // immutable `glyphs` is an address left-padded to 32 bytes
  for (const ref of art.rendererImmutables) code = code.slice(0, ref.start * 2) + word + code.slice((ref.start + ref.length) * 2)
  await evm.stateManager.putCode(createAddressFromString(GLYPHS), hexToBytes(art.glyphs as Hex))
  await evm.stateManager.putCode(createAddressFromString(RENDERER), hexToBytes(`0x${code}`))
  return evm
}

/** Rendered SVGs never change for a key, so no expiry; just bounded. */
const cache = new Lru<string, string>({ max: 2000, maxBytes: 32 * 1024 * 1024, size: v => v.length * 2 })
export async function renderNameSvg(name: string, rare: boolean, reserved: boolean, read?: (data: Hex) => Promise<Hex>, theme = 0): Promise<string> {
  if (!Number.isInteger(theme) || theme < 0 || theme > MAX_THEME) theme = 0
  const key = `${name}|${+rare}|${+reserved}|${theme}|${read ? 'chain' : 'local'}`
  const hit = cache.get(key); if (hit) return hit
  const data = encodeFunctionData({ abi: SVG_ABI, functionName: 'svg', args: [name, rare, reserved, theme] })
  let ret: Hex
  if (read) ret = await read(data)
  else {
    const evm = await (evmP ??= boot())
    const r = await evm.runCall({ to: createAddressFromString(RENDERER), data: hexToBytes(data), gasLimit: 200_000_000n })
    if (r.execResult.exceptionError) throw new Error('renderer reverted')
    ret = `0x${Buffer.from(r.execResult.returnValue).toString('hex')}`
  }
  const svg = decodeFunctionResult({ abi: SVG_ABI, functionName: 'svg', data: ret }) as string
  if (cache.size > 2000) cache.delete(cache.keys().next().value!)
  cache.set(key, svg)
  return svg
}
void abi

/** Preview of a name nobody holds yet: drops the renderer's short token id line (bottom left, "0x1234..abcd")
 *  so an unclaimed card never reads like an owner's address. Claimed names keep tokenURI's bytes exactly. */
export const unclaimedPreview = (svg: string) => svg.replace(/<g transform="translate\(96 912\)[^"]*"[^>]*>(?:<use [^>]*\/>)*<\/g>/, '')
