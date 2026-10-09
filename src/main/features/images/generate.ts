import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { aspectRatio, IMAGE_ASPECTS } from '@shared/images'

/**
 * Image generation through the user's own keys: OpenAI's Images API first,
 * Gemini's image model when there is no OpenAI key. Network and keys come in
 * as dependencies so tests never reach a real API (each call costs money).
 *
 *   OpenAI   POST /v1/images/generations  { model, prompt, n, size }        → data[].b64_json
 *            POST /v1/images/edits        multipart: image[], prompt, n    → data[].b64_json
 *   Gemini   POST /v1beta/models/<model>:generateContent
 *            parts: text (+ inline_data to edit), generationConfig.responseModalities
 *            ["IMAGE"] and imageConfig.aspectRatio → candidates[0].content.parts[].inlineData
 *            One image per request, so several are asked for side by side.
 */

export const OPENAI_IMAGE_MODEL = 'gpt-image-1'
export const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image'
const OPENAI_BASE = 'https://api.openai.com/v1'
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'

export type ImageProvider = 'openai' | 'gemini'

export { IMAGE_ASPECTS as ASPECTS, aspectRatio }

const GEMINI_RATIOS = new Set(['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'])

/** gpt-image-1 offers three sizes: square, 3:2 and 2:3. */
export function openaiSize(aspect: string | undefined): string {
  const ratio = aspectRatio(aspect)
  return ratio > 1.15 ? '1536x1024' : ratio < 0.87 ? '1024x1536' : '1024x1024'
}

export function geminiAspect(aspect: string | undefined): string {
  if (aspect === 'landscape') return '3:2'
  if (aspect === 'portrait') return '2:3'
  return aspect && GEMINI_RATIOS.has(aspect) ? aspect : '1:1'
}

export interface SourceImage {
  path: string
  mime: string
  data: Buffer
}

export interface GeneratedImage {
  mime: string
  data: Buffer
}

export interface GenerateRequest {
  prompt: string
  aspect?: string
  count: number
  /** Images to change or combine, read from the work folder. */
  edit: SourceImage[]
  /** Use this provider rather than the first one with a key. */
  provider?: ImageProvider
}

export interface GenerateDeps {
  keys: (provider: ImageProvider) => string | undefined
  fetch: typeof fetch
  signal?: AbortSignal
  /** One line saying what is happening now, for the transcript. */
  progress?: (stage: string) => void
}

export interface GenerateOutcome {
  provider: ImageProvider
  model: string
  /** What was asked for, as the provider's own size or ratio. */
  shape: string
  images: GeneratedImage[]
}

export const NO_KEY =
  'Image generation needs an OpenAI or Gemini API key, and neither is saved. Add one in Settings → Model providers (OpenAI, or Gemini from Google AI Studio), then try again.'

export function chooseProvider(keys: GenerateDeps['keys'], wanted?: ImageProvider): ImageProvider | null {
  if (wanted) return keys(wanted) ? wanted : null
  if (keys('openai')) return 'openai'
  if (keys('gemini')) return 'gemini'
  return null
}

/** The API's own error message, when its body has one. */
async function failure(response: Response, provider: string): Promise<Error> {
  let detail = ''
  try {
    const body = (await response.json()) as { error?: { message?: string } | string }
    detail = typeof body.error === 'string' ? body.error : (body.error?.message ?? '')
  } catch {
    /* not JSON */
  }
  if (response.status === 401 || response.status === 403) {
    return new Error(`${provider} refused the API key (${response.status})${detail ? `: ${detail}` : ''}. Check it in Settings → Model providers.`)
  }
  return new Error(`${provider} answered ${response.status}${detail ? `: ${detail}` : '.'}`)
}

async function openai(request: GenerateRequest, key: string, deps: GenerateDeps): Promise<GenerateOutcome> {
  const size = openaiSize(request.aspect)
  let response: Response
  if (request.edit.length > 0) {
    const form = new FormData()
    form.append('model', OPENAI_IMAGE_MODEL)
    form.append('prompt', request.prompt)
    form.append('n', String(request.count))
    form.append('size', size)
    for (const image of request.edit) {
      form.append('image[]', new Blob([new Uint8Array(image.data)], { type: image.mime }), image.path.split(/[\\/]/).pop() ?? 'image.png')
    }
    response = await deps.fetch(`${OPENAI_BASE}/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: deps.signal
    })
  } else {
    response = await deps.fetch(`${OPENAI_BASE}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OPENAI_IMAGE_MODEL, prompt: request.prompt, n: request.count, size }),
      signal: deps.signal
    })
  }
  if (!response.ok) throw await failure(response, 'OpenAI')
  const body = (await response.json()) as { data?: { b64_json?: string }[] }
  const images = (body.data ?? []).flatMap((item) => (item.b64_json ? [{ mime: 'image/png', data: Buffer.from(item.b64_json, 'base64') }] : []))
  if (images.length === 0) throw new Error('OpenAI answered without an image.')
  return { provider: 'openai', model: OPENAI_IMAGE_MODEL, shape: size, images }
}

interface GeminiPart {
  text?: string
  inlineData?: { mimeType?: string; data?: string }
  inline_data?: { mime_type?: string; data?: string }
}

async function geminiOne(request: GenerateRequest, key: string, deps: GenerateDeps): Promise<GeneratedImage> {
  const parts: Record<string, unknown>[] = [{ text: request.prompt }]
  for (const image of request.edit) parts.push({ inline_data: { mime_type: image.mime, data: image.data.toString('base64') } })
  const response = await deps.fetch(`${GEMINI_BASE}/models/${GEMINI_IMAGE_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: geminiAspect(request.aspect) } }
    }),
    signal: deps.signal
  })
  if (!response.ok) throw await failure(response, 'Gemini')
  const body = (await response.json()) as {
    candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[]
    promptFeedback?: { blockReason?: string }
  }
  const candidate = body.candidates?.[0]
  for (const part of candidate?.content?.parts ?? []) {
    const inline = part.inlineData ?? (part.inline_data ? { mimeType: part.inline_data.mime_type, data: part.inline_data.data } : undefined)
    if (inline?.data) return { mime: inline.mimeType || 'image/png', data: Buffer.from(inline.data, 'base64') }
  }
  // No picture: Gemini says why in a text part, a block reason or a finish reason.
  const said = (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join(' ').trim()
  const reason = said || body.promptFeedback?.blockReason || candidate?.finishReason || 'no reason given'
  throw new Error(`Gemini returned no image (${reason}).`)
}

async function gemini(request: GenerateRequest, key: string, deps: GenerateDeps): Promise<GenerateOutcome> {
  let done = 0
  const images = await Promise.all(
    Array.from({ length: request.count }, async () => {
      const image = await geminiOne(request, key, deps)
      done++
      if (request.count > 1) deps.progress?.(`Image ${done} of ${request.count} ready…`)
      return image
    })
  )
  return { provider: 'gemini', model: GEMINI_IMAGE_MODEL, shape: geminiAspect(request.aspect), images }
}

export async function generateImages(request: GenerateRequest, deps: GenerateDeps): Promise<GenerateOutcome> {
  const provider = chooseProvider(deps.keys, request.provider)
  if (!provider) {
    throw new Error(
      request.provider
        ? `No ${request.provider === 'openai' ? 'OpenAI' : 'Gemini'} API key is saved. Add one in Settings → Model providers, or leave provider out to use whichever key there is.`
        : NO_KEY
    )
  }
  const key = deps.keys(provider)!
  const what = request.count === 1 ? 'an image' : `${request.count} images`
  deps.progress?.(
    `${request.edit.length > 0 ? 'Editing with' : 'Asking'} ${provider === 'openai' ? `OpenAI (${OPENAI_IMAGE_MODEL})` : `Gemini (${GEMINI_IMAGE_MODEL})`} for ${what}…`
  )
  return provider === 'openai' ? openai(request, key, deps) : gemini(request, key, deps)
}

const EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }

/** A file name from the prompt: its first few words, lower-case and dashed. */
export function slugFor(prompt: string, name?: string): string {
  const source = name?.trim() || prompt
  const slug = source
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter(Boolean)
    .slice(0, name ? 12 : 6)
    .join('-')
    .slice(0, 60)
    .replace(/-+$/, '')
  return slug || 'image'
}

/**
 * Writes the images into `<folder>/images/` and returns their paths. A name
 * already taken gets a number rather than being overwritten.
 */
export async function saveImages(folder: string, slug: string, images: GeneratedImage[]): Promise<string[]> {
  const dir = join(folder, 'images')
  await mkdir(dir, { recursive: true })
  const paths: string[] = []
  for (let i = 0; i < images.length; i++) {
    const ext = EXT[images[i].mime] ?? '.png'
    const base = images.length === 1 ? slug : `${slug}-${i + 1}`
    let path = join(dir, `${base}${ext}`)
    for (let n = 2; existsSync(path) || paths.includes(path); n++) path = join(dir, `${base}-${n}${ext}`)
    await writeFile(path, images[i].data)
    // Said to be saved only once it really is (a full disk can leave nothing).
    const written = await stat(path).catch(() => null)
    if (!written || written.size !== images[i].data.length) throw new Error(`Couldn't save the image to ${path}. Check there is space on the disk and that the folder can be written to.`)
    paths.push(path)
  }
  return paths
}

const MIME_BY_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/** The largest image either provider takes to edit (OpenAI: 25 MB per file; Gemini: 20 MB per request). */
export const MAX_EDIT_BYTES = 20 * 1024 * 1024

/** An image to edit, read from disk. Only the formats both providers take, and small enough for them. */
export async function readSource(path: string): Promise<SourceImage> {
  const mime = MIME_BY_EXT[extname(path).toLowerCase()]
  if (!mime) throw new Error(`${path} is not a PNG, JPEG or WebP image.`)
  const info = await stat(path).catch(() => null)
  if (!info) throw new Error(`${path} doesn't exist.`)
  if (info.size > MAX_EDIT_BYTES) {
    throw new Error(`${path} is ${Math.round(info.size / (1024 * 1024))} MB; image providers take up to 20 MB. Make a smaller copy first (for example with sips or ImageMagick).`)
  }
  return { path, mime, data: await readFile(path) }
}
