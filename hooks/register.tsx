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
// Whether the terminal draws Image pixels; elsewhere each picture is a Raster of quadrant blocks.
let drawsPixels = false
let isWindows: boolean | undefined
// Keyed by path, size and mtime, so a file that failed to decode isn't read again until it changes.
const decoded = new Map<string, { size: Size | null; thumb: Thumb | null } | null>()

// Image draws pixels in kitty and Ghostty only (the alt text elsewhere), so pick it only
// there. CLAUDE_CODE_FORCE_TERMINAL_IMAGES is what turns them on in a background session.
async function terminalDrawsPixels($: EngineInterface): Promise<boolean> {
  if (/^(1|true)$/i.test((await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')) ?? '')) return true
  const term = (await $.env.get('TERM')) ?? ''
  return term.startsWith('xterm-kitty') || term.startsWith('xterm-ghostty')
}

async function onWindows($: EngineInterface): Promise<boolean> {
  isWindows ??= (await $.env.get('OS')) === 'Windows_NT'
  return isWindows
}

// Claude Code caches each paste as <tmp>/<project>/<session>/images/<n>.png, where <tmp> is
// %TEMP%\claude on Windows and /tmp/claude-<uid> elsewhere. The project folder is named after
// a working directory that may since have moved, so find it by the session id instead.
async function findTmpRoot($: EngineInterface): Promise<string | undefined> {
  const fromEnv = await $.env.get('CLAUDE_CODE_TMPDIR')
  if (fromEnv) return fromEnv
  if (await onWindows($)) {
    const temp = (await $.env.get('TEMP')) ?? (await $.env.get('TMP'))
    return temp && `${temp.replaceAll('\\', '/')}/claude`
  }
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
// null when it can't be drawn.
async function load($: EngineInterface, path: string) {
  const read = await $.fs.read(path, { as: 'bytes' }).catch(() => undefined)
  // Over $.fs.read's 4 MiB cap: an Image still draws it, just without its aspect ratio.
  if (read === undefined) return drawsPixels ? { size: null, thumb: null } : null
  if (drawsPixels) {
    const size = pngSize(read.base64)
    return size && { size, thumb: null }
  }
  const thumb = decodePng(fromBase64(read.base64))
  return thumb && { size: thumb.source, thumb }
}

// isMissing while the file isn't there yet, so the next poll looks again. A file that is
// there but can't be drawn is settled: it keeps its "no preview" tile and stops the polling.
async function describe($: EngineInterface, dir: string | undefined, n: number) {
  const path = `${dir}/${n}.png`
  const stat = dir === undefined ? undefined : await $.fs.stat(path).catch(() => undefined)
  if (stat?.kind !== 'file') return { image: { n, path: null, size: null }, isMissing: true }
  const key = `${path}|${stat.size}|${stat.mtimeMs}`
  let entry = decoded.get(key)
  if (entry === undefined) {
    entry = await load($, path)
    decoded.set(key, entry)
  }
  const image: PastedImage = entry
    ? { n, path, size: entry.size, thumbKey: entry.thumb ? key : undefined }
    : { n, path: null, size: null }
  return { image, isMissing: false }
}

// Opens the original in the OS's own viewer, since a thumbnail (a mosaic most of all) only
// tells pictures apart. argv, no shell: the path goes to the viewer as one argument.
async function openImage($: EngineInterface, path: string) {
  if (await onWindows($)) return $.process.run(['explorer.exe', path.replaceAll('/', '\\')])
  const isMac = (await $.process.run(['uname'])).stdout.trim() === 'Darwin'
  return $.process.run([isMac ? 'open' : 'xdg-open', path])
}

async function show($: EngineInterface, draft: string) {
  const numbers = imageNumbers(draft)
  const key = numbers.join(',')
  if (key === shownKey) return
  const dir = numbers.length > 0 ? await imagesDir($) : undefined
  const described = await Promise.all(numbers.map(n => describe($, dir, n)))
  shownKey = described.some(d => d.isMissing) ? undefined : key
  await update($, images, () => described.map(d => d.image))
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

    const { Box, Button, Image, Raster, Text } = $.ui.resolve(e)
    const cells = fitRow(list.map(image => image.size), e.props.maxRows, e.props.bodyColumns)
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          {list.map(({ n, path, thumbKey }, i) => {
            const { columns, rows } = cells[i] ?? { columns: 4, rows: 1 }
            const thumb = thumbKey === undefined ? undefined : decoded.get(thumbKey)?.thumb
            if (path === null) {
              return (
                <Box flexDirection="column" alignItems="center" borderStyle="round" borderDimColor>
                  <Box width={columns} height={rows} alignItems="center" justifyContent="center">
                    <Text dimColor wrap="truncate">no preview</Text>
                  </Box>
                  <Text dimColor>#{n}</Text>
                </Box>
              )
            }
            return (
              <Box flexDirection="column" alignItems="center" borderStyle="round" borderDimColor>
                {thumb ? (
                  <Raster
                    key={`image-${n}`}
                    columns={columns}
                    rows={rows}
                    cells={toBase64(new Uint8Array(rasterCells(thumb, columns, rows).buffer))}
                  />
                ) : (
                  <Image key={`image-${n}`} source={{ file: path, format: 'png' }} columns={columns} rows={rows} alt={`[Image #${n}]`} />
                )}
                {/* A click, or the digit while the band has the focus (ctrl+x tab), opens it. */}
                <Button
                  key={`open-${n}`}
                  label={`#${n} open`}
                  {...(n <= 9 && { hotkey: String(n) })}
                  plain
                  dimColor
                  onPress={() => openImage($, path).catch(() => $.ui.toast(`Couldn't open image #${n}`))}
                />
              </Box>
            )
          })}
        </Box>
        {below}
      </Box>
    )
  })
}
