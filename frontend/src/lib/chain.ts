import { erc20Abi, formatUnits, type Address } from 'viem'
import { useReadContract } from 'wagmi'
import { BURN_ADDRESS, robinhoodChain, WIF_DECIMALS, WIF_TOKEN } from '../config'

/** Real reads from Robinhood Chain. Read-only: nothing here signs or sends. */
export function useWifBalance(address?: Address) {
  const q = useReadContract({
    address: WIF_TOKEN, abi: erc20Abi, functionName: 'balanceOf', chainId: robinhoodChain.id,
    args: address ? [address] : undefined, query: { enabled: !!address, refetchInterval: 30_000 },
  })
  return { ...q, value: q.data !== undefined ? Number(formatUnits(q.data, WIF_DECIMALS)) : undefined }
}

export function useWifAtBurnAddress() {
  return useWifBalance(BURN_ADDRESS)
}

export function useWifSupply() {
  const q = useReadContract({ address: WIF_TOKEN, abi: erc20Abi, functionName: 'totalSupply', chainId: robinhoodChain.id })
  return { ...q, value: q.data !== undefined ? Number(formatUnits(q.data, WIF_DECIMALS)) : undefined }
}
