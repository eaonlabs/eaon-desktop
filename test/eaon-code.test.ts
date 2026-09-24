import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachJsonlReader } from '../src/main/features/eaonCode/jsonl'
import { createEventBatcher, slimEvent } from '../src/main/features/eaonCode/batch'
import { buildChildEnv } from '../src/main/features/eaonCode/env'
import { agentDirFor, parseVersion, versionAtLeast } from '../src/main/features/eaonCode/locate'
import { defaultSessionDir, listSessions, summariseSession } from '../src/main/features/eaonCode/sessions'
import { shellQuote } from '../src/main/features/eaonCode/terminal'
import { explainInstallFailure } from '../src/main/features/eaonCode/install'
import { applyEvents, emptyTranscript, peekArgument, transcriptFromMessages } from '../src/renderer/src/components/code/transcript'
import type { EaonEvent } from '@shared/eaonCode'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('jsonl: splits on LF only, keeps U+2028/U+2029 inside records, strips CR, joins split code points', async () => {
  const stream = new PassThrough()
  const lines: string[] = []
  attachJsonlReader(stream, (line) => lines.push(line))
  const record = JSON.stringify({ text: 'a\u2028b\u2029c — é' })
  const bytes = Buffer.from(`${record}\r\n{"n":2}\n{"n":`, 'utf8')
  // Split in the middle of the multi-byte em dash.
  const cut = bytes.indexOf(Buffer.from('—')) + 1
  stream.write(bytes.subarray(0, cut))
  stream.write(bytes.subarray(cut))
  stream.end('3}')
  await new Promise((resolve) => stream.once('end', resolve))
  assert.equal(lines.length, 3)
  assert.equal(JSON.parse(lines[0]).text, 'a\u2028b\u2029c — é')
  assert.deepEqual(JSON.parse(lines[1]), { n: 2 })
  assert.deepEqual(JSON.parse(lines[2]), { n: 3 })
})

test('batch: coalesces adjacent deltas per content block and keeps order', async () => {
  const sent: EaonEvent[][] = []
  const batcher = createEventBatcher((events) => sent.push(events), 5)
  const delta = (type: string, contentIndex: number, text: string): EaonEvent => ({
    type: 'message_update',
    usage: { output: text.length },
    assistantMessageEvent: { type, contentIndex, delta: text }
  })
  const original = delta('text_delta', 1, 'Hel')
  batcher.push({ type: 'agent_start' })
  batcher.push(delta('thinking_delta', 0, 'hmm'))
  batcher.push(delta('thinking_delta', 0, '…'))
  batcher.push(original)
  batcher.push(delta('text_delta', 1, 'lo'))
  batcher.push({ type: 'tool_execution_update', toolCallId: 't1', partialResult: { content: [{ type: 'text', text: 'a' }] } })
  batcher.push({ type: 'tool_execution_update', toolCallId: 't1', partialResult: { content: [{ type: 'text', text: 'ab' }] } })
  batcher.push({ type: 'agent_end', messages: new Array(500).fill({ role: 'user' }), willRetry: false })
  batcher.push({ type: 'message_start', message: { role: 'system', content: 'huge prompt' } })
  await sleep(20)
  assert.equal(sent.length, 1, 'one IPC message per frame')
  const batch = sent[0]
  assert.deepEqual(batch.map((e) => e.type), ['agent_start', 'message_update', 'message_update', 'tool_execution_update', 'agent_end'])
  assert.equal((batch[1].assistantMessageEvent as { delta: string }).delta, 'hmm…')
  assert.equal((batch[2].assistantMessageEvent as { delta: string }).delta, 'Hello')
  assert.equal((original.assistantMessageEvent as { delta: string }).delta, 'Hel', "the caller's event is not mutated")
  assert.deepEqual(batch[4], { type: 'agent_end', willRetry: false }, 'message lists are stripped')
  assert.equal(slimEvent({ type: 'entry_appended' }), null)
})

test('env: maps Eaon provider ids to Eaon Code variables without clobbering exported ones', () => {
  const keys: Record<string, string> = { anthropic: 'sk-ant', gemini: 'g-key', openai: 'sk-oai', azure: 'az', 'some-custom': 'x' }
  const { env, shared } = buildChildEnv({ PATH: '/bin', OPENAI_API_KEY: 'mine' }, true, (id) => keys[id])
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant')
  assert.equal(env.GEMINI_API_KEY, 'g-key')
  assert.equal(env.OPENAI_API_KEY, 'mine', 'an exported key wins')
  assert.equal(env.AZURE_OPENAI_API_KEY, undefined, 'azure needs more than a key')
  assert.deepEqual(shared.sort(), ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY'])
  const off = buildChildEnv({ PATH: '/bin' }, false, (id) => keys[id])
  assert.equal(off.env.ANTHROPIC_API_KEY, undefined)
  assert.deepEqual(off.shared, [])
})

test('locate: version parsing and the Node floor', () => {
  assert.deepEqual(parseVersion('v22.22.3\n'), [22, 22, 3])
  assert.deepEqual(parseVersion('1.0.1'), [1, 0, 1])
  assert.equal(parseVersion('command not found'), null)
  assert.equal(versionAtLeast([22, 19, 0], [22, 19, 0]), true)
  assert.equal(versionAtLeast([22, 18, 9], [22, 19, 0]), false)
  assert.equal(versionAtLeast([24, 0, 0], [22, 19, 0]), true)
  assert.equal(agentDirFor({ dir: null, configDir: '.eaon', appName: 'eaon-code' }, { EAON_CODE_CODING_AGENT_DIR: '/x/agent' }), '/x/agent')
})

test('sessions: reads names, first prompt and activity like Eaon Code does, filtered to the folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eaon-code-sessions-'))
  const project = join(root, 'project')
  mkdirSync(project)
  const agentDir = join(root, 'agent')
  const dir = defaultSessionDir(agentDir, project)
  mkdirSync(dir, { recursive: true })
  const line = (value: unknown): string => JSON.stringify(value)
  const header = (id: string, ts: string): string => line({ type: 'session', version: 3, id, timestamp: ts, cwd: project })
  const message = (role: string, text: string, timestamp: number): string =>
    line({ type: 'message', id: `m${timestamp}`, parentId: null, timestamp: new Date(timestamp).toISOString(), message: { role, content: [{ type: 'text', text }], timestamp } })
  writeFileSync(
    join(dir, 'a.jsonl'),
    [header('A', '2026-09-01T00:00:00Z'), message('user', 'fix the login bug', 1_788_000_000_000), message('assistant', 'done', 1_788_000_100_000), line({ type: 'session_info', id: 'i', parentId: null, timestamp: '', name: 'Login fix' })].join('\n')
  )
  writeFileSync(join(dir, 'b.jsonl'), [header('B', '2026-09-02T00:00:00Z'), message('user', 'newer one', 1_789_000_000_000)].join('\n'))
  writeFileSync(join(dir, 'empty.jsonl'), header('C', '2026-09-03T00:00:00Z'))
  writeFileSync(join(dir, 'junk.jsonl'), 'not json\n')

  const sessions = await listSessions(project, { dir: null, configDir: '.eaon', appName: 'eaon-code' }, { env: { EAON_CODE_CODING_AGENT_DIR: agentDir } })
  assert.deepEqual(sessions.map((s) => s.id), ['B', 'A'], 'newest first; empty and non-session files skipped')
  assert.equal(sessions[1].name, 'Login fix')
  assert.equal(sessions[1].firstMessage, 'fix the login bug')
  assert.equal(sessions[1].messageCount, 2)
  assert.equal(summariseSession('x', 'garbage', 0), null)
})

test('transcript: streams thinking, text and a tool call by contentIndex, then settles', () => {
  const update = (assistantMessageEvent: Record<string, unknown>): EaonEvent => ({ type: 'message_update', assistantMessageEvent })
  let t = applyEvents(emptyTranscript(), [
    { type: 'agent_start' },
    { type: 'message_start', message: { role: 'user', content: 'edit it' } },
    { type: 'message_start', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Pl' }] } },
    update({ type: 'thinking_start', contentIndex: 0 }),
    update({ type: 'thinking_delta', contentIndex: 0, delta: 'Plan' }),
    update({ type: 'text_start', contentIndex: 1 }),
    update({ type: 'text_delta', contentIndex: 1, delta: 'Editing ' }),
    update({ type: 'toolcall_start', contentIndex: 2, id: 'call1', toolName: 'edit' }),
    update({ type: 'toolcall_delta', contentIndex: 2, delta: '{"path":"src/a.ts","ed' })
  ])
  assert.equal(t.running, true)
  const assistant = t.items[1]
  assert.equal(assistant.kind, 'assistant')
  if (assistant.kind !== 'assistant') return
  assert.deepEqual(assistant.blocks[0], { kind: 'thinking', text: 'Plan' }, 'thinking_start resets the pre-filled part')
  assert.deepEqual(assistant.blocks[1], { kind: 'text', text: 'Editing ' })
  assert.equal(t.tools.call1.status, 'preparing')
  assert.equal(peekArgument(t.tools.call1.argsText), 'src/a.ts')

  const before = t
  t = applyEvents(t, [
    update({ type: 'text_delta', contentIndex: 1, delta: 'now' }),
    update({ type: 'toolcall_end', contentIndex: 2, toolCall: { id: 'call1', name: 'edit', arguments: { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }] } } }),
    { type: 'tool_execution_start', toolCallId: 'call1', toolName: 'edit', args: { path: 'src/a.ts' } },
    { type: 'tool_execution_end', toolCallId: 'call1', toolName: 'edit', result: { content: [{ type: 'text', text: 'Successfully replaced 1 block(s)' }] }, isError: false }
  ])
  assert.equal(before.items[0], t.items[0], 'untouched items keep their identity')
  assert.equal(t.tools.call1.status, 'done')
  assert.match(t.tools.call1.output, /Successfully/)

  t = applyEvents(t, [
    {
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'thinking', thinking: 'Plan' }, { type: 'text', text: 'Editing now' }, { type: 'toolCall', id: 'call1', name: 'edit', arguments: { path: 'src/a.ts' } }] }
    },
    { type: 'queue_update', steering: ['also rename it'], followUp: [] },
    { type: 'agent_settled' }
  ])
  const done = t.items[1]
  assert.equal(done.kind === 'assistant' && done.streaming, false)
  assert.equal(done.kind === 'assistant' && (done.blocks[1] as { text: string }).text, 'Editing now')
  assert.equal(t.running, false)
  assert.deepEqual(t.queue.steering, ['also rename it'])
})

test('transcript: retries, compaction, extension UI and errors become notices, dialogs and statuses', () => {
  const t = applyEvents(emptyTranscript(), [
    { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '529 overloaded' },
    { type: 'auto_retry_end', success: true, attempt: 2 },
    { type: 'compaction_start', reason: 'threshold' },
    { type: 'compaction_end', reason: 'threshold', result: { summary: 'S', tokensBefore: 150000, estimatedTokensAfter: 32000 }, aborted: false, willRetry: false },
    { type: 'extension_ui_request', id: 'd1', method: 'confirm', title: 'Allow?', message: 'rm -rf build' },
    { type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'Blocked', notifyType: 'warning' },
    { type: 'extension_ui_request', id: 's1', method: 'setStatus', statusKey: 'swarm', statusText: '\u001b[33mswarm 1/2 · scout\u001b[0m' },
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'No API key for anthropic' } }
  ])
  const notices = t.items.filter((i) => i.kind === 'notice')
  assert.equal(notices.length, 3, 'retry start/end share one notice; compaction likewise')
  assert.match((notices[0] as { text: string }).text, /Recovered after 2 attempts/)
  assert.match((notices[1] as { text: string }).text, /150k → ~32k/)
  assert.deepEqual(t.dialogs.map((d) => d.id), ['d1'])
  assert.equal(t.statuses.swarm, 'swarm 1/2 · scout', 'ANSI styling is stripped')
  const failed = t.items[t.items.length - 1]
  assert.equal(failed.kind === 'assistant' && failed.error, 'No API key for anthropic')
})

test('transcript: rebuilds a resumed session from get_messages', () => {
  const t = transcriptFromMessages([
    { role: 'user', content: 'list files' },
    { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }], stopReason: 'toolUse' },
    { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'a.ts\nb.ts' }], isError: false },
    { role: 'bashExecution', command: 'git status', output: 'clean', exitCode: 0, cancelled: false, truncated: false },
    { role: 'compactionSummary', summary: 'Earlier work', tokensBefore: 12000 },
    { role: 'assistant', content: [{ type: 'text', text: 'Two files.' }], stopReason: 'stop' }
  ])
  assert.deepEqual(t.items.map((i) => i.kind), ['user', 'assistant', 'bash', 'notice', 'assistant'])
  assert.equal(t.tools.c1.status, 'done')
  assert.equal(t.tools.c1.output, 'a.ts\nb.ts')
  assert.equal(t.running, false)
})

test('transcript: a bash delta after the command finished is dropped, not appended', () => {
  let t = emptyTranscript()
  t = { ...t, items: [{ kind: 'bash', id: 'bash-1', command: 'ls', output: '', running: true }] }
  t = applyEvents(t, [{ type: 'bash_execution_update', id: 'bash-1', delta: 'a\n' }])
  assert.equal(t.items[0].kind === 'bash' && t.items[0].output, 'a\n')
  t = { ...t, items: [{ ...(t.items[0] as Extract<(typeof t.items)[number], { kind: 'bash' }>), running: false, output: 'a\nb\n' }] }
  t = applyEvents(t, [{ type: 'bash_execution_update', id: 'bash-1', delta: 'b\n' }])
  assert.equal(t.items[0].kind === 'bash' && t.items[0].output, 'a\nb\n')
})

test('terminal and install helpers', () => {
  assert.equal(shellQuote("it's here"), `'it'\\''s here'`)
  assert.match(explainInstallFailure('npm error code EACCES\nnpm error syscall mkdir', 243), /permission denied/)
  assert.match(explainInstallFailure('npm error code ENOTFOUND', 1), /registry/)
  assert.match(explainInstallFailure('weird\nfailure', 7), /code 7: weird failure/)
})
