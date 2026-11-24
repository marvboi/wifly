import { useQuery } from '@tanstack/react-query'
import { USDG_TOKEN } from '../config'
import { api } from './client'

export type PayRailsConfig = { usdgConfigured: boolean; paymentsLive: boolean }

export function usePayRails() {
  const q = useQuery({
    queryKey: ['config-pay'],
    queryFn: () => api<{ usdgConfigured?: boolean; paymentsLive?: boolean }>('/config'),
    staleTime: 60_000,
  })
  const rails: PayRailsConfig = {
    usdgConfigured: q.data?.usdgConfigured ?? !!USDG_TOKEN,
    paymentsLive: q.data?.paymentsLive ?? !!USDG_TOKEN,
  }
  return { rails, loading: q.isLoading }
}