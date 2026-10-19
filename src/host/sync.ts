import type { McpServer, Settings } from '@shared/types'
import { secrets } from '@main/secrets'
import { store } from '@main/store'
import type { SyncPayload } from './host'

/**
 * What a worker computer takes from the desktop: its keys and sign-ins, its
 * providers, its MCP servers, and its model and agent choices — so a worker
 * thinks with the same models and tools wherever it runs.
 */

/** The model and agent choices the desktop shares; never the look, and never its own folders. */
const SETTINGS_FROM_DESKTOP = [
  'selectedModelId',
  'selectedProviderId',
  'favoriteModels',
  'effort',
  'approvalMode',
  'work',
  'context',
  'mcp',
  'installedPlugins',
  'disabledPlugins',
  'disabledSkills',
  'configuration'
] as const

export function pickSettings(settings: Record<string, unknown>): Partial<Settings> {
  const patch: Record<string, unknown> = {}
  for (const key of SETTINGS_FROM_DESKTOP) if (settings[key] !== undefined) patch[key] = settings[key]
  // The desktop's Eaon folder is a path on the desktop; workers here keep theirs here.
  if (patch.work && typeof patch.work === 'object') patch.work = { ...(patch.work as object), defaultFolder: store.getSettings().work.defaultFolder }
  return patch as Partial<Settings>
}

export function applySync(payload: SyncPayload): void {
  const incoming = payload.secrets && typeof payload.secrets === 'object' ? payload.secrets : {}
  // The desktop's vault, exactly: a key removed there is removed here too.
  const removed = Object.fromEntries(Object.keys(secrets.entries()).filter((id) => !(id in incoming)).map((id) => [id, '']))
  secrets.setMany({ ...removed, ...incoming })
  if (payload.providers && typeof payload.providers === 'object') store.saveProviderConfig(payload.providers)
  if (payload.settings && typeof payload.settings === 'object') store.patchSettings(pickSettings(payload.settings))
  if (Array.isArray(payload.mcpServers)) {
    // The built-in servers are this computer's own (Filesystem points at its home folder).
    const own = store.getMcpServers().filter((server) => server.official)
    const incomingServers = (payload.mcpServers as McpServer[]).filter((server) => server && typeof server.id === 'string' && !server.official)
    store.saveMcpServers([...own, ...incomingServers])
  }
}
