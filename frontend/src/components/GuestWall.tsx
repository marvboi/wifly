/** Logged-out preview end: a soft blurred fade of what comes next, then a calm "sign up to see more" card with the companion. */
import { motion } from 'motion/react'
import { useStore } from '../state/store'
import { Mascot } from './Mascot'

export function GuestWall({ line = 'there’s a lot more on wifly.' }: { line?: string }) {
  const { openSheet } = useStore()
  return (
    <div className="guestwall" aria-label="sign up to see more">
      <div className="guestwall__ghost" aria-hidden="true">
        {[0, 1, 2].map(i => (
          <div className="guestwall__row" key={i}><span className="skel skel--av" /><span className="skel skel--l1" /><span className="skel skel--l2" /></div>
        ))}
      </div>
      <motion.div className="guestwall__card card" initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
        transition={{ type: 'spring', stiffness: 260, damping: 28 }}>
        <Mascot size={64} mood="happy" />
        <h3>sign up to see more</h3>
        <p className="muted small">{line}</p>
        <button className="btn btn--dark btn--block" onClick={() => openSheet({ type: 'signin', reason: 'welcome to wifly' })}>sign up</button>
        <button className="btn btn--text" onClick={() => openSheet({ type: 'signin' })}>i already have an account</button>
      </motion.div>
    </div>
  )
}
