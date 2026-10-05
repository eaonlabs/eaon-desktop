import type { AppIcon, ApprovalMode, Chat, ChatMessage, EffortLevel, LaunchMode, McpServer, Project, Settings, ThemeMode, Workspace } from '@shared/types'
import type { Repaired } from './storeFiles'

/**
 * Checks for each of the store's own documents, run on every read of the file
 * (see `readDoc`). They put right what can be put right in place, set aside
 * what can't (a record with no id, a second record with the same id), and
 * leave alone what they don't know: a field a newer Eaon added stays exactly
 * as it was, so going back a version and forward again loses nothing.
 *
 * Nothing here throws. A value of the wrong shape altogether returns null,
 * which the reader treats like a file that didn't parse.
 */

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** A day of slack for clocks that disagree a little; anything later than that is a clock that was wrong. */
const FUTURE_SLACK_MS = 24 * 3_600_000

/** A list where every entry is checked by `fix`; entries it rejects (null) and repeated ids are left out. */
function repairList<T>(
  raw: unknown,
  fix: (entry: Record<string, unknown>, counts: { fixed: number }) => T | null,
  idOf: (entry: T) => string
): Repaired<T[]> | null {
  if (!Array.isArray(raw)) return null
  const counts = { fixed: 0 }
  const seen = new Set<string>()
  const value: T[] = []
  let dropped = 0
  for (const entry of raw) {
    const fixed = isObject(entry) && isId(entry.id) ? fix(entry, counts) : null
    if (!fixed || seen.has(idOf(fixed))) {
      dropped++
      continue
    }
    seen.add(idOf(fixed))
    value.push(fixed)
  }
  return { value, dropped, fixed: counts.fixed }
}

/* --------------------------------------------------------------- settings */

/**
 * Every value of a union, as an object so that adding a value to the type
 * without adding it here fails the typecheck — otherwise a new option would
 * be "repaired" back to the default on every read.
 */
const values = <T extends string>(all: Record<T, true>): readonly string[] => Object.keys(all)

/** Fields with a fixed set of values; anything else goes back to the default. */
const SETTINGS_ENUMS: Record<string, readonly string[]> = {
  'general.launchMode': values<LaunchMode>({ chat: true, workers: true, ade: true, last: true }),
  'appearance.mode': values<ThemeMode>({ system: true, light: true, dark: true }),
  'appearance.reduceMotion': values<Settings['appearance']['reduceMotion']>({ system: true, on: true, off: true }),
  'appearance.appIcon': values<AppIcon>({ default: true, agent: true }),
  effort: values<EffortLevel>({ none: true, minimal: true, light: true, medium: true, high: true, 'extra-high': true, ultra: true }),
  approvalMode: values<ApprovalMode>({ ask: true, auto: true, full: true }),
  'computerUse.quality': values<Settings['computerUse']['quality']>({ balanced: true, sharp: true })
}

/**
 * Numbers that make the app unusable outside a range (a 0 px font). Ports
 * are left to the servers that use them, which report a bad one where it can
 * be fixed rather than quietly changing it.
 */
const SETTINGS_RANGES: Record<string, [number, number]> = {
  'appearance.fontSize': [9, 32],
  'appearance.light.contrast': [0, 100],
  'appearance.dark.contrast': [0, 100],
  'mcp.toolCallTimeoutSeconds': [1, 3_600],
  'codeIndex.maxToolRounds': [1, 1_000],
  'context.compactAt': [0.05, 0.99],
  'context.keepFullToolTurns': [0, 100],
  'work.goalMaxIterations': [1, 10_000],
  'work.goalMaxMinutes': [1, 100_000],
  'work.goalMaxTokens': [1, 1e12]
}

/**
 * Settings as saved, with every known field that has the wrong type, an
 * unknown option or an impossible number removed, so the defaults fill it in
 * (`store.getSettings` merges them). An explicit `null` on a section that
 * should be an object is removed too: merging it would replace the whole
 * section with null, which the app reads as a crash at startup.
 */
export function repairSettings(raw: unknown, defaults: Record<string, unknown>): Repaired<Record<string, unknown>> | null {
  if (!isObject(raw)) return null
  let fixed = 0
  const walk = (saved: Record<string, unknown>, base: Record<string, unknown>, path: string): void => {
    for (const key of Object.keys(saved)) {
      if (!(key in base)) continue // unknown: a newer version's, kept as is
      const value = saved[key]
      const fallback = base[key]
      const at = path ? `${path}.${key}` : key
      let ok: boolean
      if (isObject(fallback)) ok = isObject(value)
      else if (Array.isArray(fallback)) ok = Array.isArray(value)
      else if (fallback === null) ok = value === null || typeof value === 'string'
      else if (typeof fallback === 'number') ok = isFiniteNumber(value)
      else ok = typeof value === typeof fallback
      if (ok && SETTINGS_ENUMS[at]) ok = SETTINGS_ENUMS[at].includes(value as string)
      if (ok && SETTINGS_RANGES[at]) ok = (value as number) >= SETTINGS_RANGES[at][0] && (value as number) <= SETTINGS_RANGES[at][1]
      if (!ok) {
        delete saved[key]
        fixed++
        continue
      }
      // Shortcuts are a free-form map, so its keys aren't checked against
      // the defaults, but each value must still be a key or null.
      if (at === 'shortcuts') {
        for (const [name, combo] of Object.entries(value as Record<string, unknown>)) {
          if (combo !== null && typeof combo !== 'string') {
            delete (value as Record<string, unknown>)[name]
            fixed++
          }
        }
        continue
      }
      if (Array.isArray(fallback) && at !== 'claudeCode.env') {
        // The string lists (plugins, favourites): drop anything that isn't one.
        const strings = (value as unknown[]).filter((v) => typeof v === 'string')
        if (strings.length !== (value as unknown[]).length) {
          saved[key] = strings
          fixed++
        }
        continue
      }
      if (isObject(fallback)) walk(value as Record<string, unknown>, fallback, at)
    }
  }
  walk(raw, defaults, '')
  return { value: raw, dropped: 0, fixed }
}

/* ------------------------------------------------------------------ chats */

const ROLES = new Set(['user', 'assistant', 'system'])
const EFFORTS = new Set(SETTINGS_ENUMS.effort)
const TOOL_STATUS = new Set(['running', 'done', 'denied', 'error'])

function repairMessage(raw: unknown, counts: { fixed: number }, chatTime: number): ChatMessage | null {
  if (!isObject(raw) || !isId(raw.id) || !ROLES.has(raw.role as string)) return null
  const message = raw as unknown as ChatMessage & Record<string, unknown>
  if (!Array.isArray(message.parts)) {
    message.parts = []
    counts.fixed++
  } else {
    const parts = message.parts.filter((part) => isObject(part) && typeof part.type === 'string')
    for (const part of parts) {
      // A tool part with no known status would render as neither done nor
      // running; call it an error, which is what a lost status amounts to.
      if (part.type === 'tool' && !TOOL_STATUS.has((part as { status?: string }).status ?? '')) {
        ;(part as { status: string }).status = 'error'
        counts.fixed++
      }
      if ((part.type === 'text' || part.type === 'reasoning') && typeof (part as { text?: unknown }).text !== 'string') {
        ;(part as { text: string }).text = ''
        counts.fixed++
      }
    }
    if (parts.length !== message.parts.length) {
      message.parts = parts
      counts.fixed++
    }
  }
  if (!isFiniteNumber(message.createdAt)) {
    message.createdAt = chatTime
    counts.fixed++
  }
  return message
}

/**
 * The chat list: each chat must have an id; a second chat with the same id
 * is left out (the first, the newer in a list kept newest-first, stays).
 * Inside a chat the same goes for messages. Missing lists become empty,
 * times that can't be (not a number, years ahead) are brought back to now,
 * and flags with the wrong type take their defaults.
 */
export function repairChats(raw: unknown, now = Date.now()): Repaired<Chat[]> | null {
  let messagesDropped = 0
  const result = repairList<Chat>(
    raw,
    (entry, counts) => {
      const chat = entry as unknown as Chat & Record<string, unknown>
      const latest = now + FUTURE_SLACK_MS
      const time = (value: unknown, fallback: number): number => {
        if (isFiniteNumber(value) && value >= 0 && value <= latest) return value
        counts.fixed++
        return fallback
      }
      chat.createdAt = time(chat.createdAt, isFiniteNumber(chat.updatedAt) && chat.updatedAt <= latest ? chat.updatedAt : now)
      chat.updatedAt = time(chat.updatedAt, chat.createdAt)
      if (typeof chat.title !== 'string') {
        chat.title = 'Untitled chat'
        counts.fixed++
      }
      if (typeof chat.workspaceId !== 'string' || !chat.workspaceId) {
        // Re-homed to Chat by migrateWorkspaces, like any unknown workspace.
        chat.workspaceId = ''
        counts.fixed++
      }
      if (chat.projectId !== null && typeof chat.projectId !== 'string') {
        chat.projectId = null
        counts.fixed++
      }
      for (const flag of ['archived', 'pinned', 'unread'] as const) {
        if (typeof chat[flag] !== 'boolean') {
          chat[flag] = false
          counts.fixed++
        }
      }
      if (chat.modelId !== null && typeof chat.modelId !== 'string') {
        chat.modelId = null
        counts.fixed++
      }
      if (!EFFORTS.has(chat.effort)) {
        chat.effort = 'medium'
        counts.fixed++
      }
      if (!Array.isArray(chat.messages)) {
        chat.messages = []
        counts.fixed++
      } else {
        const seen = new Set<string>()
        const messages: ChatMessage[] = []
        for (const message of chat.messages) {
          const fixed = repairMessage(message, counts, chat.createdAt)
          if (!fixed || seen.has(fixed.id)) {
            messagesDropped++
            continue
          }
          seen.add(fixed.id)
          messages.push(fixed)
        }
        chat.messages = messages
      }
      return chat
    },
    (chat) => chat.id
  )
  if (!result) return null
  return { ...result, dropped: result.dropped + messagesDropped }
}

/* ------------------------------------------------------- smaller documents */

export function repairProjects(raw: unknown, now = Date.now()): Repaired<Project[]> | null {
  return repairList<Project>(
    raw,
    (entry, counts) => {
      const project = entry as unknown as Project
      if (typeof project.name !== 'string') {
        project.name = 'Untitled project'
        counts.fixed++
      }
      if (typeof project.workspaceId !== 'string') {
        project.workspaceId = ''
        counts.fixed++
      }
      if (typeof project.instructions !== 'string') {
        project.instructions = ''
        counts.fixed++
      }
      if (!isFiniteNumber(project.createdAt) || project.createdAt > now + FUTURE_SLACK_MS) {
        project.createdAt = now
        counts.fixed++
      }
      return project
    },
    (project) => project.id
  )
}

/** Workspaces only need to be a list of objects: `migrateWorkspaces` rebuilds the canonical three from whatever is there. */
export function repairWorkspaces(raw: unknown): Repaired<Workspace[]> | null {
  return repairList<Workspace>(raw, (entry) => entry as unknown as Workspace, (workspace) => workspace.id)
}

export function repairMcpServers(raw: unknown): Repaired<McpServer[]> | null {
  return repairList<McpServer>(
    raw,
    (entry, counts) => {
      const server = entry as unknown as McpServer
      if (server.transport !== 'stdio' && server.transport !== 'http') {
        // Without a transport there's no telling how to start it; one that
        // names a URL and no command can only be HTTP.
        if (typeof server.url === 'string' && server.url && !server.command) server.transport = 'http'
        else if (typeof server.command === 'string' && server.command) server.transport = 'stdio'
        else return null
        counts.fixed++
      }
      if (typeof server.name !== 'string' || !server.name) {
        server.name = server.id
        counts.fixed++
      }
      if (typeof server.command !== 'string') {
        server.command = ''
        counts.fixed++
      }
      if (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== 'string')) {
        server.args = Array.isArray(server.args) ? server.args.filter((arg) => typeof arg === 'string') : []
        counts.fixed++
      }
      if (!isObject(server.env) || Object.values(server.env).some((v) => typeof v !== 'string')) {
        server.env = isObject(server.env)
          ? Object.fromEntries(Object.entries(server.env).filter(([, v]) => typeof v === 'string'))
          : {}
        counts.fixed++
      }
      if (typeof server.url !== 'string') {
        server.url = ''
        counts.fixed++
      }
      if (typeof server.enabled !== 'boolean') {
        // Unsure whether it was on: off is the safe answer for something that spawns a process.
        server.enabled = false
        counts.fixed++
      }
      if (typeof server.official !== 'boolean') {
        server.official = false
        counts.fixed++
      }
      return server
    },
    (server) => server.id
  )
}

/**
 * providers.json: per provider, the user's changes. A provider entry that
 * isn't an object is left out; inside one, lists and maps of the wrong type
 * are dropped (the catalog's own values show instead), and model lists keep
 * only entries with an id.
 */
export function repairProviderConfig(raw: unknown): Repaired<Record<string, Record<string, unknown>>> | null {
  if (!isObject(raw)) return null
  let dropped = 0
  let fixed = 0
  const value: Record<string, Record<string, unknown>> = {}
  for (const [id, entry] of Object.entries(raw)) {
    if (!isObject(entry)) {
      dropped++
      continue
    }
    for (const key of ['listed', 'custom', 'models'] as const) {
      if (!(key in entry)) continue
      const list = entry[key]
      if (!Array.isArray(list)) {
        delete entry[key]
        fixed++
        continue
      }
      const models = list.filter((model) => isObject(model) && isId(model.id))
      if (models.length !== list.length) {
        entry[key] = models
        fixed++
      }
    }
    if ('hidden' in entry && (!Array.isArray(entry.hidden) || entry.hidden.some((v) => typeof v !== 'string'))) {
      entry.hidden = Array.isArray(entry.hidden) ? entry.hidden.filter((v) => typeof v === 'string') : []
      fixed++
    }
    for (const key of ['labels', 'edits'] as const) {
      if (key in entry && !isObject(entry[key])) {
        delete entry[key]
        fixed++
      }
    }
    for (const key of ['baseUrl', 'name', 'kind'] as const) {
      if (key in entry && typeof entry[key] !== 'string') {
        delete entry[key]
        fixed++
      }
    }
    if ('enabled' in entry && typeof entry.enabled !== 'boolean') {
      delete entry.enabled
      fixed++
    }
    value[id] = entry
  }
  return { value, dropped, fixed }
}
