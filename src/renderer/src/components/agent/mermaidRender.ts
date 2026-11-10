/**
 * Drawing Mermaid diagrams, kept free of React so the main process test
 * harness can check it.
 *
 * Mermaid is large (the library and a chunk per diagram kind), so it is
 * fetched the first time a reply has a ```mermaid block in it (`loadMermaid`),
 * and a chat without diagrams never pays for it. Its own files ship with the
 * app; nothing is loaded from the web.
 *
 * The drawing is handed back as an image, not as markup: Mermaid's SVG is
 * shown in an <img>, where it can run no script and reach nothing of the app,
 * whatever a reply puts in the diagram. On top of that Mermaid runs at its
 * strictest level (`securityLevel: 'strict'`: labels escaped, click handlers
 * off). A diagram Mermaid can't read comes back as `{ ok: false }` and the
 * reply keeps its code block.
 */

import type { MermaidConfig } from 'mermaid'

type Mermaid = typeof import('mermaid').default
export type DiagramEngine = Pick<Mermaid, 'initialize' | 'render'>

/** A diagram longer than this is left as code: it is a model gone wrong, and layout time grows with it. */
const MAX_SOURCE = 20_000
const CACHE_LIMIT = 40

export type Diagram = { ok: true; src: string; width: number | null; height: number | null } | { ok: false }
const FAILED: Diagram = { ok: false }

let engine: DiagramEngine | null = null
let loading: Promise<DiagramEngine | null> | null = null
let queue: Promise<unknown> = Promise.resolve()
let counter = 0
// Re-renders and re-mounts (a theme change, scrolling back) draw the same diagram again.
const drawn = new Map<string, Diagram>()

/** Loads Mermaid, once. Null when that failed, and the next call tries again. */
export function loadMermaid(): Promise<DiagramEngine | null> {
  if (engine) return Promise.resolve(engine)
  loading ??= import('mermaid').then(
    (module) => {
      engine = module.default
      return engine
    },
    () => {
      loading = null
      return null
    }
  )
  return loading
}

/** Mermaid's settings: strict, no automatic scan of the page, no error graphic, colours for the app's theme. */
export function diagramConfig(dark: boolean): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    // The picture is an image of its own, which has no page styles to take
    // fonts or colours from: labels are plain SVG text, in a system font.
    htmlLabels: false,
    theme: dark ? 'dark' : 'neutral',
    fontFamily: 'ui-sans-serif, -apple-system, system-ui, "Segoe UI", Helvetica, Arial, sans-serif',
    // Failures are the caller's to show (the code block); Mermaid's own error picture and console noise stay off.
    suppressErrorRendering: true,
    logLevel: 'fatal',
    maxTextSize: MAX_SOURCE
  }
}

/** The drawing's size from its viewBox, so the image is shown at the size it was laid out in. */
export function svgSize(svg: string): { width: number; height: number } | null {
  const match = /<svg\b[^>]*?\sviewBox="\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(svg)
  if (!match) return null
  const width = Math.round(Number(match[3]))
  const height = Math.round(Number(match[4]))
  return width > 0 && height > 0 ? { width, height } : null
}

export const svgDataUri = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

/** One at a time: Mermaid lays diagrams out in a hidden element of the page and keeps settings of its own. */
function inTurn<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job)
  queue = run.catch(() => undefined)
  return run
}

/** Mermaid's measuring elements, which it leaves in the page when a diagram fails. */
function removeLeftovers(id: string): void {
  if (typeof document === 'undefined') return
  for (const prefix of ['', 'd', 'i']) document.getElementById(`${prefix}${id}`)?.remove()
}

/**
 * The diagram `source` describes, as an image to show, or `{ ok: false }` when
 * Mermaid can't read it (or it is empty or too big). `load` is how the engine
 * is fetched, replaceable for tests.
 */
export async function drawDiagram(source: string, dark: boolean, load: () => Promise<DiagramEngine | null> = loadMermaid): Promise<Diagram> {
  const text = source.trim()
  if (!text || text.length > MAX_SOURCE) return FAILED
  const key = `${dark ? 'd' : 'l'}\n${text}`
  const known = drawn.get(key)
  if (known) return known
  const mermaid = await load()
  if (!mermaid) return FAILED
  const result = await inTurn(async (): Promise<Diagram> => {
    const id = `eaon-diagram-${++counter}`
    try {
      mermaid.initialize(diagramConfig(dark))
      const { svg } = await mermaid.render(id, text)
      if (!/^\s*<svg[\s>]/.test(svg)) return FAILED
      const size = svgSize(svg)
      return { ok: true, src: svgDataUri(svg), width: size?.width ?? null, height: size?.height ?? null }
    } catch {
      return FAILED
    } finally {
      removeLeftovers(id)
    }
  })
  if (drawn.size >= CACHE_LIMIT) drawn.delete(drawn.keys().next().value as string)
  drawn.set(key, result)
  return result
}

/** A diagram already drawn, for showing at once when a block comes back on screen. */
export const knownDiagram = (source: string, dark: boolean): Diagram | null => drawn.get(`${dark ? 'd' : 'l'}\n${source.trim()}`) ?? null

/** Forgets every drawing (tests). */
export function forgetDiagrams(): void {
  drawn.clear()
}
