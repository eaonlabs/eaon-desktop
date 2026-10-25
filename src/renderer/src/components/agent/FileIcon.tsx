// Adapted from MIT and Apache-2.0 components; see components/agent/LICENSES.txt.
import type { CSSProperties, JSX } from 'react'
import {
  Atom,
  Award,
  Binary,
  Bird,
  Braces,
  CodeXml,
  Coffee,
  Cog,
  Container,
  Database,
  Droplet,
  FileArchive,
  FileText,
  Film,
  Gem,
  Hammer,
  Hash,
  Hexagon,
  History,
  Image,
  Info,
  KeyRound,
  Lock,
  Moon,
  Music,
  NotebookPen,
  Package,
  Settings,
  Settings2,
  Sheet,
  Terminal,
  Triangle,
  Type,
  type LucideIcon
} from 'lucide-react'

/**
 * A small mark for a file's type, like an editor's file tree shows: the
 * language's own mark where it has one people know (Python, TypeScript,
 * JavaScript, Markdown, Vue, git's files), and a glyph in the language's
 * colour for the rest — CSS's #, HTML's angle brackets, a picture for an
 * image, a gear for configuration. A file nothing matches is lines of text.
 * Shared by every place Chat names a file: the code panel's tree and tabs,
 * the edit cards, the changed-files card, the diffs and paths in replies.
 */

export type Glyph = { icon: LucideIcon; color: string } | { text: string; color: string } | { mark: 'python' | 'markdown' | 'git' | 'vue' | 'lines' | 'ts' | 'js' | 'json'; color?: string }

const BLUE = '#519aba'
const YELLOW = '#cbcb41'
const ORANGE = '#e37933'
const RED = '#cc3e44'
const PURPLE = '#a074c4'
const GREEN = '#8dc149'
const PINK = '#f55385'
const GREY = '#7d8e94'

const BY_EXT: Record<string, Glyph> = {
  ts: { mark: 'ts' },
  mts: { mark: 'ts' },
  cts: { mark: 'ts' },
  js: { mark: 'js' },
  mjs: { mark: 'js' },
  cjs: { mark: 'js' },
  json: { mark: 'json' },
  jsonc: { mark: 'json' },
  json5: { mark: 'json' },
  tsx: { icon: Atom, color: '#4fc1e9' },
  jsx: { icon: Atom, color: '#4fc1e9' },
  py: { mark: 'python' },
  pyi: { mark: 'python' },
  pyw: { mark: 'python' },
  pyx: { mark: 'python' },
  ipynb: { icon: NotebookPen, color: ORANGE },
  html: { icon: CodeXml, color: ORANGE },
  htm: { icon: CodeXml, color: ORANGE },
  xhtml: { icon: CodeXml, color: ORANGE },
  css: { icon: Hash, color: BLUE },
  scss: { icon: Hash, color: PINK },
  sass: { icon: Hash, color: PINK },
  less: { icon: Hash, color: '#7a8fd6' },
  styl: { icon: Hash, color: GREEN },
  vue: { mark: 'vue' },
  svelte: { text: 'S', color: '#ff5a1f' },
  astro: { text: 'A', color: ORANGE },
  md: { mark: 'markdown' },
  mdx: { mark: 'markdown' },
  markdown: { mark: 'markdown' },
  svg: { icon: Image, color: '#e8b53a' },
  png: { icon: Image, color: PURPLE },
  jpg: { icon: Image, color: PURPLE },
  jpeg: { icon: Image, color: PURPLE },
  gif: { icon: Image, color: PURPLE },
  webp: { icon: Image, color: PURPLE },
  bmp: { icon: Image, color: PURPLE },
  ico: { icon: Image, color: PURPLE },
  avif: { icon: Image, color: PURPLE },
  tiff: { icon: Image, color: PURPLE },
  heic: { icon: Image, color: PURPLE },
  yml: { icon: Braces, color: PURPLE },
  yaml: { icon: Braces, color: PURPLE },
  toml: { icon: Settings, color: GREY },
  ini: { icon: Settings, color: GREY },
  cfg: { icon: Settings, color: GREY },
  conf: { icon: Settings, color: GREY },
  properties: { icon: Settings, color: GREY },
  plist: { icon: CodeXml, color: YELLOW },
  xml: { icon: CodeXml, color: YELLOW },
  sh: { icon: Terminal, color: GREEN },
  bash: { icon: Terminal, color: GREEN },
  zsh: { icon: Terminal, color: GREEN },
  fish: { icon: Terminal, color: GREEN },
  ps1: { icon: Terminal, color: BLUE },
  bat: { icon: Terminal, color: YELLOW },
  cmd: { icon: Terminal, color: YELLOW },
  go: { text: 'GO', color: '#3fb3d9' },
  rs: { icon: Cog, color: '#dea584' },
  rb: { icon: Gem, color: RED },
  erb: { icon: Gem, color: RED },
  gemspec: { icon: Gem, color: RED },
  java: { icon: Coffee, color: RED },
  jar: { icon: Coffee, color: RED },
  class: { icon: Coffee, color: RED },
  kt: { text: 'K', color: PURPLE },
  kts: { text: 'K', color: PURPLE },
  swift: { icon: Bird, color: ORANGE },
  c: { text: 'C', color: BLUE },
  h: { text: 'H', color: PURPLE },
  cpp: { text: 'C++', color: PINK },
  cc: { text: 'C++', color: PINK },
  cxx: { text: 'C++', color: PINK },
  hpp: { text: 'H', color: PINK },
  cs: { text: 'C#', color: GREEN },
  m: { text: 'M', color: BLUE },
  php: { text: 'php', color: '#8892bf' },
  dart: { text: 'D', color: '#40c4ff' },
  scala: { text: 'S', color: RED },
  lua: { icon: Moon, color: BLUE },
  r: { text: 'R', color: BLUE },
  jl: { text: 'jl', color: PURPLE },
  ex: { icon: Droplet, color: PURPLE },
  exs: { icon: Droplet, color: PURPLE },
  hs: { text: 'λ', color: PURPLE },
  zig: { text: 'Z', color: ORANGE },
  sql: { icon: Database, color: PINK },
  db: { icon: Database, color: PINK },
  sqlite: { icon: Database, color: PINK },
  prisma: { icon: Triangle, color: '#9aa9b4' },
  graphql: { icon: Hexagon, color: PINK },
  gql: { icon: Hexagon, color: PINK },
  proto: { text: 'PB', color: BLUE },
  tf: { text: 'TF', color: PURPLE },
  wasm: { text: 'WA', color: PURPLE },
  pdf: { icon: FileText, color: RED },
  zip: { icon: FileArchive, color: YELLOW },
  tar: { icon: FileArchive, color: YELLOW },
  gz: { icon: FileArchive, color: YELLOW },
  tgz: { icon: FileArchive, color: YELLOW },
  rar: { icon: FileArchive, color: YELLOW },
  '7z': { icon: FileArchive, color: YELLOW },
  mp4: { icon: Film, color: PINK },
  mov: { icon: Film, color: PINK },
  webm: { icon: Film, color: PINK },
  mkv: { icon: Film, color: PINK },
  avi: { icon: Film, color: PINK },
  mp3: { icon: Music, color: PURPLE },
  wav: { icon: Music, color: PURPLE },
  flac: { icon: Music, color: PURPLE },
  ogg: { icon: Music, color: PURPLE },
  m4a: { icon: Music, color: PURPLE },
  ttf: { icon: Type, color: RED },
  otf: { icon: Type, color: RED },
  woff: { icon: Type, color: RED },
  woff2: { icon: Type, color: RED },
  csv: { icon: Sheet, color: GREEN },
  tsv: { icon: Sheet, color: GREEN },
  xlsx: { icon: Sheet, color: GREEN },
  lock: { icon: Lock, color: GREY },
  exe: { icon: Binary, color: GREY },
  dll: { icon: Binary, color: GREY },
  so: { icon: Binary, color: GREY },
  dylib: { icon: Binary, color: GREY },
  mk: { icon: Hammer, color: ORANGE }
}

/** Whole names that say more than their extension. */
function byName(name: string): Glyph | null {
  const n = name.toLowerCase()
  if (n === 'package.json' || n === 'package-lock.json') return { icon: Package, color: RED }
  if (/^(ts|js)config(\..+)?\.json$/.test(n)) return { icon: Settings2, color: BLUE }
  if (n === 'dockerfile' || n.startsWith('dockerfile.') || n === '.dockerignore' || /^(docker-)?compose(\..+)?\.ya?ml$/.test(n)) return { icon: Container, color: '#3b9ae1' }
  if (n.startsWith('.git') || n === '.gitkeep') return { mark: 'git', color: GREY }
  if (n === '.env' || n.startsWith('.env.')) return { icon: KeyRound, color: YELLOW }
  if (/\.lock$|^bun\.lockb?$|^pnpm-lock\.yaml$/.test(n)) return { icon: Lock, color: GREY }
  if (n === 'makefile' || n === 'gnumakefile' || n === 'cmakelists.txt') return { icon: Hammer, color: ORANGE }
  if (n === 'gemfile' || n === 'rakefile') return { icon: Gem, color: RED }
  if (/^readme(\.|$)/.test(n)) return { icon: Info, color: BLUE }
  if (/^(license|licence|copying)(\.|$)/.test(n)) return { icon: Award, color: YELLOW }
  if (/^changelog(\.|$)/.test(n)) return { icon: History, color: GREEN }
  if (/^\.(editorconfig|npmrc|nvmrc|prettierrc|eslintrc|babelrc|stylelintrc|browserslistrc)/.test(n) || /^(eslint|prettier|vite|vitest|webpack|rollup|tailwind|postcss|babel|jest)\.config\./.test(n)) {
    return { icon: Settings, color: n.includes('eslint') ? PURPLE : GREY }
  }
  return null
}

/** A file's mark, by its whole name first, then its extension; lines of text when nothing matches. */
export function glyphFor(file: string): Glyph {
  const name = file.split(/[\\/]/).pop() ?? file
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return byName(name) ?? BY_EXT[ext] ?? { mark: 'lines' }
}

export function FileIcon({ file, size = 14 }: { file: string; size?: number }): JSX.Element {
  const glyph = glyphFor(file)
  const tint = { '--fi': 'color' in glyph && glyph.color ? glyph.color : GREY } as CSSProperties
  if ('icon' in glyph) {
    const Icon = glyph.icon
    return <Icon size={size} strokeWidth={1.8} className="file-icon" style={tint} aria-hidden />
  }
  if ('text' in glyph) {
    // Short marks (GO, C#, php) as letters, set tight so they sit in the same square as the glyphs.
    const fontSize = glyph.text.length >= 3 ? 6.4 : glyph.text.length === 2 ? 8 : 10.5
    return (
      <svg className="file-icon file-icon--text" viewBox="0 0 16 16" width={size} height={size} style={tint} aria-hidden>
        <text x="8" y="8.6" textAnchor="middle" dominantBaseline="middle" fontSize={fontSize} fontWeight={800} fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif" fill="currentColor" letterSpacing="-0.3">
          {glyph.text}
        </text>
      </svg>
    )
  }
  return <Mark mark={glyph.mark} size={size} style={tint} />
}

function Mark({ mark, size, style }: { mark: Extract<Glyph, { mark: string }>['mark']; size: number; style: CSSProperties }): JSX.Element {
  if (mark === 'ts') {
    return (
      <svg className="file-icon" viewBox="0 0 32 32" width={size} height={size} aria-hidden>
        <path
          d="M23.827,8.243A4.424,4.424,0,0,1,26.05,9.524a5.853,5.853,0,0,1,.852,1.143c.011.045-1.534,1.083-2.471,1.662-.034.023-.169-.124-.322-.35a2.014,2.014,0,0,0-1.67-1c-1.077-.074-1.771.49-1.766,1.433a1.3,1.3,0,0,0,.153.666c.237.49.677.784,2.059,1.383,2.544,1.095,3.636,1.817,4.31,2.843a5.158,5.158,0,0,1,.416,4.333,4.764,4.764,0,0,1-3.932,2.815,10.9,10.9,0,0,1-2.708-.028,6.531,6.531,0,0,1-3.616-1.884,6.278,6.278,0,0,1-.926-1.371,2.655,2.655,0,0,1,.327-.208c.158-.09.756-.434,1.32-.761L19.1,19.6l.214.312a4.771,4.771,0,0,0,1.35,1.292,3.3,3.3,0,0,0,3.458-.175,1.545,1.545,0,0,0,.2-1.974c-.276-.395-.84-.727-2.443-1.422a8.8,8.8,0,0,1-3.349-2.055,4.687,4.687,0,0,1-.976-1.777,7.116,7.116,0,0,1-.062-2.268,4.332,4.332,0,0,1,3.644-3.374A9,9,0,0,1,23.827,8.243ZM15.484,9.726l.011,1.454h-4.63V24.328H7.6V11.183H2.97V9.755A13.986,13.986,0,0,1,3.01,8.289c.017-.023,2.832-.034,6.245-.028l6.211.017Z"
          fill="#3b8eea"
        />
      </svg>
    )
  }
  if (mark === 'js') {
    return (
      <svg className="file-icon" viewBox="0 0 32 32" width={size} height={size} aria-hidden>
        <rect x="2" y="2" width="28" height="28" rx="3" fill="#f5de19" />
        <path
          d="M20.809,23.875a2.866,2.866,0,0,0,2.6,1.6c1.09,0,1.787-.545,1.787-1.3,0-.9-.715-1.222-1.916-1.747l-.658-.282c-1.9-.809-3.16-1.822-3.16-3.964,0-1.973,1.5-3.476,3.853-3.476a3.889,3.889,0,0,1,3.742,2.107L25,18.128A1.789,1.789,0,0,0,23.311,17a1.145,1.145,0,0,0-1.259,1.128c0,.789.489,1.109,1.618,1.6l.658.282c2.236.959,3.5,1.936,3.5,4.133,0,2.369-1.861,3.667-4.36,3.667a5.055,5.055,0,0,1-4.795-2.691Zm-9.295.228c.413.733.789,1.353,1.693,1.353.864,0,1.41-.338,1.41-1.653V14.856h2.631v8.982c0,2.724-1.6,3.964-3.929,3.964a4.085,4.085,0,0,1-3.947-2.4Z"
          fill="#000"
        />
      </svg>
    )
  }
  if (mark === 'json') {
    return (
      <svg className="file-icon" viewBox="0 0 32 32" width={size} height={size} aria-hidden>
        <path
          d="M4.014,14.976a2.51,2.51,0,0,0,1.567-.518A2.377,2.377,0,0,0,6.386,13l.129-1.334A5.435,5.435,0,0,1,7.6,9.071,3.157,3.157,0,0,1,10.519,8h1.316v1.86H10.937a1.257,1.257,0,0,0-1.1.465,3.405,3.405,0,0,0-.357,1.585l-.127,1.244a3.283,3.283,0,0,1-.573,1.61A2.482,2.482,0,0,1,7.6,15.537a2.482,2.482,0,0,1,1.18.773A3.283,3.283,0,0,1,9.349,17.9l.127,1.244a3.405,3.405,0,0,0,.357,1.585,1.257,1.257,0,0,0,1.1.465h.9V23.06H10.519A3.157,3.157,0,0,1,7.6,21.981a5.435,5.435,0,0,1-1.082-2.595L6.386,18.05a2.377,2.377,0,0,0-.805-1.456A2.51,2.51,0,0,0,4.014,16.07Z"
          fill="#e8b92e"
        />
        <path
          d="M27.986,16.07a2.51,2.51,0,0,0-1.567.518,2.377,2.377,0,0,0-.805,1.456l-.129,1.334a5.435,5.435,0,0,1-1.082,2.595A3.157,3.157,0,0,1,21.481,23.06H20.165V21.2h.9a1.257,1.257,0,0,0,1.1-.465,3.405,3.405,0,0,0,.357-1.585l.127-1.244a3.283,3.283,0,0,1,.573-1.61,2.482,2.482,0,0,1,1.18-.773,2.482,2.482,0,0,1-1.18-.773,3.283,3.283,0,0,1-.573-1.61L22.527,11.9a3.405,3.405,0,0,0-.357-1.585,1.257,1.257,0,0,0-1.1-.465h-.9V8h1.316a3.157,3.157,0,0,1,2.924,1.071,5.435,5.435,0,0,1,1.082,2.595l.129,1.334A2.377,2.377,0,0,0,26.419,14.458a2.51,2.51,0,0,0,1.567.518Z"
          fill="#e8b92e"
        />
      </svg>
    )
  }
  if (mark === 'python') {
    // Two rounded halves, blue over yellow, each with its eye.
    return (
      <svg className="file-icon" viewBox="0 0 16 16" width={size} height={size} aria-hidden>
        <path d="M7.9 1.4c-2.5 0-3 1.1-3 2.1v1.4h3.2v.6H3.7c-1.2 0-2.2.9-2.2 2.6 0 1.8.9 2.7 2 2.7h1.4V9.3c0-1.1.9-2 2-2h2.7c.9 0 1.6-.7 1.6-1.6V3.5c0-1-.9-2.1-3.3-2.1Z" fill="#4b8bbe" />
        <circle cx="6.3" cy="3.1" r="0.6" fill="#fff" />
        <path d="M8.1 14.6c2.5 0 3-1.1 3-2.1v-1.4H7.9v-.6h4.4c1.2 0 2.2-.9 2.2-2.6 0-1.8-.9-2.7-2-2.7h-1.4v1.5c0 1.1-.9 2-2 2H6.4c-.9 0-1.6.7-1.6 1.6v2.2c0 1 .9 2.1 3.3 2.1Z" fill="#f7cf3d" />
        <circle cx="9.7" cy="12.9" r="0.6" fill="#fff" />
      </svg>
    )
  }
  if (mark === 'markdown') {
    return (
      <svg className="file-icon" viewBox="0 0 16 16" width={size} height={size} style={{ ...style, '--fi': BLUE } as CSSProperties} aria-hidden>
        <rect x="1" y="3.5" width="14" height="9" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M3.6 10.4V5.6l1.9 2.3 1.9-2.3v4.8M11.4 5.6v4.6M9.8 8.7l1.6 1.6 1.6-1.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (mark === 'git') {
    return (
      <svg className="file-icon" viewBox="0 0 16 16" width={size} height={size} style={style} aria-hidden>
        <path d="M8 1.3 14.7 8 8 14.7 1.3 8Z" fill="currentColor" />
        <path d="M6.2 4.8 8 6.6v3.5M8 6.6l2 2" fill="none" stroke="var(--fi-cut, var(--bg))" strokeWidth="1.2" strokeLinecap="round" />
        <circle cx="8" cy="10.6" r="1" fill="var(--fi-cut, var(--bg))" />
        <circle cx="10.3" cy="8.9" r="1" fill="var(--fi-cut, var(--bg))" />
      </svg>
    )
  }
  if (mark === 'vue') {
    return (
      <svg className="file-icon" viewBox="0 0 16 16" width={size} height={size} aria-hidden>
        <path d="M1 2.5h3l4 6.9 4-6.9h3L8 14.5Z" fill="#41b883" />
        <path d="M4 2.5h2.4L8 5.3l1.6-2.8H12L8 9.4Z" fill="#35495e" />
      </svg>
    )
  }
  // Lines of text: a file with no mark of its own.
  return (
    <svg className="file-icon" viewBox="0 0 16 16" width={size} height={size} style={style} aria-hidden>
      <path d="M3 4h10M3 7h10M3 10h10M3 13h6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

/** "src/state/store.ts" → { name: "store.ts", folder: "src/state" }. */
export function splitPath(path: string): { name: string; folder: string } {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return { name: path.slice(slash + 1), folder: slash > 0 ? path.slice(0, slash) : '' }
}
