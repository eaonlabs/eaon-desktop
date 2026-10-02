import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LineHelper } from '../src/main/features/computer/helper'

/**
 * Regressions from the 2026.6 bug pass over computer use. Nothing here sends
 * a real event: the helper tests run a Node echo script, and the tool tests
 * swap in a recording input backend.
 */

/** Answers `echo` with its `value`; never answers `hang`. */
const ECHO = String.raw`
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let i
  while ((i = buffer.indexOf('\n')) !== -1) {
    const req = JSON.parse(buffer.slice(0, i))
    buffer = buffer.slice(i + 1)
    if (req.cmd === 'echo') process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: req.value }) + '\n')
  }
})
`

test('a helper killed after a timeout does not fail the requests of the helper that replaced it', async () => {
  const helper = new LineHelper('test', process.execPath, () => ['-e', ECHO])
  try {
    await assert.rejects(helper.request('hang', {}, 200), /did not answer "hang"/)
    // The timed-out helper was killed, but its exit arrives only now — after
    // this request went to a fresh helper. It must not be failed by it.
    assert.equal(await helper.request('echo', { value: 42 }, 5000), 42)
  } finally {
    helper.kill()
  }
})

/* ---------------------------------------------------------- stepping aside */

test('overlapping hides (Settings → Test during an agent action) leave Eaon visible afterwards', async () => {
  const { BrowserWindow } = await import('electron')
  const { configureSession, withEaonHidden } = await import('../src/main/features/computer/session')
  const win = {
    opacity: 1,
    ignoring: false,
    isDestroyed: () => false,
    isVisible: () => true,
    webContents: { isOffscreen: () => false },
    getOpacity(): number {
      return this.opacity
    },
    setOpacity(value: number): void {
      this.opacity = value
    },
    setIgnoreMouseEvents(value: boolean): void {
      this.ignoring = value
    }
  }
  const stub = BrowserWindow as unknown as { getAllWindows: () => unknown[] }
  const original = stub.getAllWindows
  stub.getAllWindows = () => [win]
  configureSession({ getWindow: () => win as never })
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    let hiddenWhileSecondRan = true
    const first = withEaonHidden(() => sleep(60))
    await sleep(110)
    const second = withEaonHidden(async () => {
      await sleep(120)
      // The first call finished long ago; the window must still be out of the way.
      hiddenWhileSecondRan = win.opacity === 0 && win.ignoring
    })
    await Promise.all([first, second])
    assert.equal(hiddenWhileSecondRan, true)
    assert.equal(win.opacity, 1, 'restored to what it was before either call')
    assert.equal(win.ignoring, false)
  } finally {
    stub.getAllWindows = original
    configureSession({ getWindow: () => null })
  }
})

/* ------------------------------------------------------------ stop reaches */

test('an action queued behind another turn’s action does not run once its own turn is stopped', async () => {
  const { store, defaultSettings } = await import('../src/main/store')
  const { setInputBackend } = await import('../src/main/features/computer/backend')
  const { computerTool } = await import('../src/main/features/computer/tool')
  const performed: string[] = []
  let release!: () => void
  const typing = new Promise<void>((resolve) => (release = resolve))
  setInputBackend({
    name: 'recording',
    check: async () => ({ available: true, trusted: true, locked: false }),
    move: async () => void performed.push('move'),
    click: async () => void performed.push('click'),
    drag: async () => void performed.push('drag'),
    scroll: async () => void performed.push('scroll'),
    type: async (text) => {
      performed.push(`type ${text}`)
      await typing
    },
    key: async () => void performed.push('key'),
    cursor: async () => ({ x: 1, y: 1 }),
    frontmost: async () => null,
    activate: async () => {},
    locked: async () => false,
    openApp: async () => void performed.push('open'),
    dispose: () => {}
  })
  store.patchSettings({ approvalMode: 'auto', computerUse: { ...defaultSettings.computerUse, enabled: true, confirmEachAction: false } })
  const ctx = (chatId: string, signal: AbortSignal) =>
    ({ request: { chatId, messageId: `m-${chatId}` }, signal, confirm: async () => false, cwd: '/tmp' }) as never
  try {
    const a = new AbortController()
    const b = new AbortController()
    const first = computerTool.run({ action: 'type', text: 'hello', screenshot: false }, ctx('a', a.signal))
    await new Promise((resolve) => setTimeout(resolve, 30))
    const second = Promise.resolve(computerTool.run({ action: 'click', x: 10, y: 10, screenshot: false }, ctx('b', b.signal))).catch(
      (error: Error) => error
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    b.abort()
    release()
    await first
    const outcome = await second
    assert.deepEqual(performed, ['type hello'], 'the stopped turn’s click never happened')
    assert.match(String((outcome as Error).message), /Stopped/)
  } finally {
    setInputBackend(null)
    store.patchSettings({ approvalMode: defaultSettings.approvalMode, computerUse: { ...defaultSettings.computerUse } })
  }
})
