/** Settings bento — tile dashboard → focused sheets (speed.12.3 ship). */
import { useMemo } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { formatUnits } from 'viem'
import { Icon, type IconName } from '../../components/Icon'
import { Mascot } from '../../components/Mascot'
import { Sheet } from '../../sheets/Sheets'
import { useBalances } from '../../components/WalletsSection'
import { shortAddr } from '../../lib/format'
import {
  AccountPanel, AccountsPanel, AppearancePanel, ProfilePanel, TipsPanel, WalletsPanel, WifPanel,
} from './Panels'
import type { Panel, useSettingsModel } from './model'

type M = ReturnType<typeof useSettingsModel>

type Tile = {
  id: Exclude<Panel, null>
  icon: IconName
  label: string
  wide?: boolean
  tall?: boolean
  neon?: boolean
}

const tiles: Tile[] = [
  { id: 'profile', icon: 'user', label: 'profile', wide: true, neon: true },
  { id: 'wif', icon: 'sparkle', label: '.wif' },
  { id: 'appearance', icon: 'sun', label: 'look' },
  { id: 'wallets', icon: 'wallet', label: 'wallets', tall: true },
  { id: 'accounts', icon: 'link', label: 'accounts' },
  { id: 'tips', icon: 'tip', label: 'tips' },
  { id: 'account', icon: 'lock', label: 'account', wide: true },
]

const fmt = (v: bigint | undefined, max = 2) =>
  v === undefined ? '…' : Number(formatUnits(v, 18)).toLocaleString('en-US', { maximumFractionDigits: max })

function tileSub(id: Exclude<Panel, null>, m: M): string {
  switch (id) {
    case 'profile': return m.name.trim() || `@${m.me?.handle ?? ''}`
    case 'wif': return m.wif ? `${m.wif}.wif` : 'claim'
    case 'appearance': return 'theme'
    case 'wallets': return 'balances'
    case 'accounts': return 'linked'
    case 'tips': return 'payout'
    case 'account': return 'sign out'
  }
}


function TileButton({ t, i, m, avatar, main, b, onOpen }: {
  t: Tile; i: number; m: M; avatar: string | null; main?: { address: string }; b?: { wif?: bigint; eth?: bigint }
  onOpen: (id: Exclude<Panel, null>) => void
}) {
  return (
    <motion.button
      key={t.id}
      type="button"
      className={`sc-tile ${t.wide ? 'sc-tile--wide' : ''} ${t.tall ? 'sc-tile--tall' : ''} ${t.neon ? 'sc-tile--neon' : ''}`}
      data-testid={`sc-tile-${t.id}`}
      onClick={() => onOpen(t.id)}
      whileTap={{ scale: 0.97 }}
      whileHover={{ y: -2 }}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: i * 0.03, type: 'spring', stiffness: 320, damping: 22 }}
    >
      {t.id === 'profile' ? (
        <span className="sc-tile__face" aria-hidden="true">
          {avatar ? <img src={avatar} alt="" /> : <Mascot size={36} />}
        </span>
      ) : (
        <span className="sc-tile__ico"><Icon name={t.icon} size={20} /></span>
      )}
      <span className="sc-tile__copy">
        <span className="sc-tile__lab">{t.label}</span>
        <span className="sc-tile__sub">{tileSub(t.id, m)}</span>
      </span>
      {t.id === 'appearance' && (
        <span className="sc-tile__swatches" aria-hidden="true">
          <i className="sc-swatch sc-swatch--light" /><i className="sc-swatch sc-swatch--auto" /><i className="sc-swatch sc-swatch--dark" />
        </span>
      )}
      {t.id === 'wallets' && (
        <span className="sc-tile__wal" aria-hidden="true">
          {main ? (
            <>
              <span className="sc-tile__chip mono">{shortAddr(main.address)}</span>
              <span className="sc-tile__bals">
                <span><b className="num">{fmt(b?.wif, 2)}</b> wif</span>
                <span><b className="num">{fmt(b?.eth, 4)}</b> eth</span>
              </span>
            </>
          ) : (
            <span className="sc-tile__chip">link a wallet</span>
          )}
        </span>
      )}
    </motion.button>
  )
}

export function SettingsBento({ m }: { m: M }) {
  const { me, panel, setPanel, avatar, wif } = m
  const list = useMemo(() => me?.links?.walletList ?? [], [me?.links?.walletList])
  const main = list.find(w => w.main) ?? list[0]
  const bal = useBalances(main ? [main.address] : [])
  const b = main ? bal.data?.[main.address] : undefined
  if (!me) return null

  const titles: Record<Exclude<Panel, null>, string> = {
    profile: 'profile', wif: '.wif name', accounts: 'accounts', wallets: 'wallets',
    tips: 'tips', appearance: 'appearance', account: 'account',
  }

  return (
    <div className="sc sc--b" data-testid="settings-bento">
      <header className="sc-bento__hi">
        <span className="sc-bento__face" aria-hidden="true">
          {avatar ? <img src={avatar} alt="" /> : <Mascot size={40} />}
        </span>
        <div>
          <p className="sc-bento__hi-name">{m.name.trim() || me.handle}</p>
          <p className="mono tiny muted">@{me.handle}{wif ? ` · ${wif}.wif` : ''}</p>
        </div>
      </header>

      <div className="sc-bento">
        {tiles.map((t, i) => {
          if (t.id === 'tips') return null
          if (t.id === 'wallets') {
            const tips = tiles.find(x => x.id === 'tips')
            return (
              <div className="sc-group" key="wallets-tips" data-testid="settings-wallets-tips">
                <TileButton t={t} i={i} m={m} avatar={avatar ?? null} main={main} b={b} onOpen={setPanel} />
                {tips && <TileButton t={tips} i={i + 1} m={m} avatar={avatar ?? null} main={main} b={b} onOpen={setPanel} />}
              </div>
            )
          }
          return <TileButton key={t.id} t={t} i={i} m={m} avatar={avatar ?? null} main={main} b={b} onOpen={setPanel} />
        })}
      </div>

      <AnimatePresence>
        {panel && (
          <Sheet title={titles[panel]} onClose={() => setPanel(null)} className="sc-sheet">
            {panel === 'profile' && <ProfilePanel m={m} />}
            {panel === 'wif' && <WifPanel m={m} />}
            {panel === 'accounts' && <AccountsPanel m={m} />}
            {panel === 'wallets' && <WalletsPanel />}
            {panel === 'tips' && <TipsPanel />}
            {panel === 'appearance' && <AppearancePanel />}
            {panel === 'account' && <AccountPanel m={m} />}
          </Sheet>
        )}
      </AnimatePresence>
    </div>
  )
}

/** @deprecated alias kept so any leftover imports still resolve during the cutover */
export const ConceptB = SettingsBento
