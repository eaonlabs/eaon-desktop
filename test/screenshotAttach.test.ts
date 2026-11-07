import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { captureChoice, checkAccess, listCaptureChoices, SCREEN_DENIED, SCREEN_RESTRICTED, type CaptureDeps, type CapturerSource, type Picture } from '../src/main/features/screenshot'
import { savePastedImage } from '../src/main/features/library'

/** A picture that remembers how it was resized and encoded. */
function picture(width: number, empty = false, tag = 'png'): Picture {
  return {
    isEmpty: () => empty,
    getSize: () => ({ width, height: Math.round(width * 0.625) }),
    resize: (options) => picture(options.width ?? width, empty, `${tag}@${options.width}`),
    toPNG: () => Buffer.from(`PNG:${tag}`),
    toJPEG: (quality) => Buffer.from(`JPEG${quality}:${tag}`)
  }
}

const source = (id: string, name: string, width = 1600, empty = false): CapturerSource => ({ id, name, thumbnail: picture(width, empty, id) })

/** Deps with a permission state and a list of sources; records what was asked. */
function deps(options: { access?: string; after?: string; sources?: CapturerSource[]; fail?: boolean } = {}) {
  const log = { asked: 0, hidden: 0, requests: [] as { types: string[]; size: { width: number; height: number } }[] }
  let status = options.access ?? 'granted'
  const real: CaptureDeps = {
    getSources: async (request) => {
      log.requests.push({ types: request.types, size: request.thumbnailSize })
      if (options.fail) throw new Error('Wayland said no')
      return (options.sources ?? []).filter((s) => request.types.some((t) => s.id.startsWith(`${t}:`)))
    },
    access: () => status,
    askAccess: async () => {
      log.asked++
      status = options.after ?? status
    },
    screenEdge: () => 2400,
    hideApp: async (fn) => {
      log.hidden++
      return fn()
    }
  }
  return { real, log }
}

test('with Screen Recording off nothing is captured, and the reason is in plain words', async () => {
  const off = deps({ access: 'denied', sources: [source('screen:0:0', 'Screen 1')] })
  const list = await listCaptureChoices(off.real)
  assert.deepEqual(list, { ok: false, permission: true, message: SCREEN_DENIED })
  assert.match(SCREEN_DENIED, /Screen Recording/)
  assert.equal(off.log.requests.length, 0)
  const shot = await captureChoice('screen:0:0', off.real)
  assert.deepEqual(shot, { ok: false, permission: true, message: SCREEN_DENIED })
  assert.equal(off.log.requests.length, 0)

  const blocked = deps({ access: 'restricted' })
  assert.deepEqual(await checkAccess(blocked.real), { ok: false, message: SCREEN_RESTRICTED })
  // Asking would not help, so it is not asked.
  assert.equal(blocked.log.asked, 0)
})

test('a Mac that was never asked is asked once, on the click, and goes on if the answer is yes', async () => {
  const fresh = deps({ access: 'not-determined', after: 'granted', sources: [source('screen:0:0', 'Screen 1')] })
  const list = await listCaptureChoices(fresh.real)
  assert.equal(list.ok, true)
  assert.equal(fresh.log.asked, 1)

  const refused = deps({ access: 'not-determined', after: 'denied', sources: [source('screen:0:0', 'Screen 1')] })
  assert.deepEqual(await listCaptureChoices(refused.real), { ok: false, permission: true, message: SCREEN_DENIED })
  assert.equal(refused.log.requests.length, 0)

  // Windows and Linux have no such permission, and a system that cannot say is tried.
  for (const access of ['not-needed', 'unknown']) assert.deepEqual(await checkAccess(deps({ access }).real), { ok: true })
})

test('the picker lists screens first, then named windows with something in them, with small previews', async () => {
  const system = deps({
    sources: [
      source('window:11:0', 'Notes — Shopping'),
      source('window:12:0', '   '),
      source('window:13:0', 'Menu bar item', 1600, true),
      source('screen:1:0', ''),
      source('window:14:0', 'Terminal', 200),
      source('screen:2:0', 'Display 2'),
      source('other:1:0', 'Something else')
    ]
  })
  const list = await listCaptureChoices(system.real)
  assert.ok(list.ok)
  if (!list.ok) return
  assert.deepEqual(list.choices.map((c) => [c.id, c.kind, c.name]), [
    ['screen:1:0', 'screen', 'Screen 1'],
    ['screen:2:0', 'screen', 'Display 2'],
    ['window:11:0', 'window', 'Notes — Shopping'],
    ['window:14:0', 'window', 'Terminal']
  ])
  // A big capture is shrunk for the picker; a small one is not enlarged.
  assert.equal(Buffer.from(list.choices[2].preview.split(',')[1], 'base64').toString(), 'JPEG70:window:11:0@320')
  assert.equal(Buffer.from(list.choices[3].preview.split(',')[1], 'base64').toString(), 'JPEG70:window:14:0')
  assert.match(list.choices[0].preview, /^data:image\/jpeg;base64,/)
  assert.deepEqual(system.log.requests[0].types, ['screen', 'window'])
  assert.equal(system.log.requests[0].size.width, 320)
})

test('no sources, or a capturer that fails, is a plain failure and not an exception', async () => {
  const none = await listCaptureChoices(deps().real)
  assert.deepEqual(none, { ok: false, permission: false, message: 'The screen couldn’t be captured.' })
  const broken = await listCaptureChoices(deps({ fail: true }).real)
  assert.equal(broken.ok, false)
  const shot = await captureChoice('window:1:0', deps({ fail: true }).real)
  assert.deepEqual(shot, { ok: false, permission: false, message: 'The screen couldn’t be captured.' })
})

test('a window is captured as it is now; a screen with Eaon out of the way', async () => {
  const system = deps({ sources: [source('screen:1:0', 'Screen 1', 2400), source('window:11:0', 'Terminal', 1600)] })
  const window = await captureChoice('window:11:0', system.real)
  assert.ok(window.ok)
  if (window.ok) {
    assert.equal(window.png.toString(), 'PNG:window:11:0')
    assert.equal(window.name, 'Terminal')
  }
  assert.equal(system.log.hidden, 0)
  assert.deepEqual(system.log.requests.at(-1), { types: ['window'], size: { width: 1600, height: 1600 } })

  const screen = await captureChoice('screen:1:0', system.real)
  assert.ok(screen.ok)
  assert.equal(system.log.hidden, 1)
  assert.deepEqual(system.log.requests.at(-1), { types: ['screen'], size: { width: 2400, height: 2400 } })
})

test('only a screen or window from the list can be captured', async () => {
  const system = deps({ sources: [source('window:11:0', 'Terminal')] })
  for (const id of [undefined, 42, '', '/etc/passwd', 'file:///etc/passwd', 'camera:1:0']) {
    const result = await captureChoice(id, system.real)
    assert.equal(result.ok, false)
  }
  assert.equal(system.log.requests.length, 0)
  // A window that closed since the list was made.
  const gone = await captureChoice('window:99:0', system.real)
  assert.deepEqual(gone, { ok: false, permission: false, message: 'That window is gone or can’t be captured. Pick again.' })
  // A window with nothing in it.
  const blank = deps({ sources: [source('window:5:0', 'Blank', 800, true)] })
  assert.equal((await captureChoice('window:5:0', blank.real)).ok, false)
})

test('a captured screenshot is saved as a PNG attachment named Screenshot, and nothing else is kept', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'eaon-shot-'))
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9])
  const path = await savePastedImage(png, 'image/png', folder, 'Screenshot')
  assert.ok(path.startsWith(folder) && path.endsWith('.png'))
  assert.match(basename(path), /^Screenshot \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2} [a-z0-9]+\.png$/)
  assert.deepEqual(new Uint8Array(readFileSync(path)), png)
  assert.equal(existsSync(path), true)
  // Pasted images keep their name.
  assert.match(basename(await savePastedImage(png, 'image/png', folder)), /^Pasted image /)
})
