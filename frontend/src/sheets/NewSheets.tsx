/** Burn-for-badges and subscription tiers. */
import { motion, useReducedMotion } from 'motion/react'
import { companion } from '../lib/companion'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { useSession } from '../api/session'
import { BADGE_LEVELS, LIVE } from '../config'
import { plans, useSendPlan } from '../lib/wifly'
import { useStore } from '../state/store'
import { WifAmount, WifUsd } from '../components/Bits'
import { BadgeArt } from '../components/Badges'
import { METALS } from '../lib/medal'
import { CoinRain } from '../components/CoinRain'
import { Icon } from '../components/Icon'
import { LowBalance } from '../components/Swap'
import { TxSteps } from '../components/TxSteps'
import { AmountPicker, Sheet, useAction } from './Sheets'

export type BadgeView = { burned: number; pending: number; tiers: { id: string; name: string; min: number; earned: boolean }[]; top: string | null; next: { id: string; name: string; min: number; left: number } | null }

export function useBadges(handle?: string) {
  return useQuery({ queryKey: ['badges', handle], enabled: !!handle, queryFn: () => api<BadgeView>(`/badges/${handle}`) })
}

/**
 * Burn WIF for soulbound badges (WiflyBadges.burn). Burned WIF is gone for good. Live: the badge reveal only plays after
 * the receipt says success (confirm-before-animate). Payments off: nothing is sent.
 */
export function BurnSheet({ amount: initial }: { amount?: number }) {
  const { closeSheet, toast } = useStore()
  const { me } = useSession()
  const qc = useQueryClient()
  const b = useBadges(me?.handle ?? 'you').data
  const burned = b?.burned ?? 0
  const next = BADGE_LEVELS.find(l => l.min > burned)
  const [amount, setAmount] = useState(initial ?? (next ? next.min - burned : 1000))
  const [step, setStep] = useState<'pick' | 'confirm'>('pick')
  const [ok, setOk] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'burning' | 'done'>('idle')
  const reduced = useReducedMotion()
  const { run, busy } = useAction()
  const after = burned + amount
  const unlocks = BADGE_LEVELS.filter(l => l.min > burned && l.min <= after)
  const target = unlocks[unlocks.length - 1] ?? next ?? BADGE_LEVELS[BADGE_LEVELS.length - 1]

  const confirm = async () => {
    setPhase('burning')
    const celebrate = async () => { setPhase('done'); companion.celebrate('burn', `${amount.toLocaleString()} WIF burned`); await new Promise(r => setTimeout(r, reduced ? 400 : 1800)) }
    // record the confirmed burn with its tx hash; the api checks the BurnedForBadges event before it counts
    const onConfirmed = (txHash: string) => { api('/badges/burns', { method: 'POST', json: { amount, txHash } }).then(() => qc.invalidateQueries({ queryKey: ['badges'] })).catch(() => toast('burn confirmed', 'your badges update in a minute')) }
    const r = await run(plans.burn(amount), `burned ${amount.toLocaleString()} WIF`, () => { qc.invalidateQueries({ queryKey: ['badges'] }) }, { celebrate, onConfirmed })
    if (!r) setPhase('idle')
  }

  if (step === 'confirm' || phase !== 'idle') return (
    <Sheet title="confirm burn" onClose={closeSheet}
      footer={<>
        <TxSteps pull={amount} action={`burn ${amount.toLocaleString()} WIF`} />
        <label className="check"><input type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} /> burned WIF is gone for good</label>
        <div className="row-gap">
          <button className="btn btn--ghost" disabled={phase !== 'idle'} onClick={() => setStep('pick')}>back</button>
          <button className="btn btn--dark btn--block btn--lg" disabled={!amount || !ok || busy || phase !== 'idle'} onClick={confirm}>
            {phase === 'burning' ? 'waiting for confirmation…' : phase === 'done' ? 'done' : `burn ${amount.toLocaleString()} WIF`}
          </button>
        </div>
      </>}>
      {phase === 'done' && <CoinRain count={10} />}
      <div className="burnconfirm">
        <motion.div initial={false} animate={phase === 'done' ? { scale: [1, 1.08, 1] } : {}} transition={{ duration: 0.6 }}>
          <BadgeArt id={target.id} size={120} earned={phase === 'done' || unlocks.length > 0} />
        </motion.div>
        <div className="burnconfirm__amt"><WifAmount value={amount} /><span className="muted small"><WifUsd wif={amount} /></span></div>
        <dl className="names-fee">
          <div><dt>you get</dt><dd>{unlocks.length ? unlocks.map(u => u.name).join(' + ') : 'progress toward ' + target.name}</dd></div>
          <div><dt>total burned after</dt><dd className="num">{after.toLocaleString()} WIF</dd></div>
          <div><dt>badge</dt><dd>stays with your wallet</dd></div>
        </dl>
      </div>
    </Sheet>
  )

  return (
    <Sheet title="burn to earn" onClose={closeSheet}
      footer={<button className="btn btn--dark btn--block btn--lg" disabled={!amount} onClick={() => setStep('confirm')}>continue</button>}>
      <div className="burn-hero">
        <BadgeArt id={target.id} size={96} earned={unlocks.length > 0} />
        <b className="burn-hero__name">{unlocks.length ? `unlocks ${target.name}` : `${(target.min - after).toLocaleString()} WIF more for ${target.name}`}</b>
      </div>
      <AmountPicker value={amount} onChange={setAmount} presets={[1_000, 10_000, 100_000, 1_000_000]} />
      <LowBalance need={amount} what="this burn" />
      <div className="burn-levels">
        {BADGE_LEVELS.map(l => {
          const have = burned >= l.min, will = !have && after >= l.min
          return (
            <div key={l.id} className={`burn-level ${have ? 'is-have' : will ? 'is-will' : ''}`}>
              <BadgeArt id={l.id} size={44} earned={have || will} tilt={false} />
              <div><b>{l.name}</b><div className="muted small num">{l.min.toLocaleString()} WIF</div></div>
              <span className="small">{have ? 'earned' : will ? 'unlocks' : `${(l.min - burned).toLocaleString()} to go`}</span>
            </div>
          )
        })}
      </div>
      <p className="muted small">burned so far: <b className="num">{burned.toLocaleString()} WIF</b> (<WifUsd wif={burned} />)</p>
    </Sheet>
  )
}

/** One badge up close: the medal, what it takes, who holds it and progress. */
export function BadgeSheet({ id, handle }: { id: string; handle?: string }) {
  const { closeSheet, openSheet } = useStore()
  const { me } = useSession()
  const t = BADGE_LEVELS.find(l => l.id === id) ?? BADGE_LEVELS[0]
  const who = handle ?? me?.handle
  const b = useBadges(who).data
  const burned = b?.burned ?? 0
  const earned = burned >= t.min
  const mine = !!me && who === me.handle
  const pct = Math.min(100, (burned / t.min) * 100)
  return (
    <Sheet title={t.name} onClose={closeSheet}
      footer={mine && !earned ? <button className="btn btn--dark btn--block btn--lg" onClick={() => openSheet({ type: 'burn', amount: t.min - burned })}>burn {(t.min - burned).toLocaleString()} WIF to earn it</button> : undefined}>
      <div className="badgesheet">
        <BadgeArt id={t.id} size={168} earned={earned} />
        <div className="badgesheet__amt num">{t.min.toLocaleString()} WIF burned</div>
        <p className="muted small">{earned ? (mine ? 'you earned this one.' : `@${who} earned this one.`) : mine ? `${(t.min - burned).toLocaleString()} WIF to go.` : 'not earned yet.'}</p>
        {!earned && <div className="bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>}
        <dl className="names-fee">
          <div><dt>material</dt><dd>{METALS[t.id]?.material}</dd></div>
          <div><dt>tier</dt><dd>{BADGE_LEVELS.indexOf(t) + 1} of {BADGE_LEVELS.length}</dd></div>
          <div><dt>moves</dt><dd>never: it stays with the wallet</dd></div>
        </dl>
      </div>
    </Sheet>
  )
}

type TierDraft = { name: string; price: number; perks: string }

/** Set up to 3 subscription tiers. Saved to your profile; live, each price is also set onchain (setTier / setYearlyPrice). */
export function TiersSheet() {
  const { closeSheet, toast } = useStore()
  const { me, refresh } = useSession()
  const send = useSendPlan()
  const start = ((me as unknown as { tiers?: { name: string; price: number; perks?: string[] }[] })?.tiers ?? [])
  const [tiers, setTiers] = useState<TierDraft[]>(start.length ? start.map(t => ({ name: t.name, price: t.price, perks: (t.perks ?? []).join('\n') })) : [
    { name: 'supporter', price: 100, perks: 'supporters-only drops\nyour name in the credits' },
  ])
  const [yearly, setYearly] = useState(true)
  const [busy, setBusy] = useState(false)
  const set = (i: number, k: keyof TierDraft, v: string | number) => setTiers(ts => ts.map((t, j) => (j === i ? { ...t, [k]: v } : t)))
  const bad = tiers.some(t => !t.name.trim() || t.price <= 0) || tiers.some((t, i) => i > 0 && t.price <= tiers[i - 1].price)

  const save = async () => {
    setBusy(true)
    try {
      await api('/me/tiers', { method: 'PUT', json: { tiers: tiers.map(t => ({ name: t.name.trim(), price: t.price, perks: t.perks.split('\n').map(p => p.trim()).filter(Boolean) })) } })
      refresh()
      if (LIVE) {
        for (const [i, t] of tiers.entries()) {
          const r = await send(plans.setTier(i, t.price)); if (!r.sent) { toast('saved, but not onchain yet', r.reason); break }
          if (yearly) await send(plans.setYearlyPrice(i, t.price * 10))
        }
      }
      closeSheet(); toast('tiers saved', LIVE ? 'prices set onchain' : 'prices are saved to your profile. nothing was sent')
    } catch (e) { toast('couldn’t save tiers', (e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Sheet title="subscription tiers" onClose={closeSheet}
      footer={<>
        <TxSteps pull={0} action={`set ${tiers.length} tier price${tiers.length > 1 ? 's' : ''}`} />
        <button className="btn btn--dark btn--block btn--lg" disabled={bad || busy} onClick={save}>{busy ? 'saving…' : 'save tiers'}</button>
      </>}>
      <p className="muted small">fans pay monthly in $WIF. each tier costs more than the one before; supporters-only drops can be locked to any tier.</p>
      {tiers.map((t, i) => (
        <div key={i} className="tier-edit">
          <div className="tier-edit__head"><b>tier {i + 1}</b>{tiers.length > 1 && <button className="icon-btn" aria-label="remove tier" onClick={() => setTiers(ts => ts.filter((_, j) => j !== i))}><Icon name="close" size={16} /></button>}</div>
          <label className="field"><span className="field__label">name</span><span className="field__input"><input value={t.name} maxLength={24} onChange={e => set(i, 'name', e.target.value)} /></span></label>
          <label className="field"><span className="field__label">monthly price</span>
            <span className="field__input"><input inputMode="decimal" value={t.price || ''} onChange={e => set(i, 'price', Number(e.target.value.replace(/[^0-9.]/g, '')) || 0)} /><span className="muted">WIF</span></span>
          </label>
          <div className="tier-edit__price"><WifAmount value={t.price} />{yearly && <span className="muted small">· yearly {(t.price * 10).toLocaleString()} WIF (2 months free)</span>}</div>
          <label className="field"><span className="field__label">perks <span className="muted">· one per line</span></span><textarea className="field__area" rows={2} value={t.perks} onChange={e => set(i, 'perks', e.target.value)} /></label>
        </div>
      ))}
      {tiers.length < 3 && <button className="btn btn--ghost btn--block" onClick={() => setTiers(ts => [...ts, { name: ts.length === 1 ? 'insider' : 'inner circle', price: (ts.at(-1)?.price ?? 100) * 3, perks: '' }])}><Icon name="plus" size={16} /> add a tier</button>}
      <label className="check"><input type="checkbox" checked={yearly} onChange={e => setYearly(e.target.checked)} /> offer a yearly plan at 10× monthly</label>
      {bad && <p className="error small">every tier needs a name and a price higher than the tier before it.</p>}
    </Sheet>
  )
}
