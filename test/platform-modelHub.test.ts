import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { cancelAllDownloads, downloadModel } from '../src/main/modelHub'
import { store } from '../src/main/store'

/**
 * "Browse Hugging Face" downloads (modelHub.ts), with fetch faked: Hugging Face
 * serves whatever body a test hands it, so nothing touches the network.
 */

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const modelFolder = (repoId: string): string => join(app.getPath('userData'), 'models', repoId.replace('/', '__'))

function fakeHub(body: () => ReadableStream<Uint8Array>, contentLength: number): { requests: number } {
  const seen = { requests: 0 }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.startsWith('https://huggingface.co/')) {
      // The size check before a download is a HEAD; only file fetches count.
      if (init?.method !== 'HEAD') seen.requests++
      return new Response(body(), { headers: { 'content-length': String(contentLength) } })
    }
    throw new TypeError('fetch failed')
  }) as typeof fetch
  return seen
}

const bytes = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    }
  })

test('a finished download lands under its own name, with no partial file left and the file recorded', async () => {
  fakeHub(() => bytes('GGUF-weights'), 12)
  const model = await downloadModel('acme/tiny-GGUF', 'tiny-Q4_K_M.gguf', () => {})

  assert.equal(readFileSync(model.path, 'utf8'), 'GGUF-weights')
  assert.equal(existsSync(`${model.path}.part`), false)
  // Recorded for Eaon's own runtime: named for the picker, nothing registered elsewhere.
  assert.equal(model.label, 'tiny · Q4_K_M')
  assert.equal(model.ollamaName, undefined)
  assert.ok(store.getDownloadedModels().some((m) => m.repoId === 'acme/tiny-GGUF' && m.filename === 'tiny-Q4_K_M.gguf'))
})

test('a file that cannot be written rejects the download instead of crashing the app or hanging', async () => {
  fakeHub(() => bytes('GGUF-weights'), 12)
  // A folder where the file should go makes the write stream fail, the same
  // path a full disk takes (the stream emits 'error').
  const folder = modelFolder('acme/blocked-GGUF')
  mkdirSync(join(folder, 'blocked.gguf'), { recursive: true })
  mkdirSync(join(folder, 'blocked.gguf.part'), { recursive: true })

  await assert.rejects(downloadModel('acme/blocked-GGUF', 'blocked.gguf', () => {}), /EISDIR|directory/i)
})

test('a download bigger than the free disk space is refused before anything is written', async () => {
  fakeHub(() => bytes('x'), 1e18)
  await assert.rejects(downloadModel('acme/huge-GGUF', 'huge.gguf', () => {}), /Needs .* free/)
  assert.equal(existsSync(join(modelFolder('acme/huge-GGUF'), 'huge.gguf')), false)
  assert.equal(existsSync(join(modelFolder('acme/huge-GGUF'), 'huge.gguf.part')), false)
})

test('a second click on the same file joins the download already running', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const seen = fakeHub(
    () =>
      new ReadableStream({
        async pull(controller) {
          await gate
          controller.enqueue(new TextEncoder().encode('weights'))
          controller.close()
        }
      }),
    7
  )
  const first = downloadModel('acme/twice-GGUF', 'twice.gguf', () => {})
  const second = downloadModel('acme/twice-GGUF', 'twice.gguf', () => {})
  release()
  const [a, b] = await Promise.all([first, second])

  assert.equal(seen.requests, 1)
  assert.equal(a.path, b.path)
  assert.equal(readFileSync(a.path, 'utf8'), 'weights')
})

test('quitting mid-download stops it and removes the partial file', async () => {
  let started: () => void = () => {}
  const firstChunk = new Promise<void>((resolve) => (started = resolve))
  fakeHub(
    () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'))
        },
        // Never closes: the rest of a multi-gigabyte file still to come.
        pull() {
          return new Promise(() => {})
        }
      }),
    10_000_000
  )
  const running = downloadModel('acme/quit-GGUF', 'quit.gguf', () => started())
  await firstChunk
  // Let the first chunk reach the file.
  await new Promise((resolve) => setTimeout(resolve, 50))
  const part = join(modelFolder('acme/quit-GGUF'), 'quit.gguf.part')
  assert.equal(existsSync(part), true)

  cancelAllDownloads()
  assert.equal(existsSync(part), false, 'removed before the process can exit')
  await assert.rejects(running, /cancelled/)
  assert.equal(existsSync(join(modelFolder('acme/quit-GGUF'), 'quit.gguf')), false)
})
