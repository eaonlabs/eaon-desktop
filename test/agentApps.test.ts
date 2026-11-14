import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { foreignAgent, resumableId, whenOf } from '../src/shared/agentApps'
import { withSnapshot } from '../src/main/features/agentApps/sqlite'
import {
  headBranch,
  namedScripts,
  parseClaudeSquad,
  parseOrca,
  projectFileScripts,
  readConductorDb,
  readCrystalDb,
  readSupersetDb,
  readSynaraDb,
  readT3Db
} from '../src/main/features/agentApps/readers'

/**
 * Import from other agent apps (main/features/agentApps): each app's records,
 * in the shapes those apps write them, read into sessions and scripts.
 */

const CLAUDE_ID = '9d892f4b-1c2d-4e5f-8a9b-0c1d2e3f4a5b'
const CODEX_ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
/** A time in ms, as these apps write them (a small number reads as seconds). */
const T0 = 1_789_000_000_000

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'eaon-agentapps-'))
}

/** A database written the way these apps leave theirs: in WAL mode, still open, its last rows not yet in the main file. */
function database(file: string, sql: string): DatabaseSync {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(sql)
  return db
}

test('conversation ids, agent names and times as the other apps write them', () => {
  assert.equal(resumableId(CLAUDE_ID), CLAUDE_ID)
  assert.equal(resumableId(` ${CLAUDE_ID} `), CLAUDE_ID)
  assert.equal(resumableId('ses_abc123'), 'ses_abc123')
  assert.equal(resumableId('claude_5f9ee710_x'), null)
  assert.equal(resumableId('--resume; rm -rf ~'), null)
  assert.equal(foreignAgent('claudeAgent'), 'claude')
  assert.equal(foreignAgent('Claude Code'), 'claude')
  assert.equal(foreignAgent('codex-cli'), 'codex')
  assert.equal(foreignAgent('aider'), null)
  assert.equal(whenOf(1_789_615_120_611), 1_789_615_120_611)
  assert.equal(whenOf(1_789_615_120), 1_789_615_120_000)
  assert.equal(whenOf('2026-11-01T10:00:00.000Z'), Date.parse('2026-11-01T10:00:00.000Z'))
  assert.equal(whenOf(null), 0)
})

test('a database is read from a copy that has the rows still in its WAL, and the copy is removed', () => {
  const dir = tmp()
  const file = path.join(dir, 'host.db')
  const db = database(file, "CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept in the wal');")
  try {
    let copy = ''
    const rows = withSnapshot(file, (snap) => {
      copy = os.tmpdir()
      return snap.rows('SELECT v FROM t').map((r) => r.v)
    })
    assert.deepEqual(rows, ['kept in the wal'])
    assert.ok(copy)
    assert.deepEqual(
      withSnapshot(file, (snap) => snap.rows('SELECT nothing FROM missing')),
      [],
      'a table another version doesn’t have reads as none'
    )
    assert.deepEqual([...(withSnapshot(file, (snap) => snap.columns('t')) ?? [])], ['v'])
    assert.equal(
      withSnapshot(path.join(dir, 'absent.db'), () => 'read'),
      null
    )
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Orca: worktrees with their names and last use, the agent tab’s agent, a chat’s conversation, and repository scripts', () => {
  const reading = parseOrca(
    {
      repos: [
        { id: 'r1', path: '/code/shop', hookSettings: { scripts: { setup: 'pnpm install', archive: ['docker compose down', 'rm -rf .cache'] } } },
        { id: 'r2', path: '/code/site' }
      ],
      worktreeMeta: {
        'r1::/code/shop-worktrees/checkout': { displayName: 'Checkout flow', lastActivityAt: T0 + 2000, isArchived: true },
        'r2::/code/site': { displayName: '', lastActivityAt: 0 }
      },
      workspaceSession: {
        unifiedTabs: {
          'r2::/code/site': [
            { contentType: 'browser' },
            { contentType: 'agent-session', agentSessionAgent: 'codex' }
          ]
        },
        lastVisitedAtByWorktreeId: { 'r2::/code/site': T0 + 5000 }
      }
    },
    [
      {
        record_json: JSON.stringify({
          provider: 'claude',
          location: { workspaceId: 'r1::/code/shop-worktrees/checkout' },
          providerHandleChain: [{ handle: { nativeId: 'not-a-uuid' } }, { handle: { nativeId: CLAUDE_ID } }]
        })
      },
      { record_json: 'not json' }
    ]
  )
  assert.deepEqual(reading.sessions, [
    { title: 'Checkout flow', cwd: '/code/shop-worktrees/checkout', project: '/code/shop', branch: null, agent: 'claude', resume: CLAUDE_ID, touched: T0 + 2000, archived: true },
    { title: null, cwd: '/code/site', project: '/code/site', branch: null, agent: 'codex', resume: null, touched: T0 + 5000, archived: false }
  ])
  assert.deepEqual(reading.scripts, [
    {
      project: '/code/shop',
      commands: [
        { name: 'Setup', command: 'pnpm install', when: 'setup' },
        { name: 'Archive', command: 'docker compose down && rm -rf .cache', when: 'teardown' }
      ],
      source: 'Orca’s settings'
    }
  ])
})

test('Orca: a terminal agent put to sleep keeps its provider’s conversation, which wins over a chat’s', () => {
  const reading = parseOrca(
    {
      worktreeMeta: { 'r::/code/a': { displayName: 'A' } },
      workspaceSession: {
        sleepingAgentSessionsByPaneKey: {
          'r::/code/a@@1': { worktreeId: 'r::/code/a', agent: 'codex', providerSession: { id: CODEX_ID, cwd: '/code/a' }, updatedAt: 10 },
          'r::/code/a@@2': { worktreeId: 'r::/code/a', agent: 'claude', providerSession: { id: CLAUDE_ID, cwd: '/code/a' }, updatedAt: 20 }
        }
      }
    },
    [{ record_json: JSON.stringify({ provider: 'codex', location: { workspaceId: 'r::/code/a' }, providerHandleChain: [{ handle: { nativeId: CODEX_ID } }] }) }]
  )
  assert.equal(reading.sessions[0].resume, CLAUDE_ID)
  assert.equal(reading.sessions[0].agent, 'claude')
})

test('Superset: workspaces with their branch, the newest conversation a terminal ran, and the project’s own checkout named after it', () => {
  const dir = tmp()
  const file = path.join(dir, 'host.db')
  const db = database(
    file,
    `CREATE TABLE projects (id TEXT, repo_path TEXT, name TEXT);
     CREATE TABLE workspaces (id TEXT, project_id TEXT, worktree_path TEXT, branch TEXT, name TEXT, type TEXT, archived_at INTEGER, updated_at INTEGER, last_activity_at INTEGER);
     CREATE TABLE terminal_agent_bindings (terminal_id TEXT, workspace_id TEXT, agent_id TEXT, agent_session_id TEXT, started_at INTEGER, last_event_at INTEGER);
     INSERT INTO projects VALUES ('p1', '/code/api', 'api');
     INSERT INTO workspaces VALUES ('w1', 'p1', '/code/api', 'main', 'api', 'main', NULL, ${T0 + 100}, ${T0 + 100});
     INSERT INTO workspaces VALUES ('w2', 'p1', '/sup/api/fix-auth', 'fix-auth', 'Fix auth', 'worktree', ${T0 + 3000}, ${T0 + 200}, ${T0 + 250});
     INSERT INTO terminal_agent_bindings VALUES ('t1', 'w2', 'claude', '${CLAUDE_ID}', ${T0 + 300}, ${T0 + 400});
     INSERT INTO terminal_agent_bindings VALUES ('t2', 'w2', 'codex', '${CODEX_ID}', ${T0 + 500}, ${T0 + 600});
     INSERT INTO terminal_agent_bindings VALUES ('t3', 'w1', 'amp', 'T-1234', 10, 20);
     ALTER TABLE terminal_agent_bindings ADD COLUMN transcript_path TEXT;
     INSERT INTO terminal_agent_bindings VALUES ('t4', 'w1', 'claude', '${CLAUDE_ID}', 30, 40, '/Users/me/.paradev/claude-home/projects/x/${CLAUDE_ID}.jsonl');`
  )
  try {
    const reading = withSnapshot(file, readSupersetDb)
    // A conversation kept in a Claude home of Superset's own isn't offered: --resume wouldn't find it.
    assert.deepEqual(reading?.sessions, [
      { title: null, cwd: '/code/api', project: '/code/api', branch: 'main', agent: null, resume: null, touched: T0 + 100, archived: false },
      { title: 'Fix auth', cwd: '/sup/api/fix-auth', project: '/code/api', branch: 'fix-auth', agent: 'codex', resume: CODEX_ID, touched: T0 + 600, archived: true }
    ])
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Claude Squad: an instance per worktree, its program as the agent, the default program when it has none', () => {
  const state = {
    instances: [
      {
        title: 'refactor',
        path: '/code/app',
        branch: 'me/refactor',
        program: '/usr/local/bin/codex',
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-02T00:00:00Z',
        worktree: { repo_path: '/code/app', worktree_path: '/home/.claude-squad/worktrees/refactor_1a2b', branch_name: 'me/refactor' }
      },
      { title: 'plain', path: '/code/other', branch: 'main' }
    ]
  }
  const reading = parseClaudeSquad(state, { default_program: '/Users/me/.local/bin/claude' })
  assert.deepEqual(reading.sessions, [
    {
      title: 'refactor',
      cwd: '/home/.claude-squad/worktrees/refactor_1a2b',
      project: '/code/app',
      branch: 'me/refactor',
      agent: 'codex',
      resume: null,
      touched: Date.parse('2026-10-02T00:00:00Z'),
      archived: false
    },
    { title: 'plain', cwd: '/code/other', project: '/code/other', branch: 'main', agent: 'claude', resume: null, touched: 0, archived: false }
  ])
  // Older versions kept the list as a JSON string.
  assert.equal(parseClaudeSquad({ instances: JSON.stringify(state.instances) }, null).sessions.length, 2)
  assert.deepEqual(parseClaudeSquad(null, null).sessions, [])
})

test('T3 Code: a session per folder from its threads, the newest naming it, its conversation, and the project’s named scripts', () => {
  const dir = tmp()
  const file = path.join(dir, 'statev2.sqlite')
  const scripts = JSON.stringify([
    { id: 's1', name: 'Install', command: 'bun install', icon: 'configure', runOnWorktreeCreate: true },
    { id: 's2', name: 'Dev', command: 'bun dev', icon: 'play' },
    { id: 's3', name: 'Test', command: 'bun test', icon: 'test' },
    { id: 's4', name: '', command: 'ignored' }
  ])
  const db = database(
    file,
    `CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT, scripts_json TEXT, deleted_at TEXT);
     CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, title TEXT, default_provider TEXT, archived_at TEXT, deleted_at TEXT, updated_at TEXT, payload_json TEXT);
     CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, provider TEXT, driver TEXT, payload_json TEXT);
     CREATE TABLE provider_session_runtime (thread_id TEXT, provider_name TEXT, resume_cursor_json TEXT);
     INSERT INTO projection_projects VALUES ('p1', '/code/t3', '${scripts}', NULL);
     INSERT INTO projection_projects VALUES ('p2', '/code/gone', '[]', '2026-01-01');
     INSERT INTO orchestration_v2_projection_threads VALUES ('a', 'p1', 'Older thread', 'claudeAgent', NULL, NULL, '2026-11-01T00:00:00Z', '{"branch":"feat","worktreePath":"/t3/wt/feat"}');
     INSERT INTO orchestration_v2_projection_threads VALUES ('b', 'p1', 'Newer thread', 'claudeAgent', NULL, NULL, '2026-11-03T00:00:00Z', '{"branch":"feat","worktreePath":"/t3/wt/feat"}');
     INSERT INTO orchestration_v2_projection_threads VALUES ('c', 'p1', 'In the root', 'codex', '2026-11-05', NULL, '2026-11-02T00:00:00Z', '{}');
     INSERT INTO orchestration_v2_projection_threads VALUES ('d', 'p1', 'Deleted', 'codex', NULL, '2026-11-05', '2026-11-09T00:00:00Z', '{}');
     INSERT INTO orchestration_v2_projection_provider_threads VALUES ('a', 'claudeAgent', 'claudeAgent', '{"nativeThreadRef":{"driver":"claudeAgent","nativeId":"${CLAUDE_ID}"}}');
     INSERT INTO provider_session_runtime VALUES ('c', 'codex', '{"resume":"${CODEX_ID}"}');`
  )
  try {
    const reading = withSnapshot(file, readT3Db)
    assert.deepEqual(reading?.sessions, [
      // The newest thread names it; the older one, which kept its conversation, gives that.
      { title: 'Newer thread', cwd: '/t3/wt/feat', project: '/code/t3', branch: 'feat', agent: 'claude', resume: CLAUDE_ID, touched: Date.parse('2026-11-03T00:00:00Z'), archived: false },
      { title: null, cwd: '/code/t3', project: '/code/t3', branch: null, agent: 'codex', resume: CODEX_ID, touched: Date.parse('2026-11-02T00:00:00Z'), archived: true }
    ])
    assert.deepEqual(reading?.scripts, [
      {
        project: '/code/t3',
        commands: [
          { name: 'Install', command: 'bun install', when: 'setup' },
          { name: 'Dev', command: 'bun dev', when: 'run' },
          { name: 'Test', command: 'bun test', when: null }
        ],
        source: 'T3 Code’s project settings'
      }
    ])
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Synara: projects only (not chats), threads in their worktree, and only Claude’s conversations reopened', () => {
  const dir = tmp()
  const file = path.join(dir, 'state.sqlite')
  const db = database(
    file,
    `CREATE TABLE projection_projects (project_id TEXT, kind TEXT, workspace_root TEXT, scripts_json TEXT, deleted_at TEXT);
     CREATE TABLE projection_threads (thread_id TEXT, project_id TEXT, title TEXT, branch TEXT, worktree_path TEXT, associated_worktree_path TEXT, associated_worktree_branch TEXT, working_directory TEXT, model_selection_json TEXT, archived_at TEXT, deleted_at TEXT, updated_at TEXT);
     CREATE TABLE provider_session_runtime (thread_id TEXT, provider_name TEXT, resume_cursor_json TEXT);
     INSERT INTO projection_projects VALUES ('p1', 'project', '/code/syn', NULL, NULL);
     INSERT INTO projection_projects VALUES ('p2', 'chat', '/chats', NULL, NULL);
     INSERT INTO projection_threads VALUES ('a', 'p1', 'Add billing', NULL, NULL, '/syn/wt/billing', 'billing', NULL, NULL, NULL, NULL, '2026-11-04T00:00:00Z');
     INSERT INTO projection_threads VALUES ('b', 'p1', 'Codex work', 'main', '/syn/wt/codex', NULL, NULL, NULL, '{"instanceId":"codex"}', NULL, NULL, '2026-11-03T00:00:00Z');
     INSERT INTO projection_threads VALUES ('c', 'p2', 'A chat', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-11-05T00:00:00Z');
     INSERT INTO provider_session_runtime VALUES ('a', 'claudeAgent', '{"resume":"${CLAUDE_ID}","resumeSessionAt":"x"}');
     INSERT INTO provider_session_runtime VALUES ('b', 'codex', '{"resume":"${CODEX_ID}"}');`
  )
  try {
    const reading = withSnapshot(file, readSynaraDb)
    assert.deepEqual(reading?.sessions, [
      { title: 'Add billing', cwd: '/syn/wt/billing', project: '/code/syn', branch: 'billing', agent: 'claude', resume: CLAUDE_ID, touched: Date.parse('2026-11-04T00:00:00Z'), archived: false },
      // Synara's Codex keeps its conversations in a home of its own, where `codex resume` can't find them.
      { title: 'Codex work', cwd: '/syn/wt/codex', project: '/code/syn', branch: 'main', agent: 'codex', resume: null, touched: Date.parse('2026-11-03T00:00:00Z'), archived: false }
    ])
    assert.deepEqual(reading?.scripts, [])
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scripts a project keeps in a file: conductor.json, and Superset’s config with its local file as a fallback', () => {
  const dir = tmp()
  try {
    writeFileSync(path.join(dir, 'conductor.json'), JSON.stringify({ scripts: { setup: 'npm ci', run: 'npm run dev', archive: '' }, runScriptMode: 'nonconcurrent' }))
    assert.deepEqual(projectFileScripts(dir, 'conductor'), {
      project: dir,
      commands: [
        { name: 'Setup', command: 'npm ci', when: 'setup' },
        { name: 'Run', command: 'npm run dev', when: 'run' }
      ],
      source: 'conductor.json'
    })
    assert.equal(projectFileScripts(dir, 'superset'), null)
    mkdirSync(path.join(dir, '.superset'))
    writeFileSync(path.join(dir, '.superset', 'config.local.json'), JSON.stringify({ setup: ['cp ../.env .env', 'bun install'], teardown: 'docker compose down' }))
    assert.deepEqual(projectFileScripts(dir, 'superset'), {
      project: dir,
      commands: [
        { name: 'Setup', command: 'cp ../.env .env && bun install', when: 'setup' },
        { name: 'Teardown', command: 'docker compose down', when: 'teardown' }
      ],
      source: '.superset/config.local.json'
    })
    writeFileSync(path.join(dir, 'conductor.json'), '{ not json')
    assert.equal(projectFileScripts(dir, 'conductor'), null)
    assert.deepEqual(namedScripts('nope'), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the branch a folder has checked out, in a repository and in a worktree of it, read from git’s files', () => {
  const dir = tmp()
  try {
    const repo = path.join(dir, 'repo')
    mkdirSync(path.join(repo, '.git', 'worktrees', 'wt'), { recursive: true })
    writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(path.join(repo, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/feature/login\n')
    const wt = path.join(dir, 'wt')
    mkdirSync(wt)
    writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`)
    const detached = path.join(dir, 'detached')
    mkdirSync(path.join(detached, '.git'), { recursive: true })
    writeFileSync(path.join(detached, '.git', 'HEAD'), '3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a\n')
    assert.equal(headBranch(repo), 'main')
    assert.equal(headBranch(wt), 'feature/login')
    assert.equal(headBranch(detached), null)
    assert.equal(headBranch(path.join(dir, 'nothing')), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Conductor: workspaces under ~/conductor, the newest Claude chat’s title and conversation, cloud ones left out, and the scripts typed into the app', () => {
  const dir = tmp()
  const file = path.join(dir, 'conductor.db')
  const db = database(
    file,
    `CREATE TABLE settings (key TEXT, value TEXT);
     CREATE TABLE repos (id TEXT, name TEXT, root_path TEXT, default_branch TEXT, storage_version INTEGER, setup_script TEXT, run_script TEXT, archive_script TEXT);
     CREATE TABLE workspaces (id TEXT, local_id TEXT, repository_id TEXT, directory_name TEXT, branch TEXT, state TEXT, hosting_server_url TEXT);
     CREATE TABLE sessions (id TEXT, workspace_id TEXT, agent_type TEXT, claude_session_id TEXT, title TEXT, status TEXT, is_hidden INTEGER, updated_at TEXT, last_user_message_at TEXT);
     INSERT INTO repos VALUES ('r1', 'shop', '/code/shop', 'main', 3, 'pnpm i', 'pnpm dev', NULL);
     INSERT INTO repos VALUES ('r2', 'old', '/code/old', 'main', 2, NULL, NULL, NULL);
     INSERT INTO workspaces VALUES ('w1', 'L1', 'r1', 'san-antonio', 'me/checkout', 'ready', NULL);
     INSERT INTO workspaces VALUES ('w2', NULL, 'r2', 'lisbon', 'fix', 'archived', NULL);
     INSERT INTO workspaces VALUES ('w3', NULL, 'r1', 'tokyo', 'cloud', 'ready', 'https://cloud.conductor.build');
     INSERT INTO sessions VALUES ('s1', 'L1', NULL, '${CLAUDE_ID}', 'Checkout flow', 'idle', 0, '2026-11-01 10:00:00', '2026-11-01 10:00:00');
     INSERT INTO sessions VALUES ('s2', 'L1', 'claude', NULL, 'Hidden one', 'idle', 1, '2026-11-09 10:00:00', NULL);
     INSERT INTO sessions VALUES ('s3', 'w2', 'codex', '${CODEX_ID}', 'Codex chat', 'idle', 0, '2026-10-01 08:00:00', NULL);`
  )
  try {
    const reading = withSnapshot(file, (snap) => readConductorDb(snap, '/Users/me'))
    assert.deepEqual(reading?.sessions, [
      {
        title: 'Checkout flow',
        cwd: '/Users/me/conductor/workspaces/shop/san-antonio',
        project: '/code/shop',
        branch: 'me/checkout',
        agent: 'claude',
        resume: CLAUDE_ID,
        touched: Date.parse('2026-11-01T10:00:00Z'),
        archived: false
      },
      // Codex's thread id isn't trusted from this column; its conversation is found by folder.
      { title: 'Codex chat', cwd: '/code/old/.conductor/lisbon', project: '/code/old', branch: 'fix', agent: 'codex', resume: null, touched: Date.parse('2026-10-01T08:00:00Z'), archived: true }
    ])
    assert.deepEqual(reading?.scripts, [
      {
        project: '/code/shop',
        commands: [
          { name: 'Setup', command: 'pnpm i', when: 'setup' },
          { name: 'Run', command: 'pnpm dev', when: 'run' }
        ],
        source: 'Conductor’s repository settings'
      }
    ])
    db.exec("INSERT INTO settings VALUES ('conductor_root_path', '/Volumes/work/conductor')")
    assert.equal(withSnapshot(file, (snap) => readConductorDb(snap, '/Users/me'))?.sessions[0].cwd, '/Volumes/work/conductor/workspaces/shop/san-antonio')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Crystal: sessions with their worktree and Claude conversation, and a project’s run script', () => {
  const dir = tmp()
  const file = path.join(dir, 'crystal.db')
  const db = database(
    file,
    `CREATE TABLE projects (id INTEGER, path TEXT, run_script TEXT);
     CREATE TABLE sessions (id TEXT, name TEXT, project_id INTEGER, worktree_path TEXT, archived INTEGER, tool_type TEXT, claude_session_id TEXT, created_at TEXT, updated_at TEXT);
     INSERT INTO projects VALUES (1, '/code/cr', 'npm start');
     INSERT INTO sessions VALUES ('a', 'Dark mode', 1, '/code/cr/worktrees/dark-mode', 0, 'claude', '${CLAUDE_ID}', '2026-02-01 09:00:00', '2026-02-02 09:00:00');
     INSERT INTO sessions VALUES ('b', 'Old', 1, '/code/cr/worktrees/old', 1, 'codex', NULL, '2026-01-01 09:00:00', NULL);`
  )
  try {
    const reading = withSnapshot(file, readCrystalDb)
    assert.deepEqual(reading?.sessions, [
      { title: 'Dark mode', cwd: '/code/cr/worktrees/dark-mode', project: '/code/cr', branch: null, agent: 'claude', resume: CLAUDE_ID, touched: Date.parse('2026-02-02T09:00:00Z'), archived: false },
      { title: 'Old', cwd: '/code/cr/worktrees/old', project: '/code/cr', branch: null, agent: 'codex', resume: null, touched: Date.parse('2026-01-01T09:00:00Z'), archived: true }
    ])
    assert.deepEqual(reading?.scripts, [{ project: '/code/cr', commands: [{ name: 'Run', command: 'npm start', when: 'run' }], source: 'Crystal’s project settings' }])
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
