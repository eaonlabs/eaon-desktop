import { app } from 'electron'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MOD_LIMITS,
  MOD_SCHEMA,
  parseManifest,
  safeModPath,
  type ClaudePluginParts,
  type ModManifest,
  type ModPack
} from '@shared/mods'

/**
 * Mods on disk. An installed mod is a folder under `modsRoot()`, named by its
 * id, holding its `mod.json` and files; userData keeps it across updates and
 * apart from other Eaon profiles. Eaon's own mods ship inside the app
 * (`bundledRoot()`) so the marketplace works offline.
 */

export const modsRoot = (): string => process.env.EAON_MODS_DIR || join(app.getPath('userData'), 'mods')

/** Where an installed mod lives. Ids are checked by `parseManifest`, so one can't climb out of the folder. */
export const modDir = (id: string): string => join(modsRoot(), id)

/** A panel's saved notes, kept apart from the mod so an update doesn't wipe them. */
export const modDataFile = (id: string): string => join(modsRoot(), '.data', `${id}.json`)

/** Eaon's bundled mods: <Resources>/mods when packaged, resources/mods in development and tests. */
export function bundledRoot(): string | null {
  const candidates = [
    process.env.EAON_BUNDLED_MODS || null,
    app.isPackaged ? join(process.resourcesPath, 'mods') : null,
    fileURLToPath(new URL('../../resources/mods', import.meta.url)),
    fileURLToPath(new URL('../../../resources/mods', import.meta.url)),
    join(process.cwd(), 'resources', 'mods')
  ]
  return candidates.find((dir): dir is string => Boolean(dir) && existsSync(dir!)) ?? null
}

export type ReadMod = { ok: true; manifest: ModManifest; files: Map<string, Buffer> } | { ok: false; error: string }

/**
 * A mod's folder read in full: its manifest, checked, and every file it
 * would install. Symlinks and anything past the size limits are refused, so
 * what is reviewed is what installs.
 */
export function readModFolder(dir: string): ReadMod {
  const files = new Map<string, Buffer>()
  let bytes = 0
  const walk = (at: string): string | null => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name)
      const rel = relative(dir, full).split(sep).join('/')
      // Dotfiles (.git, .DS_Store, .gitignore) are left behind: neither reviewed nor installed.
      if (entry.name.startsWith('.') && entry.name !== '.claude-plugin' && entry.name !== '.mcp.json') continue
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) return `${rel} is a link; a mod's files must be its own`
      if (stat.isDirectory()) {
        if (!safeModPath(rel)) return `${rel} isn't an allowed folder name`
        const problem = walk(full)
        if (problem) return problem
        continue
      }
      if (!stat.isFile()) continue
      if (!safeModPath(rel)) return `${rel} isn't an allowed file name`
      bytes += stat.size
      if (files.size >= MOD_LIMITS.files) return `the mod has more than ${MOD_LIMITS.files} files`
      if (bytes > MOD_LIMITS.bytes) return `the mod is larger than ${MOD_LIMITS.bytes / 1024 / 1024} MB`
      files.set(rel, readFileSync(full))
    }
    return null
  }
  try {
    if (!statSync(dir).isDirectory()) return { ok: false, error: 'That isn’t a folder.' }
    const problem = walk(dir)
    if (problem) return { ok: false, error: `Can’t install this mod: ${problem}.` }
  } catch (error) {
    return { ok: false, error: `Couldn’t read the folder: ${error instanceof Error ? error.message : String(error)}` }
  }
  return checked(files)
}

/** A packed mod (`ModPack`), as read from a file or a URL. */
export function readModPack(raw: unknown): ReadMod {
  if (typeof raw !== 'object' || raw === null || (raw as ModPack).eaonMod !== MOD_SCHEMA) {
    return { ok: false, error: 'That isn’t an Eaon mod: a packed mod is a JSON file with "eaonMod": 1, a "manifest" and its "files".' }
  }
  const pack = raw as ModPack
  const files = new Map<string, Buffer>()
  let bytes = 0
  const listed = typeof pack.files === 'object' && pack.files !== null ? Object.entries(pack.files) : []
  if (listed.length > MOD_LIMITS.files) return { ok: false, error: `The mod has more than ${MOD_LIMITS.files} files.` }
  for (const [name, content] of listed) {
    const rel = safeModPath(name)
    if (!rel || rel === 'mod.json') return { ok: false, error: `Can’t install this mod: "${name}" isn’t an allowed file name.` }
    if (typeof content !== 'string') return { ok: false, error: `Can’t install this mod: "${name}" isn’t text.` }
    const data = Buffer.from(content, 'utf8')
    bytes += data.length
    if (bytes > MOD_LIMITS.bytes) return { ok: false, error: `The mod is larger than ${MOD_LIMITS.bytes / 1024 / 1024} MB.` }
    files.set(rel, data)
  }
  files.set('mod.json', Buffer.from(JSON.stringify(pack.manifest ?? null, null, 2)))
  return checked(files)
}

/** The manifest parsed, and every file it names present. */
function checked(files: Map<string, Buffer>): ReadMod {
  const raw = files.get('mod.json')
  if (!raw) return { ok: false, error: 'There’s no mod.json in that folder.' }
  let json: unknown
  try {
    json = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    return { ok: false, error: `mod.json isn’t valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  const parsed = parseManifest(json)
  if (!parsed.ok) return { ok: false, error: `mod.json: ${parsed.error}` }
  const c = parsed.manifest.contributes
  for (const panel of c.panels ?? []) {
    if (!files.has(panel.entry)) return { ok: false, error: `mod.json: the ${panel.title} panel’s ${panel.entry} isn’t in the mod.` }
  }
  if (c.claudePlugin && !files.has(`${c.claudePlugin}/.claude-plugin/plugin.json`)) {
    return { ok: false, error: `mod.json: ${c.claudePlugin}/.claude-plugin/plugin.json isn’t in the mod.` }
  }
  return { ok: true, manifest: parsed.manifest, files }
}

/** Writes a mod's files into `dir`, which must be empty or missing. */
export function writeModFiles(dir: string, files: Map<string, Buffer>): void {
  mkdirSync(dir, { recursive: true })
  for (const [rel, data] of files) {
    const target = join(dir, ...rel.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
  }
}

/** An installed mod's manifest, or null when its folder is gone or damaged. */
export function readInstalledManifest(id: string): ModManifest | null {
  try {
    const parsed = parseManifest(JSON.parse(readFileSync(join(modDir(id), 'mod.json'), 'utf8')))
    return parsed.ok && parsed.manifest.id === id ? parsed.manifest : null
  } catch {
    return null
  }
}

/* ------------------------------------------------- Claude Code plugin parts */

/** The plugin.json fields Eaon reads and shows; any other one is shown as something it can't vouch for. */
const KNOWN_PLUGIN_FIELDS = new Set(['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'commands', 'agents', 'skills', 'hooks', 'mcpServers'])

type FileSource = { has: (rel: string) => boolean; read: (rel: string) => string | null; list: (prefix: string) => string[] }

/** A file source over a mod's files in memory (being reviewed) or on disk (installed). */
export function memoryFiles(files: Map<string, Buffer>): FileSource {
  return {
    has: (rel) => files.has(rel),
    read: (rel) => files.get(rel)?.toString('utf8') ?? null,
    list: (prefix) => [...files.keys()].filter((rel) => rel.startsWith(prefix))
  }
}

export function diskFiles(root: string): FileSource {
  const all: string[] = []
  const walk = (at: string): void => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(at, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) all.push(relative(root, full).split(sep).join('/'))
    }
  }
  walk(root)
  return {
    has: (rel) => all.includes(rel),
    read: (rel) => {
      try {
        return readFileSync(join(root, ...rel.split('/')), 'utf8')
      } catch {
        return null
      }
    },
    list: (prefix) => all.filter((rel) => rel.startsWith(prefix))
  }
}

const parseJson = (text: string | null): unknown => {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const asList = (value: unknown): string[] => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])

/** "./custom/cmds" from plugin.json, relative to the plugin root, as a prefix of the mod's files. */
const under = (root: string, path: string): string | null => {
  const rel = safeModPath(path.replace(/^\.\//, ''))
  return rel ? `${root}/${rel}` : null
}

/**
 * What a Claude Code plugin folder in a mod holds: its commands, skills,
 * subagents, hooks (with the commands they run) and MCP servers, read the
 * way Claude Code reads a plugin (its default folders, plus any paths
 * plugin.json names). Fields of plugin.json this doesn't know are listed as
 * hooks, so the install screen errs on the side of saying a mod runs code.
 */
export function claudeParts(source: FileSource, root: string): ClaudePluginParts {
  const manifest = (parseJson(source.read(`${root}/.claude-plugin/plugin.json`)) ?? {}) as Record<string, unknown>
  const parts: ClaudePluginParts = { commands: [], skills: [], agents: [], hooks: [], mcpServers: [] }

  const markdownIn = (prefix: string): string[] =>
    source
      .list(`${prefix}/`)
      .filter((rel) => rel.endsWith('.md'))
      .map((rel) => rel.slice(prefix.length + 1, -3).split('/').join(':'))
  const dirs = (field: unknown, fallback: string): string[] => [`${root}/${fallback}`, ...asList(field).map((p) => under(root, p)).filter((p): p is string => Boolean(p))]

  for (const prefix of dirs(manifest.commands, 'commands')) parts.commands.push(...markdownIn(prefix))
  for (const prefix of dirs(manifest.agents, 'agents')) parts.agents.push(...markdownIn(prefix))
  for (const prefix of dirs(manifest.skills, 'skills')) {
    for (const rel of source.list(`${prefix}/`)) {
      const match = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/]+)/SKILL\\.md$`).exec(rel)
      if (match) parts.skills.push(match[1])
    }
  }

  const hookSets: unknown[] = [parseJson(source.read(`${root}/hooks/hooks.json`))]
  for (const field of asList(manifest.hooks)) hookSets.push(parseJson(source.read(under(root, field) ?? '')))
  if (typeof manifest.hooks === 'object' && manifest.hooks !== null && !Array.isArray(manifest.hooks)) hookSets.push(manifest.hooks)
  for (const set of hookSets) {
    const events = (set as { hooks?: unknown } | null)?.hooks ?? set
    if (typeof events !== 'object' || events === null) continue
    for (const [event, groups] of Object.entries(events as Record<string, unknown>)) {
      for (const group of Array.isArray(groups) ? groups : []) {
        const matcher = typeof group?.matcher === 'string' && group.matcher ? ` (${group.matcher})` : ''
        for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
          const what = typeof hook?.command === 'string' ? hook.command : typeof hook?.prompt === 'string' ? `asks the model: ${hook.prompt}` : JSON.stringify(hook)
          parts.hooks.push(`${event}${matcher}: ${what}`)
        }
      }
    }
  }

  const serverSets: unknown[] = [parseJson(source.read(`${root}/.mcp.json`))]
  for (const field of asList(manifest.mcpServers)) serverSets.push(parseJson(source.read(under(root, field) ?? '')))
  if (typeof manifest.mcpServers === 'object' && manifest.mcpServers !== null && !Array.isArray(manifest.mcpServers)) serverSets.push({ mcpServers: manifest.mcpServers })
  for (const set of serverSets) {
    const servers = (set as { mcpServers?: unknown } | null)?.mcpServers
    if (typeof servers !== 'object' || servers === null) continue
    for (const [name, server] of Object.entries(servers as Record<string, { command?: unknown; args?: unknown; url?: unknown }>)) {
      const run = typeof server?.command === 'string' ? [server.command, ...asList(server.args)].join(' ') : typeof server?.url === 'string' ? server.url : ''
      parts.mcpServers.push(`${name}: ${run}`)
    }
  }

  const unknown = Object.keys(manifest).filter((key) => !KNOWN_PLUGIN_FIELDS.has(key))
  if (unknown.length) parts.hooks.push(`plugin.json also sets ${unknown.join(', ')}, which Eaon can’t describe`)
  if (source.has(`${root}/settings.json`)) parts.hooks.push('The plugin has a settings.json, which can change how Claude Code behaves')
  for (const list of Object.values(parts)) list.sort()
  return parts
}
