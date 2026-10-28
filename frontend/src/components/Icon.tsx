import type { SVGProps } from 'react'

const paths = {
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4" /></>,
  moon: <path d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1Z" />,
  monitor: <><rect x="3.5" y="4.5" width="17" height="11.5" rx="2" /><path d="M9 20h6M12 16v4" /></>,
  bookmark: <path d="M6.5 4.5h11a1 1 0 0 1 1 1V20l-6.5-4-6.5 4V5.5a1 1 0 0 1 1-1Z" />,
  quote: <><path d="M5 7.5h14a1 1 0 0 1 1 1V17a1 1 0 0 1-1 1H9l-4 3V8.5a1 1 0 0 1 1-1Z" /><path d="M9 11.5h6M9 14.5h4" /></>,
  trash: <><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5a1 1 0 0 0 1 .9h7a1 1 0 0 0 1-.9l1-12.5" /></>,
  mute: <><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" /><path d="m16 9.5 5 5M21 9.5l-5 5" /></>,
  eyeOff: <><path d="M3.5 12S6.5 6.5 12 6.5 20.5 12 20.5 12 17.5 17.5 12 17.5 3.5 12 3.5 12Z" /><path d="M4 4l16 16" /></>,
  home: <path d="M3.5 10.5 12 4l8.5 6.5V20a1 1 0 0 1-1 1H15v-6h-6v6H4.5a1 1 0 0 1-1-1z" />,
  bell: <><path d="M6 9.5a6 6 0 1 1 12 0c0 4.5 1.8 6 1.8 6H4.2S6 14 6 9.5Z" /><path d="M10 19a2 2 0 0 0 4 0" /></>,
  mail: <><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="m4 7 8 6 8-6" /></>,
  user: <><circle cx="12" cy="8.5" r="3.75" /><path d="M4.5 20c1.2-3.6 4-5.25 7.5-5.25S18.3 16.4 19.5 20" /></>,
  bolt: <path d="M13 3 5 13.5h6L10.5 21 19 10h-6z" />,
  agent: <><rect x="4.5" y="7.5" width="15" height="11" rx="3" /><path d="M12 4v3.5M9 12.5v1M15 12.5v1M2.5 12v3M21.5 12v3" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  star: <path d="m12 3.8 2.5 5.1 5.6.8-4 4 1 5.6-5.1-2.7-5 2.7 1-5.6-4.1-4 5.6-.8z" />,
  heart: <path d="M12 20s-7.5-4.6-7.5-10.1A4.4 4.4 0 0 1 12 7.3a4.4 4.4 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20Z" />,
  reply: <path d="M20.5 12c0 4-3.8 7-8.5 7-1.3 0-2.6-.2-3.7-.6L4 19.5l1.2-3.4C4.1 14.9 3.5 13.5 3.5 12c0-4 3.8-7 8.5-7s8.5 3 8.5 7Z" />,
  repost: <><path d="M7 7h10.5a2 2 0 0 1 2 2v3M17 17H6.5a2 2 0 0 1-2-2v-3" /><path d="m9.5 4.5-2.5 2.5 2.5 2.5M14.5 19.5l2.5-2.5-2.5-2.5" /></>,
  tip: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v9M14.6 9.4c-.4-.9-1.4-1.4-2.6-1.4-1.5 0-2.6.8-2.6 1.9 0 2.7 5.4 1.4 5.4 4.2 0 1.1-1.2 1.9-2.8 1.9-1.3 0-2.4-.6-2.8-1.6" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>,
  unlock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 7.7-1.5" /></>,
  share: <><path d="M12 3.5v12M7.5 8 12 3.5 16.5 8" /><path d="M5 13v5.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V13" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  flame: <path d="M12 21c-3.6 0-6-2.4-6-5.6 0-3.9 3.4-5.4 3.9-9.4 2.6 1.5 3.6 3.8 3.4 5.6 1-.5 1.6-1.6 1.8-2.8C17 10.4 18 12.8 18 15.4 18 18.6 15.6 21 12 21Z" />,
  pot: <><path d="M4.5 9.5h15l-1.3 9a2 2 0 0 1-2 1.7H7.8a2 2 0 0 1-2-1.7z" /><path d="M8 9.5V7a4 4 0 0 1 8 0v2.5" /></>,
  pin: <><path d="M9 3.5h6l-1 5 3 3v1.5H7V11.5l3-3z" /><path d="M12 13v7.5" /></>,
  chevron: <path d="m9 6 6 6-6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  up: <path d="m6 15 6-6 6 6" />,
  back: <path d="M15 6l-6 6 6 6" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5" /><path d="M12 8h.01" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  shop: <><path d="M4.5 9 6 4.5h12L19.5 9" /><path d="M4.5 9h15v10.5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z" /><path d="M9.5 13.5h5" /></>,
  file: <><path d="M14 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z" /><path d="M14 3.5V8h4.5" /></>,
  calendar: <><rect x="4" y="5.5" width="16" height="15" rx="2" /><path d="M8 3.5v4M16 3.5v4M4 10h16" /></>,
  globe: <><circle cx="12" cy="12" r="8.5" /><ellipse cx="12" cy="12" rx="8.5" ry="3.4" /><path d="M12 3.5v17" /></>,
  wallet: <><rect x="3.5" y="6" width="17" height="13" rx="2.5" /><path d="M16 12.5h1.5M3.5 9.5h17" /></>,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" /></>,
  x: <path d="M5 4.5h3.6L19 19.5h-3.6zM18.5 4.5l-5.6 6.4M5.5 19.5l5.6-6.4" />,
  send: <path d="M20.5 3.5 10 14M20.5 3.5 14 20.5l-4-6.5-6.5-4z" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.4-4.4" /></>,
  grid: <><rect x="4" y="4" width="6.5" height="6.5" rx="2.2" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="2.2" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="2.2" /><circle cx="16.75" cy="16.75" r="3.25" /></>,
  more: <><circle cx="6" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="18" cy="12" r="1" /></>,
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
  power: <><path d="M12 3.5v8" /><path d="M7 6.3a7.5 7.5 0 1 0 10 0" /></>,
  sparkle: <path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.5 6.5l2.5 2.5M15 15l2.5 2.5M6.5 17.5 9 15M15 9l2.5-2.5" />,
  shield: <path d="M12 3.5 19 6v5.5c0 4.4-3 7.8-7 9-4-1.2-7-4.6-7-9V6z" />,
  vault: <><path d="M3.5 9.5 12 4.5l8.5 5" /><path d="M5 10v8M9.7 10v8M14.3 10v8M19 10v8" /><path d="M3.5 20h17" /></>,
  vote: <><path d="M12 4.5 19.5 14h-4.25v5.5h-6.5V14H4.5z" /></>,
  trophy: <><path d="M7.5 4.5h9v4a4.5 4.5 0 0 1-9 0z" /><path d="M7.5 6H4.5v1.5A3 3 0 0 0 7.6 10.5M16.5 6h3v1.5a3 3 0 0 1-3.1 3M12 13v3.5M8.5 20h7M9.5 16.5h5V20h-5z" /></>,
  external: <><path d="M13.5 4.5h6v6M19.5 4.5 11 13" /><path d="M17.5 13.5v5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V8A1.5 1.5 0 0 1 6 6.5h5" /></>,
  swap: <><path d="M7 4.5v15M7 19.5 3.5 16M7 19.5 10.5 16M17 19.5v-15M17 4.5 13.5 8M17 4.5 20.5 8" /></>,
  at: <><circle cx="12" cy="12" r="3.6" /><path d="M15.6 8.5v4.6a2.4 2.4 0 0 0 4.8 0V12a8.5 8.5 0 1 0-3.3 6.7" /></>,
  camera: <><path d="M4.5 8.5a1.5 1.5 0 0 1 1.5-1.5h2.2l1.4-2h4.8l1.4 2H18a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 18 19H6a1.5 1.5 0 0 1-1.5-1.5z" /><circle cx="12" cy="12.75" r="3.25" /></>,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.75" /><path d="m4 18 5-5 4 4 2.5-2.5L20 19" /></>,
} satisfies Record<string, JSX.Element>

export type IconName = keyof typeof paths

export function Icon({ name, size = 20, fill, ...rest }: { name: IconName; size?: number; fill?: boolean } & Omit<SVGProps<SVGSVGElement>, 'fill'>) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill={fill ? 'currentColor' : 'none'} stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {paths[name]}
    </svg>
  )
}
