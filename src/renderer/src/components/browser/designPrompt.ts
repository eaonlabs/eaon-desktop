import type { DesignNote, SourceLocation } from '@shared/browser'

/**
 * Design Mode's notes as one block of context for a coding agent: each picked
 * element with what the user wants changed, where it is in the source, its
 * markup, computed styles and a screenshot. Pasted into an ADE terminal (the
 * agent opens the screenshot by its path) or added to the chat composer (the
 * screenshots go as attachments).
 */

/** Styles worth an agent's attention first; the rest follow. */
const FIRST = ['display', 'position', 'width', 'height', 'margin', 'padding', 'gap', 'color', 'background-color', 'font-size', 'font-weight', 'line-height', 'font-family', 'border', 'border-radius', 'box-shadow']

export function sourceText(source: SourceLocation | null, cwd?: string | null): string | null {
  if (!source) return null
  let file = source.file
  if (cwd && file.startsWith(cwd)) file = file.slice(cwd.length).replace(/^[\\/]/, '')
  const at = source.line ? `${file}:${source.line}${source.column ? `:${source.column}` : ''}` : file
  return source.approximate ? `${at} (approximate)` : at
}

export function formatNotes(notes: DesignNote[], options: { cwd?: string | null; screenshots: 'paths' | 'attached' }): string {
  if (notes.length === 0) return ''
  const pages = [...new Set(notes.map((n) => n.element.url))]
  const first = notes[0].element
  const where = pages.length === 1 ? `on ${first.url}${first.title ? ` (“${first.title}”)` : ''}` : `on ${pages.length} pages`
  const lines: string[] = [`Design Mode: ${notes.length === 1 ? '1 element' : `${notes.length} elements`} picked in the browser ${where}.`, '']

  notes.forEach((note, index) => {
    const el = note.element
    const ask = note.note.trim()
    lines.push(`${index + 1}. <${el.label}>${ask ? ` — ${ask.replace(/\n+/g, ' ')}` : ''}`)
    if (pages.length > 1) lines.push(`   Page: ${el.url}`)
    const source = sourceText(el.source, options.cwd)
    if (source) lines.push(`   Source: ${source}`)
    if (el.components.length) lines.push(`   Components: ${el.components.slice(0, 4).join(' › ')}`)
    lines.push(`   Selector: ${el.selector}`)
    lines.push(
      `   Box: ${Math.round(el.rect.width)}×${Math.round(el.rect.height)} at ${Math.round(el.rect.x)},${Math.round(el.rect.y)} in a ${el.viewport.width}×${el.viewport.height} viewport`
    )
    if (el.text) lines.push(`   Text: “${el.text.length > 140 ? `${el.text.slice(0, 140)}…` : el.text}”`)
    const styles = Object.entries(el.styles).sort(([a], [b]) => rank(a) - rank(b))
    if (styles.length) lines.push(`   Computed styles: ${styles.map(([k, v]) => `${k}: ${v}`).join('; ')}`)
    if (note.screenshot) lines.push(options.screenshots === 'paths' ? `   Screenshot: ${note.screenshot}` : `   Screenshot: attached (${index + 1})`)
    if (el.parentTag) lines.push(`   Inside: ${el.parentTag}`)
    lines.push('   Markup:')
    for (const line of el.html.split('\n').slice(0, 30)) lines.push(`     ${line}`)
    lines.push('')
  })
  return `${lines.join('\n').trimEnd()}\n`
}

function rank(prop: string): number {
  const index = FIRST.indexOf(prop)
  return index === -1 ? FIRST.length : index
}
