import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  claudeTurns,
  codexTurns,
  describeAction,
  HANDOFF_BUDGET,
  handoffDocument,
  handoffFileName,
  handoffPrompt,
  writeHandoff,
  type HandoffTurn
} from '../src/main/features/terminals/handoff'
import { agentCommand, createTerminals, promptLine, resumeLine } from '../src/main/features/terminals'
import { AGENT_KINDS, agentOfArgs } from '../src/main/features/terminals/agentSessions'

const jsonl = (...entries: unknown[]): string => entries.map((e) => JSON.stringify(e)).join('\n') + '\n'

test('Claude Code: what the user asked and what the agent said and did, without tool output or harness notes', () => {
  const turns = claudeTurns(
    jsonl(
      { type: 'permission-mode', permissionMode: 'default' },
      { type: 'user', message: { role: 'user', content: 'Fix the login bug<system-reminder>internal</system-reminder>' } },
      { type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: meta' } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'private' },
            { type: 'text', text: 'Looking at the auth module.' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/p/src/auth.ts' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'npm test -- auth' } }
          ]
        }
      },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'FAIL 3 tests' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/p/src/auth.ts' } }] } },
      { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent chatter' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed the token check; one test still fails.' }] } },
      { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
      'not json'
    )
  )
  assert.equal(turns.length, 2)
  assert.deepEqual(turns[0], { role: 'user', text: 'Fix the login bug', actions: [] })
  assert.equal(turns[1].role, 'assistant')
  assert.equal(turns[1].text, 'Looking at the auth module.\n\nFixed the token check; one test still fails.')
  assert.deepEqual(turns[1].actions, ['ran `npm test -- auth`', 'edited /p/src/auth.ts'])
  assert.doesNotMatch(JSON.stringify(turns), /private|subagent|FAIL 3|internal/)
})

test('Codex: messages, shell commands and patches, without its environment and instruction preamble', () => {
  const turns = codexTurns(
    jsonl(
      { type: 'session_meta', payload: { id: 'x' } },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'system stuff' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Make the build pass' }] } },
      { type: 'response_item', payload: { type: 'reasoning', summary: [] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm run build'] }) } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: src/b.ts\n*** End Patch' } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: 'npm run build' } } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The build passes now.' }] } }
    )
  )
  assert.equal(turns.length, 2)
  assert.equal(turns[0].text, 'Make the build pass')
  assert.equal(turns[1].text, 'The build passes now.')
  // The same command from the response item and the completed item is listed once.
  assert.deepEqual(turns[1].actions, ['ran `npm run build`', 'edited src/a.ts, src/b.ts'])
})

test('actions: a line each for what changes things, nothing for reads and todo lists', () => {
  assert.equal(describeAction('Write', { file_path: 'a.md' }), 'wrote a.md')
  assert.equal(describeAction('Task', { description: 'find callers' }), 'asked a subagent to find callers')
  assert.equal(describeAction('WebSearch', { query: 'electron fuses' }), 'searched the web for "electron fuses"')
  assert.equal(describeAction('Read', { file_path: 'a' }), null)
  assert.equal(describeAction('TodoWrite', {}), null)
  assert.equal(describeAction('mcp__github__create_pr', {}), 'used mcp__github__create_pr')
  assert.ok(describeAction('Bash', { command: 'x'.repeat(500) })!.length < 200, 'a long command is cut short')
})

const base = { fromLabel: 'Claude Code', toLabel: 'Codex', note: '', git: 'Branch: main\n\nNo uncommitted changes.', at: new Date('2026-10-17T12:00:00Z') }

test('the handoff document: the first ask, where it stopped, the project, the note and the conversation', () => {
  const turns: HandoffTurn[] = [
    { role: 'user', text: 'Fix the login bug', actions: [] },
    { role: 'assistant', text: 'Fixed the token check; one test still fails.', actions: ['edited src/auth.ts'] }
  ]
  const doc = handoffDocument({ ...base, turns, screen: null, note: 'Focus on the failing test' })
  assert.match(doc, /^# Handoff from Claude Code to Codex/)
  assert.match(doc, /## Note from the user\n\nFocus on the failing test/)
  assert.match(doc, /## What the user asked first\n\nFix the login bug/)
  assert.match(doc, /## Where Claude Code stopped\n\nFixed the token check/)
  assert.match(doc, /## The project now\n\nBranch: main/)
  assert.match(doc, /### Claude Code\n\nFixed the token check; one test still fails.\n\n- edited src\/auth.ts/)
})

test('a long conversation keeps its start and its latest turns, and says how many were left out', () => {
  const turns: HandoffTurn[] = Array.from({ length: 400 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `message ${i} ${'x'.repeat(900)}`, actions: [] }))
  const doc = handoffDocument({ ...base, turns, screen: null })
  assert.ok(doc.length <= HANDOFF_BUDGET + 2000, `${doc.length} is over the budget`)
  assert.match(doc, /message 0 /)
  assert.match(doc, /message 1 /)
  assert.match(doc, /message 399 /)
  assert.match(doc, /_…\d+ earlier messages left out to keep this short…_/)
})

test('an agent without a readable transcript hands over its terminal text, the latest part when it is long', () => {
  const doc = handoffDocument({ ...base, fromLabel: 'Gemini CLI', turns: null, screen: `old ${'y'.repeat(HANDOFF_BUDGET)} newest line` })
  assert.match(doc, /## Gemini CLI's terminal/)
  assert.match(doc, /newest line/)
  assert.doesNotMatch(doc, /old y/)
  assert.match(handoffDocument({ ...base, turns: null, screen: '' }), /couldn't read what Claude Code did/)
})

test('the file name and the line the new agent starts on', () => {
  assert.equal(handoffFileName('Claude Code', 'Gemini CLI', base.at), '2026-10-17-120000-claude-code-to-gemini-cli.md')
  assert.equal(handoffPrompt('.eaon/handoffs/x.md', 'Claude Code'), 'Read .eaon/handoffs/x.md first: it is the conversation so far from Claude Code in this project, handed over to you. Then check the files and carry on from where it stopped.')
})

test('written into the project, and kept out of git', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaon-handoff-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    const file = await writeHandoff(dir, 'h.md', '# hi\n')
    assert.equal(file, '.eaon/handoffs/h.md')
    assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), '# hi\n')
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), '', '.eaon/ shows in git status')
    await writeHandoff(dir, 'h2.md', 'x')
    const exclude = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8')
    assert.equal(exclude.match(/^\.eaon\/$/gm)?.length, 1, 'the exclude line is added once')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('each agent gets its first task the way its CLI takes one', () => {
  const req = { paneId: 'p', cwd: '/p', cols: 80, rows: 24, prompt: 'Read .eaon/handoffs/x.md first' }
  const line = (agent: string, command: string): string | null => promptLine({ ...req, agent: agent as never, command }, 'posix').command
  assert.equal(line('claude', 'claude'), "claude 'Read .eaon/handoffs/x.md first'")
  assert.equal(line('cursor', 'cursor-agent'), "cursor-agent 'Read .eaon/handoffs/x.md first'")
  assert.equal(line('opencode', 'opencode'), "opencode --prompt 'Read .eaon/handoffs/x.md first'")
  assert.equal(line('copilot', 'copilot'), "copilot -i 'Read .eaon/handoffs/x.md first'")
  assert.equal(line('gemini', 'gemini'), "gemini -i 'Read .eaon/handoffs/x.md first'")
  // No known way on its command line: left alone, and the task is typed in once it's up.
  assert.equal(line('amp', 'amp'), 'amp')
})

test('Claude Code in the ADE always starts with bypass permissions, resumed, continued or given a task', async () => {
  const claude = agentCommand('claude', 'claude')
  assert.equal(claude, 'claude --dangerously-skip-permissions')
  assert.equal(agentCommand('codex', 'codex'), 'codex', 'other agents start as they are')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaon-agents-'))
  try {
    const listed = (await createTerminals({ dir }).control.agents()).find((a) => a.id === 'claude')
    assert.equal(listed?.command, claude, 'the agent list hands every pane the flagged command')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  const id = '0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b'
  const req = { paneId: 'p', cwd: '/p', cols: 80, rows: 24, agent: 'claude' as const, command: claude }
  assert.equal(resumeLine({ ...req, resume: id }).command, `claude --dangerously-skip-permissions --resume ${id}`)
  assert.equal(AGENT_KINDS.claude.continueLatest(claude), 'claude --dangerously-skip-permissions --continue')
  assert.equal(promptLine({ ...req, prompt: 'Read .eaon/handoffs/x.md first' }, 'posix').command, "claude --dangerously-skip-permissions 'Read .eaon/handoffs/x.md first'")
  // The session watch still knows it by its first word.
  assert.equal(agentOfArgs(`${claude} --resume ${id}`), 'claude')
})
