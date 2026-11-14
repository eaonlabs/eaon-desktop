import { statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import {
  AGENT_APP_NAMES,
  type AgentAppImport,
  type AgentAppImportResult,
  type AgentAppScan,
  type ForeignAgent,
  type ForeignScripts,
  type ForeignSession
} from '@shared/agentApps'
import { cleanAllScripts, cleanScripts, type ProjectScripts } from '@shared/adeScripts'
import type { Feature } from '../types'
import { store } from '../../store'
import { adeSessions } from '../ade'
import { allConversations } from '../ade/conversations'
import { addProjectScripts } from '../chatCode'
import { headBranch, READERS, type Where } from './readers'

/**
 * Import from other apps (shared/agentApps.ts): what Conductor, Orca,
 * Paradev (Superset), Claude Squad, T3 Code, Synara and Crystal keep about
 * their sessions and projects, read on this computer and brought into the
 * ADE when picked.
 *
 * The window is sent what was found and sends back the keys it picked; main
 * reads everything again before importing, so nothing it imports came from
 * the window but the choice.
 */

const SCRIPTS_FILE = 'ade-scripts.json'

const isDir = (dir: string): boolean => {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

interface Found {
  scans: AgentAppScan[]
  /** Each session's full reading, by key: the conversation it reopens can come from Claude Code's own records. */
  sessions: Map<string, ForeignSession>
  scripts: Map<string, ForeignScripts>
}

/** Everything the other apps have that the ADE could take, newest first in each app. */
async function find(): Promise<Found> {
  const home = path.resolve(os.homedir())
  // From the home folder, as Import's MCP servers are found (importApps/sources.ts): Electron's
  // appData on a Mac is the real one whatever HOME says.
  const appData =
    process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : process.platform === 'win32' ? app.getPath('appData') : (process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'))
  const where: Where = { home, appData }
  const book = adeSessions()
  // A session another app didn't keep a conversation for reopens the newest one that ran in its folder.
  let byCwd: Map<string, { agent: ForeignAgent; id: string }> | null = null
  const newestIn = async (cwd: string): Promise<{ agent: ForeignAgent; id: string } | null> => {
    if (!byCwd) {
      byCwd = new Map()
      for (const c of await allConversations().catch(() => [])) {
        const dir = path.resolve(c.cwd)
        if (!byCwd.has(dir)) byCwd.set(dir, { agent: c.agent, id: c.id })
      }
    }
    return byCwd.get(cwd) ?? null
  }

  const found: Found = { scans: [], sessions: new Map(), scripts: new Map() }
  for (const reader of READERS) {
    let reading
    try {
      reading = reader.read(where)
    } catch (error) {
      found.scans.push({ id: reader.id, name: AGENT_APP_NAMES[reader.id], sessions: [], scripts: [], error: error instanceof Error ? error.message : String(error) })
      continue
    }
    if (!reading) continue
    const seen = new Set<string>()
    const sessions: ForeignSession[] = []
    for (const s of reading.sessions.sort((a, b) => b.touched - a.touched)) {
      const cwd = path.resolve(s.cwd)
      // Gone since (an old worktree, a temporary checkout): nothing to open. The home folder
      // itself (Superset files a workspace there) is no project's session.
      if (seen.has(cwd) || !isDir(cwd) || cwd === home || cwd === path.parse(cwd).root) continue
      seen.add(cwd)
      const fallback = s.resume ? null : await newestIn(cwd)
      const session: ForeignSession = {
        key: `${reader.id}:${cwd}`,
        app: reader.id,
        title: s.title,
        cwd,
        project: s.project ? path.resolve(s.project) : null,
        branch: s.branch ?? headBranch(cwd),
        agent: s.resume ? s.agent : (fallback?.agent ?? s.agent),
        resume: s.resume ?? fallback?.id ?? null,
        touched: s.touched,
        archived: s.archived,
        already: Boolean(book.byCwd(cwd))
      }
      sessions.push(session)
      found.sessions.set(session.key, session)
    }
    const scripts: ForeignScripts[] = []
    for (const s of reading.scripts) {
      const project = path.resolve(s.project)
      if (!isDir(project) || s.commands.length === 0) continue
      const item: ForeignScripts = { key: `${reader.id}:${project}`, app: reader.id, project, commands: s.commands, source: s.source }
      if (found.scripts.has(item.key)) continue
      scripts.push(item)
      found.scripts.set(item.key, item)
    }
    if (sessions.length || scripts.length) found.scans.push({ id: reader.id, name: AGENT_APP_NAMES[reader.id], sessions, scripts })
  }
  return found
}

export async function scanAgentApps(): Promise<AgentAppScan[]> {
  return (await find()).scans
}

/** A project's scripts in the ADE's form: the first command for each moment, as the ADE keeps one of each. */
function adeScriptsOf(item: ForeignScripts): ProjectScripts {
  const first = (when: 'setup' | 'run' | 'teardown'): string | undefined => item.commands.find((c) => c.when === when)?.command
  return cleanScripts({ setup: first('setup'), run: first('run'), teardown: first('teardown') })
}

/** What was picked: each session made in the ADE, each project's scripts kept. Returns the panes the window opens. */
export async function importAgentApps(pick: AgentAppImport): Promise<AgentAppImportResult & { panes: { cwd: string; agent: ForeignAgent; resume: string }[] }> {
  const found = await find()
  const book = adeSessions()
  const result: AgentAppImportResult & { panes: { cwd: string; agent: ForeignAgent; resume: string }[] } = { sessions: 0, scripts: 0, skipped: [], panes: [] }

  for (const key of new Set(pick.sessions)) {
    const s = found.sessions.get(key)
    if (!s) {
      result.skipped.push({ key, why: 'It isn’t there any more.' })
      continue
    }
    const made = await book.adoptForeign(s.cwd, { title: s.title, at: s.touched, from: AGENT_APP_NAMES[s.app], archived: s.archived })
    if (!made) {
      result.skipped.push({ key, why: 'The ADE has this folder already.' })
      continue
    }
    result.sessions++
    if (s.agent && s.resume) result.panes.push({ cwd: made.cwd, agent: s.agent, resume: s.resume })
  }

  if (pick.scripts.length) {
    const ade = cleanAllScripts(store.getJson<unknown>(SCRIPTS_FILE, {}))
    for (const key of new Set(pick.scripts)) {
      const item = found.scripts.get(key)
      if (!item) {
        result.skipped.push({ key, why: 'They aren’t there any more.' })
        continue
      }
      let kept = false
      // The ADE keeps one set per project: one set already there is left as it is.
      const scripts = adeScriptsOf(item)
      if (!ade[item.project] && Object.keys(scripts).length) {
        ade[item.project] = scripts
        kept = true
      }
      // Chat's project scripts (Run menu): every command but the archive one, after the ones it has.
      const runnable = item.commands.filter((c) => c.when !== 'teardown').map((c) => ({ name: c.name, command: c.command }))
      if (addProjectScripts(item.project, runnable) > 0) kept = true
      if (kept) result.scripts++
      else result.skipped.push({ key, why: 'Eaon has these scripts already.' })
    }
    store.setJson(SCRIPTS_FILE, ade)
  }
  return result
}

export const agentAppsFeature: Feature = {
  id: 'agent-apps',
  register: ({ ipcMain }) => {
    ipcMain.handle('agent-apps:scan', () => scanAgentApps())
    ipcMain.handle('agent-apps:import', (_e, pick: unknown) => {
      const v = (pick && typeof pick === 'object' ? pick : {}) as Record<string, unknown>
      const keys = (list: unknown): string[] =>
        (Array.isArray(list) ? list : []).filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length < 4096).slice(0, 1000)
      return importAgentApps({ sessions: keys(v.sessions), scripts: keys(v.scripts) })
    })
  }
}
