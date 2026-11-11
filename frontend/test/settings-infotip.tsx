import { createRoot } from 'react-dom/client'
import { InfoTip } from '../src/components/InfoTip'

const TIPS = [
  { title: '.wif name', label: 'about .wif names', body: 'holding a .wif makes it your name here.' },
  { title: 'accounts', label: 'about linked accounts', body: 'link x or a wallet to sign in from anywhere.' },
  { title: 'wallets', label: 'about wallets', body: 'main shows on your profile. tips go to the receiving one.' },
  { title: 'tips', label: 'about the tip destination', body: 'tips go to this wallet. changing it needs a signature.' },
] as const

function App() {
  return (
    <main className="wrap" data-testid="settings-stage">
      <div className="sc sc--b">
        <div className="sc-bento" aria-hidden="true">
          <button type="button" className="sc-tile sc-tile--wide sc-tile--neon"><span className="sc-tile__lab">profile</span><span className="sc-tile__sub">kai</span></button>
          <button type="button" className="sc-tile"><span className="sc-tile__lab">.wif</span><span className="sc-tile__sub">claim</span></button>
          <button type="button" className="sc-tile"><span className="sc-tile__lab">look</span><span className="sc-tile__sub">theme</span></button>
        </div>
      </div>
      {TIPS.map(t => (
        <section className="sc-panel" key={t.label}>
          <div className="sc-panel__head">
            <span>{t.title}</span>
            <InfoTip label={t.label}>{t.body}</InfoTip>
          </div>
          <div className="card" style={{ padding: 16, minHeight: 88 }}>
            <b>row under the tip</b>
            <p className="muted small">sits below so a misplaced pop is obvious</p>
          </div>
        </section>
      ))}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
