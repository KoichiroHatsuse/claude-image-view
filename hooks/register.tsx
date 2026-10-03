import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PastedImage } from '../types'
import { fitRow, imageNumbers, pngSize } from './layout'
import type { Size } from './layout'
import { decodePng, fromBase64, rasterCells, toBase64 } from './png'
import type { Thumb } from './png'

// Pasting an image raises no prompt.edit (the tag only shows up on the next keystroke),
// so the draft is polled instead.
const POLL_MS = 200

const images = atom({ plugin: 'image-view', key: 'images' } as const, [] as PastedImage[])

let tmpRoot: string | undefined
let found: { sessionId: string; dir: string } | undefined
// The image numbers last drawn, so an unchanged draft doesn't rewrite state; undefined
// while a drawn image's file is still missing, so the next poll looks again.
let shownKey: string | undefined
let isChecking = false
// Whether the terminal draws Image pixels; elsewhere each picture is a Raster of half blocks.
let drawsPixels = false
// Keyed by path, size and mtime, so a file that failed to decode isn't read again until it changes.
const decoded = new Map<string, { size: Size | null; thumb: Thumb | null } | null>()

// Image draws pixels in kitty and Ghostty only (the alt text elsewhere), so pick it only
// there. CLAUDE_CODE_FORCE_TERMINAL_IMAGES is what turns them on in a background session.
async function terminalDrawsPixels($: EngineInterface): Promise<boolean> {
  if (/^(1|true)$/i.test((await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')) ?? '')) return true
  const term = (await $.env.get('TERM')) ?? ''
  return term.startsWith('xterm-kitty') || term.startsWith('xterm-ghostty')
}

// Claude Code caches each paste as <tmp>/<project>/<session>/images/<n>.png, where <tmp> is
// %TEMP%\claude on Windows and /tmp/claude-<uid> elsewhere. The project folder is named after
// a working directory that may since have moved, so find it by the session id instead.
async function findTmpRoot($: EngineInterface): Promise<string> {
  const fromEnv = await $.env.get('CLAUDE_CODE_TMPDIR')
  if (fromEnv) return fromEnv
  const temp = (await $.env.get('TEMP')) ?? (await $.env.get('TMP'))
  if (temp) return `${temp.replaceAll('\\', '/')}/claude`
  return `/tmp/claude-${(await $.process.run(['id', '-u'])).stdout.trim()}`
}

async function imagesDir($: EngineInterface): Promise<string | undefined> {
  const sessionId = await $.session.id()
  if (found?.sessionId === sessionId) return found.dir
  tmpRoot ??= await findTmpRoot($).catch(() => undefined)
  if (tmpRoot === undefined) return undefined
  const entries = await $.fs.list(tmpRoot).catch(() => [])
  for (const entry of entries) {
    const dir = `${tmpRoot}/${entry.name}/${sessionId}/images`
    if (entry.kind === 'dir' && (await $.fs.exists(dir))) {
      found = { sessionId, dir }
      return dir
    }
  }
  return undefined
}

// Reads the whole file: its size for an Image, and its pixels too when it's drawn as a Raster.
async function load($: EngineInterface, path: string) {
  const { base64 } = await $.fs.read(path, { as: 'bytes' })
  if (drawsPixels) {
    const size = pngSize(base64)
    return size === null ? null : { size, thumb: null }
  }
  const thumb = decodePng(fromBase64(base64))
  return thumb === null ? null : { size: thumb.source, thumb }
}

async function describe($: EngineInterface, dir: string | undefined, n: number): Promise<PastedImage> {
  const path = `${dir}/${n}.png`
  const stat = dir === undefined ? undefined : await $.fs.stat(path).catch(() => undefined)
  if (stat?.kind !== 'file') return { n, path: null, size: null }
  const key = `${path}|${stat.size}|${stat.mtimeMs}`
  if (!decoded.has(key)) {
    decoded.set(
      key,
      await load($, path).catch(() =>
        // Over $.fs.read's 4 MiB cap: an Image still draws it, just without its aspect ratio.
        drawsPixels ? { size: null, thumb: null } : null,
      ),
    )
  }
  const entry = decoded.get(key)
  if (entry === null || entry === undefined) return { n, path: null, size: null }
  return { n, path, size: entry.size, thumbKey: entry.thumb ? key : undefined }
}

async function show($: EngineInterface, draft: string) {
  const numbers = imageNumbers(draft)
  const key = numbers.join(',')
  if (key === shownKey) return
  const dir = numbers.length > 0 ? await imagesDir($) : undefined
  const list: PastedImage[] = []
  for (const n of numbers) list.push(await describe($, dir, n))
  shownKey = list.every(image => image.path !== null) ? key : undefined
  await update($, images, () => list)
}

async function check($: EngineInterface) {
  if (isChecking) return
  isChecking = true
  try {
    await show($, (await $.prompt.read()).text)
  } finally {
    isChecking = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    drawsPixels = await terminalDrawsPixels($)
    $.clock.every(POLL_MS, () => check($))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const list = await read($, images)
    if (list.length === 0) return next(e)

    const { Box, Image, Raster, Text } = $.ui.resolve(e)
    const cells = fitRow(list.map(image => image.size), e.props.maxRows, e.props.bodyColumns)
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          {list.map((image, i) => {
            const { columns, rows } = cells[i] ?? { columns: 4, rows: 1 }
            const thumb = image.thumbKey === undefined ? undefined : decoded.get(image.thumbKey)?.thumb
            return (
              <Box flexDirection="column" alignItems="center" borderStyle="round" borderDimColor>
                {image.path === null ? (
                  <Box width={columns} height={rows} alignItems="center" justifyContent="center">
                    <Text dimColor wrap="truncate">no preview</Text>
                  </Box>
                ) : thumb ? (
                  <Raster
                    key={`image-${image.n}`}
                    columns={columns}
                    rows={rows}
                    cells={toBase64(new Uint8Array(rasterCells(thumb, columns, rows).buffer))}
                  />
                ) : (
                  <Image
                    key={`image-${image.n}`}
                    source={{ file: image.path, format: 'png' }}
                    columns={columns}
                    rows={rows}
                    alt={`[Image #${image.n}]`}
                  />
                )}
                <Text dimColor>#{image.n}</Text>
              </Box>
            )
          })}
        </Box>
        {below}
      </Box>
    )
  })
}
