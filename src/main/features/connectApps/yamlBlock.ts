import { ConfigError } from './files'

/**
 * Adds, replaces or removes one child block under a top-level key of a
 * block-style YAML file (`providers:` → `  eaon:` and what's indented under
 * it), leaving every other line as it was. Flow style beyond an empty `{}`,
 * and tab indentation, are refused rather than rewritten.
 */

const yamlString = (value: string): string => JSON.stringify(value)

/** Renders a small nested object as block YAML, `indent` spaces deep. */
export function yamlLines(value: Record<string, unknown>, indent: number): string[] {
  const pad = ' '.repeat(indent)
  const out: string[] = []
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item)) {
      out.push(`${pad}${key}:`)
      for (const entry of item) {
        if (entry && typeof entry === 'object') {
          const inner = yamlLines(entry as Record<string, unknown>, indent + 4)
          out.push(`${pad}  - ${inner[0].trimStart()}`, ...inner.slice(1))
        } else out.push(`${pad}  - ${scalar(entry)}`)
      }
    } else if (item && typeof item === 'object') {
      out.push(`${pad}${key}:`, ...yamlLines(item as Record<string, unknown>, indent + 2))
    } else out.push(`${pad}${key}: ${scalar(item)}`)
  }
  return out
}

function scalar(value: unknown): string {
  return typeof value === 'string' ? yamlString(value) : String(value)
}

interface Parent {
  line: number
  /** Indentation of its children, from the first one; null when it has none yet. */
  childIndent: number | null
  /** Last line (inclusive) that belongs to the parent's block. */
  end: number
}

function findParent(lines: string[], parentKey: string): Parent | 'flow' | null {
  if (lines.some((line) => /^\t/.test(line) || /^ *\t/.test(line))) {
    throw new ConfigError('The file is indented with tabs, which Eaon won\'t rewrite. Use Copy settings and add them by hand.')
  }
  const at = lines.findIndex((line) => new RegExp(`^${parentKey}:`).test(line))
  if (at === -1) return null
  const rest = lines[at].slice(parentKey.length + 1).replace(/\s+#.*$/, '').trim()
  if (rest === '{}') return 'flow'
  if (rest) throw new ConfigError(`\`${parentKey}:\` is written on one line, which Eaon won't rewrite. Use Copy settings and add it by hand.`)
  let end = at
  let childIndent: number | null = null
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (indent === 0) break
    if (childIndent === null) childIndent = indent
    end = i
  }
  return { line: at, childIndent, end }
}

function childSpan(lines: string[], parent: Parent, childKey: string): { start: number; end: number } | null {
  if (parent.childIndent === null) return null
  const pad = ' '.repeat(parent.childIndent)
  const start = lines.findIndex((line, i) => i > parent.line && i <= parent.end && new RegExp(`^${pad}["']?${childKey}["']?:\\s*(#.*)?$`).test(line))
  if (start === -1) return null
  let end = start
  for (let i = start + 1; i <= parent.end; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    if (indent <= parent.childIndent) break
    end = i
  }
  return { start, end }
}

export function hasChild(text: string, parentKey: string, childKey: string): boolean {
  const lines = text.split('\n')
  const parent = findParent(lines, parentKey)
  return parent !== null && parent !== 'flow' && childSpan(lines, parent, childKey) !== null
}

/** Puts `childKey:` with `body` (an object rendered as YAML) under `parentKey:`. */
export function setChild(text: string, parentKey: string, childKey: string, body: Record<string, unknown>): string {
  const lines = text.split('\n')
  const parent = findParent(lines, parentKey)
  if (parent === null || parent === 'flow') {
    const indent = 2
    const block = [`${parentKey}:`, `${' '.repeat(indent)}${childKey}:`, ...yamlLines(body, indent * 2)]
    if (parent === 'flow') {
      const at = lines.findIndex((line) => new RegExp(`^${parentKey}:`).test(line))
      lines.splice(at, 1, ...block)
      return lines.join('\n')
    }
    const head = text.replace(/\n*$/, '')
    return `${head}${head ? '\n' : ''}${block.join('\n')}\n`
  }
  const indent = parent.childIndent ?? 2
  const block = [`${' '.repeat(indent)}${childKey}:`, ...yamlLines(body, indent * 2)]
  const span = childSpan(lines, parent, childKey)
  if (span) lines.splice(span.start, span.end - span.start + 1, ...block)
  else lines.splice(parent.end + 1, 0, ...block)
  return lines.join('\n')
}

export function removeChild(text: string, parentKey: string, childKey: string): string {
  const lines = text.split('\n')
  const parent = findParent(lines, parentKey)
  if (parent === null || parent === 'flow') return text
  const span = childSpan(lines, parent, childKey)
  if (!span) return text
  lines.splice(span.start, span.end - span.start + 1)
  // A parent left with no children goes too, so removing undoes adding.
  const after = findParent(lines, parentKey)
  if (after && after !== 'flow' && after.childIndent === null) lines.splice(after.line, 1)
  return lines.join('\n')
}
