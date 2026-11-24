/** /terms and /privacy: short legal pages in the same chrome as docs. */
import { useEffect, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Wordmark } from '../components/Bits'
import { Icon } from '../components/Icon'
import { ThemeToggle } from '../components/ThemeToggle'
import { LINKS } from '../config'
import { useThemedPage } from '../lib/theme'
import '../styles/docs.css'
import '../styles/legal.css'

type Section = { id: string; title: string; body: ReactNode }

function Back() {
  const nav = useNavigate()
  return (
    <button type="button" className="dx-top__back" aria-label="back" data-testid="legal-back" onClick={() => {
      if (window.history.length > 1) nav(-1)
      else nav('/')
    }}>
      <Icon name="back" size={18} />
    </button>
  )
}

function LegalPage({ title, lede, sections }: { title: string; lede: string; sections: Section[] }) {
  useThemedPage()
  useEffect(() => { document.title = `${title} · wifly` }, [title])
  const other = title === 'terms of use' ? { to: '/privacy', label: 'privacy' } : { to: '/terms', label: 'terms' }
  return (
    <div className="dx dx--legal" data-testid="legal-page">
      <header className="dx-top">
        <div className="dx-wrap dx-top__in">
          <Back />
          <Wordmark size="sm" />
          <span className="dx-top__tag">{title}</span>
          <ThemeToggle className="dx-top__theme" />
        </div>
      </header>
      <div className="dx-wrap">
        <main className="dx-main">
          <div className="dx-intro">
            <h1>{title}</h1>
            <p>{lede}</p>
          </div>
          {sections.map(s => (
            <section key={s.id} id={s.id} className="dx-sec">
              <h2>{s.title}</h2>
              {s.body}
            </section>
          ))}
          <footer className="dx-foot">
            <Link to="/">back to wifly</Link>
            <Link to={other.to}>{other.label}</Link>
            <Link to="/docs">docs</Link>
          </footer>
        </main>
      </div>
    </div>
  )
}

const terms: Section[] = [
  {
    id: 'as-is', title: 'provided as is',
    body: <p>wifly is provided as is, with no warranties of any kind. we may change, pause or stop any part of the service.</p>,
  },
  {
    id: 'wallet', title: 'your wallet',
    body: <>
      <p>you are responsible for your wallet, your keys and your transactions. we never hold your keys.</p>
      <p>actions you sign on robinhood chain are final and irreversible. if you send funds to the wrong place or sign something you didn’t mean to, we cannot undo it.</p>
    </>,
  },
  {
    id: 'advice', title: 'not financial advice',
    body: <p>nothing on wifly is financial, investment or legal advice. $wif and other tokens can lose value.</p>,
  },
  {
    id: 'bots', title: 'no bots or abuse',
    body: <>
      <p>don’t use bots, automation, scripts or scraping against the service. don’t create accounts or .wif names in bulk, wash vote, farm tips or votes, or abuse rate limits, faucets or rewards.</p>
      <p>if you do, we can limit your access, remove content, and withhold names or rewards.</p>
    </>,
  },
  {
    id: 'conduct', title: 'be decent',
    body: <p>no spam, impersonation, illegal content or harassment.</p>,
  },
  {
    id: 'names', title: '.wif names',
    body: <p>a .wif name must not infringe someone else’s trademark. we may reclaim or withhold a name that does.</p>,
  },
  {
    id: 'changes', title: 'changes',
    body: <p>we can change these terms. the current version is always on this page. using wifly after a change means you accept it.</p>,
  },
  {
    id: 'contact', title: 'contact',
    body: <p>questions about these terms: <a href={LINKS.wifX} target="_blank" rel="noreferrer">$wif on x</a>.</p>,
  },
]

const privacy: Section[] = [
  {
    id: 'collect', title: 'what we store',
    body: <>
      <p>when you use wifly we may store:</p>
      <ul className="dx-list">
        <li>your wallet address, and any other wallets you link</li>
        <li>your @name and .wif names</li>
        <li>profile info you add: display name, bio, avatar, location and links</li>
        <li>your posts (drops), plus likes, follows, bookmarks and similar activity</li>
        <li>direct messages (text and images) on our servers, in readable form. they are not end-to-end encrypted. we can read them if we need to look at a report or a legal request. hiding a message on your side does not erase it, and deleting your account does not automatically remove messages already sent</li>
        <li>uploads you add, such as avatars and images in posts or messages</li>
        <li>your x username and email, if you sign in or link them</li>
        <li>a session cookie so you stay signed in, and a few preferences in your browser (theme, wallet connection, and a guest key if you use one)</li>
        <li>reports you send us, and basic server logs</li>
      </ul>
      <p>logs are written without full wallet addresses, emails or tokens.</p>
      <p>we don’t run a third-party analytics product on the site.</p>
    </>,
  },
  {
    id: 'public', title: 'what is public',
    body: <p>your profile, posts, @name, .wif names and anything you do on-chain (tips, votes, name claims, swaps and the like) is public. on-chain data lives on robinhood chain, and we can’t take it down.</p>,
  },
  {
    id: 'parties', title: 'who else sees data',
    body: <>
      <p>we use a few trusted services to run wifly, like sign-in, wallet connection, hosting and the in-app assistant. they only get what they need to do their job.</p>
      <p>we don’t sell your data.</p>
    </>,
  },
  {
    id: 'delete', title: 'deletion',
    body: <>
      <p>you can delete your account in settings. that anonymizes your profile, hides your posts, frees your @name and unlinks wallets, x and email so you can start a new account. we keep a backup of the deleted account. things you already minted or sent on-chain stay on the chain and in your wallet. some records, like messages you already sent, may remain.</p>
      <p>to ask about deletion or this policy, reach us at <a href={LINKS.wifX} target="_blank" rel="noreferrer">$wif on x</a>.</p>
    </>,
  },
  {
    id: 'changes', title: 'changes',
    body: <p>we can update this policy. the current version is always on this page.</p>,
  },
]

export function Terms() {
  return <LegalPage title="terms of use" lede="by using wifly you agree to these terms." sections={terms} />
}

export function Privacy() {
  return <LegalPage title="privacy policy" lede="this is what wifly actually collects and keeps." sections={privacy} />
}
