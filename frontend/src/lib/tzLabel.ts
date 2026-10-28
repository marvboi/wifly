/** The browser's offset as a short label ("utc+1", "utc-5:30"), never a city or zone name. */
export function utcLabel(d = new Date()): string {
  const off = -d.getTimezoneOffset(), a = Math.abs(off), h = Math.floor(a / 60), m = a % 60
  return off === 0 ? 'utc' : `utc${off > 0 ? '+' : '-'}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`
}
