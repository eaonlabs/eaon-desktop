/**
 * Syntax colouring for finished code blocks, written rather than installed:
 * a full grammar set (Shiki, Prism) is bigger than the whole Markdown
 * renderer, and replies only need the broad strokes — comments, strings,
 * numbers, keywords, calls and types — to be readable at a glance. One
 * regular expression per family of languages, scanned once; whatever it
 * doesn't recognise stays plain text.
 *
 * Kept free of React so the test harness can run it.
 */

export type TokenKind = 'comment' | 'string' | 'number' | 'keyword' | 'literal' | 'func' | 'type' | 'tag' | 'attr' | 'add' | 'del' | 'meta'

export interface Token {
  text: string
  kind: TokenKind | null
}

/** Past this, a block is shown plain: colouring it would cost more than it helps. */
const MAX_CHARS = 60_000

const C_KEYWORDS =
  'abstract as async await break case catch class const continue debugger def default defer delete do else enum export extends final finally fn for from func function go goto if impl implements import in instanceof interface internal let loop match mod module move mut namespace new of override package private protected pub public readonly return sealed select static struct super switch throw throws trait try type typeof use using val var void where while with yield'
const PY_KEYWORDS =
  'and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield'
const RB_KEYWORDS = 'alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require require_relative attr_accessor attr_reader'
const SH_KEYWORDS = 'case do done elif else esac export fi for function if in local readonly return select then until while sudo cd echo exit source alias unset set'
const SQL_KEYWORDS =
  'add all alter and as asc between by case check column constraint create cross database default delete desc distinct drop else end exists foreign from full group having if in index inner insert into is join key left like limit not null on or order outer primary references right select set table then top truncate union unique update values view when where with returning'
const LITERALS = 'true false null undefined nil None True False NaN Infinity this self'

const words = (list: string): string => list.split(' ').join('|')

/** One pattern of named groups, one per token kind, tried in this order at each point. */
function family(parts: Partial<Record<TokenKind, string>>, flags = 'g'): RegExp {
  const order: TokenKind[] = ['comment', 'attr', 'string', 'meta', 'add', 'del', 'tag', 'number', 'literal', 'keyword', 'func', 'type']
  return new RegExp(
    order
      .filter((name) => parts[name])
      .map((name) => `(?<${name}>${parts[name]})`)
      .join('|'),
    flags
  )
}

const NUMBER = String.raw`\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z]*\b`
const DQ = String.raw`"(?:[^"\\\n]|\\.)*"?`
const SQ = String.raw`'(?:[^'\\\n]|\\.)*'?`
const BT = String.raw`\`(?:[^\`\\]|\\.)*\`?`
const CALL = String.raw`\b[A-Za-z_$][\w$]*(?=\s*\()`
const TYPE = String.raw`\b[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*\b`

const FAMILIES: Record<string, RegExp> = {
  c: family({
    comment: String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|(?![\s\S]))`,
    string: `${DQ}|${SQ}|${BT}`,
    meta: String.raw`^\s*#\s*\w+|@[A-Za-z_][\w.]*`,
    number: NUMBER,
    literal: String.raw`\b(?:${words(LITERALS)})\b`,
    keyword: String.raw`\b(?:${words(C_KEYWORDS)})\b`,
    func: CALL,
    type: TYPE
  }, 'gm'),
  python: family({
    comment: String.raw`#[^\n]*`,
    string: String.raw`[rRbBfFuU]{0,2}(?:"""[\s\S]*?(?:"""|(?![\s\S]))|'''[\s\S]*?(?:'''|(?![\s\S]))|${DQ}|${SQ})`,
    meta: String.raw`@[A-Za-z_][\w.]*`,
    number: NUMBER,
    literal: String.raw`\b(?:${words(LITERALS)})\b`,
    keyword: String.raw`\b(?:${words(PY_KEYWORDS)})\b`,
    func: CALL,
    type: TYPE
  }),
  ruby: family({
    comment: String.raw`#[^\n]*`,
    string: `${DQ}|${SQ}|:[A-Za-z_]\\w*`,
    number: NUMBER,
    literal: String.raw`\b(?:${words(LITERALS)})\b`,
    keyword: String.raw`\b(?:${words(RB_KEYWORDS)})\b`,
    func: CALL,
    type: TYPE
  }),
  shell: family({
    comment: String.raw`(?:^|(?<=\s))#[^\n]*`,
    string: `${DQ}|${SQ}`,
    meta: String.raw`\$\{[^}\n]*\}|\$[A-Za-z_][\w]*|\$[@*#?$!0-9]`,
    attr: String.raw`(?<=\s)--?[A-Za-z][\w-]*`,
    number: String.raw`\b\d+\b`,
    keyword: String.raw`\b(?:${words(SH_KEYWORDS)})\b`,
    func: String.raw`(?:^|(?<=[|;&]\s*)|(?<=^\s*\$\s))[A-Za-z_.][\w.-]*`
  }, 'gm'),
  json: family({
    attr: String.raw`"(?:[^"\\\n]|\\.)*"(?=\s*:)`,
    string: DQ,
    number: String.raw`-?${NUMBER}`,
    literal: String.raw`\b(?:true|false|null)\b`
  }),
  yaml: family({
    comment: String.raw`#[^\n]*`,
    attr: String.raw`^[ \t-]*[A-Za-z_][\w .-]*(?=\s*[:=])|^\s*\[[^\]\n]+\]`,
    string: `${DQ}|${SQ}`,
    number: NUMBER,
    literal: String.raw`\b(?:true|false|null|yes|no|on|off|~)\b`
  }, 'gm'),
  sql: family({
    comment: String.raw`--[^\n]*|\/\*[\s\S]*?(?:\*\/|(?![\s\S]))`,
    string: SQ + '|' + DQ,
    number: NUMBER,
    literal: String.raw`\b(?:true|false|null)\b`,
    keyword: String.raw`\b(?:${words(SQL_KEYWORDS)})\b`,
    func: CALL
  }, 'gi'),
  css: family({
    comment: String.raw`\/\*[\s\S]*?(?:\*\/|(?![\s\S]))`,
    string: `${DQ}|${SQ}`,
    meta: String.raw`@[\w-]+|![\w]+`,
    attr: String.raw`[\w-]+(?=\s*:[^;{}\n]*[;}\n])`,
    number: String.raw`-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|ms|s|deg|fr)?\b|#[\da-fA-F]{3,8}\b`,
    func: String.raw`[\w-]+(?=\()`,
    tag: String.raw`[.#]?[A-Za-z][\w-]*(?=[^{}\n]*\{)`
  }),
  html: family({
    comment: String.raw`<!--[\s\S]*?(?:-->|(?![\s\S]))`,
    tag: String.raw`<\/?[A-Za-z][\w:-]*|\/?>`,
    attr: String.raw`(?<=\s)[A-Za-z_:][\w:.-]*(?==)`,
    string: `${DQ}|${SQ}`
  }),
  diff: family({
    meta: String.raw`^(?:@@[^\n]*|diff [^\n]*|index [^\n]*|\+\+\+ [^\n]*|--- [^\n]*)`,
    add: String.raw`^\+[^\n]*`,
    del: String.raw`^-[^\n]*`
  }, 'gm')
}

const ALIASES: Record<string, keyof typeof FAMILIES> = {
  js: 'c', javascript: 'c', jsx: 'c', mjs: 'c', cjs: 'c', ts: 'c', typescript: 'c', tsx: 'c', java: 'c', c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cc: 'c', hpp: 'c', cs: 'c', csharp: 'c', go: 'c', golang: 'c', rust: 'c', rs: 'c', swift: 'c', kotlin: 'c', kt: 'c', php: 'c', dart: 'c', scala: 'c', zig: 'c', objc: 'c', 'objective-c': 'c', groovy: 'c', solidity: 'c', glsl: 'c', wgsl: 'c', proto: 'c', graphql: 'c', gql: 'c',
  py: 'python', python: 'python', python3: 'python', pyi: 'python',
  rb: 'ruby', ruby: 'ruby', crystal: 'ruby', elixir: 'ruby', ex: 'ruby', exs: 'ruby',
  sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', console: 'shell', shellsession: 'shell', fish: 'shell', powershell: 'shell', ps1: 'shell', ps: 'shell', dockerfile: 'shell', docker: 'shell', makefile: 'shell', make: 'shell',
  json: 'json', jsonc: 'json', json5: 'json', geojson: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml', env: 'yaml', dotenv: 'yaml', properties: 'yaml', conf: 'yaml',
  sql: 'sql', postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql', plsql: 'sql',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html', astro: 'html', xhtml: 'html', plist: 'html',
  diff: 'diff', patch: 'diff'
}

/** The language family for a fence's label ("ts", "Python", "bash title=x"), or null to leave it plain. */
export function languageFamily(lang: string): string | null {
  const name = lang.trim().toLowerCase().split(/[\s{:,]/)[0] ?? ''
  return ALIASES[name] ?? null
}

/** The code cut into tokens. Text the language's pattern doesn't cover comes back with `kind: null`. */
export function highlight(code: string, lang: string): Token[] {
  const key = languageFamily(lang)
  if (!key || code.length > MAX_CHARS) return [{ text: code, kind: null }]
  const pattern = FAMILIES[key]
  const tokens: Token[] = []
  let last = 0
  pattern.lastIndex = 0
  for (const match of code.matchAll(pattern)) {
    const at = match.index ?? 0
    if (match[0].length === 0) continue
    if (at > last) tokens.push({ text: code.slice(last, at), kind: null })
    const groups = match.groups ?? {}
    const name = Object.keys(groups).find((group) => groups[group] !== undefined) ?? null
    tokens.push({ text: match[0], kind: name as TokenKind | null })
    last = at + match[0].length
  }
  if (last < code.length) tokens.push({ text: code.slice(last), kind: null })
  return tokens
}
