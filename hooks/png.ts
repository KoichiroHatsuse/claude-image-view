// A PNG decoder small enough to read: the hooks module has no zlib, no DecompressionStream
// and no WebAssembly, so a terminal without the kitty graphics protocol gets its picture
// from these bytes, drawn as half-block cells.
//
// Indexing below is bounds-checked by the loops around it, hence the `!`s.

/** A picture shrunk to at most THUMB pixels a side: RGB, 3 bytes a pixel, row-major. */
export type Thumb = { width: number; height: number; rgb: Uint8Array; source: { width: number; height: number } }

const THUMB = 64
// ponytail: transparent pixels are blended onto one dark grey, not the terminal's background;
// pasted screenshots are opaque, so read the terminal's colours if logos with alpha matter.
const BACKDROP = 0x1e
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** Shrinks a PNG to a Thumb, or null when it isn't an 8-bit, non-interlaced PNG this reads. */
export function decodePng(bytes: Uint8Array): Thumb | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 33 || signature.some((byte, i) => bytes[i] !== byte)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  const depth = bytes[24]!
  const colorType = bytes[25]!
  const channels = CHANNELS[colorType]
  if (!width || !height || depth !== 8 || channels === undefined || bytes[28] !== 0) return null

  let palette: Uint8Array = new Uint8Array(0)
  const idat: Uint8Array[] = []
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    const data = bytes.subarray(at + 8, at + 8 + length)
    if (type === 'PLTE') palette = data
    if (type === 'IDAT') idat.push(data)
    if (type === 'IEND') break
    at += 12 + length
  }
  if (colorType === 3 && palette.length === 0) return null

  const stride = width * channels
  let raw: Uint8Array
  try {
    raw = inflate(concat(idat), height * (stride + 1))
  } catch {
    return null
  }

  const scale = Math.min(1, THUMB / Math.max(width, height))
  const tw = Math.max(1, Math.round(width * scale))
  const th = Math.max(1, Math.round(height * scale))
  const sums = new Float64Array(tw * th * 3)
  const counts = new Uint32Array(tw * th)
  const rgba = [0, 0, 0, 0]
  let prior = new Uint8Array(stride)
  let line = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1)
    if (!unfilter(raw[start]!, raw.subarray(start + 1, start + 1 + stride), prior, line, channels)) return null
    const row = Math.min(th - 1, Math.floor(y * scale))
    for (let x = 0; x < width; x++) {
      pixel(line, x * channels, colorType, palette, rgba)
      const alpha = rgba[3]!
      const cell = row * tw + Math.min(tw - 1, Math.floor(x * scale))
      for (let c = 0; c < 3; c++) sums[cell * 3 + c]! += (rgba[c]! * alpha + BACKDROP * (255 - alpha)) / 255
      counts[cell]!++
    }
    ;[prior, line] = [line, prior]
  }
  const rgb = new Uint8Array(tw * th * 3)
  for (let i = 0; i < rgb.length; i++) rgb[i] = Math.round(sums[i]! / Math.max(1, counts[Math.floor(i / 3)]!))
  return { width: tw, height: th, rgb, source: { width, height } }
}

/**
 * The Raster `cells` for a thumb drawn `columns` by `rows`: each cell is an upper half
 * block, its foreground the pixel above and its background the pixel below.
 */
export function rasterCells(thumb: Thumb, columns: number, rows: number): Uint32Array {
  const words = new Uint32Array(columns * rows * 3)
  const at = (x: number, y: number) => {
    const py = Math.min(thumb.height - 1, Math.floor((y * thumb.height) / (rows * 2)))
    const px = Math.min(thumb.width - 1, Math.floor((x * thumb.width) / columns))
    const i = (py * thumb.width + px) * 3
    return (thumb.rgb[i]! << 16) | (thumb.rgb[i + 1]! << 8) | thumb.rgb[i + 2]!
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      words.set([0x2580, at(x, y * 2), at(x, y * 2 + 1)], (y * columns + x) * 3)
    }
  }
  return words
}

// Writes the pixel at byte `i` of an unfiltered line into `out` as RGBA.
function pixel(line: Uint8Array, i: number, colorType: number, palette: Uint8Array, out: number[]) {
  const v = line[i]!
  if (colorType === 0 || colorType === 4) out.fill(v, 0, 3)
  else if (colorType === 3) for (let c = 0; c < 3; c++) out[c] = palette[v * 3 + c] ?? 0
  else for (let c = 0; c < 3; c++) out[c] = line[i + c]!
  out[3] = colorType === 4 ? line[i + 1]! : colorType === 6 ? line[i + 3]! : 255
}

// PNG filters (spec section 9): each byte is stored as its difference from a predictor.
function unfilter(type: number, src: Uint8Array, prior: Uint8Array, out: Uint8Array, bpp: number): boolean {
  if (type > 4) return false
  for (let i = 0; i < src.length; i++) {
    const left = i >= bpp ? out[i - bpp]! : 0
    const up = prior[i]!
    const upLeft = i >= bpp ? prior[i - bpp]! : 0
    let predicted = 0
    if (type === 1) predicted = left
    else if (type === 2) predicted = up
    else if (type === 3) predicted = (left + up) >> 1
    else if (type === 4) {
      const p = left + up - upLeft
      const pa = Math.abs(p - left)
      const pb = Math.abs(p - up)
      const pc = Math.abs(p - upLeft)
      predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
    }
    out[i] = (src[i]! + predicted) & 0xff
  }
  return true
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

// zlib inflate (RFC 1950 and 1951), after zlib's puff.c: stored, fixed and dynamic blocks.
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

type Huffman = { counts: Uint16Array; symbols: Uint16Array }

function huffman(lengths: Uint8Array): Huffman {
  const counts = new Uint16Array(16)
  for (const len of lengths) counts[len]!++
  counts[0] = 0
  const offsets = new Uint16Array(16)
  for (let len = 1; len < 16; len++) offsets[len] = offsets[len - 1]! + counts[len - 1]!
  const symbols = new Uint16Array(lengths.length)
  lengths.forEach((len, symbol) => {
    if (len) symbols[offsets[len]!++] = symbol
  })
  return { counts, symbols }
}

const FIXED = {
  lit: huffman(new Uint8Array(288).fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288)),
  dist: huffman(new Uint8Array(30).fill(5)),
}

/** Inflates a zlib stream whose output is exactly `size` bytes; throws on anything malformed. */
export function inflate(data: Uint8Array, size: number): Uint8Array {
  const cmf = data[0] ?? 0
  if ((cmf & 0x0f) !== 8 || ((cmf << 8) | (data[1] ?? 0)) % 31 !== 0) throw new Error('not zlib')
  const out = new Uint8Array(size)
  let written = 0
  let pos = 2
  let buffer = 0
  let count = 0

  const byte = () => {
    if (pos >= data.length) throw new Error('truncated')
    return data[pos++]!
  }
  const bits = (n: number) => {
    while (count < n) {
      buffer |= byte() << count
      count += 8
    }
    const value = buffer & ((1 << n) - 1)
    buffer >>>= n
    count -= n
    return value
  }
  const decode = (h: Huffman) => {
    let code = 0
    let first = 0
    let index = 0
    for (let len = 1; len < 16; len++) {
      code |= bits(1)
      const n = h.counts[len]!
      if (code - n < first) return h.symbols[index + (code - first)]!
      index += n
      first = (first + n) << 1
      code <<= 1
    }
    throw new Error('bad code')
  }
  const put = (value: number) => {
    if (written >= size) throw new Error('too long')
    out[written++] = value
  }

  let last = 0
  while (!last) {
    last = bits(1)
    const type = bits(2)
    if (type === 0) {
      buffer = 0
      count = 0
      const len = byte() | (byte() << 8)
      pos += 2 // the length's complement
      for (let i = 0; i < len; i++) put(byte())
      continue
    }
    let lit = FIXED.lit
    let dist = FIXED.dist
    if (type === 2) {
      const nlen = bits(5) + 257
      const ndist = bits(5) + 1
      const ncode = bits(4) + 4
      const codeLengths = new Uint8Array(19)
      for (let i = 0; i < ncode; i++) codeLengths[CODE_ORDER[i]!] = bits(3)
      const lencode = huffman(codeLengths)
      const lengths = new Uint8Array(nlen + ndist)
      for (let i = 0; i < nlen + ndist; ) {
        const symbol = decode(lencode)
        if (symbol < 16) {
          lengths[i++] = symbol
          continue
        }
        let repeat = 0
        let value = 0
        if (symbol === 16) {
          if (i === 0) throw new Error('repeat with no length')
          value = lengths[i - 1]!
          repeat = 3 + bits(2)
        } else if (symbol === 17) repeat = 3 + bits(3)
        else repeat = 11 + bits(7)
        if (i + repeat > nlen + ndist) throw new Error('too many lengths')
        lengths.fill(value, i, i + repeat)
        i += repeat
      }
      lit = huffman(lengths.subarray(0, nlen))
      dist = huffman(lengths.subarray(nlen))
    } else if (type !== 1) throw new Error('bad block type')

    for (let symbol = decode(lit); symbol !== 256; symbol = decode(lit)) {
      if (symbol < 256) {
        put(symbol)
        continue
      }
      const s = symbol - 257
      if (s >= 29) throw new Error('bad length')
      const len = LENGTH_BASE[s]! + bits(LENGTH_EXTRA[s]!)
      const d = decode(dist)
      if (d >= 30) throw new Error('bad distance')
      const back = DIST_BASE[d]! + bits(DIST_EXTRA[d]!)
      if (back > written) throw new Error('distance too far')
      for (let i = 0; i < len; i++) put(out[written - back]!)
    }
  }
  if (written !== size) throw new Error('too short')
  return out
}

// Uint8Array.fromBase64 and toBase64 run here but aren't in the es2023 lib the types target.
export const fromBase64 = (base64: string) => Uint8Array.from(atob(base64), char => char.charCodeAt(0))
export const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
