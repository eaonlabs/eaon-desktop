/**
 * Drawing LaTeX with KaTeX, kept free of React so the main process test
 * harness can check it.
 *
 * KaTeX and its stylesheet and fonts are not part of the first load: they are
 * fetched the first time a reply has a formula in it (`loadKatex`), so a chat
 * without maths never pays for them. Until they arrive, and for any formula
 * KaTeX cannot read, the formula stays as the LaTeX it was written in.
 */

type Katex = typeof import('katex').default

/** A formula longer than this is shown as written: nobody types one, and a model gone wrong can send megabytes. */
const MAX_SOURCE = 8000
const CACHE_LIMIT = 400

let katex: Katex | null = null
let loading: Promise<boolean> | null = null
// Settled streaming re-renders draw the same formulas again; null is a formula that did not parse.
const drawn = new Map<string, string | null>()

/** Hands over an already loaded KaTeX: the loader uses it, and tests draw with it directly. */
export function provideKatex(module: Katex | null): void {
  katex = module
  drawn.clear()
}

export const katexReady = (): boolean => katex !== null

/**
 * Loads KaTeX and its stylesheet (bundled, with its fonts: nothing is fetched
 * from the web), once. Resolves false when that failed, and the next call tries again.
 */
export function loadKatex(): Promise<boolean> {
  if (katex) return Promise.resolve(true)
  loading ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(
    ([module]) => {
      provideKatex(module.default)
      return true
    },
    () => {
      loading = null
      return false
    }
  )
  return loading
}

/**
 * A formula as KaTeX's markup, or null when it is not valid LaTeX (or too big).
 * Links, images and style hooks in the LaTeX stay off (`trust`), so the markup
 * is only ever what KaTeX makes of maths, with the text in it escaped.
 */
export function renderMath(engine: Katex, src: string, display: boolean): string | null {
  if (!src.trim() || src.length > MAX_SOURCE) return null
  try {
    return engine.renderToString(src, {
      displayMode: display,
      throwOnError: true,
      output: 'htmlAndMathml',
      trust: false,
      strict: 'ignore',
      // A rule or space of a million ems is a way to lock up the page, not maths.
      maxSize: 50,
      maxExpand: 1000
    })
  } catch {
    return null
  }
}

/** The markup for a formula, or null while KaTeX is still loading and when the formula is not valid. */
export function drawMath(src: string, display: boolean): string | null {
  if (!katex) return null
  const key = `${display ? 'd' : 'i'}\n${src}`
  const known = drawn.get(key)
  if (known !== undefined) return known
  const html = renderMath(katex, src, display)
  if (drawn.size >= CACHE_LIMIT) drawn.delete(drawn.keys().next().value as string)
  drawn.set(key, html)
  return html
}
