import { useStore } from '../state/store'
import { Icon } from './Icon'
import { GasWallet } from './TxNote'
import { AnimatePresence, motion } from 'motion/react'

/** Toasts sit at the top, under the top bar, so they never cover a page's main button or the dock. */
export function Toasts() {
  const { toasts } = useStore()
  return (
    <div className="toasts" aria-live="polite">
      <AnimatePresence initial={false}>
      {toasts.map(t => (
        <motion.div key={t.id} layout className={`toast toast--${t.tone}`} role={t.tone === 'warn' ? 'alert' : 'status'}
          initial={{ opacity: 0, y: 18, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.97, transition: { duration: 0.16 } }}
          transition={{ type: 'spring', stiffness: 420, damping: 30 }}>
          <span className="toast__icon"><Icon name={t.tone === 'warn' ? 'info' : t.tone === 'info' ? 'info' : 'check'} size={16} /></span>
          <div className="toast__copy"><div className="strong">{t.title}</div>{t.body && <div className="small toast__body">{t.body}</div>}{t.copy && <GasWallet address={t.copy} />}</div>
        </motion.div>
      ))}
      </AnimatePresence>
    </div>
  )
}
