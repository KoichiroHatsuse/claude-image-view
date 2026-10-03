import { expect, mock, test } from 'claude-code/testing'

import { fitCells, fitRow, imageNumbers, pngSize } from '../hooks/layout'
import { decodePng, rasterCells } from '../hooks/png'

function pngHead(width: number, height: number): string {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return btoa(String.fromCharCode(...bytes))
}

const posix = (path: string) => path.replaceAll('\\', '/').replace(/^[A-Za-z]:/, '')

test('image numbers come from the draft, deduplicated, in order', () => {
  expect(imageNumbers('look [Image #2] and [Image #1] again [Image #2]')).toEqual([2, 1])
  expect(imageNumbers('[Image 1] [image #3] #4')).toEqual([])
})

test('PNG size is read from the IHDR header', () => {
  expect(pngSize(pngHead(1630, 632))).toEqual({ width: 1630, height: 632 })
  expect(pngSize(btoa('\xff\xd8\xff\xe0 this is a jpeg, not a png...'))).toBeNull()
})

test('thumbnails keep aspect ratio within the tile', () => {
  // Square: 6 rows tall, twice as many columns because cells are tall.
  expect(fitCells({ width: 500, height: 500 })).toEqual({ columns: 12, rows: 6 })
  // Very wide: capped at 32 columns, rows shrink to match.
  expect(fitCells({ width: 3000, height: 500 })).toEqual({ columns: 32, rows: 3 })
  // Very tall: never narrower than 4 columns.
  expect(fitCells({ width: 100, height: 2000 })).toEqual({ columns: 4, rows: 6 })
})

test('a row of tiles shrinks to fit the band so it never scrolls', () => {
  const square = { width: 500, height: 500 }
  // Plenty of room: full 6-row tiles.
  expect(fitRow([square], 20, 120)).toEqual([{ columns: 12, rows: 6 }])
  // A short band: border and label take 3 rows, so the picture gets the rest.
  expect(fitRow([square], 7, 120)).toEqual([{ columns: 8, rows: 4 }])
  // A narrow band: three 6-row squares need 3 * 14 + 2 = 44 columns; 40 forces 5 rows.
  expect(fitRow([square, square, square], 20, 40)).toEqual([
    { columns: 10, rows: 5 },
    { columns: 10, rows: 5 },
    { columns: 10, rows: 5 },
  ])
})

const BAND = {
  plugin: 'image-view',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

// A 2x2 PNG: red, green over blue, white.
const RGBW = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAAMIM/////w8AH+4F+7C4l8kAAAAASUVORK5CYII='

test('a 2x2 PNG decodes to its pixels and draws as half blocks', () => {
  const thumb = decodePng(Uint8Array.fromBase64(RGBW))
  expect(thumb?.source).toEqual({ width: 2, height: 2 })
  expect([...(thumb?.rgb ?? [])]).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255])
  // One cell a column: the top pixel is the foreground of an upper half block, the bottom one its background.
  expect([...rasterCells(thumb!, 2, 1)]).toEqual([0x2580, 0xff0000, 0x0000ff, 0x2580, 0x00ff00, 0xffffff])
  expect(decodePng(Uint8Array.fromBase64(pngHead(10, 10)))).toBeNull()
})

type Paste = { env: Record<string, string>; dir: string; png: string }

// Mounts the band after #1 is pasted (and #2 named with no file behind it).
async function pasted($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1], paste: Paste) {
  const clock = mock.clock(on)
  const root = paste.dir.split('/').slice(0, -3).join('/')
  let draft = 'see [Image #1] [Image #2]'
  mock.env(on, paste.env)
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('session.id', () => ({ value: 'sess-1' }))
  // Another project's folder and a stray file sit beside the one holding this session.
  const entry = { size: 0, mtimeMs: 0, isLink: false }
  on('fs.list', ($, e) => ({
    value: posix(e.path) === root
      ? [
          { name: '-other', kind: 'dir', ...entry },
          { name: 'notes.txt', kind: 'file', ...entry },
          { name: '-work', kind: 'dir', ...entry },
        ]
      : [],
  }))
  // On Windows the engine hands hooks resolved paths (C:\tmp\...), so compare in POSIX form.
  on('fs.exists', ($, e) => ({ value: posix(e.path) === paste.dir }))
  on('fs.stat', ($, e) =>
    posix(e.path) === `${paste.dir}/1.png` ? { value: { kind: 'file', ...entry, size: 1 } } : { deny: 'ENOENT' },
  )
  on('fs.read', () => ({ value: { base64: paste.png } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(200)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const clear = async () => {
    await ui.unmount()
    draft = ''
    await clock.advance(200)
    return $.ui.mount({ ...BAND, surface: 'terminal' })
  }
  return { ui, clear }
}

test('in Ghostty a pasted image shows as pixels and clears when the draft does', async ($, on) => {
  const dir = '/tmp/claude-501/-work/sess-1/images'
  const { ui, clear } = await pasted($, on, {
    env: { CLAUDE_CODE_TMPDIR: '/tmp/claude-501', TERM: 'xterm-ghostty' },
    dir,
    png: pngHead(800, 400),
  })
  const image = await ui.find({ type: 'Image' })
  expect(image?.props).toMatchObject({ source: { file: `${dir}/1.png`, format: 'png' }, columns: 24, rows: 6 })
  // #2 has no cached file, so it gets a placeholder tile instead of a broken Image.
  expect(await ui.find({ type: 'Text', text: 'no preview' })).toBeDefined()

  // Sending the prompt empties the box.
  const after = await clear()
  expect(await after.find({ type: 'Image' })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: 'engine band' })).toBeDefined()
})

test('in Windows Terminal the cache is found under %TEMP% and drawn as a Raster', async ($, on) => {
  const { ui } = await pasted($, on, {
    env: { TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp', TERM_PROGRAM: 'vscode' },
    dir: '/Users/me/AppData/Local/Temp/claude/-work/sess-1/images',
    png: RGBW,
  })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  const raster = await ui.find({ type: 'Raster' })
  // A square keeps the same 12x6 box an Image would get.
  expect(raster?.props).toMatchObject({ key: 'image-1', columns: 12, rows: 6 })
  const words = new Uint32Array(Uint8Array.fromBase64(String(raster?.props.cells)).buffer)
  expect(words.length).toBe(12 * 6 * 3)
  expect([...words.slice(0, 3)]).toEqual([0x2580, 0xff0000, 0xff0000])
  expect(await ui.find({ type: 'Text', text: 'no preview' })).toBeDefined()
})
