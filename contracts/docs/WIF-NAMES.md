# WIF Names (.wif) — integration note

`.wif` names are ERC-721 tokens in the **WiflyNames** contract ("WIF Names", `WIFNAME`) on **Robinhood Chain (4663)**.
Any app in the WIF ecosystem can resolve them with plain view calls: no API, no keys, no off-chain gateway.

- Contract: `WIF_NAMES = 0x…` (fill in after deploy). This is a **UUPS proxy** (ERC-1967): always integrate against
  the proxy address the deploy script prints, never the implementation. The address stays the same across upgrades;
  the read/write ABI below is unchanged (new versions may only add functions). Listen for `Upgraded(address)` if you
  cache code or ABIs.
- Names: `<label>.wif`, label = 3-20 bytes of `[a-z0-9_]`, lowercase only. Every lookup accepts `marv` or `marv.wif`.
  Lowercase and trim user input before calling (the contract does not case-fold: `Marv.wif` resolves to nothing).
- `tokenId = uint256(keccak256(label))` (label without `.wif`). Not ENS namehash.
- Unclaimed or invalid names resolve to `0x0000…0000` / `""`; the calls never revert.

## name.wif → address

```ts
import { createPublicClient, http, parseAbi, zeroAddress } from 'viem'

const client = createPublicClient({ transport: http(process.env.RH_RPC_URL) }) // Robinhood Chain 4663
const abi = parseAbi([
  'function resolve(string fullName) view returns (address)',
  'function reverseName(address account) view returns (string)',
  'function text(string name, string key) view returns (string)',
])

const addr = await client.readContract({
  address: WIF_NAMES, abi, functionName: 'resolve',
  args: ['marv.wif'.trim().toLowerCase()],
})
if (addr === zeroAddress) throw new Error('marv.wif is not registered')
```

`resolve` returns the address the owner set with `setAddr`, or the **owner** if none is set.

## address → name.wif

```ts
const name = await client.readContract({
  address: WIF_NAMES, abi, functionName: 'reverseName', args: [account],
}) // "marv.wif" or "" (no verified primary name)
```

`reverseName` is already verified on-chain: it returns the account's primary name only when that name
forward-resolves back to the same account, so it is safe to display as-is. (`nameOf(address)` returns the
bare, unverified primary label — don't display that.)

Profile records: `text(name, key)`. Suggested keys: `avatar` (https/ipfs/data URI), `x` (handle, no @),
`url`, `bio`, `description`. Values are at most 256 bytes; treat them as untrusted user input.

## Events to index

| Event | Meaning |
|---|---|
| `NameClaimed(uint256 indexed tokenId, string name, address indexed owner, uint256 fee)` | New name (bare label). `fee` is the full claim fee paid (split 50% treasury / 50% Wifly pot, no burn); `0` for team-reserved names. |
| `FeeSplit(uint256 treasuryAmount, uint256 potAmount, uint256 burnAmount)` | Emitted for every claim/sale fee. If `pot` is unset, `potAmount` went to the treasury. |
| `PotSet(address pot)` | Owner changed the community pot (the Wifly contract). |
| `Transfer(address indexed from, address indexed to, uint256 indexed tokenId)` | ERC-721 ownership (mints, transfers, sales). |
| `RecordsCleared(uint256 indexed tokenId, uint256 version)` | Emitted on every transfer: **drop all cached addr/text records** for the token. |
| `AddrChanged(uint256 indexed tokenId, address addr)` | Resolved address set (`0x0` = back to "resolves to owner"). |
| `TextChanged(uint256 indexed tokenId, string indexed indexedKey, string key, string value)` | Text record set (`""` = deleted). |
| `PrimarySet(address indexed account, uint256 indexed tokenId)` | Reverse name changed (`tokenId = 0` = none). Re-check with `reverseName`, since it also depends on `addr`. |
| `Listed` / `Delisted` / `Sold` | Built-in WIF marketplace. |
| `BatchMetadataUpdate(uint256, uint256)` | ERC-4906: art renderer changed, refresh all `tokenURI`s. |

Indexer rule of thumb: records for `tokenId` are valid only since its last `RecordsCleared` (or since mint).
When in doubt, read `addrOf(tokenId)` / `textOf(tokenId, key)` directly — the contract is the source of truth.

## Writing (owner of the token only)

`setAddr(tokenId, address)`, `setText(tokenId, key, value)`, `setPrimary(tokenId)`. Batch with
`multicall(bytes[])`, e.g. `claim("marv.wif")` + `setText(...)` in one transaction. Operators/approved
addresses cannot set records; records are wiped when the token moves.
