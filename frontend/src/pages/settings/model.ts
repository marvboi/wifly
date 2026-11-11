/** Shared settings state + actions for the bento settings page. */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { adoptUser, api, uploadAvatar } from '../../api/client'
import { useSession, type Login, type Me } from '../../api/session'
import { useStore } from '../../state/store'
import { FEED_PATH } from '../../lib/hosts'
import type { IconName } from '../../components/Icon'
import { userError } from '../../lib/txError'

export type Panel = 'profile' | 'wif' | 'accounts' | 'wallets' | 'tips' | 'appearance' | 'account' | null

export function useSettingsModel() {
  const { me, ready, setMe, signOut, login } = useSession()
  const { toast, openSheet } = useStore()
  const qc = useQueryClient()
  const nav = useNavigate()
  const [name, setName] = useState(me?.name ?? '')
  const [bio, setBio] = useState(me?.bio ?? '')
  const [avatar, setAvatar] = useState<string | null>(me?.avatar ?? null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [del, setDel] = useState(false)
  const [card, setCard] = useState(false)
  const [panel, setPanel] = useState<Panel>(null)
  const mine = useQuery({
    queryKey: ['names', 'mine', me?.handle],
    queryFn: () => api<{ usable: string | null; names: { name: string; theme: number; primary: boolean }[] }>('/names/mine'),
    enabled: !!me,
  })
  useEffect(() => { if (me) { setName(me.name ?? ''); setBio(me.bio ?? ''); setAvatar(me.avatar ?? null) } }, [me?.handle]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current) }, [])

  const dirty = !!me && (name.trim() !== (me.name ?? '') || bio.trim() !== (me.bio ?? '') || avatar !== (me.avatar ?? null))
  const wif = me?.wifName ?? null
  const usable = mine.data?.usable && mine.data.usable !== wif ? mine.data.usable : null
  const wifTheme = mine.data?.names.find(n => n.name === wif)?.theme

  const markSaved = () => {
    setSaved(true)
    if (savedTimer.current) clearTimeout(savedTimer.current)
    savedTimer.current = setTimeout(() => setSaved(false), 1800)
  }
  const save = async () => {
    if (!me) return
    setBusy(true)
    try {
      const r = await api<{ me: Me }>('/me', { method: 'PATCH', json: { name: name.trim(), bio: bio.trim(), ...(avatar !== (me.avatar ?? null) ? { avatar } : {}) } })
      adoptUser({ ...r.me, you: true }); setMe(r.me)
      void qc.invalidateQueries(); toast('saved'); markSaved()
    } catch (e) { toast('couldn’t save', userError(e)) } finally { setBusy(false) }
  }
  const pick = async (f: File) => {
    try { setAvatar(await uploadAvatar(f)); setSaved(false) } catch (e) { toast('couldn’t add that photo', userError(e)) }
  }
  const out = async () => {
    setBusy(true)
    try { await signOut(); nav(FEED_PATH, { replace: true }) } catch (e) { toast('couldn’t sign out', userError(e)) } finally { setBusy(false) }
  }
  const removeAvatar = () => { setAvatar(null); setSaved(false) }

  return {
    me, ready, login, toast, openSheet,
    name, setName, bio, setBio, avatar, setAvatar, removeAvatar,
    busy, saved, dirty, del, setDel, card, setCard, panel, setPanel,
    wif, usable, wifTheme, pick, save, out, markSaved,
  }
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-2)}`
export function loginLine(l: Login | null): string {
  if (!l) return 'signed in'
  switch (l.method) {
    case 'wallet': return l.address ? `wallet ${short(l.address.toLowerCase())}` : 'wallet'
    case 'guest': return 'guest key'
    case 'x': return `x · @${l.username}`
    case 'email': return 'email'
    default: return 'signed in'
  }
}
export function loginIcon(l: Login | null): IconName {
  return !l ? 'user' : l.method === 'wallet' || l.method === 'guest' ? 'wallet' : l.method === 'x' ? 'x' : l.method === 'email' ? 'mail' : 'user'
}
