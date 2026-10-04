/**
 * Finding the text an edit means, when the model's `old_text` isn't a byte
 * exact copy of the file.
 *
 * Ported from opencode (MIT, packages/opencode/src/tool/edit.ts), which
 * credits Cline's diff-apply evals and Gemini CLI's edit corrector. The
 * strategies run in order, most literal first; the first one that finds a
 * single match wins. A match far bigger than what the model sent is refused
 * rather than applied, because a fuzzy match that swallows a whole function
 * is worse than an error the model can recover from.
 */

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>

const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.65
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.65

function levenshtein(a: string, b: string): number {
  if (a === '' || b === '') return Math.max(a.length, b.length)
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = row
  }
  return prev[b.length]
}

/** The text of lines `start`..`end` (inclusive) of `content`, exactly as in the file. */
function span(lines: string[], start: number, end: number): string {
  return lines.slice(start, end + 1).join('\n')
}

export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const original = content.split('\n')
  const search = find.split('\n')
  if (search[search.length - 1] === '') search.pop()
  for (let i = 0; i <= original.length - search.length; i++) {
    let ok = true
    for (let j = 0; j < search.length; j++) {
      if (original[i + j].trim() !== search[j].trim()) {
        ok = false
        break
      }
    }
    if (ok) yield span(original, i, i + search.length - 1)
  }
}

function middleSimilarity(original: string[], start: number, end: number, search: string[]): number {
  const size = end - start + 1
  const checks = Math.min(search.length - 2, size - 2)
  if (checks <= 0) return 1
  let total = 0
  for (let j = 1; j < search.length - 1 && j < size - 1; j++) {
    const a = original[start + j].trim()
    const b = search[j].trim()
    const longest = Math.max(a.length, b.length)
    if (longest === 0) continue
    total += 1 - levenshtein(a, b) / longest
  }
  return total / checks
}

export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const original = content.split('\n')
  const search = find.split('\n')
  if (search.length < 3) return
  if (search[search.length - 1] === '') search.pop()
  const first = search[0].trim()
  const last = search[search.length - 1].trim()
  const maxDelta = Math.max(1, Math.floor(search.length * 0.25))
  const candidates: { start: number; end: number }[] = []
  for (let i = 0; i < original.length; i++) {
    if (original[i].trim() !== first) continue
    for (let j = i + 2; j < original.length; j++) {
      if (original[j].trim() === last) {
        if (Math.abs(j - i + 1 - search.length) <= maxDelta) candidates.push({ start: i, end: j })
        break
      }
    }
  }
  if (candidates.length === 0) return
  if (candidates.length === 1) {
    const { start, end } = candidates[0]
    if (middleSimilarity(original, start, end, search) >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) yield span(original, start, end)
    return
  }
  let best: { start: number; end: number } | null = null
  let bestScore = -1
  for (const c of candidates) {
    const score = middleSimilarity(original, c.start, c.end, search)
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }
  if (best && bestScore >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD) yield span(original, best.start, best.end)
}

export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim()
  const wanted = normalize(find)
  const lines = content.split('\n')
  for (const line of lines) {
    if (normalize(line) === wanted) {
      yield line
      continue
    }
    if (normalize(line).includes(wanted)) {
      const words = find.trim().split(/\s+/)
      if (words.length === 0) continue
      try {
        const match = line.match(new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')))
        if (match) yield match[0]
      } catch {
        /* not a usable pattern */
      }
    }
  }
  const findLines = find.split('\n')
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length).join('\n')
      if (normalize(block) === wanted) yield block
    }
  }
}

export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const dedent = (text: string): string => {
    const lines = text.split('\n')
    const filled = lines.filter((l) => l.trim().length > 0)
    if (filled.length === 0) return text
    const min = Math.min(...filled.map((l) => (l.match(/^(\s*)/)?.[1].length ?? 0)))
    return lines.map((l) => (l.trim().length === 0 ? l : l.slice(min))).join('\n')
  }
  const wanted = dedent(find)
  const lines = content.split('\n')
  const count = find.split('\n').length
  for (let i = 0; i <= lines.length - count; i++) {
    const block = lines.slice(i, i + count).join('\n')
    if (dedent(block) === wanted) yield block
  }
}

export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescape = (text: string): string =>
    text.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (whole, c: string) => {
      switch (c) {
        case 'n':
          return '\n'
        case 't':
          return '\t'
        case 'r':
          return '\r'
        case '\n':
          return '\n'
        default:
          return c ?? whole
      }
    })
  const wanted = unescape(find)
  if (content.includes(wanted)) yield wanted
  const lines = content.split('\n')
  const count = wanted.split('\n').length
  for (let i = 0; i <= lines.length - count; i++) {
    const block = lines.slice(i, i + count).join('\n')
    if (unescape(block) === wanted) yield block
  }
}

export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmed = find.trim()
  if (trimmed === find) return
  if (content.includes(trimmed)) yield trimmed
  const lines = content.split('\n')
  const count = find.split('\n').length
  for (let i = 0; i <= lines.length - count; i++) {
    const block = lines.slice(i, i + count).join('\n')
    if (block.trim() === trimmed) yield block
  }
}

export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split('\n')
  if (findLines.length < 3) return
  if (findLines[findLines.length - 1] === '') findLines.pop()
  const lines = content.split('\n')
  const first = findLines[0].trim()
  const last = findLines[findLines.length - 1].trim()
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== first) continue
    for (let j = i + 2; j < lines.length; j++) {
      if (lines[j].trim() !== last) continue
      const block = lines.slice(i, j + 1)
      if (block.length === findLines.length) {
        let matching = 0
        let filled = 0
        for (let k = 1; k < block.length - 1; k++) {
          const a = block[k].trim()
          const b = findLines[k].trim()
          if (a.length > 0 || b.length > 0) {
            filled++
            if (a === b) matching++
          }
        }
        if (filled === 0 || matching / filled >= 0.5) {
          yield block.join('\n')
          return
        }
      }
      break
    }
  }
}

export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  let from = 0
  for (;;) {
    const at = content.indexOf(find, from)
    if (at === -1) break
    yield find
    from = at + find.length
  }
}

const STRATEGIES: [string, Replacer][] = [
  ['exact', SimpleReplacer],
  ['trimmed lines', LineTrimmedReplacer],
  ['block anchors', BlockAnchorReplacer],
  ['whitespace', WhitespaceNormalizedReplacer],
  ['indentation', IndentationFlexibleReplacer],
  ['escapes', EscapeNormalizedReplacer],
  ['trimmed boundary', TrimmedBoundaryReplacer],
  ['context', ContextAwareReplacer],
  ['occurrences', MultiOccurrenceReplacer]
]

function disproportionate(search: string, oldText: string): boolean {
  const oldLines = oldText.split('\n').length
  const searchLines = search.split('\n').length
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true
  if (oldLines === 1) return false
  return search.trim().length > Math.max(oldText.trim().length + 500, oldText.trim().length * 4)
}

export interface Replacement {
  content: string
  /** Which strategy found the text: "exact" for a byte-exact match. */
  strategy: string
  occurrences: number
}

/**
 * `content` with `oldText` replaced by `newText`. Throws a sentence the
 * model can act on when nothing (or more than one place) matches.
 */
/**
 * When the text was found only by looking past its indentation, the new
 * text is shifted by the same amount — opencode leaves it as sent, so a
 * model that dropped the leading spaces of a one-line edit put the new line
 * at column 0. Only for matches that start a line, and only when the old
 * and found text differ in indentation in a way that can be carried over.
 */
function fitIndent(content: string, at: number, found: string, oldText: string, newText: string): string {
  if (at > 0 && content[at - 1] !== '\n') return newText
  const lead = (text: string): string | null => {
    const line = text.split('\n').find((l) => l.trim())
    return line === undefined ? null : /^[ \t]*/.exec(line)![0]
  }
  const have = lead(found)
  const sent = lead(oldText)
  if (have === null || sent === null || have === sent) return newText
  const shift = (line: string): string => {
    if (!line.trim()) return line
    if (have.startsWith(sent)) return have.slice(sent.length) + line
    if (sent.startsWith(have)) {
      const drop = sent.length - have.length
      const indent = /^[ \t]*/.exec(line)![0]
      return line.slice(Math.min(drop, indent.length))
    }
    return line.startsWith(sent) ? have + line.slice(sent.length) : line
  }
  return newText.split('\n').map(shift).join('\n')
}

export function replaceIn(content: string, oldText: string, newText: string, replaceAll = false): Replacement {
  if (oldText === newText) throw new Error('No change: old_text and new_text are identical.')
  if (oldText === '') throw new Error('old_text is empty. Give the exact text to replace, or use write_file to replace the whole file.')
  let found = false
  for (const [name, strategy] of STRATEGIES) {
    for (const search of strategy(content, oldText)) {
      const at = content.indexOf(search)
      if (at === -1) continue
      found = true
      if (disproportionate(search, oldText)) {
        throw new Error('Refusing: the closest match is much larger than old_text. Read the file again and send the exact text to replace.')
      }
      if (replaceAll) {
        const occurrences = content.split(search).length - 1
        return { content: content.split(search).join(newText), strategy: name, occurrences }
      }
      if (at !== content.lastIndexOf(search)) continue
      const text = name === 'exact' ? newText : fitIndent(content, at, search, oldText, newText)
      return { content: content.slice(0, at) + text + content.slice(at + search.length), strategy: name, occurrences: 1 }
    }
  }
  if (!found) throw new Error('old_text was not found in the file. It must match the file, including indentation; read the file again and copy the exact lines.')
  throw new Error('old_text matches more than one place. Include more surrounding lines so it matches once, or pass replace_all to change every one.')
}
