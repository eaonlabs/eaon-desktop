import type { Style } from './term'

/**
 * Syntax colour for code in the transcript: diffs, file previews and fenced
 * blocks. A small tokenizer per language family (keywords, strings,
 * comments, numbers, types, calls) rather than a grammar engine: it runs on
 * every visible line of every redraw, needs no native module, and is right
 * often enough that code reads like code. Block comments and triple-quoted
 * strings carry over from one line to the next.
 */

export interface Token {
  text: string
  style?: Style
}

export const SYNTAX = {
  keyword: { fg: '#C792EA' } as Style,
  string: { fg: '#A5D6A7' } as Style,
  comment: { fg: '#6B7280', italic: true } as Style,
  number: { fg: '#F78C6C' } as Style,
  type: { fg: '#FFCB6B' } as Style,
  func: { fg: '#82AAFF' } as Style,
  constant: { fg: '#F78C6C' } as Style,
  tag: { fg: '#F07178' } as Style,
  attr: { fg: '#FFCB6B' } as Style,
  plain: { fg: '#D6DEEB' } as Style,
  punct: { fg: '#89DDFF' } as Style
}

type Family = 'c' | 'py' | 'sh' | 'json' | 'css' | 'html' | 'yaml' | 'md' | 'sql' | 'rb' | 'plain'

interface Lang {
  family: Family
  keywords: Set<string>
  constants: Set<string>
  line?: string
  block?: [string, string]
}

const words = (text: string): Set<string> => new Set(text.split(/\s+/).filter(Boolean))

const JS = words(
  'abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let module namespace new of package private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield'
)
const PY = words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield self cls')
const GO = words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var')
const RUST = words('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while')
const CLIKE = words(
  'auto break case catch char class const continue default delete do double else enum explicit extern final float for friend fun goto if inline int long namespace new operator override private protected public register return short signed sizeof static struct switch template this throw try typedef union unsigned using val var virtual void volatile while import package interface extends implements func let guard defer protocol extension init deinit internal open fileprivate where is as in out suspend data object companion'
)
const SH = words('if then else elif fi case esac for while until do done in function return local export readonly declare set unset shift source alias echo exit cd test')
const SQL = words('select from where and or not insert into values update set delete create table index drop alter add join left right inner outer on group by order having limit offset as distinct union all null is primary key foreign references default begin commit rollback with case when then else end')
const RB = words('alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require attr_accessor')
const CONSTS = words('true false null undefined None True False nil NaN Infinity')

const LANGS: Record<string, Lang> = {}
const add = (exts: string[], lang: Lang): void => exts.forEach((e) => (LANGS[e] = lang))
add(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'javascript', 'typescript', 'vue', 'svelte'], { family: 'c', keywords: JS, constants: CONSTS, line: '//', block: ['/*', '*/'] })
add(['go'], { family: 'c', keywords: GO, constants: CONSTS, line: '//', block: ['/*', '*/'] })
add(['rs', 'rust'], { family: 'c', keywords: RUST, constants: CONSTS, line: '//', block: ['/*', '*/'] })
add(['c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'java', 'kt', 'kts', 'swift', 'scala', 'dart', 'php', 'm', 'mm', 'zig'], { family: 'c', keywords: CLIKE, constants: CONSTS, line: '//', block: ['/*', '*/'] })
add(['py', 'pyi', 'python'], { family: 'py', keywords: PY, constants: CONSTS, line: '#' })
add(['rb', 'ruby', 'rake'], { family: 'rb', keywords: RB, constants: CONSTS, line: '#' })
add(['sh', 'bash', 'zsh', 'fish', 'shell', 'console', 'env', 'dockerfile', 'makefile', 'mk'], { family: 'sh', keywords: SH, constants: CONSTS, line: '#' })
add(['json', 'jsonc', 'json5'], { family: 'json', keywords: new Set(), constants: CONSTS, line: '//' })
add(['css', 'scss', 'less', 'sass'], { family: 'css', keywords: new Set(), constants: new Set(), block: ['/*', '*/'] })
add(['html', 'htm', 'xml', 'svg', 'plist'], { family: 'html', keywords: new Set(), constants: new Set(), block: ['<!--', '-->'] })
add(['yaml', 'yml', 'toml', 'ini', 'cfg', 'conf'], { family: 'yaml', keywords: new Set(), constants: CONSTS, line: '#' })
add(['md', 'markdown', 'mdx'], { family: 'md', keywords: new Set(), constants: new Set() })
add(['sql'], { family: 'sql', keywords: SQL, constants: CONSTS, line: '--', block: ['/*', '*/'] })

/** The language for a path or a fence's info string. */
export function languageOf(pathOrLang: string | undefined): string {
  if (!pathOrLang) return 'plain'
  const lower = pathOrLang.toLowerCase()
  const base = lower.slice(lower.lastIndexOf('/') + 1)
  if (base === 'dockerfile' || base === 'makefile') return base
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : base
  return LANGS[ext] ? ext : 'plain'
}

/** Carried from one line to the next: inside a block comment or a multi-line string. */
export interface HighlightState {
  inBlock?: boolean
  inTriple?: string | null
}

const IDENT = /^[A-Za-z_$][\w$]*/
const NUMBER = /^(0x[\da-fA-F_]+|0b[01_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?[a-zA-Z]*)/

/** Tokens for one line of code. Pass the same `state` object for consecutive lines. */
export function highlightLine(line: string, lang: string, state: HighlightState = {}): Token[] {
  const spec = LANGS[lang]
  if (!spec) return [{ text: line, style: SYNTAX.plain }]
  const out: Token[] = []
  const push = (text: string, style: Style): void => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && last.style === style) last.text += text
    else out.push({ text, style })
  }
  let i = 0

  if (spec.family === 'md') {
    const style = /^\s*#/.test(line) ? SYNTAX.keyword : /^\s*([-*+]|\d+\.)\s/.test(line) ? SYNTAX.punct : /^\s*>/.test(line) ? SYNTAX.comment : SYNTAX.plain
    return [{ text: line, style }]
  }

  if (spec.family === 'html') {
    if (state.inBlock) {
      const end = line.indexOf('-->')
      if (end === -1) return [{ text: line, style: SYNTAX.comment }]
      push(line.slice(0, end + 3), SYNTAX.comment)
      state.inBlock = false
      i = end + 3
    }
    const rest = line.slice(i)
    const re = /(<!--[\s\S]*?(?:-->|$))|(<\/?)([\w:-]+)|([\w:-]+)(=)("[^"]*"|'[^']*')|(\/?>)|("[^"]*")/g
    let last = 0
    for (const m of rest.matchAll(re)) {
      const at = m.index ?? 0
      push(rest.slice(last, at), SYNTAX.plain)
      if (m[1]) {
        push(m[1], SYNTAX.comment)
        if (!m[1].endsWith('-->')) state.inBlock = true
      } else if (m[2]) {
        push(m[2], SYNTAX.punct)
        push(m[3], SYNTAX.tag)
      } else if (m[4]) {
        push(m[4], SYNTAX.attr)
        push(m[5], SYNTAX.punct)
        push(m[6], SYNTAX.string)
      } else if (m[7]) push(m[7], SYNTAX.punct)
      else if (m[8]) push(m[8], SYNTAX.string)
      last = at + m[0].length
    }
    push(rest.slice(last), SYNTAX.plain)
    return out
  }

  while (i < line.length) {
    const rest = line.slice(i)
    if (state.inBlock && spec.block) {
      const end = line.indexOf(spec.block[1], i)
      if (end === -1) {
        push(rest, SYNTAX.comment)
        return out
      }
      push(line.slice(i, end + spec.block[1].length), SYNTAX.comment)
      i = end + spec.block[1].length
      state.inBlock = false
      continue
    }
    if (state.inTriple) {
      const end = line.indexOf(state.inTriple, i)
      if (end === -1) {
        push(rest, SYNTAX.string)
        return out
      }
      push(line.slice(i, end + 3), SYNTAX.string)
      i = end + 3
      state.inTriple = null
      continue
    }
    if (spec.line && rest.startsWith(spec.line) && !(spec.family === 'sh' && i > 0 && /\S/.test(line[i - 1]))) {
      push(rest, SYNTAX.comment)
      return out
    }
    if (spec.block && rest.startsWith(spec.block[0])) {
      state.inBlock = true
      push(spec.block[0], SYNTAX.comment)
      i += spec.block[0].length
      continue
    }
    const ch = line[i]
    if (spec.family === 'py' && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      state.inTriple = rest.slice(0, 3)
      push(rest.slice(0, 3), SYNTAX.string)
      i += 3
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1
      const text = line.slice(i, Math.min(line.length, j + 1))
      // A JSON key reads as a property, not a string.
      const isKey = spec.family === 'json' && /^\s*:/.test(line.slice(j + 1))
      push(text, isKey ? SYNTAX.func : SYNTAX.string)
      i += text.length
      continue
    }
    if (/\d/.test(ch) && (i === 0 || !/[\w$]/.test(line[i - 1]))) {
      const m = NUMBER.exec(rest)
      if (m) {
        push(m[0], SYNTAX.number)
        i += m[0].length
        continue
      }
    }
    if (spec.family === 'css') {
      const m = /^(#[\da-fA-F]{3,8}\b|[\w-]+(?=\s*:)|@[\w-]+|\.[\w-]+|::?[\w-]+)/.exec(rest)
      if (m) {
        push(m[0], m[0].startsWith('#') || m[0].startsWith('@') ? SYNTAX.number : m[0].startsWith('.') || m[0].startsWith(':') ? SYNTAX.type : SYNTAX.func)
        i += m[0].length
        continue
      }
    }
    if (spec.family === 'yaml') {
      const m = /^([\w.-]+)(\s*[:=])/.exec(rest)
      if (m && line.slice(0, i).trim().replace(/^-\s*/, '') === '') {
        push(m[1], SYNTAX.func)
        push(m[2], SYNTAX.punct)
        i += m[0].length
        continue
      }
    }
    if (spec.family === 'sh' && ch === '$') {
      const m = /^\$(\{[^}]*\}|\w+|[@*#?$!0-9])/.exec(rest)
      if (m) {
        push(m[0], SYNTAX.type)
        i += m[0].length
        continue
      }
    }
    const id = IDENT.exec(rest)
    if (id) {
      const word = id[0]
      const next = line.slice(i + word.length).trimStart()[0]
      const lower = spec.family === 'sql' ? word.toLowerCase() : word
      let style = SYNTAX.plain
      if (spec.keywords.has(lower)) style = SYNTAX.keyword
      else if (spec.constants.has(word)) style = SYNTAX.constant
      else if (next === '(') style = SYNTAX.func
      else if (/^[A-Z][A-Za-z0-9]*$/.test(word) && spec.family !== 'sql' && spec.family !== 'sh') style = SYNTAX.type
      else if (spec.family === 'c' && line[i - 1] === '.') style = SYNTAX.plain
      push(word, style)
      i += word.length
      continue
    }
    push(ch, /[{}()[\];,.<>=+\-*/%&|^!?:~@]/.test(ch) ? SYNTAX.punct : SYNTAX.plain)
    i++
  }
  return out
}

/** Highlights several lines at once, carrying comment and string state across them. */
export function highlightLines(lines: string[], lang: string): Token[][] {
  const state: HighlightState = {}
  return lines.map((line) => highlightLine(line, lang, state))
}

/** The same tokens with a background laid under every one (diff rows). */
export function onBackground(tokens: Token[], bg: string): Token[] {
  return tokens.map((t) => ({ text: t.text, style: { ...(t.style ?? SYNTAX.plain), bg } }))
}
