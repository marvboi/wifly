import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

/** Quiet leading line-icon for profile/drop meta (location, joined, time, links). */
export function MetaItem({ icon, children, className = '', href, ...rest }: {
  icon: IconName
  children: ReactNode
  className?: string
  href?: string
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'className' | 'children'>) {
  const cls = ['meta-ico', className].filter(Boolean).join(' ')
  const body = <><Icon name={icon} size={14} />{children}</>
  if (href) return <a className={cls} href={href} target="_blank" rel="noreferrer noopener" {...rest}>{body}</a>
  return <span className={cls}>{body}</span>
}
