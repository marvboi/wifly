import { useEffect, useState } from 'react'
import { formatUnits, parseEther } from 'viem'
import { useBalance, usePublicClient } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { robinhoodChain, UNISWAP, WIF_DECIMALS } from '../config'

/**
 * Live read-only quote: ETH in, WIF out, through the Uniswap v4 WIF/ETH pool.
 * V4Quoter.quoteExactInputSingle is called with eth_call (simulate), so nothing is signed or sent.
 */
const quoterAbi = [{
  type: 'function', name: 'quoteExactInputSingle', stateMutability: 'nonpayable',
  inputs: [{
    name: 'params', type: 'tuple', components: [
      { name: 'poolKey', type: 'tuple', components: [
        { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
        { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
      ] },
      { name: 'zeroForOne', type: 'bool' }, { name: 'exactAmount', type: 'uint128' }, { name: 'hookData', type: 'bytes' },
    ],
  }],
  outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }],
}] as const

function useDebounced<T>(v: T, ms = 350) {
  const [d, setD] = useState(v)
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t) }, [v, ms])
  return d
}

export function useWifQuote(ethIn: number) {
  const client = usePublicClient({ chainId: robinhoodChain.id })
  const amount = useDebounced(ethIn)
  return useQuery({
    queryKey: ['wif-quote', amount],
    enabled: !!client && amount > 0,
    refetchInterval: 15_000,
    placeholderData: prev => prev,
    retry: 2,
    queryFn: async () => {
      // the api's shared quote cache first (one RPC call per amount every 20s for everyone); direct RPC only as a fallback
      const amt = amount.toFixed(18).replace(/\.?0+$/, '')
      const r = await fetch(`/api/swap/quote?dir=eth2wif&amount=${amt}`).then(r => r.ok ? r.json() as Promise<{ amountOut: string }> : null).catch(() => null)
      if (r?.amountOut) { const out = Number(formatUnits(BigInt(r.amountOut), WIF_DECIMALS)); return { wifOut: out, perEth: out / amount, at: Date.now() } }
      const exactAmount = parseEther(String(amount))
      const { result } = await client!.simulateContract({
        address: UNISWAP.v4Quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle',
        args: [{ poolKey: UNISWAP.poolKey, zeroForOne: true, exactAmount, hookData: '0x' }],
      })
      const out = Number(formatUnits(result[0], WIF_DECIMALS))
      return { wifOut: out, perEth: out / amount, at: Date.now() }
    },
  })
}

export function useEthBalance(address?: `0x${string}`) {
  const q = useBalance({ address, chainId: robinhoodChain.id, query: { enabled: !!address } })
  return q.data ? Number(formatUnits(q.data.value, 18)) : undefined
}
