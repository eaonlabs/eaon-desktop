import { nativeImage } from 'electron'
import { registerToolSource, type AgentTool, type ToolContext, type ToolResult } from '../../agent/tools'
import type { NeutralImage } from '../../providers/adapters/types'
import { resolveWorkPath } from '../../localTools'
import { secrets } from '../../secrets'
import { ASPECTS, generateImages, readSource, saveImages, slugFor, type GenerateDeps, type GeneratedImage, type ImageProvider } from './generate'

/**
 * `generate_image`: pictures from the user's OpenAI or Gemini key, saved in
 * the work folder (a worker's own folder for a worker) under `images/`.
 *
 * It writes files, so it is mutating: plan mode leaves it out, Ask first asks,
 * and scheduled runs follow their policy. Each call is billed to the user's
 * key, which the approval line says. The model gets a smaller JPEG of each
 * image to look at; the files on disk are the full ones.
 */

export const GENERATE_IMAGE = 'generate_image'

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

function count(input: Record<string, unknown>): number {
  const n = Math.round(Number(input.count))
  return Number.isFinite(n) ? Math.min(4, Math.max(1, n)) : 1
}

/** A copy small enough to send back to the model: the long edge at most 1024px. */
function forModel(image: GeneratedImage): NeutralImage {
  try {
    const picture = nativeImage.createFromBuffer(image.data)
    const { width, height } = picture.getSize()
    const scale = Math.min(1, 1024 / Math.max(width, height))
    const small = (scale < 1 ? picture.resize({ width: Math.round(width * scale), height: Math.round(height * scale) }) : picture).toJPEG(85)
    if (small.length > 0) return { mime: 'image/jpeg', data: small.toString('base64') }
  } catch {
    /* fall back to the original */
  }
  return { mime: image.mime, data: image.data.toString('base64') }
}

export function createGenerateImageTool(deps: Partial<Pick<GenerateDeps, 'keys' | 'fetch'>> = {}): AgentTool {
  const keys = deps.keys ?? ((provider: ImageProvider) => secrets.get(provider))
  return {
    name: GENERATE_IMAGE,
    description:
      "Make images from a text prompt with the user's OpenAI or Gemini key, or change existing ones (pass them in edit). Saved under images/ in the work folder. Each call is billed to the user's key: make one image unless asked for more.",
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What the image shows: subject, style, composition, any text in it' },
        aspect: { type: 'string', enum: [...ASPECTS], description: 'Shape; square by default' },
        count: { type: 'number', description: '1 to 4; default 1' },
        edit: { type: 'array', items: { type: 'string' }, description: 'Images (paths) to change or combine, following the prompt' },
        name: { type: 'string', description: 'Short file name; taken from the prompt if omitted' },
        provider: { type: 'string', enum: ['openai', 'gemini'], description: 'Only when the user asks for one' }
      },
      required: ['prompt']
    },
    mutating: true,
    describe: (input) => {
      const n = count(input)
      const what = Array.isArray(input.edit) && input.edit.length > 0 ? 'Edit an image' : n === 1 ? 'Generate an image' : `Generate ${n} images`
      return `${what} (billed to your OpenAI or Gemini key): ${str(input.prompt)}`
    },
    run: async (input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
      const prompt = str(input.prompt)
      if (!prompt) throw new Error('prompt is empty.')
      const edit = await Promise.all(
        (Array.isArray(input.edit) ? input.edit : [])
          .filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
          .slice(0, 4)
          .map((path) => readSource(resolveWorkPath(ctx.cwd, path).path))
      )
      const provider = input.provider === 'openai' || input.provider === 'gemini' ? input.provider : undefined
      const outcome = await generateImages(
        { prompt, aspect: str(input.aspect) || undefined, count: count(input), edit, provider },
        { keys, fetch: deps.fetch ?? fetch, signal: ctx.signal, progress: ctx.progress }
      )
      // What came back must be a picture before anything is saved or reported.
      const pictures = outcome.images.filter((image) => !nativeImage.createFromBuffer(image.data).isEmpty())
      if (pictures.length === 0) throw new Error(`${outcome.provider === 'openai' ? 'OpenAI' : 'Gemini'} sent back something that isn't a readable image. Nothing was saved; try again.`)
      outcome.images = pictures
      ctx.progress(`Saving ${outcome.images.length === 1 ? 'the image' : `${outcome.images.length} images`}…`)
      const paths = await saveImages(ctx.cwd, slugFor(prompt, str(input.name) || undefined), outcome.images)
      const made = paths.length === 1 ? 'an image' : `${paths.length} images`
      const by = outcome.provider === 'openai' ? `OpenAI ${outcome.model}` : `Gemini ${outcome.model}`
      return {
        // The card in the transcript reads the paths from these "- " lines.
        text: `${edit.length > 0 ? 'Edited' : 'Generated'} ${made} with ${by} (${outcome.shape}), saved in the work folder:\n${paths.map((path) => `- ${path}`).join('\n')}`,
        images: outcome.images.map(forModel)
      }
    }
  }
}

const tool = createGenerateImageTool()

registerToolSource({
  id: 'images',
  // Chat (the agent) and workers; it needs a folder to save into. Not offered
  // to swarm sub-agents, which run in parallel and would each bill the key.
  tools: (query) => (query.mode === 'work' && query.depth === 0 ? [tool] : []),
  guidance: () =>
    "generate_image bills the user's OpenAI or Gemini key per image, so make one unless asked for more. To change an image you made, pass its path in edit rather than starting over. Tell the user where the files are."
})
