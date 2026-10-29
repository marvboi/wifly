/** /swap: get $WIF. Just the swap card. */
import { Link } from 'react-router-dom'
import { PageHead } from '../components/Shell'
import { SwapPanel } from '../components/Swap'

export default function GetWif() {
  return (
    <>
      <PageHead title="get $wif" />
      <div className="getwif"><SwapPanel /><Link className="getwif__dca" to="/dca">buy wif on a schedule</Link></div>
    </>
  )
}
