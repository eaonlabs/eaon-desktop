import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { allConversations, conversationsIn } from '../src/main/features/ade/conversations'
import { claudeSlug, setAgentHome } from '../src/main/features/terminals/agentSessions'
import { resumeLine } from '../src/main/features/terminals'

/**
 * Import reads the conversations Claude Code and Codex keep on disk, in the
 * shapes those CLIs write (Claude Code 2.1, Codex 0.159), from a scratch home
 * — never the real ~/.claude or ~/.codex.
 */

let home = ''
let projA = ''
let projDash = ''

const CLAUDE_TITLED = '11111111-1111-4111-8111-111111111111'
const CLAUDE_ASKED = '22222222-2222-4222-8222-222222222222'
const CLAUDE_EMPTY = '33333333-3333-4333-8333-333333333333'
const CLAUDE_OTHER_PATH = '44444444-4444-4444-8444-444444444444'
const CODEX_ID = '55555555-5555-4555-8555-555555555555'

const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'

function write(file: string, text: string, mtime: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  fs.utimesSync(file, mtime / 1000, mtime / 1000)
}

before(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ade-conv-')))
  projA = path.join(home, 'work', 'acme-internal')
  // Claude Code files `/x/acme-internal` and `/x/acme/internal` under the same folder name.
  projDash = path.join(home, 'work', 'acme', 'internal')
  fs.mkdirSync(projA, { recursive: true })
  fs.mkdirSync(projDash, { recursive: true })
  setAgentHome(home, {})
  const claude = path.join(home, '.claude', 'projects', claudeSlug(projA))
  assert.equal(claudeSlug(projA), claudeSlug(projDash))

  write(
    path.join(claude, `${CLAUDE_TITLED}.jsonl`),
    jsonl([
      { type: 'permission-mode', permissionMode: 'default', sessionId: CLAUDE_TITLED },
      { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' }, cwd: projA, sessionId: CLAUDE_TITLED },
      { type: 'user', message: { role: 'user', content: 'the checks link in the PR panel goes nowhere' }, cwd: projA, sessionId: CLAUDE_TITLED },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }] }, cwd: projA },
      { type: 'ai-title', aiTitle: 'Investigating checks link', sessionId: CLAUDE_TITLED },
      { type: 'ai-title', aiTitle: 'Fixed checks detail link', sessionId: CLAUDE_TITLED }
    ]),
    Date.UTC(2026, 9, 6, 6)
  )
  write(
    path.join(claude, `${CLAUDE_ASKED}.jsonl`),
    jsonl([
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] }, cwd: projA },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Add regression coverage\nfor the deep link' }] }, cwd: projA },
      { type: 'assistant', message: { role: 'assistant', content: [] }, cwd: projA }
    ]),
    Date.UTC(2026, 9, 6, 4)
  )
  // Opened and closed without a word: `claude --resume` would only say "No conversation found".
  write(path.join(claude, `${CLAUDE_EMPTY}.jsonl`), jsonl([{ type: 'permission-mode', permissionMode: 'default', sessionId: CLAUDE_EMPTY }]), Date.UTC(2026, 9, 6, 7))
  write(
    path.join(claude, `${CLAUDE_OTHER_PATH}.jsonl`),
    jsonl([
      { type: 'user', message: { role: 'user', content: 'in the other folder' }, cwd: projDash },
      { type: 'assistant', message: { role: 'assistant', content: [] }, cwd: projDash }
    ]),
    Date.UTC(2026, 9, 5, 12)
  )
  write(
    path.join(home, '.codex', 'sessions', '2026', '10', '06', `rollout-2026-10-06T05-00-00-${CODEX_ID}.jsonl`),
    jsonl([
      { timestamp: 't', type: 'session_meta', payload: { id: CODEX_ID, cwd: projA, cli_version: '0.159.0' } },
      { timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<user_instructions>be careful</user_instructions>' }] } },
      { timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
      { timestamp: 't', type: 'event_msg', payload: { type: 'user_message', message: 'verifying CI panel deep link opens the run' } },
      { timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } }
    ]),
    Date.UTC(2026, 9, 6, 5)
  )
  // A rollout that never got a turn.
  write(
    path.join(home, '.codex', 'sessions', '2026', '10', '06', 'rollout-2026-10-06T08-00-00-66666666-6666-4666-8666-666666666666.jsonl'),
    jsonl([{ timestamp: 't', type: 'session_meta', payload: { id: '66666666-6666-4666-8666-666666666666', cwd: projA } }]),
    Date.UTC(2026, 9, 6, 8)
  )
})

after(() => {
  setAgentHome(null)
  fs.rmSync(home, { recursive: true, force: true })
})

test('every conversation with something to reopen, titled the way its agent titled it, newest first', async () => {
  const found = await allConversations()
  assert.deepEqual(
    found.map((c) => [c.agent, c.id, c.cwd, c.title]),
    [
      ['claude', CLAUDE_TITLED, projA, 'Fixed checks detail link'],
      ['codex', CODEX_ID, projA, 'verifying CI panel deep link opens the run'],
      ['claude', CLAUDE_ASKED, projA, 'Add regression coverage for the deep link'],
      ['claude', CLAUDE_OTHER_PATH, projDash, 'in the other folder']
    ]
  )
})

test('a folder’s conversations are its own, even where Claude Code files two folders together', async () => {
  assert.deepEqual(
    (await conversationsIn(projA)).map((c) => c.id),
    [CLAUDE_TITLED, CODEX_ID, CLAUDE_ASKED]
  )
  assert.deepEqual(
    (await conversationsIn(projDash)).map((c) => c.id),
    [CLAUDE_OTHER_PATH]
  )
})

test('reopening a conversation types the agent’s own resume line, and only for an id shaped like one', () => {
  const req = { paneId: 'p', cwd: projA, cols: 80, rows: 24 }
  assert.equal(resumeLine({ ...req, agent: 'claude', command: 'claude', resume: CLAUDE_TITLED }).command, `claude --resume ${CLAUDE_TITLED}`)
  assert.equal(resumeLine({ ...req, agent: 'codex', command: 'codex', resume: CODEX_ID }).command, `codex resume ${CODEX_ID}`)
  // Anything else goes nowhere near the shell's command line.
  assert.equal(resumeLine({ ...req, agent: 'claude', command: 'claude', resume: `${CLAUDE_TITLED}; rm -rf ~` }).command, 'claude')
  assert.equal(resumeLine({ ...req, agent: 'shell', command: null, resume: CLAUDE_TITLED }).command, null)
})
