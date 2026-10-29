import { useState } from 'react'
import { shortAddr } from '../lib/format'
import { Icon } from './Icon'

/** The wallet that needs a little eth: short address + copy (11.8.5). */
export function GasWallet({ address }: { address: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(address) } catch { /* clipboard blocked: the address is still in the title */ }
    setCopied(true); window.setTimeout(() => setCopied(false), 1600)
  }
  return (
    <span className="gaswallet tiny" data-testid="gas-wallet">
      <span className="muted">wallet</span> <code className="mono" title={address}>{shortAddr(address)}</code>
      <button type="button" className="linkbtn gaswallet__copy" onClick={copy} aria-label="copy wallet address"><Icon name={copied ? 'check' : 'copy'} size={12} /> {copied ? 'copied' : 'copy'}</button>
    </span>
  )
}

/** An inline tx error: one calm, clamped line, plus the wallet when it's the gas case. Never raw text. */
export function TxErrorNote({ line, address, className = '' }: { line: string | null; address?: string | null; className?: string }) {
  if (!line) return null
  return (
    <div className={`txerr ${className}`} role="alert" data-testid="tx-error">
      <p className="txerr__line small">{line}</p>
      {address && <GasWallet address={address} />}
    </div>
  )
}
