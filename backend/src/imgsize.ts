/** Pixel size from an image header (png, gif, webp, jpg), without decoding. Null when it can't tell. */
export function imageSize(b: Uint8Array): { w: number; h: number } | null {
  const ok = (w: number, h: number) => (w > 0 && h > 0 && w < 65536 && h < 65536 ? { w, h } : null)
  const u16be = (i: number) => (b[i] << 8) | b[i + 1]
  const u16le = (i: number) => b[i] | (b[i + 1] << 8)
  const u24le = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
  const u32be = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]
  if (b.length < 26) return null
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ok(u32be(16), u32be(20)) // IHDR
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return ok(u16le(6), u16le(8))
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15])
    if (fourcc === 'VP8X' && b.length >= 30) return ok(u24le(24) + 1, u24le(27) + 1)
    if (fourcc === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
      return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
    }
    if (fourcc === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return ok(u16le(26) & 0x3fff, u16le(28) & 0x3fff)
    return null
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    let turned: boolean | undefined // set by the first valid Exif APP1 only (later Exif APP1s are ignored, as browsers do); XMP never touches it
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue }
      const m = b[i + 1]
      if (m === 0xff) { i++; continue }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue }
      const len = u16be(i + 2)
      // SOF0-15 except DHT (c4), JPG (c8) and DAC (cc)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return turned === true ? ok(u16be(i + 5), u16be(i + 7)) : ok(u16be(i + 7), u16be(i + 5))
      if (m === 0xe1 && turned === undefined) turned = exifTurned(b, i + 4, len - 2) // browsers apply EXIF orientation: 5-8 swap the sides
      if (len < 2) return null
      i += 2 + len
    }
  }
  return null
}

/** For a valid Exif APP1 ("Exif\0\0" + a TIFF header + an IFD0 that fits the segment): true for orientation 5-8, false
 *  otherwise (1-4, out of range, or no orientation tag), and that settles it: later Exif APP1s don't count.
 *  undefined only when this APP1 isn't a valid Exif (XMP, extended XMP, truncated or malformed), so the next one may. */
function exifTurned(b: Uint8Array, at: number, len: number): boolean | undefined {
  if (len < 14 || at + 6 > b.length) return undefined
  if (b[at] !== 0x45 || b[at + 1] !== 0x78 || b[at + 2] !== 0x69 || b[at + 3] !== 0x66 || b[at + 4] !== 0 || b[at + 5] !== 0) return undefined // "Exif\0\0"
  const t = at + 6
  const le = b[t] === 0x49 && b[t + 1] === 0x49
  if (!le && !(b[t] === 0x4d && b[t + 1] === 0x4d)) return undefined // "II" or "MM"
  const end = Math.min(b.length, at + len)
  const r16 = (i: number) => (i + 1 < end ? (le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]) : -1)
  const r32 = (i: number) => (i + 3 < end ? (le ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 2 ** 24 : b[i] * 2 ** 24 + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3])) : -1)
  if (r16(t + 2) !== 42) return undefined
  const ifd = r32(t + 4)
  if (ifd < 8) return undefined
  const n = r16(t + ifd)
  for (let k = 0; k < n && k < 64; k++) {
    const e = t + ifd + 2 + k * 12
    const tag = r16(e)
    if (tag < 0) return undefined // ran off the segment
    if (tag === 0x0112) { const o = r16(e + 8); return o < 0 ? undefined : o >= 5 && o <= 8 }
  }
  if (n < 0 || (n > 0 && r16(t + ifd + n * 12) < 0)) return undefined // IFD0 doesn't fit the segment
  return false // IFD0 parsed, no orientation tag: upright
}

/** Upload names may carry their pixel size ("<id>--<w>x<h>.<ext>") so pages can reserve the box before the image loads. */
export const sizedName = (id: string, ext: string, s: { w: number; h: number } | null) => (s ? `${id}--${s.w}x${s.h}.${ext}` : `${id}.${ext}`)
