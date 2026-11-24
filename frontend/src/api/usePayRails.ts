import { useQuery } from '@tanstack/react-query'
import { api } from './client'

export type PayRailsConfig = { usdgConfigured: boolean; paymentsLive: boolean }

export function usePayRails() {
  const q = useQuery({
    queryKey: ['config-pay'],
    queryFn: () => api<{ usdgConfigured?: boolean; paymentsLive?: boolean }>('/config'),
    staleTime: 60_000,
  })
  const rails: PayRailsConfig = {
    usdgConfigured: !!q.data?.usdgConfigured,
    paymentsLive: !!q.data?.paymentsLive,
  }
  return { rails, loading: q.isLoading }
}