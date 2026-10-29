import { useNeedsApprove } from '../lib/wifly'
import { PayingFrom } from './Payer'
import { Icon } from './Icon'

/**
 * What confirming will do, in plain words: allow the WIF first (an ERC-20 approve, only when needed), then the action.
 * `action` is user-facing copy. 11.8.7: the paying-from row sits full width above the steps, never inside the steps row.
 */
export function TxSteps({ pull, action, fromBalance = false, payer = true }: { pull: number; action: string; fromBalance?: boolean; payer?: boolean }) {
  const needsApprove = useNeedsApprove(fromBalance ? 0 : pull)
  const steps = (
    <div className="txsteps">
      <ol>
        {pull > 0 && !fromBalance && (
          <li className={needsApprove ? '' : 'is-done'}>
            <span className="txsteps__n">{needsApprove ? 1 : <Icon name="check" size={12} />}</span>
            allow {pull.toLocaleString('en-US', { maximumFractionDigits: 2 })} wif
          </li>
        )}
        <li><span className="txsteps__n">{pull > 0 && !fromBalance ? 2 : 1}</span>{action}</li>
      </ol>
    </div>
  )
  if (!payer) return steps
  return <div className="txblock" data-testid="txblock"><PayingFrom />{steps}</div>
}
