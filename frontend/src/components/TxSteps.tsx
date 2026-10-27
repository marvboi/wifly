import { useNeedsApprove } from '../lib/wifly'
import { Icon } from './Icon'

/** What confirming will do, in plain words: allow the WIF first (an ERC-20 approve, only when needed), then the action. `action` is user-facing copy. */
export function TxSteps({ pull, action, fromBalance = false }: { pull: number; action: string; fromBalance?: boolean }) {
  const needsApprove = useNeedsApprove(fromBalance ? 0 : pull)
  return (
    <div className="txsteps">
      <ol>
        {pull > 0 && !fromBalance && (
          <li className={needsApprove ? '' : 'is-done'}>
            <span className="txsteps__n">{needsApprove ? 1 : <Icon name="check" size={12} />}</span>
            allow {pull.toLocaleString('en-US', { maximumFractionDigits: 2 })} WIF
          </li>
        )}
        <li><span className="txsteps__n">{pull > 0 && !fromBalance ? 2 : 1}</span>{action}</li>
      </ol>
    </div>
  )
}
