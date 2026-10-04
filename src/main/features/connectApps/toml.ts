/**
 * Just enough TOML editing for Codex's config.toml: read, set and remove a
 * top-level key, and replace or remove one whole table. Everything else in
 * the file (comments, spacing, other tables, multi-line arrays and strings)
 * comes back byte for byte.
 *
 * A line is only treated as a key or a table header when it starts a new
 * statement: lines inside a multi-line array, inline table or string are
 * part of the value before them.
 */

interface Statement {
  /** First and last line index (inclusive) of the statement. */
  start: number
  end: number
  /** `key` for `key = value` lines, the header name for tables, null for blank/comment lines. */
  key: string | null
  header: string | null
  /** The raw value text (may span lines), for `key = value` statements. */
  value: string | null
}

/** Normalises a dotted key or header: `model_providers."eaon"` → `model_providers.eaon`. */
function normaliseKey(raw: string): string {
  return raw
    .split('.')
    .map((part) => part.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'))
    .join('.')
}

/** Walks the text, tracking strings and brackets, and splits it into statements. */
function statements(text: string): { lines: string[]; list: Statement[] } {
  const lines = text.split('\n')
  const list: Statement[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      list.push({ start: i, end: i, key: null, header: null, value: null })
      i++
      continue
    }
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(trimmed)
    if (header) {
      list.push({ start: i, end: i, key: null, header: normaliseKey(header[1]), value: null })
      i++
      continue
    }
    const eq = keyValue(line)
    if (!eq) {
      list.push({ start: i, end: i, key: null, header: null, value: null })
      i++
      continue
    }
    // Follow the value across lines until its brackets and strings close.
    let depth = 0
    let multi: '"""' | "'''" | null = null
    let end = i
    let text2 = eq.value
    for (let j = i; j < lines.length; j++) {
      const chunk = j === i ? eq.value : lines[j]
      const state = scan(chunk, depth, multi)
      depth = state.depth
      multi = state.multi
      end = j
      if (j > i) text2 += `\n${lines[j]}`
      if (depth <= 0 && !multi) break
    }
    list.push({ start: i, end, key: normaliseKey(eq.key), header: null, value: text2.trim() })
    i = end + 1
  }
  return { lines, list }
}

function keyValue(line: string): { key: string; value: string } | null {
  // A bare, quoted or dotted key, then `=`. Quoted parts may contain `=`.
  const match = /^\s*((?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*'))*)\s*=(.*)$/.exec(line)
  return match ? { key: match[1], value: match[2] } : null
}

/** Updates bracket depth and open multi-line string state across one chunk of text. */
function scan(chunk: string, depth: number, multi: '"""' | "'''" | null): { depth: number; multi: '"""' | "'''" | null } {
  let i = 0
  while (i < chunk.length) {
    if (multi) {
      const close = chunk.indexOf(multi, i)
      if (close === -1) return { depth, multi }
      i = close + 3
      multi = null
      continue
    }
    const ch = chunk[i]
    if (ch === '#') break
    if (chunk.startsWith('"""', i) || chunk.startsWith("'''", i)) {
      multi = chunk.slice(i, i + 3) as '"""' | "'''"
      i += 3
      continue
    }
    if (ch === '"') {
      i++
      while (i < chunk.length && chunk[i] !== '"') i += chunk[i] === '\\' ? 2 : 1
      i++
      continue
    }
    if (ch === "'") {
      const close = chunk.indexOf("'", i + 1)
      i = close === -1 ? chunk.length : close + 1
      continue
    }
    if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
    i++
  }
  return { depth, multi }
}

/** The index where the top-level section (before the first table header) ends. */
function topLevelEnd(list: Statement[]): number {
  const first = list.findIndex((s) => s.header !== null)
  return first === -1 ? list.length : first
}

/** A TOML basic string. */
export function tomlString(value: string): string {
  return JSON.stringify(value)
}

/** Reads a simple value back: strings unquoted, anything else as written. */
export function tomlValue(raw: string | null): string | null {
  if (raw === null) return null
  const value = raw.replace(/\s+#.*$/, '').trim()
  if (value.startsWith('"') && !value.startsWith('"""')) {
    try {
      return JSON.parse(value) as string
    } catch {
      return value
    }
  }
  if (value.startsWith("'") && !value.startsWith("'''")) return value.slice(1, -1)
  return value
}

export function getTopLevel(text: string, key: string): string | null {
  const { list } = statements(text)
  const found = list.slice(0, topLevelEnd(list)).find((s) => s.key === key)
  return found ? found.value : null
}

/** Sets `key = rawValue` among the top-level keys, replacing the old value wherever it spans. */
export function setTopLevel(text: string, key: string, rawValue: string): string {
  const { lines, list } = statements(text)
  const top = list.slice(0, topLevelEnd(list))
  const found = top.find((s) => s.key === key)
  const line = `${key} = ${rawValue}`
  if (found) {
    lines.splice(found.start, found.end - found.start + 1, line)
    return lines.join('\n')
  }
  // After the last top-level key; with none, at the top, followed by a blank line.
  const lastKey = [...top].reverse().find((s) => s.key !== null)
  if (lastKey) lines.splice(lastKey.end + 1, 0, line)
  else lines.splice(0, 0, line, ...(text.trim() ? [''] : []))
  return lines.join('\n')
}

export function removeTopLevel(text: string, key: string): string {
  const { lines, list } = statements(text)
  const top = list.slice(0, topLevelEnd(list))
  const found = top.find((s) => s.key === key)
  if (!found) return text
  lines.splice(found.start, found.end - found.start + 1)
  // The last top-level key, at the top of the file: take the blank line setTopLevel put after it.
  const othersLeft = top.some((s) => s.key !== null && s !== found)
  if (found.start === 0 && !othersLeft && lines.length > 1 && lines[0].trim() === '') lines.splice(0, 1)
  return lines.join('\n')
}

/** The table's span: its header line through the last line before the next header. */
function tableSpan(list: Statement[], header: string): { start: number; end: number } | null {
  const index = list.findIndex((s) => s.header === header)
  if (index === -1) return null
  let last = index
  for (let k = index + 1; k < list.length && list[k].header === null; k++) last = k
  return { start: list[index].start, end: list[last].end }
}

export function getTableValue(text: string, header: string, key: string): string | null {
  const { list } = statements(text)
  const index = list.findIndex((s) => s.header === header)
  if (index === -1) return null
  for (let k = index + 1; k < list.length && list[k].header === null; k++) {
    if (list[k].key === key) return list[k].value
  }
  return null
}

export function hasTable(text: string, header: string): boolean {
  return statements(text).list.some((s) => s.header === header)
}

/** Writes the whole table, replacing it if it exists or appending it at the end. */
export function setTable(text: string, header: string, entries: [string, string][]): string {
  const block = [`[${header}]`, ...entries.map(([k, v]) => `${k} = ${v}`)]
  const { lines, list } = statements(text)
  const span = tableSpan(list, header)
  if (span) {
    // Keep blank lines that separated it from what follows.
    let end = span.end
    while (end > span.start && lines[end].trim() === '') end--
    lines.splice(span.start, end - span.start + 1, ...block)
    return lines.join('\n')
  }
  const body = text.replace(/\n*$/, '')
  return `${body}${body ? '\n\n' : ''}${block.join('\n')}\n`
}

export function removeTable(text: string, header: string): string {
  const { lines, list } = statements(text)
  const span = tableSpan(list, header)
  if (!span) return text
  let end = span.end
  while (end > span.start && lines[end].trim() === '') end--
  // Take one separating blank line with it, so removing undoes adding.
  let start = span.start
  if (start > 0 && lines[start - 1].trim() === '') start--
  lines.splice(start, end - start + 1)
  return lines.join('\n')
}
