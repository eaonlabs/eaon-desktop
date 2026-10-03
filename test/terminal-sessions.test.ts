import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_KINDS,
  agentOfArgs,
  claudeSlug,
  eaonSessionDir,
  setAgentHome,
  setExtraAgentBin
} from '../src/main/features/terminals/agentSessions'
import { PaneRecords, restoredScreen, SCROLLBACK_BYTES } from '../src/main/features/terminals/paneRecords'
import { agentUnder, byParent, programLine, SessionWatch, type Proc, type WatchDeps } from '../src/main/features/terminals/sessionWatch'
import { createTerminals } from '../src/main/features/terminals'
import { knownAgent, type TerminalAgent, type TerminalAgentId, type TerminalSpawnResult } from '@shared/terminals'

/**
 * Bringing ADE panes back after a quit, and following which CLI runs in each:
 * how each agent's conversations are found and reopened (against files laid
 * out the way the real CLIs lay them out), the watch over a faked process
 * table, the records, and — last — the whole round trip with real shells: a
 * pane running an agent and a pane that had `cd`'d somewhere, quit, and
 * relaunched.
 */

const ID_A = '11111111-2222-4333-8444-555555555555'
const ID_B = '66666666-7777-4888-9999-aaaaaaaaaaaa'
const ID_C = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'

let home: string
let project: string

before(() => {
  // Real path: lsof reports /private/var/… for what tmpdir() calls /var/….
  home = realpathSync(mkdtempSync(join(tmpdir(), 'eaon-agents-')))
  project = join(home, 'work', 'My Project')
  mkdirSync(project, { recursive: true })
  setAgentHome(home, {})
})

after(() => {
  setAgentHome(null)
  rmSync(home, { recursive: true, force: true })
})

function write(file: string, text: string): string {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
  return file
}

/* ------------------------------------------------------------------ which agent */

test('agents are recognised by their own name, not by a word in a path', () => {
  assert.equal(agentOfArgs('claude --resume 1234'), 'claude')
  assert.equal(agentOfArgs('/Users/me/.local/bin/claude'), 'claude')
  assert.equal(agentOfArgs('eaon-code '), 'eaon-code')
  assert.equal(agentOfArgs('node /Users/me/.nvm/versions/node/v24/bin/opencode'), 'opencode')
  assert.equal(agentOfArgs('/usr/local/bin/node --max-old-space-size=8192 /opt/lib/codex/bin/codex'), 'codex')
  assert.equal(agentOfArgs('/Users/me/.local/bin/agy -c'), 'antigravity')
  assert.equal(agentOfArgs('gemini --resume latest'), null, 'Gemini CLI is no longer one of the ADE agents')
  assert.equal(agentOfArgs('node /x/@openai/codex/bin/codex.js resume'), 'codex')
  assert.equal(agentOfArgs('C:\\tools\\codex.exe'), 'codex')
  assert.equal(agentOfArgs('-zsh'), null)
  assert.equal(agentOfArgs('vim /notes/claude/todo.md'), null)
  assert.equal(agentOfArgs('node /x/claude-helper.js'), null)
  assert.equal(agentOfArgs('node'), null)
  // Eaon Code run from a binary pinned in Settings carries that binary's name.
  setExtraAgentBin('/opt/eaon/bin/eaon', 'eaon-code')
  assert.equal(agentOfArgs('/opt/eaon/bin/eaon --session x'), 'eaon-code')
  setExtraAgentBin(null, 'eaon-code')
  assert.equal(agentOfArgs('/opt/eaon/bin/eaon'), null)
})

test('the agent under a shell is the outermost one, wrappers included', () => {
  const table: Proc[] = [
    { pid: 10, ppid: 1, args: '-zsh' },
    { pid: 11, ppid: 10, args: 'node /usr/lib/node_modules/opencode-ai/bin/opencode' },
    { pid: 12, ppid: 11, args: '/usr/lib/node_modules/opencode-darwin-arm64/bin/opencode' },
    { pid: 20, ppid: 1, args: '-zsh' },
    { pid: 21, ppid: 20, args: 'bash -c make' },
    { pid: 22, ppid: 21, args: 'claude -p hi' },
    { pid: 23, ppid: 22, args: 'claude --nested' },
    { pid: 30, ppid: 1, args: '-zsh' },
    { pid: 31, ppid: 30, args: 'vim notes.md' }
  ]
  const kids = byParent(table)
  assert.deepEqual(agentUnder(10, kids), { proc: table[1], agent: 'opencode' })
  assert.equal(agentUnder(20, kids)?.proc.pid, 22)
  assert.equal(agentUnder(30, kids), null)
})

test('a program is started again with its file, even one with spaces in its name', () => {
  write(join(project, 'Read Me.md'), '#')
  assert.equal(programLine('vim Read Me.md', project), "vim 'Read Me.md'")
  assert.equal(programLine('/usr/bin/vim -O a.ts b.ts', project), 'vim -O a.ts b.ts')
  assert.equal(programLine('htop', project), 'htop')
  // Anything not known to be harmless is left for the user to start.
  assert.equal(programLine('npm run dev', project), null)
  assert.equal(programLine('rm -rf build', project), null)
})

/* ------------------------------------------------------------------ claude */

test('Claude Code: the process names its conversation, and only a spoken one is reopened', async () => {
  const kind = AGENT_KINDS.claude
  const projects = join(home, '.claude', 'projects', claudeSlug(project))
  write(join(projects, `${ID_A}.jsonl`), `{"type":"summary"}\n{"type":"user","message":{"content":"hi"}}\n`)
  write(join(projects, `${ID_B}.jsonl`), `{"type":"file-history-snapshot"}\n`)
  assert.equal(claudeSlug('/Users/me/My Project'), '-Users-me-My-Project')

  write(join(home, '.claude', 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: ID_A, cwd: project }))
  assert.deepEqual(kind.own!(4242, project), { sessionId: ID_A, cwd: project })
  // A pid reused by a process somewhere else is not handed this conversation.
  assert.equal(kind.own!(4242, '/elsewhere'), null)
  assert.equal(kind.own!(4243, project), null)

  assert.equal(kind.named(`claude --resume ${ID_B} --model x`), ID_B)
  assert.equal(kind.named(`claude --session-id=${ID_C}`), ID_C)
  assert.equal(kind.named('claude --resume'), null)

  assert.deepEqual([...(await kind.conversations(project)).keys()].sort(), [ID_A, ID_B])
  assert.equal(await kind.resumable(project, ID_A), true)
  // Started and closed without a word: `claude --resume` would say "No conversation found".
  assert.equal(await kind.resumable(project, ID_B), false)
  assert.equal(await kind.resumable(project, ID_C), false)
  assert.equal(kind.resume('claude', ID_A), `claude --resume ${ID_A}`)
})

/* ------------------------------------------------------------------ codex */

test('Codex: conversations are found by the folder in their first line', async () => {
  const kind = AGENT_KINDS.codex
  const d = new Date()
  const day = join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
  const dir = join(home, '.codex', 'sessions', day)
  write(join(dir, `rollout-2026-09-30T10-00-00-${ID_A}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id: ID_A, cwd: project } })}\n`)
  write(join(dir, `rollout-2026-09-30T11-00-00-${ID_B}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id: ID_B, cwd: '/somewhere/else' } })}\n`)
  assert.deepEqual([...(await kind.conversations(project)).keys()], [ID_A])
  assert.equal(await kind.resumable(project, ID_A), true)
  assert.equal(await kind.resumable(project, ID_B), false)
  assert.equal(kind.named(`codex resume ${ID_C}`), ID_C)
  assert.equal(kind.resume('codex', ID_A), `codex resume ${ID_A}`)
  assert.equal(kind.continueLatest('codex'), 'codex resume --last')
})

/* ------------------------------------------------------------------ antigravity */

test("Antigravity: the folder's latest conversation comes from its cache and must still be on disk", async () => {
  const kind = AGENT_KINDS.antigravity
  const root = join(home, '.gemini', 'antigravity-cli')
  write(join(root, 'cache', 'last_conversations.json'), JSON.stringify({ [project]: ID_A, '/somewhere/else': ID_B }))
  write(join(root, 'brain', ID_A, '.system_generated', 'logs', 'transcript.jsonl'), '{}\n')

  assert.deepEqual([...(await kind.conversations(project)).keys()], [ID_A])
  assert.equal(await kind.resumable(project, ID_A), true)
  assert.equal(await kind.resumable(project, ID_B), false, "another folder's conversation")
  assert.equal(await kind.resumable('/somewhere/else', ID_B), false, 'named in the cache but gone from disk')
  assert.equal(kind.named(`agy --conversation ${ID_C}`), ID_C)
  assert.equal(kind.named(`agy --conversation=${ID_C}`), ID_C)
  assert.equal(kind.resume('agy', ID_A), `agy --conversation ${ID_A}`)
  assert.equal(kind.continueLatest('agy'), 'agy --continue')
  assert.equal(agentOfArgs(`/Users/me/.local/bin/agy --conversation ${ID_A}`), 'antigravity')

  // An object entry carrying the id counts too.
  write(join(root, 'cache', 'last_conversations.json'), JSON.stringify({ [project]: { conversationId: ID_A, updatedAt: 1 } }))
  assert.deepEqual([...(await kind.conversations(project)).keys()], [ID_A])
})

test('a Gemini CLI pane saved by an older version comes back as a shell', () => {
  assert.equal(knownAgent('gemini'), 'shell')
  assert.equal(knownAgent('antigravity'), 'antigravity')
  assert.equal(knownAgent(undefined), 'shell')
})

/* ------------------------------------------------------------------ opencode */

test('OpenCode: sessions are read from its database, sub-agents and archived ones left out', { skip: !hasSqlite() }, async () => {
  const kind = AGENT_KINDS.opencode
  const db = join(home, '.local', 'share', 'opencode', 'opencode.db')
  mkdirSync(join(db, '..'), { recursive: true })
  const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
  execFileSync('sqlite3', [
    db,
    'create table session (id text primary key, parent_id text, directory text not null, time_created integer not null, time_updated integer not null, time_archived integer);' +
      `insert into session values ('ses_main', null, ${q(project)}, 1000, 5000, null);` +
      `insert into session values ('ses_child', 'ses_main', ${q(project)}, 1100, 1200, null);` +
      `insert into session values ('ses_old', null, ${q(project)}, 10, 20, 30);` +
      "insert into session values ('ses_other', null, '/else', 1, 2, null);"
  ])
  const found = await kind.conversations(project)
  assert.deepEqual([...found.keys()], ['ses_main'])
  assert.deepEqual(found.get('ses_main'), { id: 'ses_main', born: 1000, touched: 5000 })
  assert.equal(await kind.resumable(project, 'ses_main'), true)
  assert.equal(await kind.resumable(project, 'ses_other'), false)
  assert.equal(kind.named('node /x/bin/opencode -s ses_abc123'), 'ses_abc123')
  assert.equal(kind.resume('opencode', 'ses_main'), 'opencode --session ses_main')
})

function hasSqlite(): boolean {
  try {
    execFileSync('sqlite3', ['-version'])
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ eaon code */

test('Eaon Code: sessions are filed under the folder, named by timestamp and id', async () => {
  const kind = AGENT_KINDS['eaon-code']
  const dir = eaonSessionDir(project)
  assert.equal(dir, join(home, '.eaon', 'agent', 'sessions', `--${project.slice(1).replace(/\//g, '-')}--`))
  write(join(dir, `2026-09-30T10-00-00-000Z_${ID_A}.jsonl`), `{"type":"session","id":"${ID_A}"}\n`)
  assert.deepEqual([...(await kind.conversations(project)).keys()], [ID_A])
  assert.equal(await kind.resumable(project, ID_A), true)
  assert.equal(kind.named(`eaon-code --session ${ID_B}`), ID_B)
  assert.equal(kind.resume("'/opt/eaon code/eaon'", ID_A), `'/opt/eaon code/eaon' --session ${ID_A}`)
})

/* ------------------------------------------------------------------ records */

test('pane records survive a reload, refresh quietly, and go with their pane', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eaon-panes-'))
  const recs = new PaneRecords(dir)
  recs.set('pane-a', { agent: 'claude', sessionId: ID_A, cwd: project })
  recs.set('pane-b', { agent: 'shell', cwd: '/tmp' })
  recs.saveScrollback('pane-a', 'hello')
  recs.saveScrollback('pane-b', 'world')
  recs.flush()

  const again = new PaneRecords(dir)
  assert.equal(again.get('pane-a')?.sessionId, ID_A)
  assert.equal(again.get('pane-b')?.agent, 'shell')
  const shown = again.takeScrollback('pane-a')
  assert.equal(shown?.text, 'hello')
  // Once: a Restart later in the same run does not draw it again.
  assert.equal(again.takeScrollback('pane-a'), null)

  // A closed pane leaves nothing behind.
  again.prune(new Set(['pane-a']))
  assert.equal(again.get('pane-b'), null)
  assert.equal(existsSync(join(dir, 'scrollback', 'pane-b.log')), false)
  again.flush()
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'panes.json'), 'utf8'))), ['pane-a'])
  rmSync(dir, { recursive: true, force: true })
})

test('a restored screen ends with every mode put back and a line saying so', () => {
  const screen = restoredScreen('\x1b[?1049h\x1b[?1000hvim screen', Date.UTC(2026, 8, 30, 18, 54))
  assert.ok(screen.startsWith('\x1b[?1049h'))
  const tail = screen.slice(screen.indexOf('vim screen'))
  for (const off of ['\x1b[?1049l', '\x1b[?1000l', '\x1b[?2004l', '\x1b[?25h', '\x1b[?2026l']) assert.ok(tail.includes(off), off)
  assert.match(tail, /restored · last session ended/)
  // A saved tail starts at its first whole line, never partway through a sequence.
  const cut = restoredScreen(`[31mpartial\nwhole line${'x'.repeat(SCROLLBACK_BYTES)}`, 0)
  assert.ok(cut.startsWith('whole line'))
})

test('a restored shell keeps every line it showed: nothing sent after it moves the cursor home', async () => {
  // The same parser the app draws with, headless: CommonJS, so its class is on the default export.
  const xterm = (await import('@xterm/headless')) as unknown as { default: typeof import('@xterm/headless') }
  const { Terminal } = xterm.default
  const shell = 'me@mac proj % cd sub && echo HELLO-$((6*7))\r\nHELLO-42\r\nme@mac sub % '
  const screen = restoredScreen(shell, 0)
  // Neither cursor-homing reset is sent for output that never asked for it.
  assert.ok(!screen.includes('\x1b[?1049l'))
  assert.ok(!screen.includes('\x1b[r'))
  // Left inside the alternate screen, or with a scroll region: undone, the cursor kept.
  assert.ok(restoredScreen('\x1b[?1049hvim', 0).includes('\x1b[?1049l'))
  assert.ok(restoredScreen('\x1b[?1049hvim\x1b[?1049l$ ', 0).indexOf('\x1b[?1049l', 20) === -1)
  assert.ok(restoredScreen('\x1b[2;20rless', 0).includes('\x1b7\x1b[r\x1b8'))
  const term = new Terminal({ cols: 60, rows: 10, allowProposedApi: true })
  await new Promise<void>((resolve) => term.write(screen + 'me@mac sub % ', resolve))
  const lines = Array.from({ length: 6 }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true) ?? '')
  assert.equal(lines[0], 'me@mac proj % cd sub && echo HELLO-$((6*7))')
  assert.equal(lines[1], 'HELLO-42')
  assert.match(lines[3], /restored · last session ended/)
  assert.equal(lines[4], 'me@mac sub % ')
})

/* ------------------------------------------------------------------ the watch */

interface Fake {
  table: Proc[]
  cwds: Map<number, string>
  now: number
  settling: Set<string>
  events: [string, TerminalAgentId][]
  panes: Map<string, number>
}

function fakeWatch(recs: PaneRecords): { fake: Fake; watch: SessionWatch } {
  const fake: Fake = { table: [], cwds: new Map(), now: Date.now(), settling: new Set(), events: [], panes: new Map() }
  const deps: WatchDeps = {
    table: async () => fake.table,
    cwdOf: async (pid) => fake.cwds.get(pid) ?? '',
    now: () => fake.now
  }
  const watch = new SessionWatch(
    () => fake.panes,
    (paneId) => fake.settling.has(paneId),
    recs,
    (paneId, agent) => fake.events.push([paneId, agent]),
    deps
  )
  return { fake, watch }
}

let recsDir: string
beforeEach(() => {
  recsDir = mkdtempSync(join(tmpdir(), 'eaon-watch-'))
})

test('the logo follows the CLI: shell, then Claude Code, then OpenCode, then the shell again', async () => {
  const recs = new PaneRecords(recsDir)
  const { fake, watch } = fakeWatch(recs)
  fake.panes.set('pane-a', 100)
  fake.table = [{ pid: 100, ppid: 1, args: '-zsh' }]
  await watch.tick()
  fake.table.push({ pid: 101, ppid: 100, args: 'claude' })
  fake.cwds.set(101, project)
  await watch.tick()
  await watch.tick()
  fake.table = [
    { pid: 100, ppid: 1, args: '-zsh' },
    { pid: 102, ppid: 100, args: 'node /x/bin/opencode' }
  ]
  await watch.tick()
  fake.table = [{ pid: 100, ppid: 1, args: '-zsh' }]
  await watch.tick()
  assert.deepEqual(fake.events, [
    ['pane-a', 'shell'],
    ['pane-a', 'claude'],
    ['pane-a', 'opencode'],
    ['pane-a', 'shell']
  ])
  // Quit on purpose, so it stays closed: the pane comes back as its shell.
  assert.equal(recs.get('pane-a')?.agent, 'shell')
  assert.equal(recs.get('pane-a')?.sessionId, undefined)
})

test('a pane still starting its agent is not reported as a bare shell, nor forgotten', async () => {
  const recs = new PaneRecords(recsDir)
  recs.set('pane-a', { agent: 'claude', sessionId: ID_A, cwd: project })
  const { fake, watch } = fakeWatch(recs)
  fake.panes.set('pane-a', 100)
  fake.settling.add('pane-a')
  watch.expect('pane-a', 'claude')
  fake.table = [{ pid: 100, ppid: 1, args: '-zsh' }]
  await watch.tick()
  assert.deepEqual(fake.events, [])
  assert.equal(recs.get('pane-a')?.sessionId, ID_A)
})

test('Claude Code typed into a shell is followed into its conversation, and through a /resume', async () => {
  const recs = new PaneRecords(recsDir)
  const { fake, watch } = fakeWatch(recs)
  fake.panes.set('pane-a', 100)
  fake.table = [
    { pid: 100, ppid: 1, args: '-zsh' },
    { pid: 5150, ppid: 100, args: 'claude' }
  ]
  fake.cwds.set(5150, project)
  write(join(home, '.claude', 'sessions', '5150.json'), JSON.stringify({ pid: 5150, sessionId: ID_A, cwd: project }))
  await watch.tick()
  assert.deepEqual({ ...recs.get('pane-a'), at: 0 }, { agent: 'claude', sessionId: ID_A, cwd: project, at: 0 })
  write(join(home, '.claude', 'sessions', '5150.json'), JSON.stringify({ pid: 5150, sessionId: ID_C, cwd: project }))
  await watch.tick()
  assert.equal(recs.get('pane-a')?.sessionId, ID_C)
})

test('a new conversation goes to the pane whose agent started it', async () => {
  const recs = new PaneRecords(recsDir)
  const { fake, watch } = fakeWatch(recs)
  const other = join(home, 'work', 'other')
  mkdirSync(other, { recursive: true })
  fake.panes.set('pane-a', 100)
  fake.panes.set('pane-b', 200)
  fake.table = [
    { pid: 100, ppid: 1, args: '-zsh' },
    { pid: 101, ppid: 100, args: 'eaon-code ' },
    { pid: 200, ppid: 1, args: '-zsh' },
    { pid: 201, ppid: 200, args: 'eaon-code ' }
  ]
  fake.cwds.set(101, other)
  fake.cwds.set(201, project)
  await watch.tick()
  assert.equal(recs.get('pane-a')?.sessionId, undefined)
  write(join(eaonSessionDir(other), `2026-09-30T12-00-00-000Z_${ID_B}.jsonl`), '{}\n')
  write(join(eaonSessionDir(project), `2026-09-30T12-00-01-000Z_${ID_C}.jsonl`), '{}\n')
  await watch.tick()
  assert.equal(recs.get('pane-a')?.sessionId, ID_B)
  assert.equal(recs.get('pane-b')?.sessionId, ID_C)
  assert.equal(recs.get('pane-a')?.cwd, other)
})

test('a reopened agent keeps its conversation until another one is written to', async () => {
  const recs = new PaneRecords(recsDir)
  // Eaon Code rewrites its process title, so `--session <id>` is not visible to ps.
  recs.set('pane-a', { agent: 'eaon-code', sessionId: ID_A, cwd: project })
  const { fake, watch } = fakeWatch(recs)
  fake.panes.set('pane-a', 100)
  fake.table = [
    { pid: 100, ppid: 1, args: '-zsh' },
    { pid: 101, ppid: 100, args: 'eaon-code ' }
  ]
  fake.cwds.set(101, project)
  const file = join(eaonSessionDir(project), `2026-09-30T10-00-00-000Z_${ID_A}.jsonl`)
  utimesSync(file, new Date(fake.now - 60_000), new Date(fake.now - 60_000))
  await watch.tick()
  assert.equal(recs.get('pane-a')?.sessionId, ID_A, 'carried while nothing says otherwise')
  // The user switched conversations inside the agent: the one written to is its own now.
  fake.now += 10_000
  const switched = join(eaonSessionDir(project), `2026-09-30T12-00-01-000Z_${ID_C}.jsonl`)
  utimesSync(switched, new Date(fake.now), new Date(fake.now))
  await watch.tick()
  assert.equal(recs.get('pane-a')?.sessionId, ID_C)
})

test('a terminal program open in a shell is noted to be started again', async () => {
  const recs = new PaneRecords(recsDir)
  const { fake, watch } = fakeWatch(recs)
  fake.panes.set('pane-a', 100)
  fake.table = [
    { pid: 100, ppid: 1, args: '-zsh' },
    { pid: 101, ppid: 100, args: 'vim Read Me.md' }
  ]
  fake.cwds.set(101, project)
  await watch.tick()
  assert.equal(recs.get('pane-a')?.program, "vim 'Read Me.md'")
  fake.table = [{ pid: 100, ppid: 1, args: '-zsh' }]
  await watch.tick()
  assert.equal(recs.get('pane-a')?.program, undefined)
})

/* ------------------------------------------------------------------ round trip */

/**
 * The real thing, with real shells: a pane running an agent (a stand-in
 * Claude Code that files its conversation exactly where the real one does)
 * and a pane that had moved to a subfolder and printed something. Quit, then
 * launch again: the agent is resumed into its conversation, and the shell is
 * back in its subfolder under what it showed.
 */
test('quitting and relaunching brings every pane back: the agent resumed, the shell where it was', { skip: process.platform === 'win32', timeout: 60_000 }, async () => {
  const bin = join(home, 'bin')
  const fakeClaude = write(
    join(bin, 'claude'),
    `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const home = ${JSON.stringify(home)}
const args = process.argv.slice(2)
const i = args.indexOf('--resume')
const id = i >= 0 ? args[i + 1] : ${JSON.stringify(ID_B)}
const cwd = process.cwd()
const projects = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
fs.mkdirSync(projects, { recursive: true })
fs.appendFileSync(path.join(projects, id + '.jsonl'), JSON.stringify({ type: 'user', message: 'hi' }) + '\\n')
fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true })
fs.writeFileSync(path.join(home, '.claude', 'sessions', process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: id, cwd }))
process.stdout.write('FAKE CLAUDE ' + args.join(' ') + '\\n')
setInterval(() => {}, 1000)
`
  )
  chmodSync(fakeClaude, 0o755)
  const agents = (): TerminalAgent[] => [
    { id: 'claude', label: 'Claude Code', command: fakeClaude, installed: true },
    { id: 'shell', label: 'Shell', command: null, installed: true }
  ]
  const dir = join(home, 'ade-terminals')
  const sub = join(project, 'sub dir')
  mkdirSync(sub, { recursive: true })

  const run = (): {
    feature: ReturnType<typeof createTerminals>
    spawn: (paneId: string, command: string | null, agent: TerminalAgentId) => Promise<TerminalSpawnResult>
    type: (paneId: string, text: string) => void
    saveLayout: () => Promise<unknown>
    output: Map<string, string>
    events: unknown[]
  } => {
    const feature = createTerminals({ dir, agents, settleMs: 1500 })
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const output = new Map<string, string>()
    const events: unknown[] = []
    const ipcMain = {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
      on: (channel: string, fn: (...args: unknown[]) => void) => listeners.set(channel, fn)
    }
    const send = (channel: string, payload: unknown): void => {
      if (channel === 'terminal:data') {
        const { paneId, data } = payload as { paneId: string; data: string }
        output.set(paneId, (output.get(paneId) ?? '') + data)
      } else if (channel === 'terminal:agent') events.push(payload)
    }
    void feature.register({ ipcMain, send, getWindow: () => null, emitStream: () => {} } as never)
    return {
      feature,
      output,
      events,
      spawn: (paneId, command, agent) =>
        handlers.get('terminal:spawn')!({}, { paneId, cwd: project, cols: 100, rows: 30, command, agent }) as Promise<TerminalSpawnResult>,
      type: (paneId, text) => listeners.get('terminal:write')!({}, paneId, text),
      saveLayout: async () =>
        handlers.get('terminal:save-layout')!({}, {
          [project]: [
            { id: 'pane-a', name: 'Cynthia', agent: 'shell' },
            { id: 'pane-b', name: 'Andy', agent: 'shell' }
          ],
          // A pane closed since: what it left is cleared away.
          [sub]: []
        })
    }
  }
  const until = async (what: string, check: () => boolean, ms = 20_000): Promise<void> => {
    const end = Date.now() + ms
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  // First run: pane A opens as a shell and the user types the agent's name;
  // pane B moves to a subfolder and prints something.
  const first = run()
  try {
    assert.equal((await first.spawn('pane-a', null, 'shell')).ok, true)
    assert.equal((await first.spawn('pane-b', null, 'shell')).ok, true)
    await first.saveLayout()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    first.type('pane-a', `${fakeClaude}\r`)
    first.type('pane-b', `cd '${sub}' && echo MARKER-$((40+2))\r`)
    await until('the agent to start', () => (first.output.get('pane-a') ?? '').includes('FAKE CLAUDE'))
    await until('the marker', () => (first.output.get('pane-b') ?? '').includes('MARKER-42'))
    await until('the logo to switch to Claude Code', () => {
      void first.feature.tick()
      return first.events.some((e) => JSON.stringify(e) === JSON.stringify({ paneId: 'pane-a', agent: 'claude' }))
    })
  } finally {
    await first.feature.shutdown!()
  }
  const saved = JSON.parse(readFileSync(join(dir, 'panes.json'), 'utf8'))
  assert.equal(saved['pane-a'].agent, 'claude')
  assert.equal(saved['pane-a'].sessionId, ID_B)
  assert.equal(saved['pane-b'].agent, 'shell')
  assert.equal(saved['pane-b'].cwd, sub)

  // Second run: both panes ask to start as the shells they were opened as.
  const second = run()
  try {
    const a = await second.spawn('pane-a', null, 'shell')
    const b = await second.spawn('pane-b', null, 'shell')
    assert.equal(a.ok && b.ok, true)
    assert.equal(a.restored, undefined, 'a resumed agent redraws its own conversation')
    assert.ok(b.restored?.includes('MARKER-42'), 'the shell shows what it showed')
    assert.ok(second.events.some((e) => JSON.stringify(e) === JSON.stringify({ paneId: 'pane-a', agent: 'claude' })))
    await until('the agent to be resumed', () => (second.output.get('pane-a') ?? '').includes(`FAKE CLAUDE --resume ${ID_B}`))
    second.type('pane-b', 'pwd\r')
    await until('the shell to report its folder', () => (second.output.get('pane-b') ?? '').includes(sub))
  } finally {
    await second.feature.shutdown!()
  }
  // Quit again: the screen it came back with is kept along with what it printed since.
  const kept = readFileSync(join(dir, 'scrollback', 'pane-b.log'), 'utf8')
  assert.ok(kept.includes('MARKER-42') && kept.includes(sub))
})
