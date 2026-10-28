/** A short error line for logs and stored details: viem's shortMessage or the first line, URLs masked, no request body. */
export function errLine(e: unknown, max = 160): string {
  const x = (e ?? {}) as { shortMessage?: unknown; message?: unknown; code?: unknown }
  const first = typeof x.shortMessage === 'string' && x.shortMessage ? x.shortMessage
    : typeof x.message === 'string' && x.message ? x.message.split('\n')[0] : typeof e === 'string' ? e.split('\n')[0] : ''
  const code = typeof x.code === 'string' || typeof x.code === 'number' ? String(x.code) : ''
  const line = first ? (code && !first.includes(code) ? `${first} (${code})` : first) : code || 'unknown error'
  return line.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, '<url>').slice(0, max)
}
