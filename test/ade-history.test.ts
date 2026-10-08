import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AdeHistory } from '../src/main/features/ade/history'
import { allConversations } from '../src/main/features/ade/conversations'
import { claudeSlug, setAgentHome } from '../src/main/features/terminals/agentSessions'
import { pathsForTerminal } from '@shared/terminals'

/**
 * Reported from the ADE: Import brought back every folder Claude Code was
 * ever used in, closed sessions filled the sidebar, and conversations other
 * programs started (headless `claude -p`, Codex's desktop app and subagents)
 * were listed as if someone had opened them. And files couldn't be dropped on
 * a terminal.
 */

let home = ''
let proj = ''
const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
const TERMINAL = 'aaaaaaaa-1111-4111-8111-111111111111'
const HEADLESS = 'bbbbbbbb-2222-4222-8222-222222222222'
const OLD_VERSION = 'cccccccc-3333-4333-8333-333333333333'
const CODEX_CLI = 'dddddddd-4444-4444-8444-444444444444'
const CODEX_EXEC = 'eeeeeeee-5555-4555-8555-555555555555'
const CODEX_SUB = 'ffffffff-6666-4666-8666-666666666666'

before(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ade-history-')))
  proj = path.join(home, 'work', 'site')
  fs.mkdirSync(proj, { recursive: true })
  setAgentHome(home, {})
  const claude = path.join(home, '.claude', 'projects', claudeSlug(proj))
  fs.mkdirSync(claude, { recursive: true })
  const turn = (id: string, entrypoint?: string) =>
    jsonl([
      { type: 'user', message: { role: 'user', content: `asked in ${id.slice(0, 4)}` }, cwd: proj, sessionId: id, ...(entrypoint ? { entrypoint } : {}) },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, cwd: proj }
    ])
  fs.writeFileSync(path.join(claude, `${TERMINAL}.jsonl`), turn(TERMINAL, 'cli'))
  fs.writeFileSync(path.join(claude, `${HEADLESS}.jsonl`), turn(HEADLESS, 'sdk-cli'))
  fs.writeFileSync(path.join(claude, `${OLD_VERSION}.jsonl`), turn(OLD_VERSION))
  // A subagent's transcript, under its conversation's folder.
  fs.mkdirSync(path.join(claude, TERMINAL, 'subagents'), { recursive: true })
  fs.writeFileSync(path.join(claude, TERMINAL, 'subagents', 'agent-a1.jsonl'), turn(TERMINAL, 'cli'))
  const codexDay = path.join(home, '.codex', 'sessions', '2026', '10', '08')
  fs.mkdirSync(codexDay, { recursive: true })
  const codex = (id: string, source: unknown) =>
    jsonl([
      { type: 'session_meta', payload: { id, cwd: proj, source, originator: 'codex_cli_rs' } },
      { type: 'event_msg', payload: { type: 'user_message', message: `asked in ${id.slice(0, 4)}` } }
    ])
  fs.writeFileSync(path.join(codexDay, `rollout-2026-10-08T01-00-00-${CODEX_CLI}.jsonl`), codex(CODEX_CLI, 'cli'))
  fs.writeFileSync(path.join(codexDay, `rollout-2026-10-08T01-01-00-${CODEX_EXEC}.jsonl`), codex(CODEX_EXEC, 'exec'))
  fs.writeFileSync(path.join(codexDay, `rollout-2026-10-08T01-02-00-${CODEX_SUB}.jsonl`), codex(CODEX_SUB, { subagent: 'review' }))
})

after(() => fs.rmSync(home, { recursive: true, force: true }))

test('only conversations someone started in a terminal are listed, never other programs’ or subagents’', async () => {
  const ids = (await allConversations()).map((c) => c.id).sort()
  assert.deepEqual(ids, [CODEX_CLI, OLD_VERSION, TERMINAL].sort())
})

test('the history keeps what ran in the ADE’s terminals, across a restart, and nothing else', () => {
  let saved: unknown = null
  const deps = { load: () => saved, save: (v: unknown) => void (saved = structuredClone(v)), now: () => 1_000 }
  const history = new AdeHistory(deps)
  history.note('claude', TERMINAL, proj)
  history.note('shell', 'whatever', proj)
  history.note('codex', CODEX_CLI, `${proj}/`)
  assert.equal(history.has('claude', TERMINAL), true)
  assert.equal(history.has('claude', HEADLESS), false, 'a conversation that never ran in a pane')
  assert.equal(history.has('shell', 'whatever'), false, 'a shell has no conversation')
  const again = new AdeHistory(deps)
  assert.equal(again.size, 2)
  assert.equal(again.has('codex', CODEX_CLI), true)
  // Seen again in the same folder: no write.
  const before = JSON.stringify(saved)
  again.note('claude', TERMINAL, proj)
  assert.equal(JSON.stringify(saved), before)
})

test('files dropped on a terminal are typed as their paths, quoted for the shell where they need it', () => {
  assert.equal(pathsForTerminal(['/Users/al/Desktop/shot.png']), '/Users/al/Desktop/shot.png ')
  assert.equal(pathsForTerminal(['/Users/al/Screen Shot 1.png', '/tmp/a.png']), `'/Users/al/Screen Shot 1.png' /tmp/a.png `)
  assert.equal(pathsForTerminal(["/Users/al/it's here.png"]), `'/Users/al/it'\\''s here.png' `)
  assert.equal(pathsForTerminal([]), '')
})
