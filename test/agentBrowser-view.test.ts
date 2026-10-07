import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { NativeImage } from 'electron'
import { agentBrowserFeature, setWorkerBrowsers } from '../src/main/features/agentBrowser'
import type { WorkerBrowsers } from '../src/main/features/workers/browser'
import type { FeatureContext } from '../src/main/features/types'

/** A window's page, as main sees it: what it was sent, and the events it fires. */
class FakeSender extends EventEmitter {
  frames: unknown[] = []
  destroyed = false
  constructor(public id: number) {
    super()
  }
  send(channel: string, payload: unknown): void {
    if (channel === 'agent-browser:frame') this.frames.push(payload)
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
}

/** A picture of the page; `shade` stands for its pixels. */
function picture(shade: number): NativeImage {
  return {
    isEmpty: () => false,
    getSize: () => ({ width: 2560, height: 1720 }),
    resize: () => picture(shade),
    toBitmap: () => Buffer.alloc(64, shade),
    toJPEG: () => Buffer.from([shade])
  } as unknown as NativeImage
}

test('the live view: frames go only to the windows watching, unchanged ones not at all, and a window that reloads or closes stops watching', async () => {
  const listeners = new Set<(image: NativeImage) => void>()
  let stopped = 0
  const browsers = {
    watchFrames: (_id: string, listener: (image: NativeImage) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        stopped++
      }
    },
    window: () => ({}),
    page: () => ({ url: 'https://example.com/', title: 'Example' }),
    viewport: () => ({ width: 1280, height: 860 }),
    controlled: () => false,
    releaseControl: () => {}
  } as unknown as WorkerBrowsers
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ctx = {
    ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn) },
    send: () => {},
    getWindow: () => null,
    getWindows: () => [],
    emitStream: () => {}
  } as unknown as FeatureContext
  agentBrowserFeature.register(ctx)
  setWorkerBrowsers(browsers)
  const watch = (sender: FakeSender, on: boolean): unknown => handlers.get('agent-browser:watch')!({ sender }, on, 'worker:w1')
  const paint = (shade: number): void => {
    for (const listener of listeners) listener(picture(shade))
  }

  try {
    const a = new FakeSender(1)
    const b = new FakeSender(2)
    watch(a, true)
    paint(1)
    assert.equal(a.frames.length, 1)
    assert.equal(b.frames.length, 0, 'a window not watching is sent nothing')

    // A second window opening a view gets the picture the first one has.
    watch(b, true)
    assert.equal(b.frames.length, 1)
    // The same picture again is neither encoded nor sent.
    paint(1)
    assert.deepEqual([a.frames.length, b.frames.length], [1, 1])
    paint(2)
    assert.deepEqual([a.frames.length, b.frames.length], [2, 2])

    // The second window reloads: its view is gone, though it never said so.
    b.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    paint(3)
    assert.deepEqual([a.frames.length, b.frames.length], [3, 2])
    assert.equal(b.listenerCount('did-start-navigation'), 0, 'nothing is left listening to it')

    // A route change inside the app, or a frame in it navigating, is not a reload.
    a.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    a.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    paint(4)
    assert.equal(a.frames.length, 4)
    assert.equal(stopped, 0)

    // The first window closes: nobody is watching, so the browser stops being pictured.
    a.emit('destroyed')
    assert.equal(stopped, 1)
    assert.equal(listeners.size, 0)

    // Two views in one window: closing one leaves the other watching.
    const c = new FakeSender(3)
    watch(c, true)
    watch(c, true)
    watch(c, false)
    paint(5)
    assert.equal(c.frames.length, 1)
    watch(c, false)
    assert.equal(stopped, 2)
    assert.equal(c.listenerCount('destroyed'), 0)
  } finally {
    agentBrowserFeature.dispose?.()
  }
})
