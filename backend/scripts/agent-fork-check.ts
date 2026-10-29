// agent spending check on an anvil fork of chain 4663 (throwaway keys only, never a real key):
//   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8611
//   (user: setAgent(agent, 100 wif) + deposit first, see NOTES) then
//   RPC_URL=http://127.0.0.1:8611 AGENT_PRIVATE_KEY=<anvil key> KEEPER_PRIVATE_KEY=<same anvil key> npx tsx scripts/agent-fork-check.ts <user> <creator>
// The agent and keeper share one key: both sends go out at once and must get distinct nonces.
import { createPublicClient, encodeFunctionData, http, parseAbi, parseEther, type Address } from 'viem'
import { robinhoodChain } from '../src/chain'
import { loadAgentSigner, loadKeeperSigner, envSigner } from '../src/agent/signer'

const W = (process.env.WIFLY_CONTRACT_ADDRESS || '0x1eeB081a4529A2905Ea888948185ADa66c0619F5') as Address
const [user, creator] = process.argv.slice(2) as [Address, Address]
const abi = parseAbi(['function tipFor(address user, address creator, uint256 amount, bytes32 postId)', 'function agentRemaining(address) view returns (uint256)'])
const pc = createPublicClient({ chain: robinhoodChain, transport: http(process.env.RPC_URL) })
const tip = (wif: string) => encodeFunctionData({ abi, functionName: 'tipFor', args: [user, creator, parseEther(wif), `0x${'0'.repeat(64)}`] })

const agent = loadAgentSigner()!, keeper = loadKeeperSigner()!, attesterLike = envSigner('AGENT_PRIVATE_KEY', 'third')!
if (agent.address !== keeper.address) throw new Error('expected one shared key')
console.log('agent', agent.address, 'remaining', (await pc.readContract({ address: W, abi, functionName: 'agentRemaining', args: [user] })) / 10n ** 18n)
// 1) three sends at once from the same key through three signer objects: agent tip 60, keeper no-op, another no-op
const hs = await Promise.all([agent.send(W, tip('60')), keeper.send(agent.address, '0x'), attesterLike.send(agent.address, '0x')])
const rs = await Promise.all(hs.map(hash => pc.waitForTransactionReceipt({ hash })))
const txs = await Promise.all(hs.map(hash => pc.getTransaction({ hash })))
console.log('concurrent sends', rs.map(r => r.status).join(','), 'nonces', txs.map(t => t.nonce).join(','), 'tip gas', rs[0].gasUsed, 'gasPrice', rs[0].effectiveGasPrice)
console.log('remaining after 60', (await pc.readContract({ address: W, abi, functionName: 'agentRemaining', args: [user] })) / 10n ** 18n)
// 2) over the cap: 50 more (60 + 50 > 100) must revert
try { await agent.send(W, tip('50')); console.log('OVER-CAP DID NOT REVERT') } catch (e) { console.log('over cap reverted:', /AgentCapExceeded|0x[0-9a-f]{8}/.exec(String((e as Error).message))?.[0] ?? (e as Error).message.slice(0, 120)) }
// 3) still fine under the cap: 40 more = exactly 100
const h = await agent.send(W, tip('40')); console.log('tip 40 ->', (await pc.waitForTransactionReceipt({ hash: h })).status)
console.log('remaining', (await pc.readContract({ address: W, abi, functionName: 'agentRemaining', args: [user] })) / 10n ** 18n)
