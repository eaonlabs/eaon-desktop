import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import { toolsFor, type ToolContext } from '../src/main/agent/tools'
import { aspectRatio, geminiAspect, NO_KEY, openaiSize, slugFor } from '../src/main/features/images/generate'
import { createGenerateImageTool } from '../src/main/features/images/tool'
import { store } from '../src/main/store'
import type { StreamRequest } from '@shared/types'

/**
 * generate_image against fake OpenAI and Gemini endpoints: every real call
 * costs money, so nothing here leaves the machine.
 */

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

interface Seen {
  url: string
  headers: Record<string, string>
  body: unknown
}

function fakeFetch(reply: (seen: Seen) => Response): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = []
  const fake = (async (url: string | URL, init?: RequestInit) => {
    const body = init?.body instanceof FormData ? init.body : typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body
    const entry = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body }
    seen.push(entry)
    return reply(entry)
  }) as typeof fetch
  return { fetch: fake, seen }
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

function context(cwd: string): { ctx: ToolContext; stages: string[] } {
  const stages: string[] = []
  const ctx = { cwd, signal: new AbortController().signal, progress: (stage: string) => stages.push(stage) } as unknown as ToolContext
  return { ctx, stages }
}

const keys =
  (saved: Record<string, string>) =>
  (provider: string): string | undefined =>
    saved[provider]

test('OpenAI first: gpt-image-1 with the size for the shape, saved under images/ with the prompt as the name', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-img-'))
  const api = fakeFetch(() => json({ data: [{ b64_json: PIXEL }, { b64_json: PIXEL }] }))
  const tool = createGenerateImageTool({ keys: keys({ openai: 'sk-test', gemini: 'g-test' }), fetch: api.fetch })
  const { ctx, stages } = context(cwd)
  const result = await tool.run({ prompt: 'A red fox in fresh snow, morning light', aspect: 'landscape', count: 2 }, ctx)
  assert.ok(typeof result !== 'string')

  assert.equal(api.seen.length, 1)
  assert.equal(api.seen[0].url, 'https://api.openai.com/v1/images/generations')
  assert.equal(api.seen[0].headers.Authorization, 'Bearer sk-test')
  assert.deepEqual(api.seen[0].body, { model: 'gpt-image-1', prompt: 'A red fox in fresh snow, morning light', n: 2, size: '1536x1024' })

  const paths = [join(cwd, 'images', 'a-red-fox-in-fresh-snow-1.png'), join(cwd, 'images', 'a-red-fox-in-fresh-snow-2.png')]
  for (const path of paths) assert.deepEqual(readFileSync(path), Buffer.from(PIXEL, 'base64'))
  assert.match(result.text, /Generated 2 images with OpenAI gpt-image-1 \(1536x1024\)/)
  for (const path of paths) assert.ok(result.text.includes(`- ${path}`), 'each path on a "- " line for the card')
  assert.equal(result.images?.length, 2, 'the model sees what it made')
  assert.ok(stages[0].startsWith('Asking OpenAI (gpt-image-1) for 2 images'))
})

test('OpenAI edits send the images as multipart image[] to /images/edits', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-img-'))
  writeFileSync(join(cwd, 'logo.png'), Buffer.from(PIXEL, 'base64'))
  const api = fakeFetch(() => json({ data: [{ b64_json: PIXEL }] }))
  const tool = createGenerateImageTool({ keys: keys({ openai: 'sk-test' }), fetch: api.fetch })
  const { ctx } = context(cwd)
  const result = await tool.run({ prompt: 'Make the logo blue', edit: ['logo.png'], name: 'Blue logo' }, ctx)
  assert.equal(api.seen[0].url, 'https://api.openai.com/v1/images/edits')
  const form = api.seen[0].body as FormData
  assert.equal(form.get('model'), 'gpt-image-1')
  assert.equal(form.get('prompt'), 'Make the logo blue')
  assert.equal(form.getAll('image[]').length, 1)
  assert.ok(typeof result !== 'string' && result.text.startsWith('Edited an image'))
  assert.ok(existsSync(join(cwd, 'images', 'blue-logo.png')))
})

test('Gemini when there is no OpenAI key: one request per image, the ratio in imageConfig, edits as inline_data', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-img-'))
  writeFileSync(join(cwd, 'room.jpg'), Buffer.from(PIXEL, 'base64'))
  const api = fakeFetch(() => json({ candidates: [{ content: { parts: [{ text: 'Here you go' }, { inlineData: { mimeType: 'image/png', data: PIXEL } }] } }] }))
  const tool = createGenerateImageTool({ keys: keys({ gemini: 'g-test' }), fetch: api.fetch })
  const { ctx, stages } = context(cwd)
  const result = await tool.run({ prompt: 'Paint the room green', aspect: '16:9', count: 2, edit: ['room.jpg'] }, ctx)
  assert.equal(api.seen.length, 2)
  assert.equal(api.seen[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent')
  assert.equal(api.seen[0].headers['x-goog-api-key'], 'g-test')
  const body = api.seen[0].body as { contents: { parts: Record<string, unknown>[] }[]; generationConfig: Record<string, unknown> }
  assert.deepEqual(body.generationConfig, { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } })
  assert.deepEqual(body.contents[0].parts[0], { text: 'Paint the room green' })
  assert.deepEqual(body.contents[0].parts[1], { inline_data: { mime_type: 'image/jpeg', data: PIXEL } })
  assert.ok(typeof result !== 'string' && /Edited 2 images with Gemini gemini-2.5-flash-image \(16:9\)/.test(result.text))
  assert.ok(stages.includes('Image 2 of 2 ready…'))
})

test('no key: a message naming both keys and where to add them', async () => {
  const tool = createGenerateImageTool({ keys: keys({}), fetch: fakeFetch(() => json({})).fetch })
  await assert.rejects(Promise.resolve(tool.run({ prompt: 'x' }, context(mkdtempSync(join(tmpdir(), 'eaon-img-'))).ctx)), (error: Error) => error.message === NO_KEY)
  assert.match(NO_KEY, /OpenAI or Gemini API key.*Settings → Model providers/)
})

test("an API's own error message comes through, and a refused key says to check it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-img-'))
  const policy = createGenerateImageTool({
    keys: keys({ openai: 'sk-test' }),
    fetch: fakeFetch(() => json({ error: { message: 'Your request was rejected by the safety system.' } }, 400)).fetch
  })
  await assert.rejects(Promise.resolve(policy.run({ prompt: 'x' }, context(cwd).ctx)), /OpenAI answered 400: Your request was rejected by the safety system\./)
  const refused = createGenerateImageTool({ keys: keys({ gemini: 'bad' }), fetch: fakeFetch(() => json({ error: { message: 'API key not valid' } }, 403)).fetch })
  await assert.rejects(Promise.resolve(refused.run({ prompt: 'x' }, context(cwd).ctx)), /Gemini refused the API key \(403\): API key not valid\. Check it in Settings/)
})

test('Gemini without a picture says why', async () => {
  const tool = createGenerateImageTool({
    keys: keys({ gemini: 'g' }),
    fetch: fakeFetch(() => json({ candidates: [{ content: { parts: [] }, finishReason: 'IMAGE_SAFETY' }] })).fetch
  })
  await assert.rejects(Promise.resolve(tool.run({ prompt: 'x' }, context(mkdtempSync(join(tmpdir(), 'eaon-img-'))).ctx)), /Gemini returned no image \(IMAGE_SAFETY\)/)
})

test('an image already there is never overwritten', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-img-'))
  const tool = createGenerateImageTool({ keys: keys({ openai: 'sk' }), fetch: fakeFetch(() => json({ data: [{ b64_json: PIXEL }] })).fetch })
  await tool.run({ prompt: 'Sunset' }, context(cwd).ctx)
  await tool.run({ prompt: 'Sunset' }, context(cwd).ctx)
  assert.ok(existsSync(join(cwd, 'images', 'sunset.png')))
  assert.ok(existsSync(join(cwd, 'images', 'sunset-2.png')))
})

test('shapes map to each provider, and names come from the prompt', () => {
  assert.equal(openaiSize('square'), '1024x1024')
  assert.equal(openaiSize('16:9'), '1536x1024')
  assert.equal(openaiSize('9:16'), '1024x1536')
  assert.equal(geminiAspect('landscape'), '3:2')
  assert.equal(geminiAspect('21:9'), '21:9')
  assert.equal(geminiAspect(undefined), '1:1')
  assert.equal(aspectRatio('portrait'), 2 / 3)
  assert.equal(aspectRatio('16:9'), 16 / 9)
  assert.equal(slugFor('Café logo — "Bold" & bright, v2!'), 'cafe-logo-bold-bright-v2')
  assert.equal(slugFor('!!!'), 'image')
})

test('offered to the agent and to workers, never in plan mode or to sub-agents, and it says it is billed', () => {
  const settings = store.getSettings()
  const request = { mode: 'work', work: { swarm: false, plan: false }, goal: null } as unknown as StreamRequest
  const names = (over: Partial<{ readOnly: boolean; depth: number; mode: 'work' | 'chat' }>): string[] =>
    toolsFor({ mode: 'work', cwd: '/tmp', depth: 0, readOnly: false, settings, request, ...over }).map((tool) => tool.name)
  assert.ok(names({}).includes('generate_image'))
  assert.ok(!names({ readOnly: true }).includes('generate_image'), 'plan mode leaves it out')
  assert.ok(!names({ depth: 1 }).includes('generate_image'))
  assert.ok(!names({ mode: 'chat' }).includes('generate_image'))
  const tool = createGenerateImageTool()
  assert.equal(tool.mutating, true)
  assert.equal(tool.catastrophic, undefined)
  assert.match(tool.describe!({ prompt: 'A fox', count: 3 }), /^Generate 3 images \(billed to your OpenAI or Gemini key\): A fox$/)
})

test('the card reads the saved files and the provider back from the result', async () => {
  const { generatedPaths, madeWith } = await import('../src/renderer/src/components/agent/imageResults')
  const output = 'Generated 2 images with OpenAI gpt-image-1 (1536x1024), saved in the work folder:\n- /w/images/fox-1.png\n- /w/images/fox 2.webp'
  assert.deepEqual(generatedPaths(output), ['/w/images/fox-1.png', '/w/images/fox 2.webp'])
  assert.equal(madeWith(output), 'OpenAI · gpt-image-1')
  assert.deepEqual(generatedPaths('Error: OpenAI answered 400'), [])
  assert.equal(madeWith(null), null)
})

test('a generated image keeps a row of its own in the turn, outside any folded run', async () => {
  const { turnItems } = await import('../src/renderer/src/components/agent/turnItems')
  const tool = (id: string, name: string) => ({ type: 'tool' as const, id, name, input: {}, output: null, status: 'done' as const })
  const items = turnItems([tool('a', 'read_file'), tool('b', 'generate_image'), tool('c', 'read_file')])
  assert.deepEqual(
    items.map((item) => (item.kind === 'steps' ? item.steps.map((s) => (s.kind === 'tool' ? s.part.name : 'thought')) : item.kind)),
    [['read_file'], ['generate_image'], ['read_file']]
  )
})

test('an answer that isn’t an image is refused before anything is saved', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-img-bad-'))
  const { fetch } = fakeFetch(() => json({ data: [{ b64_json: Buffer.from('<html>error page</html>').toString('base64') }] }))
  const tool = createGenerateImageTool({ keys: keys({ openai: 'sk' }), fetch })
  await assert.rejects(tool.run({ prompt: 'a cat' }, context(cwd).ctx), /isn't a readable image\. Nothing was saved/)
  assert.equal(existsSync(join(cwd, 'images')), false)
})

test('an image too big for the providers to edit is refused with what to do', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-img-big-'))
  writeFileSync(join(cwd, 'huge.png'), Buffer.alloc(21 * 1024 * 1024))
  const { fetch, seen } = fakeFetch(() => json({ data: [{ b64_json: PIXEL }] }))
  const tool = createGenerateImageTool({ keys: keys({ openai: 'sk' }), fetch })
  await assert.rejects(tool.run({ prompt: 'brighter', edit: ['huge.png'] }, context(cwd).ctx), /21 MB; image providers take up to 20 MB/)
  await assert.rejects(tool.run({ prompt: 'brighter', edit: ['missing.png'] }, context(cwd).ctx), /doesn't exist/)
  assert.equal(seen.length, 0, 'nothing was sent, so nothing was billed')
})
