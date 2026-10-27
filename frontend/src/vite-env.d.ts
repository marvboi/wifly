/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_WIFLY_ADDRESS?: string
  readonly VITE_WIFLY_AGENT_ADDRESS?: string
  readonly VITE_WIFLY_TEAM_WALLET?: string
  /** Privy app id (public). Empty = wallet + guest sign-in. The Privy app secret is server only. */
  readonly VITE_PRIVY_APP_ID?: string
  /** Landing host, e.g. https://wifly.fun. Set with VITE_APP_URL to split landing and app across two hosts. */
  readonly VITE_SITE_URL?: string
  /** App host, e.g. https://app.wifly.fun. */
  readonly VITE_APP_URL?: string
}
interface ImportMeta { readonly env: ImportMetaEnv }
