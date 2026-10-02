import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { cancelLibraryPull, LIBRARY, pullLibraryVariant, removeInstalledModel } from '../src/main/modelLibrary'
import { findLocalModel, localModelInfo } from '../src/main/llama/models'
import { mainFile } from '@shared/modelLibrary'
import type { ModelDownloadProgress } from '@shared/types'

/**
 * Library downloads (modelLibrary/index.ts) against a fake Hugging Face:
 * fetch is replaced, so nothing reaches the network. Files land in the test
 * stub's userData, and the entry they make is what the picker lists.
 */

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** The smallest runnable variant in the catalog, so the free-space check passes on any dev machine. */
const smallest = LIBRARY.filter((m) => !m.unsupported && !m.requires)
  .flatMap((model) => model.variants.map((variant) => ({ model, variant })))
  .sort((a, b) => a.variant.sizeBytes - b.variant.sizeBytes)[0]

/** A vision model's smallest variant: the model file plus its projector. */
const vision = LIBRARY.filter((m) => m.capabilities.includes('vision'))
  .flatMap((model) => model.variants.map((variant) => ({ model, variant })))
  .filter(({ variant }) => variant.source.files.length === 2)
  .sort((a, b) => a.variant.sizeBytes - b.variant.sizeBytes)[0]

async function until(ready: () => boolean): Promise<void> {
  for (let waited = 0; !ready(); waited += 5) {
    if (waited > 3000) throw new Error('timed out waiting for the download to start')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Serves every Hugging Face file as a few bytes naming it, after `gate` opens. */
function fakeHub(gate: Promise<void>): { files: string[] } {
  const seen = { files: [] as string[] }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.startsWith('https://huggingface.co/')) throw new TypeError('fetch failed')
    const file = decodeURIComponent(url.split('/resolve/main/')[1] ?? '')
    seen.files.push(file)
    const signal = init?.signal
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const aborted = new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()))
        await Promise.race([gate, aborted])
        if (signal?.aborted) return controller.error(new DOMException('The operation was aborted.', 'AbortError'))
        controller.enqueue(new TextEncoder().encode(`GGUF ${file}`))
        controller.close()
      }
    })
    return new Response(body)
  }) as typeof fetch
  return seen
}

test('a second Get on a model that is already downloading joins that download instead of failing', async () => {
  let release: () => void = () => {}
  const seen = fakeHub(new Promise((resolve) => (release = resolve)))
  const sent: ModelDownloadProgress[] = []
  const send = (_channel: string, progress: ModelDownloadProgress): void => void sent.push(progress)

  const first = pullLibraryVariant(smallest.model.id, smallest.variant.id, send)
  const second = pullLibraryVariant(smallest.model.id, smallest.variant.id, send)
  await until(() => seen.files.length > 0)
  release()

  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a, b)
  assert.deepEqual(seen.files, smallest.variant.source.files, 'each file fetched once')
  assert.ok(sent.length > 0, 'progress reached the Downloads panel')

  // The model is now in the picker's "On this computer" group, runnable by Eaon's llama.cpp.
  const local = findLocalModel(a.id)
  assert.ok(local, 'recorded as a local model')
  assert.equal(readFileSync(local.path, 'utf8'), `GGUF ${mainFile(smallest.variant)}`)
  assert.equal(localModelInfo(local).label, `${smallest.model.name} · ${smallest.variant.quant}`)

  await removeInstalledModel(a.id)
  assert.equal(findLocalModel(a.id), undefined)
  assert.equal(existsSync(local.path), false, 'the file is deleted')
})

test('a vision model downloads its projector too, and runs with it', async () => {
  fakeHub(Promise.resolve())
  const { id } = await pullLibraryVariant(vision.model.id, vision.variant.id, () => {})
  const local = findLocalModel(id)
  assert.ok(local?.mmprojPath, 'projector recorded')
  assert.match(readFileSync(local.mmprojPath, 'utf8'), /mmproj/i)
  assert.equal(localModelInfo(local).vision, true)
  await removeInstalledModel(id)
})

test('Cancel stops a joined download for everyone waiting on it', async () => {
  const seen = fakeHub(new Promise(() => {}))
  const first = pullLibraryVariant(smallest.model.id, smallest.variant.id, () => {})
  const second = pullLibraryVariant(smallest.model.id, smallest.variant.id, () => {})
  await until(() => seen.files.length > 0)

  cancelLibraryPull(smallest.model.id, smallest.variant.id)
  await assert.rejects(first, /cancelled/)
  await assert.rejects(second, /cancelled/)
})
