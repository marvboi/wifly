/**
 * Brand constants. The name is final: Wifly.
 *
 * LOGO SLOT: Wifly's own logo is being designed separately. Until it lands, the wordmark is
 * styled text built from APP_NAME (see Wordmark in components/Bits.tsx).
 * To swap in the real logo, drop the file in public/brand/ and set WORDMARK_SRC, for example
 * '/brand/wifly-wordmark.svg'. Every wordmark in the app (rails, mobile top bar, landing, footer) uses it.
 */
export const APP_NAME = 'Wifly'
export const APP_TAGLINE = 'the social app that runs on $WIF'
export const PLUS_NAME = `${APP_NAME} Plus`
export const WORDMARK_SRC: string | null = null
/** Width/height ratio of the logo file, so it sits on the same baseline as the text placeholder. */
export const WORDMARK_RATIO = 3.2
