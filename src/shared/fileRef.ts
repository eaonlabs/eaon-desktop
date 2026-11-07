/**
 * Reading a file path out of text: `src/app.ts:42`, `./a/b.tsx#L10`, a bare
 * `package.json`. Used for the paths in an agent's reply (Chat) and in a
 * terminal's output (the ADE), so both decide the same way what is a file and
 * what is only a word with a dot in it.
 */

const EXTENSIONS = new Set(
  (
    'ts tsx js jsx mjs cjs mts cts json jsonc md mdx css scss sass less html htm py pyi rb go rs java kt kts swift m mm c h cc cpp hpp cs php sh bash zsh fish ' +
    'yml yaml toml lock txt sql vue svelte astro env xml gradle plist ini cfg conf proto graphql gql lua dart ex exs erl hs ml scala clj r jl zig nim ' +
    'tf hcl dockerfile make cmake mk gitignore npmrc log csv tsv svg ipynb'
  ).split(' ')
)

/** Extensions that are just as often a property (`console.log`, `process.env`): a file only with a folder in front. */
const AMBIGUOUS = new Set(['log', 'env', 'm', 'r', 'ml', 'mk', 'ex', 'h', 'c', 'make', 'conf', 'cfg'])

/** A path, with a line (`:12`, `:12:4`, `#L12`, `#L12-L20`) when there is one. */
const FILE_REF = /^(?<path>(?:~|\.{1,2})?[\\/]?[\w@+.-]+(?:[\\/][\w@+.-]+)*)(?:(?::|#L)(?<line>\d+)(?::\d+)?(?:-L?\d+)?)?$/

/** `text` as a file and line when it reads as a path to a file: a folder in it, or an extension files have. */
export function parseFileRef(text: string): { path: string; line: number | null } | null {
  const trimmed = text.trim()
  if (trimmed.length < 3 || trimmed.length > 300 || /\s/.test(trimmed) || /^[a-z]+:\/\//i.test(trimmed)) return null
  const m = FILE_REF.exec(trimmed)
  if (!m?.groups) return null
  const path = m.groups.path
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : dot === 0 ? base.slice(1).toLowerCase() : ''
  const folder = /[\\/]/.test(path) && !/^[\\/]+$/.test(path)
  const known = (EXTENSIONS.has(ext) && (folder || !AMBIGUOUS.has(ext))) || /^(Makefile|Dockerfile|Procfile|Gemfile|Rakefile|LICENSE|README)$/.test(base)
  // A dotted name with no folder and no file extension is a method call or a version, not a file.
  if (!known && !(folder && dot > 0 && /^[A-Za-z][A-Za-z0-9]{0,9}$/.test(ext))) return null
  return { path, line: m.groups.line ? Number(m.groups.line) : null }
}
