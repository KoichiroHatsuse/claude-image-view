// A PNG decoder small enough to read: the hooks module has no zlib, no DecompressionStream
// and no WebAssembly, so a terminal without the kitty graphics protocol gets its picture
// from these bytes, drawn as half-block cells.

/** A picture shrunk to at most THUMB pixels a side: RGB, 3 bytes a pixel, row-major. */
export type Thumb = { width: number; height: number; rgb: Uint8Array; source: { width: number; height: number } }

const THUMB = 64
// ponytail: transparent pixels are blended onto one dark grey, not the terminal's background;
// pasted screenshots are opaque, so read the terminal's colours if logos with alpha matter.
const BACKDROP = [0x1e, 0x1e, 0x1e]
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** Shrinks a PNG to a Thumb, or null when it isn't an 8-bit, non-interlaced PNG this reads. */
export function decodePng(bytes: Uint8Array): Thumb | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 33 || signature.some((byte, i) => bytes[i] !== byte)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  const [depth, colorType, , , interlace] = bytes.subarray(24, 29)
  const channels = CHANNELS[colorType]
  if (!width || !height || depth !== 8 || channels === undefined || interlace !== 0) return null

  let palette = new Uint8Array(0)
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
  let prior = new Uint8Array(stride)
  let line = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1)
    if (!unfilter(raw[start], raw.subarray(start + 1, start + 1 + stride), prior, line, channels)) return null
    const row = Math.min(th - 1, Math.floor(y * scale))
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(line, x * channels, colorType, palette)
      const cell = row * tw + Math.min(tw - 1, Math.floor(x * scale))
      sums[cell * 3] += (r * a + BACKDROP[0] * (255 - a)) / 255
      sums[cell * 3 + 1] += (g * a + BACKDROP[1] * (255 - a)) / 255
      sums[cell * 3 + 2] += (b * a + BACKDROP[2] * (255 - a)) / 255
      counts[cell]++
    }
    ;[prior, line] = [line, prior]
  }
  const rgb = new Uint8Array(tw * th * 3)
  for (let i = 0; i < rgb.length; i++) rgb[i] = Math.round(sums[i] / Math.max(1, counts[Math.floor(i / 3)]))
  return { width: tw, height: th, rgb, source: { width, height } }
}

/**
 * The Raster `cells` for a thumb drawn `columns` by `rows`: each cell is an upper half
 * block, its foreground the pixel above and its background the pixel below.
 */
export function rasterCells(thumb: Thumb, columns: number, rows: number): Uint32Array {
  const words = new Uint32Array(columns * rows * 3)
  const at = (x: number, y: number) => {
    const i = (Math.min(thumb.height - 1, Math.floor((y * thumb.height) / (rows * 2))) * thumb.width +
      Math.min(thumb.width - 1, Math.floor((x * thumb.width) / columns))) * 3
    return (thumb.rgb[i] << 16) | (thumb.rgb[i + 1] << 8) | thumb.rgb[i + 2]
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      words.set([0x2580, at(x, y * 2), at(x, y * 2 + 1)], (y * columns + x) * 3)
    }
  }
  return words
}

function pixel(line: Uint8Array, i: number, colorType: number, palette: Uint8Array): number[] {
  switch (colorType) {
    case 0: return [line[i], line[i], line[i], 255]
    case 2: return [line[i], line[i + 1], line[i + 2], 255]
    case 3: return [palette[line[i] * 3] ?? 0, palette[line[i] * 3 + 1] ?? 0, palette[line[i] * 3 + 2] ?? 0, 255]
    case 4: return [line[i], line[i], line[i], line[i + 1]]
    default: return [line[i], line[i + 1], line[i + 2], line[i + 3]]
  }
}

// PNG filters (spec section 9): each byte is stored as its difference from a predictor.
function unfilter(type: number, src: Uint8Array, prior: Uint8Array, out: Uint8Array, bpp: number): boolean {
  for (let i = 0; i < src.length; i++) {
    const left = i >= bpp ? out[i - bpp] : 0
    const up = prior[i]
    const upLeft = i >= bpp ? prior[i - bpp] : 0
    let predicted: number
    if (type === 0) predicted = 0
    else if (type === 1) predicted = left
    else if (type === 2) predicted = up
    else if (type === 3) predicted = (left + up) >> 1
    else if (type === 4) {
      const p = left + up - upLeft
      const pa = Math.abs(p - left)
      const pb = Math.abs(p - up)
      const pc = Math.abs(p - upLeft)
      predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
    } else return false
    out[i] = (src[i] + predicted) & 0xff
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

function huffman(lengths: ArrayLike<number>): Huffman {
  const counts = new Uint16Array(16)
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]]++
  counts[0] = 0
  const offsets = new Uint16Array(16)
  for (let len = 1; len < 16; len++) offsets[len] = offsets[len - 1] + counts[len - 1]
  const symbols = new Uint16Array(lengths.length)
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    if (lengths[symbol]) symbols[offsets[lengths[symbol]]++] = symbol
  }
  return { counts, symbols }
}

const FIXED = (() => {
  const lengths = new Uint8Array(288)
  lengths.fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288)
  return { lit: huffman(lengths), dist: huffman(new Uint8Array(30).fill(5)) }
})()

/** Inflates a zlib stream whose output is exactly `size` bytes; throws on anything malformed. */
export function inflate(data: Uint8Array, size: number): Uint8Array {
  if (data.length < 2 || (data[0] & 0x0f) !== 8 || ((data[0] << 8) | data[1]) % 31 !== 0) throw new Error('not zlib')
  const out = new Uint8Array(size)
  let written = 0
  let pos = 2
  let buffer = 0
  let count = 0

  const bits = (n: number) => {
    while (count < n) {
      if (pos >= data.length) throw new Error('truncated')
      buffer |= data[pos++] << count
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
      const n = h.counts[len]
      if (code - n < first) return h.symbols[index + (code - first)]
      index += n
      first = (first + n) << 1
      code <<= 1
    }
    throw new Error('bad code')
  }
  const put = (byte: number) => {
    if (written >= size) throw new Error('too long')
    out[written++] = byte
  }

  let last = 0
  while (!last) {
    last = bits(1)
    const type = bits(2)
    if (type === 0) {
      buffer = 0
      count = 0
      if (pos + 4 > data.length) throw new Error('truncated')
      const len = data[pos] | (data[pos + 1] << 8)
      pos += 4
      if (pos + len > data.length) throw new Error('truncated')
      for (let i = 0; i < len; i++) put(data[pos + i])
      pos += len
      continue
    }
    let lit = FIXED.lit
    let dist = FIXED.dist
    if (type === 2) {
      const nlen = bits(5) + 257
      const ndist = bits(5) + 1
      const ncode = bits(4) + 4
      const codeLengths = new Uint8Array(19)
      for (let i = 0; i < ncode; i++) codeLengths[CODE_ORDER[i]] = bits(3)
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
          value = lengths[i - 1]
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
      const len = LENGTH_BASE[s] + bits(LENGTH_EXTRA[s])
      const d = decode(dist)
      if (d >= 30) throw new Error('bad distance')
      const back = DIST_BASE[d] + bits(DIST_EXTRA[d])
      if (back > written) throw new Error('distance too far')
      for (let i = 0; i < len; i++) put(out[written - back])
    }
  }
  if (written !== size) throw new Error('too short')
  return out
}
