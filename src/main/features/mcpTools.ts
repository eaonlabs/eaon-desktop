import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { dialog, Notification } from 'electron'
import type { McpServer } from '@shared/types'
import {
  MAX_PROJECT_MCP_BYTES,
  parseProjectMcp,
  PROJECT_MCP_FILES,
  projectServerRow,
  projectStatus,
  type ProjectMcpDecision,
  type ProjectMcpFile,
  type ProjectMcpOffer
} from '@shared/mcpProject'
import { store } from '../store'
import { clearMcpLogs, getAllTools, getMcpLogs, syncMcpServers } from '../mcp'
import { adoptLoginShellPath } from '../shellEnv'
import { onProjectRun } from '../agent/projectHooks'
import type { Feature, FeatureContext } from './types'

/**
 * What Settings → MCP Servers needs beyond the server list: every tool a
 * server has (including ones switched off, so they can be switched back on),
 * a server's log, and a project's own server file.
 *
 * A project file is read, never run: `scan` lists the folders that have one
 * with each server's exact command, and nothing starts until `approve` is
 * called with the fingerprint of the text the person was shown. Approving
 * saves the file's servers as ordinary rows tagged with the folder (their
 * tools are offered in that folder only; see shared/mcpTools.ts) and a file
 * that changes afterwards is `changed` and has to be approved again.
 *
 * Channels (all `mcp-tools:` / `mcp-project:`): `all`, `logs`, `clear-logs`;
 * `scan`, `pick`, `approve`, `decline`, `forget`, and the `offer` event.
 */

const DECISIONS_FILE = 'mcp-project-decisions.json'

type Decisions = Record<string, ProjectMcpDecision>

const readDecisions = (): Decisions => {
  const saved = store.getJson<Decisions>(DECISIONS_FILE, {})
  return typeof saved === 'object' && saved !== null && !Array.isArray(saved) ? saved : {}
}

const folderName = (folder: string): string => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder

/** The first project file in a folder, read; null when there is none, or it is too big or can't be read. */
async function readProjectFile(folder: string): Promise<{ file: ProjectMcpFile; text: string } | null> {
  for (const file of PROJECT_MCP_FILES) {
    const path = join(folder, file)
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size > MAX_PROJECT_MCP_BYTES) continue
      return { file, text: await readFile(path, 'utf8') }
    } catch {
      /* not there: try the next */
    }
  }
  return null
}

const fingerprintOf = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The offer for one folder, or null when it has no (readable) project file. */
export async function projectOffer(folder: string, name = folderName(folder)): Promise<ProjectMcpOffer | null> {
  const found = await readProjectFile(folder)
  if (!found) return null
  const { servers, problems } = parseProjectMcp(found.text)
  const fingerprint = fingerprintOf(found.text)
  return {
    folder,
    name,
    file: found.file,
    servers,
    problems,
    fingerprint,
    status: projectStatus(readDecisions()[folder], fingerprint),
    importedIds: store.getMcpServers().filter((s) => s.projectPath === folder).map((s) => s.id)
  }
}

/** The offers for every Chat project that has a folder, ones with a project file only. */
export async function scanProjects(): Promise<ProjectMcpOffer[]> {
  const seen = new Set<string>()
  const offers: ProjectMcpOffer[] = []
  for (const project of store.getProjects()) {
    if (!project.folder || seen.has(project.folder)) continue
    seen.add(project.folder)
    const offer = await projectOffer(project.folder, project.name)
    if (offer) offers.push(offer)
  }
  return offers
}

/** Saves a folder's decision and, for an approval, its servers; what was imported from the folder before is replaced. */
export async function decideProject(folder: string, fingerprint: string, decision: 'approved' | 'declined'): Promise<ProjectMcpOffer | null> {
  const found = await readProjectFile(folder)
  if (decision === 'approved') {
    if (!found) throw new Error('That folder has no .mcp.json or .eaon/mcp.json any more.')
    // Approval is for the text that was shown, and only that.
    if (fingerprintOf(found.text) !== fingerprint) throw new Error('The file changed since you looked at it. Review it again before approving.')
    const { servers } = parseProjectMcp(found.text)
    if (servers.length === 0) throw new Error('There are no servers in that file to approve.')
    const rows = servers.map((server) => projectServerRow(folder, server))
    // Carry the user's own choices over a re-approval (tools turned off, permissions) where the server is still there.
    const before = new Map(store.getMcpServers().filter((s) => s.projectPath === folder).map((s) => [s.id, s]))
    const merged: McpServer[] = rows.map((row) => {
      const old = before.get(row.id)
      return old ? { ...row, enabled: old.enabled, ...(old.disabledTools ? { disabledTools: old.disabledTools } : {}), ...(old.toolPermissions ? { toolPermissions: old.toolPermissions } : {}) } : row
    })
    store.saveMcpServers([...store.getMcpServers().filter((s) => s.projectPath !== folder), ...merged])
    void adoptLoginShellPath().then(() => syncMcpServers())
  } else if (found && fingerprintOf(found.text) !== fingerprint) {
    throw new Error('The file changed since you looked at it. Review it again.')
  }
  const decisions = readDecisions()
  decisions[folder] = { fingerprint, decision, at: Date.now() }
  store.setJson(DECISIONS_FILE, decisions)
  return projectOffer(folder)
}

/** Removes the servers saved from a folder and forgets what was decided about it. */
export async function forgetProject(folder: string): Promise<void> {
  const remaining = store.getMcpServers().filter((s) => s.projectPath !== folder)
  if (remaining.length !== store.getMcpServers().length) {
    store.saveMcpServers(remaining)
    void adoptLoginShellPath().then(() => syncMcpServers())
  }
  const decisions = readDecisions()
  delete decisions[folder]
  store.setJson(DECISIONS_FILE, decisions)
}

let ctx: FeatureContext | null = null
/** Folders already offered since Eaon started, with the file they had, so an offer is made once. */
const offered = new Set<string>()
const notifications = new Set<Notification>()

/** A run started in `folder`: if its project file hasn't been decided on, say so once. */
async function offerOnRun(folder: string): Promise<void> {
  const offer = await projectOffer(folder)
  if (!offer || (offer.status !== 'new' && offer.status !== 'changed') || offer.servers.length === 0) return
  const key = `${folder} ${offer.fingerprint}`
  if (offered.has(key)) return
  offered.add(key)
  ctx?.send('mcp-project:offer', offer)
  if (!Notification.isSupported()) return
  const count = offer.servers.length
  const notification = new Notification({
    title: offer.status === 'changed' ? `${offer.name} changed its MCP servers` : `${offer.name} has MCP servers`,
    body: `${offer.file} lists ${count} ${count === 1 ? 'server' : 'servers'}. Nothing runs until you review and approve ${count === 1 ? 'it' : 'them'} in Settings → MCP Servers.`
  })
  notifications.add(notification)
  notification.on('click', () => {
    notifications.delete(notification)
    const win = ctx?.getWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
  notification.on('close', () => notifications.delete(notification))
  notification.show()
}

export const mcpToolsFeature: Feature = {
  id: 'mcpTools',

  register(context) {
    ctx = context
    const { ipcMain } = context
    ipcMain.handle('mcp-tools:all', () => getAllTools())
    ipcMain.handle('mcp-tools:logs', (_e, serverId: unknown) => getMcpLogs(String(serverId ?? '')))
    ipcMain.handle('mcp-tools:clear-logs', (_e, serverId: unknown) => clearMcpLogs(String(serverId ?? '')))

    ipcMain.handle('mcp-project:scan', () => scanProjects())
    // A folder chosen by hand, for a project Chat doesn't know.
    ipcMain.handle('mcp-project:pick', async (): Promise<{ offer: ProjectMcpOffer | null; folder: string } | null> => {
      const win = context.getWindow()
      const options = { title: 'Check a folder for MCP servers', properties: ['openDirectory' as const] }
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      if (picked.canceled || !picked.filePaths[0]) return null
      return { folder: picked.filePaths[0], offer: await projectOffer(picked.filePaths[0]) }
    })
    ipcMain.handle('mcp-project:approve', (_e, folder: unknown, fingerprint: unknown) => decideProject(String(folder ?? ''), String(fingerprint ?? ''), 'approved'))
    ipcMain.handle('mcp-project:decline', (_e, folder: unknown, fingerprint: unknown) => decideProject(String(folder ?? ''), String(fingerprint ?? ''), 'declined'))
    ipcMain.handle('mcp-project:forget', (_e, folder: unknown) => forgetProject(String(folder ?? '')))
    onProjectRun((folder) => void offerOnRun(folder))
  }
}


