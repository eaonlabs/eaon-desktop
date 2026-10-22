import type { McpServer, Settings } from '@shared/types'
import { credentialExpiry, hostOwnsSecret } from '@shared/workerHost'
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
  const sent = payload.secrets && typeof payload.secrets === 'object' ? payload.secrets : {}
  const incoming = { ...sent }
  const own = secrets.entries()
  // A sign-in this computer refreshed since is newer than the desktop's copy, whose
  // refresh token no longer works: it stays (and goes back to the desktop, host:tokens).
  for (const [id, value] of Object.entries(incoming)) {
    const mine = credentialExpiry(own[id])
    const theirs = credentialExpiry(value)
    if (mine !== null && theirs !== null && mine > theirs) delete incoming[id]
  }
  // Chat apps' tokens are this computer's own: they came with the workers, and the desktop doesn't send its copies.
  for (const id of Object.keys(incoming)) if (hostOwnsSecret(id)) delete incoming[id]
  // The desktop's vault otherwise, exactly: a key removed there is removed here too.
  const removed = Object.fromEntries(
    Object.keys(own)
      .filter((id) => !(id in sent) && !hostOwnsSecret(id))
      .map((id) => [id, ''])
  )
  const changes = Object.fromEntries(Object.entries({ ...removed, ...incoming }).filter(([id, value]) => (own[id] ?? '') !== value))
  if (Object.keys(changes).length > 0) secrets.setMany(changes)
  if (payload.providers && typeof payload.providers === 'object') store.saveProviderConfig(payload.providers)
  if (payload.settings && typeof payload.settings === 'object') store.patchSettings(pickSettings(payload.settings))
  if (Array.isArray(payload.mcpServers)) {
    // The built-in servers are this computer's own (Filesystem points at its home folder).
    const builtIn = store.getMcpServers().filter((server) => server.official)
    const incomingServers = (payload.mcpServers as McpServer[]).filter((server) => server && typeof server.id === 'string' && !server.official)
    store.saveMcpServers([...builtIn, ...incomingServers])
  }
}
