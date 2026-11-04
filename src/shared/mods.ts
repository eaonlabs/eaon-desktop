import { TERMINAL_AGENT_IDS, type TerminalAgentId } from './terminals'
import type { WorkerShape } from './workerLook'

/**
 * Mods: add-ons that change Eaon itself and the coding CLIs it starts. A mod
 * is a folder with a `mod.json` (this file's `ModManifest`) and the files it
 * names. Almost everything a mod adds is data: themes, slash commands,
 * snippets, worker templates, ADE presets, HTTP tools. The two parts that run
 * code are kept apart and shown before install:
 *
 * - a panel is a page that runs in a sandboxed frame with no network, no
 *   files and no `window.api`; it reaches the app only through the few host
 *   calls it declares (`ModPanel.host`);
 * - a Claude Code plugin's hooks and MCP servers run as programs, started by
 *   Claude Code in sessions Eaon launches (never the user's own).
 *
 * What a mod can touch is worked out from its manifest (`modAccess`), never
 * from a list the mod writes about itself, so the install screen can't be
 * told one thing while the mod does another.
 *
 * Main installs and serves mods (main/features/mods); the renderer applies
 * the parts it draws (renderer state/mods.ts). Docs: docs/mods.md.
 */

export const MOD_SCHEMA = 1

export type ModCategory = 'themes' | 'commands' | 'instructions' | 'editor' | 'panels' | 'workers' | 'tools' | 'ade' | 'cli' | 'sounds'

/** The categories, in the order the marketplace shows them. Connectors (MCP) are listed beside them but aren't mods. */
export const MOD_CATEGORIES: { id: ModCategory; label: string }[] = [
  { id: 'themes', label: 'Themes' },
  { id: 'commands', label: 'Commands' },
  { id: 'instructions', label: 'Instructions' },
  { id: 'editor', label: 'Editor' },
  { id: 'panels', label: 'Panels' },
  { id: 'workers', label: 'Workers' },
  { id: 'tools', label: 'Agent tools' },
  { id: 'ade', label: 'ADE' },
  { id: 'cli', label: 'Coding CLIs' },
  { id: 'sounds', label: 'Sounds' }
]

export interface ModTone {
  accent: string
  background: string
  foreground: string
  /** 0–100, as in Settings → Appearance. */
  contrast: number
}

/** An app theme: the four values per appearance that restyle every surface (renderer lib/themes.ts). */
export interface ModAppTheme {
  name: string
  light: ModTone
  dark: ModTone
}

export interface ModTerminalColors {
  background: string
  foreground: string
  cursor: string
  selection: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export const TERMINAL_COLOR_KEYS: (keyof ModTerminalColors)[] = [
  'background', 'foreground', 'cursor', 'selection',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'
]

/** An ADE terminal theme. `scene` is one of the ADE's own scenes; `app` names an app theme (built in, or one of this mod's). */
export interface ModTerminalTheme {
  id: string
  name: string
  mode: 'dark' | 'light'
  blurb: string
  scene: string | null
  app: string | null
  colors: ModTerminalColors
}

/** A "/" command in a composer: picking it puts `prompt` in the box, for the user to finish and send. */
export interface ModCommand {
  name: string
  description: string
  prompt: string
  /** Which composers list it; both when left out. */
  where?: ('chat' | 'workers')[]
}

/** Typed `prefix` then Tab in the code editor, for a file in one of `languages`. `$0` marks where the caret lands. */
export interface ModSnippet {
  prefix: string
  description: string
  languages: string[]
  body: string
}

/**
 * Syntax colouring for a language the editor and code blocks don't colour
 * yet. Only word lists and literal delimiters: the pattern is built by the
 * app (renderer components/agent/highlight.ts), so a mod can never hand it a
 * regular expression that hangs the page.
 */
export interface ModLanguage {
  id: string
  name: string
  /** File extensions and fence labels: "lua", "tf", "hcl". */
  aliases: string[]
  lineComment?: string[]
  blockComment?: [string, string]
  /** Quote characters that open a string: `"`, `'` or a backtick. */
  strings?: string[]
  keywords: string[]
  literals?: string[]
  types?: string[]
}

/** What a panel may ask the app to do, each shown on the install screen. */
export type ModHostCall = 'storage' | 'composer' | 'notify'

export const HOST_CALLS: ModHostCall[] = ['storage', 'composer', 'notify']

/** A page in the Chat and ADE dock, run in a sandbox (see the note at the top). */
export interface ModPanel {
  id: string
  title: string
  description: string
  /** An .html file in the mod. */
  entry: string
  host: ModHostCall[]
}

/** A starting point on the New worker page. */
export interface ModWorkerTemplate {
  id: string
  name: string
  blurb: string
  color: string
  shape: WorkerShape
  purpose: string
  personality: string
}

/** An ADE session that opens with these panes (and, for an agent given a prompt, starts on it). */
export interface ModSessionPreset {
  id: string
  name: string
  description: string
  panes: { agent: TerminalAgentId; name?: string; prompt?: string }[]
}

/** Something small in the ADE's header. */
export type ModWidget =
  | { id: string; kind: 'clock'; label: string; timeZone: string }
  | { id: string; kind: 'timer'; label: string; minutes: number }

/** One note of a sound, played by the app (Web Audio), so a mod ships no audio files. */
export interface ModNote {
  freq: number
  ms: number
  wave?: 'sine' | 'triangle' | 'square'
  gain?: number
}

export type ModSoundEvent = 'reply' | 'ade' | 'error'

export const SOUND_EVENTS: { id: ModSoundEvent; label: string }[] = [
  { id: 'reply', label: 'a Chat reply finishes' },
  { id: 'ade', label: 'an ADE agent finishes or needs you' },
  { id: 'error', label: 'a reply fails' }
]

/**
 * A tool agents can call that makes one HTTPS GET. The host is fixed in the
 * URL; `{name}` placeholders in the path and query are filled from the
 * call's arguments, encoded. So the install screen can say exactly which
 * sites a mod's tools reach.
 */
export interface ModTool {
  name: string
  description: string
  url: string
  params: { name: string; type: 'string' | 'number' | 'integer' | 'boolean'; description: string; required?: boolean; enum?: string[] }[]
  /** Dotted paths kept from a JSON answer ("current.temperature_2m", "items.*.title"); the whole answer when left out. */
  pick?: string[]
  /** The answer is cut to this many characters. */
  maxChars?: number
}

/** A stdio MCP server Codex starts for sessions Eaon launches (`-c mcp_servers.*`). */
export interface ModCliServer {
  command: string
  args?: string[]
}

export interface ModCodex {
  /** Added to Codex's developer instructions (`-c developer_instructions`), unless the user's Codex config sets its own. */
  instructions?: string
  mcpServers?: Record<string, ModCliServer>
}

export interface ModContributions {
  appThemes?: ModAppTheme[]
  terminalThemes?: ModTerminalTheme[]
  commands?: ModCommand[]
  /** Added to what Chat's model is told, in every chat. */
  instructions?: string
  snippets?: ModSnippet[]
  languages?: ModLanguage[]
  panels?: ModPanel[]
  workerTemplates?: ModWorkerTemplate[]
  sessionPresets?: ModSessionPreset[]
  widgets?: ModWidget[]
  sounds?: Partial<Record<ModSoundEvent, ModNote[]>>
  tools?: ModTool[]
  /** A Claude Code plugin folder in the mod (`.claude-plugin/plugin.json` and its parts), loaded with `--plugin-dir`. */
  claudePlugin?: string
  codex?: ModCodex
}

export interface ModManifest {
  schema: typeof MOD_SCHEMA
  /** Lowercase words joined by dots or dashes: "eaon.git-commands", "jane.solarized-night". */
  id: string
  name: string
  version: string
  publisher: string
  description: string
  category: ModCategory
  homepage?: string
  license?: string
  contributes: ModContributions
}

/** Where an installed mod came from. */
export type ModSource =
  | { kind: 'bundled' }
  | { kind: 'folder'; path: string }
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string }

/** What a Claude Code plugin folder holds, read when the mod is installed. */
export interface ClaudePluginParts {
  commands: string[]
  skills: string[]
  agents: string[]
  /** "PreToolUse (Bash): sh ${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh" */
  hooks: string[]
  mcpServers: string[]
}

/** One line of "what this mod can touch". `level` sorts and colours it: `code` and `access` need a review. */
export interface ModAccessRow {
  level: 'look' | 'adds' | 'access' | 'code'
  text: string
  detail?: string
  /** The detail is commands as they run, shown in a code font. */
  mono?: boolean
}

/** A mod as the marketplace shows it. */
export interface ModInfo {
  manifest: ModManifest
  /** Bundled with Eaon and published by Eaon: the only mods with a verified mark. */
  official: boolean
  installed: boolean
  enabled: boolean
  source: ModSource | null
  /** A source the mod can be installed from: 'bundled', or an index URL. */
  from: 'bundled' | string
  /** A newer version is waiting (bundled with this Eaon, or in the index) that asks for more than the one installed. */
  update: string | null
  claude: ClaudePluginParts | null
  access: ModAccessRow[]
  installedAt: number | null
}

/** A mod source (an index of packed mods) as the marketplace lists it. */
export interface ModSourceInfo {
  url: string
  name: string
  /** How many mods its index lists; null until it has been read this run. */
  count: number | null
  error: string | null
}

/** Everything the marketplace shows: installed mods, Eaon's own, and those the sources list. */
export interface ModsList {
  mods: ModInfo[]
  sources: ModSourceInfo[]
}

/** A mod source: a JSON index of packed mods, added by its URL. */
export interface ModIndex {
  name: string
  /** Each packed mod's link, relative to the index or absolute, and its manifest for the card. */
  mods: { url: string; manifest: ModManifest }[]
}

/**
 * A packed mod: the manifest and its files in one JSON document, so a mod can
 * be shared as one file or one URL without an archive format. Text files only.
 */
export interface ModPack {
  eaonMod: typeof MOD_SCHEMA
  manifest: ModManifest
  files: Record<string, string>
}

export const MOD_LIMITS = {
  files: 200,
  bytes: 2 * 1024 * 1024,
  prompt: 4000,
  instructions: 2000,
  listItems: 40
} as const

/* ------------------------------------------------------------- validation */

type Raw = Record<string, unknown>

class ManifestError extends Error {}

const fail = (message: string): never => {
  throw new ManifestError(message)
}

const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value)

function text(value: unknown, field: string, max: number, min = 1): string {
  if (typeof value !== 'string') return fail(`${field} must be text`)
  const trimmed = value.trim()
  if (trimmed.length < min) return fail(`${field} is empty`)
  if (trimmed.length > max) return fail(`${field} is longer than ${max} characters`)
  return trimmed
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  return value === undefined ? undefined : text(value, field, max)
}

function list<T>(value: unknown, field: string, each: (item: unknown, at: string) => T, max: number = MOD_LIMITS.listItems): T[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return fail(`${field} must be a list`)
  if (value.length > max) return fail(`${field} has more than ${max} entries`)
  return value.map((item, index) => each(item, `${field}[${index}]`))
}

function words(value: unknown, field: string, pattern: RegExp, max = 200): string[] {
  const items = list(value, field, (item, at) => text(item, at, 40), max) ?? []
  for (const item of items) if (!pattern.test(item)) fail(`${field} has "${item}", which isn't allowed`)
  return items
}

const HEX = /^#[0-9a-fA-F]{6}$/
const HEX_ALPHA = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/
/** A #RRGGBB colour; with `alpha`, #RRGGBBAA too (a terminal's selection is see-through). */
function color(value: unknown, field: string, alpha = false): string {
  if (typeof value !== 'string' || !(alpha ? HEX_ALPHA : HEX).test(value)) return fail(`${field} must be a colour like #1A2B3C`)
  return value.toUpperCase()
}

function number(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return fail(`${field} must be a number from ${min} to ${max}`)
  return value
}

const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function slug(value: unknown, field: string): string {
  const id = text(value, field, 48)
  if (!SLUG.test(id)) fail(`${field} must be lowercase words joined by dashes`)
  return id
}

/** A path inside the mod: relative, forward slashes, no "..", no dotfiles except `.claude-plugin`. */
export function safeModPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const path = value.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!path || path.length > 200 || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return null
  const parts = path.split('/')
  for (const part of parts) {
    if (!part || part === '.' || part === '..') return null
    if (part.startsWith('.') && part !== '.claude-plugin' && part !== '.mcp.json') return null
    if (!/^[\w.@+-]+$/.test(part)) return null
  }
  return parts.join('/')
}

function modPath(value: unknown, field: string): string {
  return safeModPath(value) ?? fail(`${field} must be a path inside the mod`)
}

function tone(value: unknown, field: string): ModTone {
  if (!isObject(value)) return fail(`${field} must be an object`)
  return {
    accent: color(value.accent, `${field}.accent`),
    background: color(value.background, `${field}.background`),
    foreground: color(value.foreground, `${field}.foreground`),
    contrast: number(value.contrast, `${field}.contrast`, 0, 100)
  }
}

function appTheme(value: unknown, field: string): ModAppTheme {
  if (!isObject(value)) return fail(`${field} must be an object`)
  return { name: text(value.name, `${field}.name`, 32), light: tone(value.light, `${field}.light`), dark: tone(value.dark, `${field}.dark`) }
}

function terminalTheme(value: unknown, field: string): ModTerminalTheme {
  if (!isObject(value)) return fail(`${field} must be an object`)
  if (!isObject(value.colors)) return fail(`${field}.colors must be an object`)
  const raw = value.colors
  const colors = Object.fromEntries(TERMINAL_COLOR_KEYS.map((key) => [key, color(raw[key], `${field}.colors.${key}`, key === 'selection')])) as unknown as ModTerminalColors
  if (value.mode !== 'dark' && value.mode !== 'light') fail(`${field}.mode must be "dark" or "light"`)
  return {
    id: slug(value.id, `${field}.id`),
    name: text(value.name, `${field}.name`, 32),
    mode: value.mode as 'dark' | 'light',
    blurb: text(value.blurb, `${field}.blurb`, 80),
    // Checked against the ADE's scenes where they're drawn (renderer): an unknown one draws nothing.
    scene: value.scene == null ? null : slug(value.scene, `${field}.scene`),
    app: value.app == null ? null : text(value.app, `${field}.app`, 32),
    colors
  }
}

function command(value: unknown, field: string): ModCommand {
  if (!isObject(value)) return fail(`${field} must be an object`)
  const name = text(value.name, `${field}.name`, 32)
  if (!/^[a-z][a-z0-9-]*$/.test(name)) fail(`${field}.name must be lowercase letters, digits and dashes`)
  const where = list(value.where, `${field}.where`, (item, at) => (item === 'chat' || item === 'workers' ? item : fail(`${at} must be "chat" or "workers"`)), 2)
  return {
    name,
    description: text(value.description, `${field}.description`, 80),
    prompt: text(value.prompt, `${field}.prompt`, MOD_LIMITS.prompt),
    ...(where ? { where } : {})
  }
}

function snippet(value: unknown, field: string): ModSnippet {
  if (!isObject(value)) return fail(`${field} must be an object`)
  const prefix = text(value.prefix, `${field}.prefix`, 24)
  if (!/^[A-Za-z_][\w-]*$/.test(prefix)) fail(`${field}.prefix must be one word`)
  return {
    prefix,
    description: text(value.description, `${field}.description`, 80),
    languages: words(value.languages, `${field}.languages`, /^[a-z0-9+#-]+$/, 20),
    body: text(value.body, `${field}.body`, 2000)
  }
}

function delimiter(value: unknown, field: string): string {
  const d = text(value, field, 4)
  if (/\s/.test(d)) fail(`${field} can't contain spaces`)
  return d
}

function language(value: unknown, field: string): ModLanguage {
  if (!isObject(value)) return fail(`${field} must be an object`)
  const block = value.blockComment
  if (block !== undefined && (!Array.isArray(block) || block.length !== 2)) fail(`${field}.blockComment must be [open, close]`)
  const strings = list(value.strings, `${field}.strings`, (item, at) => (item === '"' || item === "'" || item === '`' ? item : fail(`${at} must be a quote character`)), 3)
  const word = /^[A-Za-z_@$#:.-][\w@$#:.!?-]*$/
  return {
    id: slug(value.id, `${field}.id`),
    name: text(value.name, `${field}.name`, 32),
    aliases: words(value.aliases, `${field}.aliases`, /^[a-z0-9+#.-]+$/, 20),
    ...(value.lineComment !== undefined ? { lineComment: list(value.lineComment, `${field}.lineComment`, (item, at) => delimiter(item, at), 3) } : {}),
    ...(block !== undefined ? { blockComment: [delimiter((block as unknown[])[0], `${field}.blockComment[0]`), delimiter((block as unknown[])[1], `${field}.blockComment[1]`)] as [string, string] } : {}),
    ...(strings ? { strings } : {}),
    keywords: words(value.keywords, `${field}.keywords`, word, 300),
    ...(value.literals !== undefined ? { literals: words(value.literals, `${field}.literals`, word, 100) } : {}),
    ...(value.types !== undefined ? { types: words(value.types, `${field}.types`, word, 200) } : {})
  }
}

function panel(value: unknown, field: string): ModPanel {
  if (!isObject(value)) return fail(`${field} must be an object`)
  const entry = modPath(value.entry, `${field}.entry`)
  if (!entry.endsWith('.html')) fail(`${field}.entry must be an .html file`)
  const host = list(value.host, `${field}.host`, (item, at) => (HOST_CALLS.includes(item as ModHostCall) ? (item as ModHostCall) : fail(`${at} must be one of ${HOST_CALLS.join(', ')}`)), 3) ?? []
  return {
    id: slug(value.id, `${field}.id`),
    title: text(value.title, `${field}.title`, 24),
    description: text(value.description, `${field}.description`, 120),
    entry,
    host: [...new Set(host)]
  }
}

const SHAPES: WorkerShape[] = ['pebble', 'blob', 'bun', 'capsule', 'ghost', 'gumdrop', 'flower', 'gem', 'star', 'heart']

function workerTemplate(value: unknown, field: string): ModWorkerTemplate {
  if (!isObject(value)) return fail(`${field} must be an object`)
  if (!SHAPES.includes(value.shape as WorkerShape)) fail(`${field}.shape must be one of ${SHAPES.join(', ')}`)
  return {
    id: slug(value.id, `${field}.id`),
    name: text(value.name, `${field}.name`, 32),
    blurb: text(value.blurb, `${field}.blurb`, 80),
    color: color(value.color, `${field}.color`),
    shape: value.shape as WorkerShape,
    purpose: text(value.purpose, `${field}.purpose`, 2000),
    personality: text(value.personality, `${field}.personality`, 600)
  }
}

function preset(value: unknown, field: string): ModSessionPreset {
  if (!isObject(value)) return fail(`${field} must be an object`)
  const panes = list(value.panes, `${field}.panes`, (item, at) => {
    if (!isObject(item)) return fail(`${at} must be an object`)
    if (!(TERMINAL_AGENT_IDS as readonly unknown[]).includes(item.agent)) fail(`${at}.agent isn't an agent the ADE runs`)
    const prompt = optionalText(item.prompt, `${at}.prompt`, 500)
    if (prompt && /[\r\n]/.test(prompt)) fail(`${at}.prompt must be one line`)
    if (prompt && item.agent === 'shell') fail(`${at}: a shell pane can't have a prompt`)
    const name = optionalText(item.name, `${at}.name`, 24)
    return { agent: item.agent as TerminalAgentId, ...(name ? { name } : {}), ...(prompt ? { prompt } : {}) }
  }, 9)
  if (!panes?.length) fail(`${field}.panes is empty`)
  return { id: slug(value.id, `${field}.id`), name: text(value.name, `${field}.name`, 32), description: text(value.description, `${field}.description`, 120), panes: panes! }
}

function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

function widget(value: unknown, field: string): ModWidget {
  if (!isObject(value)) return fail(`${field} must be an object`)
  const id = slug(value.id, `${field}.id`)
  const label = text(value.label, `${field}.label`, 16)
  if (value.kind === 'clock') {
    const timeZone = text(value.timeZone, `${field}.timeZone`, 64)
    if (!validTimeZone(timeZone)) fail(`${field}.timeZone isn't a time zone`)
    return { id, kind: 'clock', label, timeZone }
  }
  if (value.kind === 'timer') return { id, kind: 'timer', label, minutes: number(value.minutes, `${field}.minutes`, 1, 240) }
  return fail(`${field}.kind must be "clock" or "timer"`)
}

function notes(value: unknown, field: string): ModNote[] {
  return (
    list(value, field, (item, at) => {
      if (!isObject(item)) return fail(`${at} must be an object`)
      const wave = item.wave
      if (wave !== undefined && wave !== 'sine' && wave !== 'triangle' && wave !== 'square') fail(`${at}.wave must be sine, triangle or square`)
      return {
        freq: number(item.freq, `${at}.freq`, 40, 4000),
        ms: number(item.ms, `${at}.ms`, 20, 1500),
        ...(wave ? { wave: wave as ModNote['wave'] } : {}),
        ...(item.gain !== undefined ? { gain: number(item.gain, `${at}.gain`, 0, 1) } : {})
      }
    }, 8) ?? []
  )
}

/** The fixed host of a tool's URL template, or null when the template isn't a plain https URL with placeholders only after the host. */
export function toolHost(template: string): string | null {
  const match = /^https:\/\/([a-z0-9.-]+)(?::\d+)?(\/[^\s]*)?$/i.exec(template)
  if (!match || match[1].includes('{') || !match[1].includes('.')) return null
  return match[1].toLowerCase()
}

const PLACEHOLDER = /\{([a-zA-Z_][\w]*)\}/g

function tool(value: unknown, field: string): ModTool {
  if (!isObject(value)) return fail(`${field} must be an object`)
  const name = text(value.name, `${field}.name`, 40)
  if (!/^[a-z][a-z0-9_]*$/.test(name)) fail(`${field}.name must be lowercase letters, digits and underscores`)
  const url = text(value.url, `${field}.url`, 400)
  if (!toolHost(url)) fail(`${field}.url must be an https URL with a fixed host`)
  const params =
    list(value.params, `${field}.params`, (item, at) => {
      if (!isObject(item)) return fail(`${at} must be an object`)
      const pname = text(item.name, `${at}.name`, 32)
      if (!/^[a-zA-Z_]\w*$/.test(pname)) fail(`${at}.name must be one word`)
      if (!['string', 'number', 'integer', 'boolean'].includes(item.type as string)) fail(`${at}.type must be string, number, integer or boolean`)
      const options = item.enum === undefined ? undefined : words(item.enum, `${at}.enum`, /^[\w .,:-]+$/, 50)
      return {
        name: pname,
        type: item.type as ModTool['params'][number]['type'],
        description: text(item.description, `${at}.description`, 200),
        ...(item.required === true ? { required: true } : {}),
        ...(options ? { enum: options } : {})
      }
    }, 10) ?? []
  for (const [, used] of url.matchAll(PLACEHOLDER)) if (!params.some((p) => p.name === used)) fail(`${field}.url uses {${used}}, which isn't one of its params`)
  const pick = value.pick === undefined ? undefined : words(value.pick, `${field}.pick`, /^[\w-]+(?:\.(?:[\w-]+|\*))*$/, 20)
  return {
    name,
    description: text(value.description, `${field}.description`, 400),
    url,
    params,
    ...(pick ? { pick } : {}),
    ...(value.maxChars !== undefined ? { maxChars: number(value.maxChars, `${field}.maxChars`, 200, 20_000) } : {})
  }
}

function codex(value: unknown, field: string): ModCodex {
  if (!isObject(value)) return fail(`${field} must be an object`)
  const out: ModCodex = {}
  if (value.instructions !== undefined) out.instructions = text(value.instructions, `${field}.instructions`, MOD_LIMITS.instructions)
  if (value.mcpServers !== undefined) {
    if (!isObject(value.mcpServers)) fail(`${field}.mcpServers must be an object`)
    const servers: Record<string, ModCliServer> = {}
    for (const [name, raw] of Object.entries(value.mcpServers as Raw)) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) fail(`${field}.mcpServers: "${name}" must be lowercase letters, digits and underscores`)
      if (!isObject(raw)) fail(`${field}.mcpServers.${name} must be an object`)
      const server = raw as Raw
      const args = list(server.args, `${field}.mcpServers.${name}.args`, (item, at) => text(item, at, 400, 0), 30)
      servers[name] = { command: text(server.command, `${field}.mcpServers.${name}.command`, 200), ...(args ? { args } : {}) }
    }
    if (Object.keys(servers).length > 8) fail(`${field}.mcpServers has more than 8 servers`)
    out.mcpServers = servers
  }
  return out
}

function unique(items: { id?: string; name?: string; prefix?: string }[] | undefined, key: 'id' | 'name' | 'prefix', field: string): void {
  const seen = new Set<string>()
  for (const item of items ?? []) {
    const value = item[key]
    if (!value) continue
    if (seen.has(value)) fail(`${field} has two entries named "${value}"`)
    seen.add(value)
  }
}

function contributions(value: unknown): ModContributions {
  if (!isObject(value)) return fail('contributes must be an object')
  const out: ModContributions = {}
  const set = <K extends keyof ModContributions>(key: K, item: ModContributions[K] | undefined): void => {
    if (item !== undefined && !(Array.isArray(item) && item.length === 0)) out[key] = item
  }
  set('appThemes', list(value.appThemes, 'appThemes', appTheme, 12))
  set('terminalThemes', list(value.terminalThemes, 'terminalThemes', terminalTheme, 24))
  set('commands', list(value.commands, 'commands', command))
  if (value.instructions !== undefined) set('instructions', text(value.instructions, 'instructions', MOD_LIMITS.instructions))
  set('snippets', list(value.snippets, 'snippets', snippet, 100))
  set('languages', list(value.languages, 'languages', language, 12))
  set('panels', list(value.panels, 'panels', panel, 4))
  set('workerTemplates', list(value.workerTemplates, 'workerTemplates', workerTemplate, 12))
  set('sessionPresets', list(value.sessionPresets, 'sessionPresets', preset, 12))
  set('widgets', list(value.widgets, 'widgets', widget, 4))
  set('tools', list(value.tools, 'tools', tool, 12))
  if (value.sounds !== undefined) {
    if (!isObject(value.sounds)) fail('sounds must be an object')
    const sounds: Partial<Record<ModSoundEvent, ModNote[]>> = {}
    for (const [event, raw] of Object.entries(value.sounds as Raw)) {
      if (!SOUND_EVENTS.some((e) => e.id === event)) fail(`sounds.${event} isn't an event (${SOUND_EVENTS.map((e) => e.id).join(', ')})`)
      const played = notes(raw, `sounds.${event}`)
      if (played.length) sounds[event as ModSoundEvent] = played
    }
    if (Object.keys(sounds).length) out.sounds = sounds
  }
  if (value.claudePlugin !== undefined) out.claudePlugin = modPath(value.claudePlugin, 'claudePlugin')
  if (value.codex !== undefined) {
    const c = codex(value.codex, 'codex')
    if (c.instructions || c.mcpServers) out.codex = c
  }
  unique(out.appThemes, 'name', 'appThemes')
  unique(out.terminalThemes, 'id', 'terminalThemes')
  unique(out.commands, 'name', 'commands')
  unique(out.snippets, 'prefix', 'snippets')
  unique(out.languages, 'id', 'languages')
  unique(out.panels, 'id', 'panels')
  unique(out.workerTemplates, 'id', 'workerTemplates')
  unique(out.sessionPresets, 'id', 'sessionPresets')
  unique(out.widgets, 'id', 'widgets')
  unique(out.tools, 'name', 'tools')
  if (Object.keys(out).length === 0) fail('contributes is empty: the mod would add nothing')
  return out
}

export type ParsedManifest = { ok: true; manifest: ModManifest } | { ok: false; error: string }

/**
 * A `mod.json` checked and trimmed to what this version understands. Unknown
 * fields are dropped rather than refused, so a mod written for a later Eaon
 * still installs here with the parts this one can apply.
 */
export function parseManifest(raw: unknown): ParsedManifest {
  try {
    if (!isObject(raw)) return fail('mod.json must be a JSON object')
    if (raw.schema !== MOD_SCHEMA) return fail(`mod.json "schema" must be ${MOD_SCHEMA}`)
    const id = text(raw.id, 'id', 64, 3)
    if (!ID.test(id)) fail('id must be lowercase words joined by dots or dashes, like "jane.night-theme"')
    const version = text(raw.version, 'version', 20)
    if (!/^\d+\.\d+\.\d+$/.test(version)) fail('version must look like 1.0.0')
    const category = raw.category as ModCategory
    if (!MOD_CATEGORIES.some((c) => c.id === category)) fail(`category must be one of ${MOD_CATEGORIES.map((c) => c.id).join(', ')}`)
    const homepage = optionalText(raw.homepage, 'homepage', 200)
    if (homepage && !/^https:\/\/\S+$/.test(homepage)) fail('homepage must be an https link')
    const license = optionalText(raw.license, 'license', 40)
    const manifest: ModManifest = {
      schema: MOD_SCHEMA,
      id,
      name: text(raw.name, 'name', 40),
      version,
      publisher: text(raw.publisher, 'publisher', 40),
      description: text(raw.description, 'description', 240),
      category,
      ...(homepage ? { homepage } : {}),
      ...(license ? { license } : {}),
      contributes: contributions(raw.contributes)
    }
    return { ok: true, manifest }
  } catch (error) {
    if (error instanceof ManifestError) return { ok: false, error: error.message }
    throw error
  }
}

/** Compares "1.2.10" and "1.10.0" by their numbers. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/* ------------------------------------------------------------------ access */

const names = (items: string[], max = 4): string => {
  const shown = items.slice(0, max).join(', ')
  return items.length > max ? `${shown} and ${items.length - max} more` : shown
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * What installing the mod lets it do, one row per kind of change, worked out
 * from the manifest (and, for a Claude Code plugin, from the folder itself).
 */
export function modAccess(manifest: ModManifest, claude: ClaudePluginParts | null): ModAccessRow[] {
  const c = manifest.contributes
  const rows: ModAccessRow[] = []
  if (c.appThemes) rows.push({ level: 'look', text: `Adds ${count(c.appThemes.length, 'app theme')} to Settings → Appearance`, detail: names(c.appThemes.map((t) => t.name)) })
  if (c.terminalThemes) rows.push({ level: 'look', text: `Adds ${count(c.terminalThemes.length, 'ADE terminal theme')} to /theme`, detail: names(c.terminalThemes.map((t) => t.name)) })
  if (c.sounds) {
    const events = SOUND_EVENTS.filter((e) => c.sounds?.[e.id]).map((e) => e.label)
    rows.push({ level: 'look', text: 'Plays a short sound when ' + events.join(', or when ') })
  }
  if (c.widgets) rows.push({ level: 'look', text: `Adds ${count(c.widgets.length, 'item')} to the ADE's header`, detail: names(c.widgets.map((w) => w.label)) })
  if (c.commands) {
    const used = new Set(c.commands.flatMap((cmd) => cmd.where ?? ['chat', 'workers']))
    const where = used.size === 2 ? 'Chat and Workers' : used.has('chat') ? 'Chat' : 'Workers'
    rows.push({ level: 'adds', text: `Adds ${count(c.commands.length, 'slash command')} to ${where}`, detail: names(c.commands.map((cmd) => `/${cmd.name}`), 6) })
  }
  if (c.snippets) rows.push({ level: 'adds', text: `Adds ${count(c.snippets.length, 'editor snippet')}`, detail: `For ${names([...new Set(c.snippets.flatMap((s) => s.languages))], 6)}` })
  if (c.languages) rows.push({ level: 'adds', text: `Colours ${count(c.languages.length, 'more language')} in the editor and in code blocks`, detail: names(c.languages.map((l) => l.name), 6) })
  if (c.workerTemplates) rows.push({ level: 'adds', text: `Adds ${count(c.workerTemplates.length, 'template')} to New worker`, detail: names(c.workerTemplates.map((t) => t.name)) })
  if (c.sessionPresets) {
    const prompted = c.sessionPresets.some((p) => p.panes.some((pane) => pane.prompt))
    rows.push({
      level: 'adds',
      text: `Adds ${count(c.sessionPresets.length, 'session preset')} to the ADE's New session`,
      detail: names(c.sessionPresets.map((p) => p.name)) + (prompted ? '. Some start an agent on a task when you pick them.' : '')
    })
  }
  if (c.instructions) rows.push({ level: 'access', text: 'Adds instructions to every Chat reply', detail: c.instructions })
  if (c.tools) {
    const hosts = [...new Set(c.tools.map((t) => toolHost(t.url)).filter((h): h is string => Boolean(h)))]
    rows.push({
      level: 'access',
      text: `Gives agents in Chat and Workers ${count(c.tools.length, 'tool')} that read from ${names(hosts)}`,
      detail: `${names(c.tools.map((t) => t.name), 6)}. What the agent looks up is sent to ${hosts.length === 1 ? 'that site' : 'those sites'}.`
    })
  }
  if (c.panels) {
    for (const p of c.panels) {
      const can = [
        p.host.includes('storage') ? 'keep its own notes' : null,
        p.host.includes('composer') ? 'put text in the message box' : null,
        p.host.includes('notify') ? 'show a notice' : null
      ].filter(Boolean)
      rows.push({
        level: 'code',
        text: `Runs the ${p.title} panel in a sandbox`,
        detail: `No network, no files, no access to your chats or keys.${can.length ? ` It can ${can.join(', ')}.` : ''}`
      })
    }
  }
  if (c.claudePlugin && claude) {
    const parts = [
      claude.commands.length ? count(claude.commands.length, 'command') : null,
      claude.skills.length ? count(claude.skills.length, 'skill') : null,
      claude.agents.length ? count(claude.agents.length, 'subagent') : null
    ].filter(Boolean)
    if (parts.length) {
      rows.push({
        level: 'adds',
        text: `Adds ${parts.join(', ')} to Claude Code sessions Eaon starts`,
        detail: names([...claude.commands.map((x) => `/${x}`), ...claude.skills, ...claude.agents], 8)
      })
    }
    if (claude.hooks.length) rows.push({ level: 'code', text: 'Runs a script during Claude Code sessions Eaon starts', detail: claude.hooks.join('\n'), mono: true })
    if (claude.mcpServers.length) rows.push({ level: 'code', text: 'Starts MCP servers in Claude Code sessions Eaon starts', detail: claude.mcpServers.join('\n'), mono: true })
  }
  if (c.codex?.instructions) rows.push({ level: 'access', text: 'Adds instructions to Codex sessions Eaon starts', detail: c.codex.instructions })
  if (c.codex?.mcpServers) {
    rows.push({
      level: 'code',
      text: 'Starts MCP servers in Codex sessions Eaon starts',
      detail: Object.entries(c.codex.mcpServers).map(([name, s]) => `${name}: ${[s.command, ...(s.args ?? [])].join(' ')}`).join('\n'),
      mono: true
    })
  }
  const order = { code: 0, access: 1, adds: 2, look: 3 }
  return rows.sort((a, b) => order[a.level] - order[b.level])
}

/** A mod with any code or access row is reviewed before it installs; the rest install from their card. */
export function needsReview(access: ModAccessRow[]): boolean {
  return access.some((row) => row.level === 'code' || row.level === 'access')
}

/** Ids that only Eaon's bundled mods may use, so nothing installed from elsewhere can pass as one. */
export const OFFICIAL_PREFIX = 'eaon.'

/** Every surface a mod reaches, for its card. */
export function modSurfaces(manifest: ModManifest): string[] {
  const c = manifest.contributes
  const out: string[] = []
  if (c.appThemes || c.sounds) out.push('App')
  if (c.commands || c.instructions || c.snippets || c.languages || c.panels || c.tools) out.push('Chat')
  if (c.workerTemplates || c.tools || c.commands?.some((cmd) => !cmd.where || cmd.where.includes('workers'))) out.push('Workers')
  if (c.terminalThemes || c.sessionPresets || c.widgets || c.panels) out.push('ADE')
  if (c.claudePlugin) out.push('Claude Code')
  if (c.codex) out.push('Codex')
  return [...new Set(out)]
}
