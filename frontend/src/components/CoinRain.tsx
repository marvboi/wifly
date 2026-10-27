import { motion, useReducedMotion } from 'motion/react'
import { useMemo } from 'react'

/** Falling $WIF coins (the official /brand/wif-coin-256.png). Only mounted after a receipt says success. */
export function CoinRain({ count = 14, onDone }: { count?: number; onDone?: () => void }) {
  const reduced = useReducedMotion()
  const coins = useMemo(() => Array.from({ length: reduced ? 4 : count }, (_, i) => ({
    x: 6 + ((i * 37) % 88), size: 22 + ((i * 13) % 22), delay: (i % 7) * 0.07, rot: ((i * 53) % 120) - 60, dur: 1.1 + ((i * 7) % 5) / 10,
  })), [count, reduced])
  return (
    <div className="coinrain" aria-hidden="true">
      {coins.map((c, i) => (
        <motion.img key={i} src="/brand/wif-coin-256.png" alt="" width={c.size} height={c.size} className="coinrain__coin"
          style={{ left: `${c.x}%` }}
          initial={{ y: -60, opacity: 0, rotate: 0 }}
          animate={{ y: reduced ? 0 : 420, opacity: [0, 1, 1, 0], rotate: c.rot }}
          transition={{ duration: reduced ? 0.6 : c.dur, delay: c.delay, ease: [0.3, 0, 0.7, 1] }}
          onAnimationComplete={i === coins.length - 1 ? onDone : undefined} />
      ))}
    </div>
  )
}
