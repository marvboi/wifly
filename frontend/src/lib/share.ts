/** Share a link: the system share sheet when there is one, else the clipboard. The caller shows the "link copied" toast. */
export type ShareResult = 'shared' | 'copied' | 'cancelled' | 'failed'
type Deps = { share?: (d: { url: string; text?: string; title?: string }) => Promise<void>; writeText?: (s: string) => Promise<void> }

const browser = (): Deps => {
  const n = typeof navigator === 'undefined' ? undefined : navigator
  return {
    share: n?.share ? (d) => n.share(d) : undefined,
    writeText: n?.clipboard?.writeText ? (s) => n.clipboard.writeText(s) : undefined,
  }
}

export async function shareLink(url: string, text?: string, deps: Deps = browser()): Promise<ShareResult> {
  if (deps.share) {
    try { await deps.share({ url, text }); return 'shared' }
    catch (e) { if ((e as { name?: string })?.name === 'AbortError') return 'cancelled' /* else: fall back to copying */ }
  }
  if (deps.writeText) { try { await deps.writeText(url); return 'copied' } catch { /* blocked */ } }
  return 'failed'
}

/** The toast line for a result, or null when nothing should show (the share sheet handled it, or it was cancelled). */
export const shareToast = (r: ShareResult) => r === 'copied' ? 'link copied' : r === 'failed' ? 'couldn’t copy the link' : null
