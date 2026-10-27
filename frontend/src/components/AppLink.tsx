import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { appHref } from '../lib/hosts'

/** A link to an app route that works on every host: a router Link in the app, a plain link to the app host from the landing host. */
export function AppLink({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const t = appHref(to)
  return t.external ? <a href={t.href} className={className}>{children}</a> : <Link to={t.href} className={className}>{children}</Link>
}
