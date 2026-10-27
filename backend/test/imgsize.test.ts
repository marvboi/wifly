/** Upload names carry the image's pixel size so feeds reserve the box before it loads (no layout shift). `npm test` */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imageSize, sizedName } from '../src/imgsize'

// 37x21 images written by Pillow; JPEG_ROT is progressive with EXIF orientation 6 (shown 21x37)
const fx: Record<string, string> = {
  PNG: 'iVBORw0KGgoAAAANSUhEUgAAACUAAAAVCAIAAABOhrD5AAAAJklEQVR4nGM8wcXFQEfARE/LRu0btW/UvlH7Ru0btW/UvlH7qAAArt4BBscTq5gAAAAASUVORK5CYII=',
  GIF: 'R0lGODdhJQAVAIEAAMgKCgAAAAAAAAAAACwAAAAAJQAVAEAILwABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqRJkgEBADs=',
  JPEG: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAVACUDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDAooorgPrQooooAKKKKACiiigAooooAKKKKAP/2Q==',
  WEBP: 'UklGRh4AAABXRUJQVlA4TBEAAAAvJAAFAAdQhSJXof+BiOh/AAA=',
  WEBP_LOSSY: 'UklGRkoAAABXRUJQVlA4ID4AAABQAwCdASolABUAPtFmrFCoJaQipWgBABoJZwDG5oAAK/fDcAD+7QcvrvFpRr/8lP8Xfebvvuus23d6pgAAAA==',
  WEBP_X: 'UklGRlgAAABXRUJQVlA4WAoAAAAQAAAAJAAAFAAAQUxQSAoAAAABB1CyiAhERP8DVlA4ICgAAADwAgCdASolABUAPtFmrVEoJaQipWgBABoJaQAAKUNt8AD+82IAAAAA',
  JPEG_ROT: '/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wgARCAAVACUDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAWAQEBAQAAAAAAAAAAAAAAAAAABAX/2gAMAwEAAhADEAAAAZ4n1gAAAAP/xAAUEAEAAAAAAAAAAAAAAAAAAAAw/9oACAEBAAEFAn//xAAUEQEAAAAAAAAAAAAAAAAAAAAg/9oACAEDAQE/AV//xAAUEQEAAAAAAAAAAAAAAAAAAAAg/9oACAECAQE/AV//xAAUEAEAAAAAAAAAAAAAAAAAAAAw/9oACAEBAAY/An//xAAUEAEAAAAAAAAAAAAAAAAAAAAw/9oACAEBAAE/IX//2gAMAwEAAgADAAAAEP8A/wD/AP8A/wD/xAAUEQEAAAAAAAAAAAAAAAAAAAAg/9oACAEDAQE/EF//xAAUEQEAAAAAAAAAAAAAAAAAAAAg/9oACAECAQE/EF//xAAUEAEAAAAAAAAAAAAAAAAAAAAw/9oACAEBAAE/EH//2Q==',
}
const buf = (k: string) => new Uint8Array(Buffer.from(fx[k], 'base64'))

test('reads the pixel size from png, gif, jpg and all three webp kinds', () => {
  for (const k of ['PNG', 'GIF', 'JPEG', 'WEBP', 'WEBP_LOSSY', 'WEBP_X']) assert.deepEqual(imageSize(buf(k)), { w: 37, h: 21 }, k)
})

test('honours EXIF rotation like browsers do', () => {
  assert.deepEqual(imageSize(buf('JPEG_ROT')), { w: 21, h: 37 })
})

test('junk, truncated or zero-sized headers give null, never a throw', () => {
  assert.equal(imageSize(new Uint8Array(10)), null)
  assert.equal(imageSize(buf('PNG').slice(0, 20)), null)
  assert.equal(imageSize(buf('JPEG').slice(0, 40)), null)
  const z = buf('PNG'); z.fill(0, 16, 24); assert.equal(imageSize(z), null)
  for (let i = 0; i < 200; i++) imageSize(new Uint8Array(Array.from({ length: 64 }, () => (Math.random() * 256) | 0)))
})

test('sized names still pass the upload name checks', () => {
  const n = sizedName('aB3_-xY9aB3_-xY9', 'png', { w: 1200, h: 800 })
  assert.equal(n, 'aB3_-xY9aB3_-xY9--1200x800.png')
  assert.match(n, /^[A-Za-z0-9_-]+\.(png|jpg|gif|webp)$/)
  assert.match(`/uploads/${n}`, /--(\d{1,5})x(\d{1,5})\.(png|jpg|gif|webp)$/)
  assert.equal(sizedName('abc', 'jpg', null), 'abc.jpg')
})

// --- Exif vs XMP APP1 (phones and Adobe write Exif, then an XMP APP1; only the Exif one may set orientation) ---
const seg = (marker: number, body: number[]) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255, ...body]
const ascii = (s: string) => [...Buffer.from(s, 'latin1')]
/** Exif APP1 body: "Exif\0\0" + TIFF with IFD0 holding one Orientation (0x0112, SHORT) entry. */
const exif = (o: number, le = true) => {
  const w16 = (v: number) => (le ? [v & 255, v >> 8] : [v >> 8, v & 255])
  const w32 = (v: number) => (le ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24] : [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255])
  return [...ascii('Exif\0\0'), ...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...w16(42), ...w32(8), ...w16(1), ...w16(0x0112), ...w16(3), ...w32(1), ...w16(o), 0, 0, ...w32(0)]
}
const xmp = (o = 1) => ascii(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:tiff="http://ns.adobe.com/tiff/1.0/" tiff:Orientation="${o}"/></rdf:RDF></x:xmpmeta>`)
/** SOI + APP segments + DQT + SOF0 (stored 400 wide x 300 tall) + EOI. Shown 300x400 when the orientation turns it. */
const jpeg = (...apps: number[][]) =>
  new Uint8Array([0xff, 0xd8, ...apps.flatMap(a => seg(0xe1, a)), ...seg(0xdb, [0, ...Array(64).fill(1)]), ...seg(0xc0, [8, 300 >> 8, 300 & 255, 400 >> 8, 400 & 255, 1, 1, 0x11, 0]), 0xff, 0xd9])

test('exif: orientation 6 followed by an XMP APP1 stays turned (300x400 portrait)', () => {
  assert.deepEqual(imageSize(jpeg(exif(6), xmp())), { w: 300, h: 400 })
  assert.equal(sizedName('abc', 'jpg', imageSize(jpeg(exif(6), xmp()))), 'abc--300x400.jpg')
  assert.deepEqual(imageSize(jpeg(exif(6), xmp(), xmp())), { w: 300, h: 400 })
})

test('exif: XMP first, then Exif(6), is still turned; the first Exif orientation wins', () => {
  assert.deepEqual(imageSize(jpeg(xmp(), exif(6))), { w: 300, h: 400 })
  assert.deepEqual(imageSize(jpeg(exif(6), exif(1))), { w: 300, h: 400 })
  assert.deepEqual(imageSize(jpeg(exif(1), exif(6))), { w: 400, h: 300 })
})

test('exif: orientations 5-8 swap the sides, 1-4 do not, in both byte orders', () => {
  for (const le of [true, false]) {
    for (const o of [1, 2, 3, 4]) assert.deepEqual(imageSize(jpeg(exif(o, le), xmp())), { w: 400, h: 300 }, `o=${o} le=${le}`)
    for (const o of [5, 6, 7, 8]) assert.deepEqual(imageSize(jpeg(exif(o, le), xmp())), { w: 300, h: 400 }, `o=${o} le=${le}`)
  }
  assert.deepEqual(imageSize(jpeg()), { w: 400, h: 300 })
  assert.deepEqual(imageSize(jpeg(xmp(6))), { w: 400, h: 300 }, 'XMP alone never rotates')
})

test('exif: malformed Exif never crashes and never rotates', () => {
  const good = exif(6)
  const bad: number[][] = [
    ascii('Exif'), // too short
    [...ascii('Exif\0\0'), 0x49, 0x49], // truncated TIFF
    [...ascii('Exif\0\0'), 0x49, 0x49, 42, 0, 0xff, 0xff, 0xff, 0x7f, 0, 0, 0, 0], // IFD offset far past the segment
    [...ascii('Exif\0\0'), 0x49, 0x49, 42, 0, 8, 0, 0, 0, 0xff, 0xff, 0x12, 0x01], // huge entry count, entries run off the end
    [...ascii('Exif\0\0'), 0x58, 0x58, ...good.slice(8)], // bad byte-order mark
    [...ascii('Exifxx'), ...good.slice(6)], // "Exif" without the \0\0
    [...good.slice(0, 8), 99, 0, ...good.slice(10)], // not TIFF magic 42
    [...good.slice(0, 24), 9, 0, ...good.slice(26)], // orientation 9 is out of range
  ]
  for (const [n, a] of bad.entries()) {
    assert.doesNotThrow(() => imageSize(jpeg(a)))
    assert.deepEqual(imageSize(jpeg(a)), { w: 400, h: 300 }, `case ${n}`)
    // a malformed Exif doesn't count, so a later valid one still applies. The last case is structurally valid Exif
    // (orientation 9 is just out of range), so it is the first valid Exif and settles it: upright.
    const settles = n === bad.length - 1
    assert.deepEqual(imageSize(jpeg(a, exif(6))), settles ? { w: 400, h: 300 } : { w: 300, h: 400 }, `case ${n} then a good Exif`)
  }
  for (let cut = 2; cut < jpeg(exif(6), xmp()).length; cut += 3) assert.doesNotThrow(() => imageSize(jpeg(exif(6), xmp()).slice(0, cut)))
})

test('exif: two Exif APP1s: only the first valid one sets orientation', () => {
  assert.deepEqual(imageSize(jpeg(exif(6), exif(1))), { w: 300, h: 400 }, 'first says turned')
  assert.deepEqual(imageSize(jpeg(exif(1), exif(6))), { w: 400, h: 300 }, 'first says upright; the second is ignored')
  assert.deepEqual(imageSize(jpeg(exif(8, false), exif(3))), { w: 300, h: 400 }, 'big-endian first wins')
  // a valid first Exif with no orientation tag at all settles it as upright: a second Exif(6) does not rotate
  const noOrient = [...ascii('Exif\0\0'), 0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x0f, 0x01, 2, 0, 1, 0, 0, 0, 0x41, 0, 0, 0, 0, 0, 0, 0]
  assert.deepEqual(imageSize(jpeg(noOrient, exif(6))), { w: 400, h: 300 })
  assert.deepEqual(imageSize(jpeg(xmp(6), noOrient, exif(6))), { w: 400, h: 300 }, 'XMP before it changes nothing')
  // a truncated (invalid) first Exif is skipped, so the second, valid one applies
  assert.deepEqual(imageSize(jpeg([...ascii('Exif\0\0'), 0x49, 0x49], exif(6))), { w: 300, h: 400 })
})
