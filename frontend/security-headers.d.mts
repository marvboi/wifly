export declare const THEME_INIT_HASH: string
export declare const RPC_ORIGIN: string
export declare const DEFAULT_SITE_ORIGINS: string[]
export declare const CADDY_SITE_ORIGINS: string
export declare function siteOrigins(env?: Record<string, string | undefined>): string[]
export declare const BASE_CSP_DIRECTIVES: Record<string, string[]>
export declare function cspDirectives(origins: string[]): Record<string, string[]>
export declare function cspFor(origins: string[]): string
export declare const CSP_DIRECTIVES: Record<string, string[]>
export declare const CSP: string
export declare const CADDY_CSP: string
export declare const SECURITY_HEADERS: Record<string, string>
