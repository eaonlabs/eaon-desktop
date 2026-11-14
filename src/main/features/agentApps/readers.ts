import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { foreignAgent, resumableId, whenOf, type AgentAppId, type ForeignAgent, type ForeignCommand } from '@shared/agentApps'
import { json, withSnapshot, type Row, type Snapshot } from './sqlite'

/**
 * How each app keeps its work, read into one shape. Paths and table names
 * are the ones those apps use today (checked against their files on a Mac
 * and their published source, Nov 2026); anything missing or renamed in another version reads as
 * nothing rather than failing the rest.
 */

export interface ReadSession {
  title: string | null
  cwd: string
  project: string | null
  branch: string | null
  agent: ForeignAgent | null
  resume: string | null
  touched: number
  archived: boolean
}

export interface ReadScripts {
  project: string
  commands: ForeignCommand[]
  source: string
}

export interface AppReading {
  sessions: ReadSession[]
  scripts: ReadScripts[]
}

/** Where things are on this computer. */
export interface Where {
  home: string
  /** ~/Library/Application Support on a Mac, %APPDATA% on Windows, ~/.config on Linux. */
  appData: string
}

export interface AppReader {
  id: AgentAppId
  /** Null when the app has nothing on this computer. */
  read(where: Where): AppReading | null
}

/* ------------------------------------------------------------------ helpers */

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

const obj = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

function readJson(file: string): unknown {
  try {
    if (!existsSync(file) || statSync(file).size > 50_000_000) return null
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function realpath(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name))
  } catch {
    return []
  }
}

/** A command as one line: a list of them runs one after another. */
function commandOf(value: unknown): string | null {
  if (Array.isArray(value)) {
    const parts = value.map(str).filter((s): s is string => Boolean(s))
    return parts.length ? parts.join(' && ') : null
  }
  return str(value)
}

function push(list: ForeignCommand[], name: string, value: unknown, when: ForeignCommand['when']): void {
  const command = commandOf(value)
  if (command) list.push({ name, command, when })
}

/**
 * The scripts a project keeps in a file of its own, in the formats these apps
 * use: Conductor's `conductor.json`, Superset's `.superset/config.json`.
 * Read only for a project Import found in that app.
 */
export function projectFileScripts(project: string, app: 'conductor' | 'superset'): ReadScripts | null {
  const commands: ForeignCommand[] = []
  if (app === 'conductor') {
    const scripts = obj(obj(readJson(path.join(project, 'conductor.json'))).scripts)
    push(commands, 'Setup', scripts.setup, 'setup')
    push(commands, 'Run', scripts.run, 'run')
    push(commands, 'Archive', scripts.archive, 'teardown')
    return commands.length ? { project, commands, source: 'conductor.json' } : null
  }
  // Superset is Paradev now; a repository set up before the rename keeps .superset.
  for (const file of ['.paradev/config.json', '.paradev/config.local.json', '.superset/config.json', '.superset/config.local.json']) {
    const config = obj(readJson(path.join(project, file)))
    push(commands, 'Setup', config.setup, 'setup')
    push(commands, 'Run', config.run, 'run')
    push(commands, 'Teardown', config.teardown, 'teardown')
    if (commands.length) return { project, commands, source: file }
  }
  return null
}

/** Named scripts as T3 Code and Synara keep them: `[{name, command, icon, runOnWorktreeCreate}]`. */
export function namedScripts(raw: unknown): ForeignCommand[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    const s = obj(item)
    const name = str(s.name)
    const command = str(s.command)
    if (!name || !command) return []
    const when = s.runOnWorktreeCreate === true ? 'setup' : s.icon === 'play' ? 'run' : null
    return [{ name: name.slice(0, 60), command, when }]
  })
}

/**
 * The branch checked out in `cwd`, from its git files (no git process: a
 * scan looks at dozens of folders). A worktree's `.git` is a file pointing at
 * its own folder in the repository's.
 */
export function headBranch(cwd: string): string | null {
  try {
    let gitDir = path.join(cwd, '.git')
    if (!existsSync(gitDir)) return null
    if (statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'))?.[1]?.trim()
      if (!pointer) return null
      gitDir = path.resolve(cwd, pointer)
    }
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    return /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1] ?? null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ Orca */

/**
 * Orca keeps each profile's state as JSON documents by domain in
 * `orca/profiles/<id>/profile-state.db` (older versions: `orca-data.json`).
 * A worktree's key is `<repoId>::<folder>`; its name and last use are in
 * `worktreeMeta`, its tabs (an agent's among them) in `workspaceSession`.
 * Agent chats it ran itself are in `agent-session-journal.db`.
 */
export function parseOrca(docs: Record<string, unknown>, journal: Row[]): AppReading {
  const repos = Array.isArray(docs.repos) ? docs.repos.map(obj) : []
  const repoPath = new Map(repos.map((r) => [str(r.id), str(r.path)]))
  const meta = obj(docs.worktreeMeta)
  const session = obj(docs.workspaceSession)
  const tabs = obj(session.unifiedTabs)
  const visited = obj(session.lastVisitedAtByWorktreeId)

  // The newest conversation each worktree's agents left, by worktree key: a terminal agent put to
  // sleep keeps its provider's id (newer Orca), an agent chat its handle chain.
  const resumeBy = new Map<string, { agent: ForeignAgent | null; id: string }>()
  const sleeping = Object.values(obj(session.sleepingAgentSessionsByPaneKey))
    .map(obj)
    .sort((a, b) => whenOf(a.updatedAt) - whenOf(b.updatedAt))
  for (const record of sleeping) {
    const key = str(record.worktreeId)
    const id = resumableId(obj(record.providerSession).id)
    const agent = foreignAgent(record.agent)
    if (key && id && agent) resumeBy.set(key, { agent, id })
  }
  for (const row of journal) {
    const record = obj(json(row.record_json))
    const key = str(obj(record.location).workspaceId)
    const chain = Array.isArray(record.providerHandleChain) ? record.providerHandleChain : []
    const id = resumableId(obj(obj(chain[chain.length - 1]).handle).nativeId)
    if (key && id && !resumeBy.has(key)) resumeBy.set(key, { agent: foreignAgent(record.provider), id })
  }

  const sessions: ReadSession[] = []
  const keys = new Set([...Object.keys(meta), ...Object.keys(tabs)])
  for (const key of keys) {
    const split = key.indexOf('::')
    if (split < 0) continue
    const cwd = key.slice(split + 2)
    const m = obj(meta[key])
    const agentTab = (Array.isArray(tabs[key]) ? tabs[key] : []).map(obj).find((t) => t.contentType === 'agent-session')
    const resume = resumeBy.get(key)
    sessions.push({
      title: str(m.displayName),
      cwd,
      project: repoPath.get(key.slice(0, split)) ?? null,
      branch: null,
      agent: resume?.agent ?? foreignAgent(agentTab?.agentSessionAgent),
      resume: resume?.id ?? null,
      touched: Math.max(whenOf(m.lastActivityAt), whenOf(visited[key])),
      archived: m.isArchived === true
    })
  }

  // Setup and archive commands set in Orca's own settings for a repository.
  const scripts: ReadScripts[] = []
  for (const repo of repos) {
    const dir = str(repo.path)
    const hooks = obj(obj(repo.hookSettings).scripts)
    const commands: ForeignCommand[] = []
    push(commands, 'Setup', hooks.setup, 'setup')
    push(commands, 'Archive', hooks.archive, 'teardown')
    if (dir && commands.length) scripts.push({ project: dir, commands, source: 'Orca’s settings' })
  }
  return { sessions, scripts }
}

const orca: AppReader = {
  id: 'orca',
  read({ appData }) {
    const root = [path.join(appData, 'orca'), path.join(appData, 'Orca')].find((dir) => existsSync(dir))
    if (!root) return null
    const index = obj(readJson(path.join(root, 'orca-profile-index.json')))
    const profile = str(index.activeProfileId) ?? 'local-default'
    const docs =
      withSnapshot(path.join(root, 'profiles', profile, 'profile-state.db'), (db) => {
        const out: Record<string, unknown> = {}
        for (const row of db.rows(`SELECT domain, payload FROM profile_state_documents WHERE domain IN ('repos', 'worktreeMeta', 'workspaceSession')`)) {
          const domain = str(row.domain)
          if (domain) out[domain] = json(row.payload)
        }
        return out
      }) ?? obj(readJson(path.join(root, 'orca-data.json')))
    const journal = withSnapshot(path.join(root, 'agent-session-journal.db'), (db) => db.rows('SELECT record_json FROM agent_session_records')) ?? []
    return parseOrca(docs, journal)
  }
}

/* ------------------------------------------------------------------ Superset */

/**
 * Superset keeps each organisation's work in `~/.superset/host/<org>/host.db`:
 * `projects`, `workspaces` (a worktree each) and `terminal_agent_bindings`,
 * which hold the Claude Code or Codex conversation a terminal ran.
 */
export function readSupersetDb(db: Snapshot): AppReading {
  const projects = new Map(db.rows('SELECT id, repo_path FROM projects').map((r) => [str(r.id), str(r.repo_path)]))
  const bindings = new Map<string, { agent: ForeignAgent | null; id: string; at: number }>()
  const transcripts = db.columns('terminal_agent_bindings').has('transcript_path')
  for (const row of db.rows(`SELECT workspace_id, agent_id, agent_session_id, started_at, last_event_at${transcripts ? ', transcript_path' : ''} FROM terminal_agent_bindings`)) {
    const workspace = str(row.workspace_id)
    const id = resumableId(row.agent_session_id)
    const agent = foreignAgent(row.agent_id)
    if (!workspace || !id || !agent) continue
    // Run with a Claude or Codex home of Superset's own, the conversation isn't where `--resume` looks.
    const transcript = str(row.transcript_path)
    if (transcript && !/[\\/]\.(?:claude|codex)[\\/]/.test(transcript)) continue
    const at = Math.max(whenOf(row.last_event_at), whenOf(row.started_at))
    const have = bindings.get(workspace)
    if (!have || at >= have.at) bindings.set(workspace, { agent, id, at })
  }
  const sessions: ReadSession[] = []
  for (const row of db.rows('SELECT id, project_id, worktree_path, branch, name, type, archived_at, updated_at, last_activity_at FROM workspaces')) {
    const cwd = str(row.worktree_path)
    if (!cwd) continue
    const binding = bindings.get(str(row.id) ?? '')
    sessions.push({
      // The project's own checkout is named after the project.
      title: row.type === 'main' ? null : str(row.name),
      cwd,
      project: projects.get(str(row.project_id)) ?? null,
      branch: str(row.branch),
      agent: binding?.agent ?? null,
      resume: binding?.id ?? null,
      touched: Math.max(whenOf(row.last_activity_at), whenOf(row.updated_at), binding?.at ?? 0),
      archived: Boolean(row.archived_at)
    })
  }
  return { sessions, scripts: [] }
}

const superset: AppReader = {
  id: 'superset',
  read({ home }) {
    // Paradev now: it moves ~/.superset to ~/.paradev and leaves a link, so the two can be one folder.
    const roots = [...new Set([path.join(home, '.paradev'), path.join(home, '.superset')].filter((dir) => existsSync(dir)).map((dir) => realpath(dir)))]
    if (roots.length === 0) return null
    const sessions: ReadSession[] = []
    for (const root of roots) {
      for (const org of subdirs(path.join(root, 'host'))) {
        const reading = withSnapshot(path.join(org, 'host.db'), readSupersetDb)
        if (reading) sessions.push(...reading.sessions)
      }
      // Before host.db: one local.db with a worktree per row.
      const legacy =
        withSnapshot(path.join(root, 'local.db'), (db) =>
          db.rows('SELECT path, branch FROM worktrees').flatMap((r) => {
            const cwd = str(r.path)
            return cwd ? [{ title: null, cwd, project: null, branch: str(r.branch), agent: null, resume: null, touched: 0, archived: false }] : []
          })
        ) ?? []
      sessions.push(...legacy)
    }
    const projects = new Set(sessions.map((s) => s.project).filter((p): p is string => Boolean(p)))
    const scripts = [...projects].map((p) => projectFileScripts(p, 'superset')).filter((s): s is ReadScripts => Boolean(s))
    return { sessions, scripts }
  }
}

/* ------------------------------------------------------------------ Claude Squad */

/** Claude Squad's `~/.claude-squad/state.json`: an instance per worktree, each running a program (claude, codex, aider…) in tmux. */
export function parseClaudeSquad(state: unknown, config: unknown): AppReading {
  const raw = obj(state).instances
  const instances = (Array.isArray(raw) ? raw : Array.isArray(json(raw)) ? (json(raw) as unknown[]) : []).map(obj)
  const fallback = str(obj(config).default_program)
  const sessions = instances.flatMap((i): ReadSession[] => {
    const tree = obj(i.worktree)
    const cwd = str(tree.worktree_path) ?? str(i.path)
    if (!cwd) return []
    return [
      {
        title: str(i.title),
        cwd,
        project: str(tree.repo_path) ?? str(i.path),
        branch: str(tree.branch_name) ?? str(i.branch),
        agent: foreignAgent(path.basename(str(i.program) ?? '')) ?? foreignAgent(path.basename(fallback ?? '')),
        resume: null,
        touched: Math.max(whenOf(i.updated_at), whenOf(i.created_at)),
        archived: false
      }
    ]
  })
  return { sessions, scripts: [] }
}

const claudeSquad: AppReader = {
  id: 'claude-squad',
  read({ home }) {
    const root = path.join(home, '.claude-squad')
    if (!existsSync(root)) return null
    return parseClaudeSquad(readJson(path.join(root, 'state.json')), readJson(path.join(root, 'config.json')))
  }
}

/* ------------------------------------------------------------------ T3 Code and Synara */

/** One session per folder: the newest thread there names it (unless it is the project's own folder) and gives its conversation. */
function byFolder(threads: (ReadSession & { thread: string })[]): ReadSession[] {
  const out = new Map<string, ReadSession>()
  for (const t of threads.sort((a, b) => b.touched - a.touched)) {
    const have = out.get(t.cwd)
    if (!have) {
      const { thread: _thread, ...session } = t
      out.set(t.cwd, session)
    } else if (!have.resume && t.resume) {
      have.resume = t.resume
      have.agent = t.agent
    }
    if (have && !t.archived) have.archived = false
  }
  return [...out.values()]
}

/** T3 Code's `~/.t3/userdata/statev2.sqlite`: projects with their scripts, and threads, each in the project or a worktree of it. */
export function readT3Db(db: Snapshot): AppReading {
  const projects = new Map<string, string>()
  const scripts: ReadScripts[] = []
  for (const row of db.rows('SELECT project_id, workspace_root, scripts_json FROM projection_projects WHERE deleted_at IS NULL')) {
    const root = str(row.workspace_root)
    if (!root) continue
    projects.set(str(row.project_id) ?? '', root)
    const commands = namedScripts(json(row.scripts_json))
    if (commands.length) scripts.push({ project: root, commands, source: 'T3 Code’s project settings' })
  }
  const native = new Map<string, { agent: ForeignAgent | null; id: string }>()
  for (const row of db.rows('SELECT thread_id, provider, driver, payload_json FROM orchestration_v2_projection_provider_threads')) {
    const ref = obj(obj(json(row.payload_json)).nativeThreadRef)
    const id = resumableId(ref.nativeId)
    if (id) native.set(str(row.thread_id) ?? '', { agent: foreignAgent(ref.driver ?? row.driver ?? row.provider), id })
  }
  for (const row of db.rows('SELECT thread_id, provider_name, resume_cursor_json FROM provider_session_runtime')) {
    const id = resumableId(obj(json(row.resume_cursor_json)).resume)
    const thread = str(row.thread_id) ?? ''
    if (id && !native.has(thread)) native.set(thread, { agent: foreignAgent(row.provider_name), id })
  }
  const threads = db
    .rows('SELECT thread_id, project_id, title, default_provider, archived_at, updated_at, payload_json FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL')
    .flatMap((row) => {
      const project = projects.get(str(row.project_id) ?? '')
      const payload = obj(json(row.payload_json))
      const cwd = str(payload.worktreePath) ?? project
      if (!cwd) return []
      const thread = str(row.thread_id) ?? ''
      const resume = native.get(thread)
      return [
        {
          thread,
          title: cwd === project ? null : str(row.title),
          cwd,
          project: project ?? null,
          branch: str(payload.branch),
          agent: resume?.agent ?? foreignAgent(row.default_provider),
          resume: resume?.id ?? null,
          touched: whenOf(row.updated_at),
          archived: Boolean(row.archived_at)
        }
      ]
    })
  return { sessions: byFolder(threads), scripts }
}

/**
 * Synara's `~/.synara/userdata/state.sqlite`, laid out as T3 Code's was.
 * Its Codex runs with a CODEX_HOME of Synara's own, where `codex resume`
 * from elsewhere can't find the conversation, so only Claude's are reopened.
 */
export function readSynaraDb(db: Snapshot): AppReading {
  const projects = new Map<string, string>()
  const scripts: ReadScripts[] = []
  const kind = db.columns('projection_projects').has('kind')
  for (const row of db.rows(`SELECT project_id, workspace_root, scripts_json${kind ? ', kind' : ''} FROM projection_projects WHERE deleted_at IS NULL`)) {
    const root = str(row.workspace_root)
    if (!root || (kind && row.kind !== 'project')) continue
    projects.set(str(row.project_id) ?? '', root)
    const commands = namedScripts(json(row.scripts_json))
    if (commands.length) scripts.push({ project: root, commands, source: 'Synara’s project settings' })
  }
  const resumes = new Map<string, string>()
  for (const row of db.rows('SELECT thread_id, provider_name, resume_cursor_json FROM provider_session_runtime')) {
    const id = resumableId(obj(json(row.resume_cursor_json)).resume)
    if (id && foreignAgent(row.provider_name) === 'claude') resumes.set(str(row.thread_id) ?? '', id)
  }
  const threads = db
    .rows(
      'SELECT thread_id, project_id, title, branch, worktree_path, associated_worktree_path, associated_worktree_branch, working_directory, model_selection_json, archived_at, updated_at FROM projection_threads WHERE deleted_at IS NULL'
    )
    .flatMap((row) => {
      const project = projects.get(str(row.project_id) ?? '')
      if (!project) return []
      const cwd = str(row.worktree_path) ?? str(row.associated_worktree_path) ?? str(row.working_directory) ?? project
      const thread = str(row.thread_id) ?? ''
      const resume = resumes.get(thread) ?? null
      return [
        {
          thread,
          title: cwd === project ? null : str(row.title),
          cwd,
          project,
          branch: str(row.branch) ?? str(row.associated_worktree_branch),
          agent: resume ? ('claude' as const) : foreignAgent(obj(json(row.model_selection_json)).instanceId ?? obj(json(row.model_selection_json)).provider),
          resume,
          touched: whenOf(row.updated_at),
          archived: Boolean(row.archived_at)
        }
      ]
    })
  return { sessions: byFolder(threads), scripts }
}

const t3code: AppReader = {
  id: 't3code',
  read: ({ home }) => withSnapshot(path.join(home, '.t3', 'userdata', 'statev2.sqlite'), readT3Db)
}

const synara: AppReader = {
  id: 'synara',
  read: ({ home }) => withSnapshot(path.join(home, '.synara', 'userdata', 'state.sqlite'), readSynaraDb)
}

/* ------------------------------------------------------------------ Conductor */

/** Conductor writes its times as UTC with no zone ("2026-11-01 10:00:00"). */
const utc = (value: unknown): number => {
  const text = str(value)
  return text && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text) ? whenOf(`${text.replace(' ', 'T')}Z`) : whenOf(value)
}

/**
 * Conductor's `conductor.db` (in its Application Support folder): `repos`
 * with the setup, run and archive scripts typed into the app, `workspaces`
 * (a worktree each, under ~/conductor/workspaces/<repo>/<city>) and
 * `sessions`, a chat tab each, with the Claude Code conversation it ran.
 * Conductor's own schema isn't published: the columns are the ones the open
 * importers read, and each is checked before it is asked for.
 */
export function readConductorDb(db: Snapshot, home: string): AppReading {
  const has = (table: string, ...columns: string[]): boolean => {
    const have = db.columns(table)
    return columns.every((c) => have.has(c))
  }
  const pick = (table: string, wanted: string[]): string => {
    const have = db.columns(table)
    return wanted.filter((c) => have.has(c)).join(', ')
  }
  const setting = db.rows("SELECT value FROM settings WHERE key = 'conductor_root_path'")[0]
  const root = str(setting?.value) ?? path.join(home, 'conductor')

  const repos = new Map<string, Row>()
  const scripts: ReadScripts[] = []
  if (has('repos', 'id', 'root_path')) {
    for (const row of db.rows(`SELECT ${pick('repos', ['id', 'name', 'root_path', 'storage_version', 'setup_script', 'run_script', 'archive_script'])} FROM repos`)) {
      repos.set(String(row.id), row)
      const project = str(row.root_path)
      const commands: ForeignCommand[] = []
      push(commands, 'Setup', row.setup_script, 'setup')
      push(commands, 'Run', row.run_script, 'run')
      push(commands, 'Archive', row.archive_script, 'teardown')
      if (project && commands.length) scripts.push({ project, commands, source: 'Conductor’s repository settings' })
      else if (project) {
        const file = projectFileScripts(project, 'conductor')
        if (file) scripts.push(file)
      }
    }
  }

  // Each workspace's newest Claude chat: its title names the session, its id reopens it.
  const chats = new Map<string, { title: string | null; agent: ForeignAgent | null; id: string | null; at: number }>()
  if (has('sessions', 'workspace_id')) {
    const cols = pick('sessions', ['workspace_id', 'agent_type', 'claude_session_id', 'title', 'is_hidden', 'updated_at', 'last_user_message_at'])
    for (const row of db.rows(`SELECT ${cols} FROM sessions`)) {
      if (row.is_hidden === 1 || row.is_hidden === true) continue
      const workspace = str(row.workspace_id)
      if (!workspace) continue
      // No agent named is Claude (the only one, before others were added).
      const agent = row.agent_type == null ? 'claude' : foreignAgent(row.agent_type)
      // Codex's thread id isn't kept the same way in every version; its conversation is found by folder instead.
      const id = agent === 'claude' ? resumableId(row.claude_session_id) : null
      const at = Math.max(utc(row.last_user_message_at), utc(row.updated_at))
      const have = chats.get(workspace)
      if (!have || at >= have.at) chats.set(workspace, { title: str(row.title), agent, id: id ?? (have?.agent === agent ? have.id : null), at })
    }
  }

  const sessions: ReadSession[] = []
  if (has('workspaces', 'id')) {
    const cols = pick('workspaces', ['id', 'local_id', 'repository_id', 'directory_name', 'workspace_path', 'branch', 'state', 'hosting_server_url', 'updated_at'])
    for (const row of db.rows(`SELECT ${cols} FROM workspaces`)) {
      // A cloud workspace has no folder here (right-click → Transfer to local brings one).
      if (str(row.hosting_server_url)) continue
      const repo = repos.get(String(row.repository_id)) ?? {}
      const project = str(repo.root_path)
      const dir = str(row.directory_name)
      const version = Number(repo.storage_version ?? 3)
      const cwd =
        str(row.workspace_path) ??
        (dir && project
          ? version >= 3
            ? path.join(root, 'workspaces', str(repo.name) ?? path.basename(project), dir)
            : version === 2
              ? path.join(project, '.conductor', dir)
              : path.join(path.dirname(project), dir)
          : null)
      if (!cwd) continue
      const chat = chats.get(String(row.local_id ?? '')) ?? chats.get(String(row.id))
      sessions.push({
        title: chat?.title ?? null,
        cwd,
        project,
        branch: str(row.branch),
        agent: chat?.agent ?? null,
        resume: chat?.id ?? null,
        touched: Math.max(chat?.at ?? 0, utc(row.updated_at)),
        archived: row.state === 'archived'
      })
    }
  }
  return { sessions, scripts }
}

const conductor: AppReader = {
  id: 'conductor',
  read: ({ home, appData }) => withSnapshot(path.join(appData, 'com.conductor.app', 'conductor.db'), (db) => readConductorDb(db, home))
}

/* ------------------------------------------------------------------ Crystal */

/** Crystal's `~/.crystal/crystal.db`: projects with a run script, and sessions, a worktree each, with the Claude Code conversation. */
export function readCrystalDb(db: Snapshot): AppReading {
  const sessionCols = db.columns('sessions')
  if (!sessionCols.has('worktree_path')) return { sessions: [], scripts: [] }
  const projectCols = db.columns('projects')
  const projects = new Map<string, string>()
  const scripts: ReadScripts[] = []
  if (projectCols.has('id') && projectCols.has('path')) {
    for (const row of db.rows(`SELECT id, path${projectCols.has('run_script') ? ', run_script' : ''} FROM projects`)) {
      const dir = str(row.path)
      if (!dir) continue
      projects.set(String(row.id), dir)
      const commands: ForeignCommand[] = []
      push(commands, 'Run', row.run_script, 'run')
      if (commands.length) scripts.push({ project: dir, commands, source: 'Crystal’s project settings' })
    }
  }
  const wanted = ['name', 'project_id', 'worktree_path', 'archived', 'tool_type', 'claude_session_id', 'updated_at', 'created_at'].filter((c) => sessionCols.has(c))
  const sessions = db.rows(`SELECT ${wanted.join(', ')} FROM sessions`).flatMap((row): ReadSession[] => {
    const cwd = str(row.worktree_path)
    if (!cwd) return []
    const agent = row.tool_type == null ? 'claude' : foreignAgent(row.tool_type)
    return [
      {
        title: str(row.name),
        cwd,
        project: projects.get(String(row.project_id)) ?? null,
        branch: null,
        agent,
        resume: agent === 'claude' ? resumableId(row.claude_session_id) : null,
        touched: Math.max(utc(row.updated_at), utc(row.created_at)),
        archived: row.archived === 1 || row.archived === true
      }
    ]
  })
  return { sessions, scripts }
}

const crystal: AppReader = {
  id: 'crystal',
  read: ({ home }) => withSnapshot(path.join(home, '.crystal', 'crystal.db'), readCrystalDb)
}

/* ------------------------------------------------------------------ all of them */

export const READERS: AppReader[] = [conductor, orca, superset, claudeSquad, t3code, synara, crystal]
