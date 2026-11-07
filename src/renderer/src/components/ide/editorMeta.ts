/**
 * What the editor says about a file and sends about it: its language's name
 * and indentation for the status bar, and a selection as the agent reads it
 * (⌘L adds it to the message, ⌘K asks for a change to it). Pure, for tests.
 */

const LANGUAGE: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript JSX',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript JSX',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  json: 'JSON',
  jsonc: 'JSON',
  md: 'Markdown',
  mdx: 'MDX',
  py: 'Python',
  rb: 'Ruby',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  swift: 'Swift',
  c: 'C',
  h: 'C',
  cc: 'C++',
  cpp: 'C++',
  hpp: 'C++',
  cs: 'C#',
  php: 'PHP',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  fish: 'Fish',
  ps1: 'PowerShell',
  html: 'HTML',
  htm: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  vue: 'Vue',
  svelte: 'Svelte',
  sql: 'SQL',
  yml: 'YAML',
  yaml: 'YAML',
  toml: 'TOML',
  xml: 'XML',
  svg: 'SVG',
  lua: 'Lua',
  dart: 'Dart',
  ex: 'Elixir',
  exs: 'Elixir',
  zig: 'Zig',
  makefile: 'Makefile',
  dockerfile: 'Dockerfile',
  env: 'Environment',
  txt: 'Plain text'
}

/** "TypeScript" for "ts" (tokens.ts languageOf); the extension itself, upper-cased, when it isn't known; "Plain text" for none. */
export function languageName(lang: string): string {
  if (!lang) return 'Plain text'
  return LANGUAGE[lang] ?? lang.toUpperCase()
}

/**
 * How the file indents, by its indented lines: "Tabs", or "Spaces: 2" for
 * the most common step between one line's indent and a deeper next one.
 * Null when nothing is indented.
 */
export function indentOf(text: string): string | null {
  const lines = text.split('\n', 4000)
  let tabs = 0
  let spaced = 0
  const steps = new Map<number, number>()
  let previous = 0
  for (const line of lines) {
    if (!line.trim()) continue
    const lead = /^[ \t]*/.exec(line)![0]
    if (lead.startsWith('\t')) {
      tabs++
      continue
    }
    const width = lead.length
    if (width > 0) spaced++
    const step = width - previous
    if (step > 0 && step <= 8) steps.set(step, (steps.get(step) ?? 0) + 1)
    previous = width
  }
  if (tabs === 0 && spaced === 0) return null
  if (tabs > spaced) return 'Tabs'
  let best = 2
  let count = 0
  for (const [step, n] of steps) if (n > count || (n === count && step < best)) [best, count] = [step, n]
  return `Spaces: ${best}`
}

/** "src/app.ts:5" or "src/app.ts:5-9": a place in a file, as the agent reads it. */
export function lineRef(rel: string, from: number, to: number): string {
  return from === to ? `${rel}:${from}` : `${rel}:${from}-${to}`
}

/** A fence long enough to hold `code`, which may have fences of its own. */
function fence(code: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`{3,}/g)].map((m) => m[0].length))
  return '`'.repeat(longest + 1)
}

/** ⌘L: the selection as context in the message, under the place it came from. */
export function selectionSnippet(rel: string, from: number, to: number, code: string, lang: string): string {
  const body = code.replace(/\n$/, '')
  const f = fence(body)
  return `\`${lineRef(rel, from, to)}\`\n${f}${lang}\n${body}\n${f}\n`
}

/** ⌘K: what to change and where, with the selected code, as one message to the agent. */
export function editRequest(rel: string, from: number, to: number, code: string, lang: string, instruction: string): string {
  const where = from === to ? `line ${from}` : `lines ${from}–${to}`
  return `In \`${rel}\` (${where}): ${instruction}\n\n${selectionSnippet(rel, from, to, code, lang)}`
}
