import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachJsonlReader } from '../src/main/features/eaonCode/jsonl'
import { createEventBatcher, slimEvent } from '../src/main/features/eaonCode/batch'
import { EaonCodeBridge } from '../src/main/features/eaonCode/bridge'
import { buildChildEnv } from '../src/main/features/eaonCode/env'
import { agentDirFor, detectEaonCode, findInstallerCopy, parseVersion, spawnSpec, versionAtLeast } from '../src/main/features/eaonCode/locate'
import { defaultSessionDir, listSessions, summariseSession } from '../src/main/features/eaonCode/sessions'
import { cmdKeepOpenArgs, launchDetached, openInTerminal, shellQuote } from '../src/main/features/eaonCode/terminal'
import { explainInstallFailure, installEaonCode } from '../src/main/features/eaonCode/install'
import { agentOfArgs, setAgentScript } from '../src/main/features/terminals/agentSessions'
import {
  applyEvents,
  emptyTranscript,
  interruptTranscript,
  peekArgument,
  transcriptFromMessages
} from '../src/renderer/src/components/code/transcript'
import type { EaonCodeStatus, EaonCommand, EaonEvent, EaonProcessInfo } from '@shared/eaonCode'

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

test('jsonl: a long record split over many chunks costs linear time, and CR before a chunk boundary is stripped', async () => {
  // A resumed session's get_messages arrives as one huge line in 64KB reads.
  const big = JSON.stringify({ type: 'response', data: { messages: 'x'.repeat(24 * 1024 * 1024) } })
  const bytes = Buffer.from(`{"n":1}\r\n${big}\n{"n":2}\r`)
  const frame = async (chunkSize: number): Promise<{ lines: string[]; ms: number }> => {
    const stream = new PassThrough()
    const lines: string[] = []
    attachJsonlReader(stream, (line) => lines.push(line))
    const started = performance.now()
    for (let i = 0; i < bytes.length; i += chunkSize) stream.write(bytes.subarray(i, i + chunkSize))
    stream.end('\n')
    await new Promise((resolve) => stream.once('end', resolve))
    return { lines, ms: performance.now() - started }
  }
  const whole = await frame(bytes.length)
  const chunked = await frame(65_536)
  assert.equal(chunked.lines.length, 3)
  assert.equal(chunked.lines[1].length, big.length)
  assert.deepEqual(JSON.parse(chunked.lines[2]), { n: 2 }, 'the CR before the final LF is stripped across chunks')
  // Rescanning the whole buffer per chunk took ~0.65s here against ~5ms for
  // the same bytes in one piece; searching only the new chunk keeps them level.
  assert.ok(chunked.ms < whole.ms * 4 + 100, `24MB in 64KB chunks took ${Math.round(chunked.ms)}ms, in one chunk ${Math.round(whole.ms)}ms`)
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

test('terminal: on Windows the line cmd /k runs keeps every part quoted', () => {
  // /s strips exactly the outer pair, so "C:\Program Files\…" stays whole;
  // without it cmd stripped the first and last quote and ran C:\Program.
  assert.deepEqual(cmdKeepOpenArgs('Eaon Code', ['C:\\Program Files\\nodejs\\node.exe', 'C:\\x\\cli.js', '--session', 'C:\\s dir\\a.jsonl']), [
    '/c',
    'start',
    '"Eaon Code"',
    'cmd.exe',
    '/s',
    '/k',
    '""C:\\Program Files\\nodejs\\node.exe" "C:\\x\\cli.js" "--session" "C:\\s dir\\a.jsonl""'
  ])
  // The cmd running `start` reads the parts unquoted, so its metacharacters are escaped for it.
  assert.equal(cmdKeepOpenArgs('A "b" & c', ['C:\\Users\\Tom & Jerry\\x.cmd']).slice(2).join(' '), '"A b  c" cmd.exe /s /k ""C:\\Users\\Tom ^& Jerry\\x.cmd""')
})

test('terminal: a folder that is gone is reported, not thrown', async () => {
  const gone = join(mkdtempSync(join(tmpdir(), 'eaon-term-')), 'missing')
  assert.deepEqual(await openInTerminal(gone, { command: 'eaon-code', args: [] }), { ok: false, error: `The folder ${gone} does not exist.` })
  assert.match((await launchDetached('/definitely/not/a/terminal', [])) ?? '', /ENOENT/)
})

test('locate: a Windows .cmd shim runs through cmd.exe with its path quoted', () => {
  // Node joins a shell command line unquoted, so C:\Program Files\nodejs\npm.cmd
  // — npm's default home — would otherwise run "C:\Program".
  const npm = spawnSpec('C:\\Program Files\\nodejs\\npm.cmd', ['install', '-g', '--ignore-scripts', '@eaonlabs/eaon-code'], 'win32')
  assert.deepEqual(npm, {
    command: '"C:\\Program Files\\nodejs\\npm.cmd"',
    args: ['install', '-g', '--ignore-scripts', '@eaonlabs/eaon-code'],
    shell: true
  })
  const shim = spawnSpec('C:\\Users\\Jo Ann\\AppData\\Roaming\\npm\\eaon-code.CMD', ['--session', 'C:\\s dir\\a "b".jsonl'], 'win32')
  assert.equal(shim.command, '"C:\\Users\\Jo Ann\\AppData\\Roaming\\npm\\eaon-code.CMD"')
  assert.deepEqual(shim.args, ['--session', '"C:\\s dir\\a ""b"".jsonl"'])
  assert.deepEqual(spawnSpec('C:\\node\\node.exe', ['--version'], 'win32'), { command: 'C:\\node\\node.exe', args: ['--version'], shell: false })
  assert.deepEqual(spawnSpec('/usr/local/bin/eaon-code', ['--mode', 'rpc'], 'darwin'), {
    command: '/usr/local/bin/eaon-code',
    args: ['--mode', 'rpc'],
    shell: false
  })
})

/**
 * A stand-in `eaon-code --mode rpc`: answers the start-up queries, holds a
 * `prompt` unanswered until `abort` (as a preflight compaction would), and
 * dies when asked to prompt "crash".
 */
function fakeEaonCode(): { binary: string; cwd: string } {
  const dir = mkdtempSync(join(tmpdir(), 'eaon-code-fake-'))
  const binary = join(dir, 'eaon-code')
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const ok = (command, data) => send({ id: command.id, type: 'response', command: command.type, success: true, data })
const state = { model: null, thinkingLevel: 'off', isStreaming: false, isCompacting: false, sessionId: 's1', messageCount: 0, pendingMessageCount: 0 }
let held = null
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\\n')) !== -1) {
    const command = JSON.parse(buffer.slice(0, newline))
    buffer = buffer.slice(newline + 1)
    if (command.type === 'get_state') ok(command, state)
    else if (command.type === 'get_available_models') ok(command, { models: [] })
    else if (command.type === 'get_available_thinking_levels') ok(command, { levels: ['off'] })
    else if (command.type === 'get_commands') ok(command, { commands: [] })
    else if (command.type === 'get_session_stats') ok(command, { sessionId: 's1', userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 })
    else if (command.type === 'prompt' && command.message === 'crash') { process.stderr.write('fatal: out of memory\\n'); process.exit(3) }
    else if (command.type === 'prompt') { held = command; send({ type: 'compaction_start', reason: 'threshold' }) }
    else if (command.type === 'abort') { if (held) ok(held); held = null; ok(command) }
    else send({ id: command.id, type: 'response', command: command.type, success: false, error: 'unknown' })
  }
})
process.stdin.on('end', () => process.exit(0))
`
  )
  chmodSync(binary, 0o755)
  return { binary, cwd: dir }
}

function fakeBridge(binary: string, processes: EaonProcessInfo[] = [], probes = { count: 0 }): EaonCodeBridge {
  const status: EaonCodeStatus = {
    state: 'ready',
    binaryPath: binary,
    launch: { command: binary, args: [] },
    source: 'setting',
    version: '1.0.1',
    node: { path: null, version: null, ok: true },
    nodeRequirement: '>=22.19.0'
  }
  return new EaonCodeBridge({
    getSettings: () => ({ binaryPath: binary, shareKeys: false }),
    getKey: () => undefined,
    onEvents: () => {},
    onProcess: (info) => processes.push(info),
    detect: async () => {
      probes.count++
      return status
    }
  })
}

test('bridge: after a start fails, the next start looks for the binary again', async () => {
  const { cwd } = fakeEaonCode()
  const probes = { count: 0 }
  // Detected once, then removed — an npm or nvm update moves it.
  const bridge = fakeBridge(join(cwd, 'gone', 'eaon-code'), [], probes)
  await assert.rejects(bridge.start(cwd), /ENOENT|exited/)
  assert.equal(probes.count, 1)
  await assert.rejects(bridge.start(cwd))
  assert.equal(probes.count, 2, 'a cached "ready" would fail the same way on every retry')
})

test('bridge: a prompt held in preflight past two minutes is not reported as failed', async (t) => {
  const { binary, cwd } = fakeEaonCode()
  const bridge = fakeBridge(binary)
  await bridge.start(cwd)
  const realSetTimeout = setTimeout
  const wait = (ms: number): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, ms))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    let outcome: string | null = null
    const prompt = bridge.command({ type: 'prompt', message: 'refactor it' }).then(
      () => (outcome = 'accepted'),
      (error: Error) => (outcome = error.message)
    )
    await wait(100)
    // A preflight compaction on a slow model can take this long and more.
    t.mock.timers.tick(10 * 60_000)
    await wait(20)
    assert.equal(outcome, null, 'still waiting, not timed out')
    await bridge.command({ type: 'abort' })
    await prompt
    assert.equal(outcome, 'accepted')
  } finally {
    t.mock.timers.reset()
    await bridge.stop()
  }
})

test('bridge: a prompt with no time limit still fails, and the crash is reported, when the process dies', async () => {
  const { binary, cwd } = fakeEaonCode()
  const processes: EaonProcessInfo[] = []
  const bridge = fakeBridge(binary, processes)
  await bridge.start(cwd)
  try {
    // The allowlist is the map's own keys, not everything `in` would find on it.
    await assert.rejects(bridge.command({ type: 'constructor' } as unknown as EaonCommand), /Unsupported command/)
    await assert.rejects(bridge.command({ type: 'prompt', message: 'crash' }), /exited with code 3/)
    const last = processes[processes.length - 1]
    assert.equal(last.state, 'exited')
    assert.equal(last.crashed, true)
    assert.equal(last.exitCode, 3)
    await assert.rejects(bridge.command({ type: 'get_state' }), /No Eaon Code session is running/)
  } finally {
    await bridge.stop()
  }
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

test('sessions: a file whose size and mtime have not moved is not parsed again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eaon-code-sessions-cache-'))
  const project = join(root, 'project')
  mkdirSync(project)
  const agentDir = join(root, 'agent')
  const dir = defaultSessionDir(agentDir, project)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'a.jsonl')
  const write = (prompt: string): void =>
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'A', timestamp: '2026-09-01T00:00:00Z', cwd: project }),
        JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: prompt }], timestamp: 1_788_000_000_000 } })
      ].join('\n')
    )
  const list = (): Promise<string[]> =>
    listSessions(project, { dir: null, configDir: '.eaon', appName: 'eaon-code' }, { env: { EAON_CODE_CODING_AGENT_DIR: agentDir } }).then(
      (sessions) => sessions.map((s) => s.firstMessage)
    )

  write('first prompt')
  // A whole-second mtime, so setting it again below reproduces it exactly.
  const mtime = new Date(Math.floor(statSync(file).mtimeMs / 1000) * 1000)
  utimesSync(file, mtime, mtime)
  assert.deepEqual(await list(), ['first prompt'])
  // Same size, same mtime: only a re-parse could see the new text.
  write('other prompt')
  utimesSync(file, mtime, mtime)
  assert.deepEqual(await list(), ['first prompt'], 'served from the cache')
  // Eaon Code appends, which moves both; the list follows.
  utimesSync(file, mtime, new Date(mtime.getTime() + 5000))
  assert.deepEqual(await list(), ['other prompt'])
  assert.match(readFileSync(file, 'utf8'), /other prompt/)
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
  ], 1_000)
  const notices = t.items.filter((i) => i.kind === 'notice')
  assert.equal(notices.length, 3, 'retry start/end share one notice; compaction likewise')
  assert.match((notices[0] as { text: string }).text, /Recovered after 2 attempts/)
  assert.match((notices[1] as { text: string }).text, /150k → ~32k/)
  assert.deepEqual(t.dialogs.map((d) => d.id), ['d1'])
  assert.equal(t.dialogs[0].receivedAt, 1_000, "a dialog's timeout counts from its arrival, not from when it is shown")
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

test('transcript: a process that dies mid-turn leaves nothing spinning', () => {
  const update = (assistantMessageEvent: Record<string, unknown>): EaonEvent => ({ type: 'message_update', assistantMessageEvent })
  let t = applyEvents(emptyTranscript(), [
    { type: 'agent_start' },
    { type: 'message_start', message: { role: 'user', content: 'run the tests' } },
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    update({ type: 'text_start', contentIndex: 0 }),
    update({ type: 'text_delta', contentIndex: 0, delta: 'Running them.' }),
    update({ type: 'toolcall_start', contentIndex: 1, id: 'call1', toolName: 'bash' }),
    update({ type: 'toolcall_start', contentIndex: 2, id: 'call2', toolName: 'read' }),
    { type: 'tool_execution_start', toolCallId: 'call1', toolName: 'bash', args: { command: 'npm test' } },
    { type: 'tool_execution_update', toolCallId: 'call1', partialResult: { content: [{ type: 'text', text: '3 passing' }] } },
    { type: 'compaction_start', reason: 'threshold' },
    { type: 'queue_update', steering: ['and lint'], followUp: [] },
    { type: 'extension_ui_request', id: 'd1', method: 'confirm', title: 'Allow?', message: 'rm -rf build' },
    { type: 'extension_ui_request', id: 's1', method: 'setStatus', statusKey: 'swarm', statusText: 'swarm 1/2' }
  ])
  t = { ...t, items: [...t.items, { kind: 'bash', id: 'bash-1', command: 'ls', output: '', running: true }] }
  const userItem = t.items[0]

  const after = interruptTranscript(t)
  assert.equal(after.running, false)
  assert.equal(after.compacting, false)
  assert.equal(after.currentAssistant, null)
  const assistant = after.items[1]
  assert.equal(assistant.kind === 'assistant' && assistant.streaming, false)
  assert.equal(after.tools.call1.status, 'error')
  assert.equal(after.tools.call1.output, '3 passing\n\nInterrupted', 'partial output is kept')
  assert.equal(after.tools.call2.status, 'error')
  assert.equal(after.tools.call2.output, 'Interrupted')
  const compaction = after.items.find((item) => item.kind === 'notice')
  assert.equal(compaction?.kind === 'notice' && compaction.pending, false)
  const bash = after.items.find((item) => item.kind === 'bash')
  assert.equal(bash?.kind === 'bash' && bash.running, false)
  assert.deepEqual(after.dialogs, [], "a dead process's dialog cannot be answered")
  assert.deepEqual(after.queue, { steering: [], followUp: [] })
  assert.deepEqual(after.statuses, {})
  assert.equal(after.items[0], userItem, 'finished items keep their identity')
  assert.equal(t.tools.call1.status, 'running', 'the input is not mutated')

  const settled = applyEvents(emptyTranscript(), [{ type: 'agent_start' }, { type: 'agent_settled' }])
  assert.equal(interruptTranscript(settled), settled, 'nothing live: same object, no re-render')
})

test('terminal and install helpers', () => {
  assert.equal(shellQuote("it's here"), `'it'\\''s here'`)
  assert.match(explainInstallFailure('npm error code EACCES\nnpm error syscall mkdir', 243), /permission denied/)
  assert.match(explainInstallFailure('npm error code ENOTFOUND', 1), /registry/)
  assert.match(explainInstallFailure("fatal: unable to access 'https://github.com/eaonlabs/eaon-code/'", 128), /reach GitHub/)
  assert.match(explainInstallFailure('weird\nfailure', 7), /code 7: weird failure/)
  // install.sh's own checks end in `eaon-code: <reason>`, which is the answer.
  assert.equal(
    explainInstallFailure('Installing Eaon Code…\neaon-code: /x contains local changes. Move them first.\n', 1),
    '/x contains local changes. Move them first.'
  )
})

/**
 * A stand-in for Eaon Code's install.sh: it lays out what the real one
 * leaves behind (a checkout with the built CLI, and the marker written last)
 * in $EAON_CODE_PREFIX.
 */
const FAKE_INSTALLER = `#!/usr/bin/env bash
set -euo pipefail
PREFIX="$EAON_CODE_PREFIX"
echo "Installing Eaon Code…"
mkdir -p "$PREFIX/.git" "$PREFIX/packages/coding-agent/dist/bundle"
echo '{"name":"@eaonlabs/eaon-code","eaonConfig":{"name":"eaon-code","configDir":".eaon"}}' > "$PREFIX/packages/coding-agent/package.json"
echo 'console.log("1.0.9")' > "$PREFIX/packages/coding-agent/dist/bundle/cli.js"
echo "Building Eaon Code…"
echo '{"kind":"eaon-code-source-install","schemaVersion":1,"repo":"eaonlabs/eaon-code","ref":"main","binDir":"x","installedCommit":"abc"}' > "$PREFIX/.git/eaon-code-install.json"
echo "Eaon Code installed."
`

test('install: runs the installer script, then finds its copy and launches it with Node, not through PATH', async () => {
  const prefix = join(mkdtempSync(join(tmpdir(), 'eaon-code-prefix-')), 'eaon-code')
  const env = { ...process.env, EAON_CODE_PREFIX: prefix }
  assert.equal(findInstallerCopy(env), null, 'nothing there yet')

  const lines: string[] = []
  const first = installEaonCode((line) => lines.push(line), { env, fetchScript: async () => FAKE_INSTALLER })
  // A second click (or a second window) joins the run instead of building the same folder twice.
  const second = installEaonCode(() => {}, { env, fetchScript: async () => 'exit 9' })
  assert.equal(first, second)
  const outcome = await first
  assert.deepEqual(outcome, { ok: true, message: 'Eaon Code is installed.' })
  assert.ok(lines.includes('Building Eaon Code…'), 'the installer output streams line by line')

  const copy = findInstallerCopy(env)
  assert.ok(copy)
  const status = await detectEaonCode(null, env)
  assert.equal(status.state, 'ready')
  assert.equal(status.source, 'installer')
  assert.equal(status.binaryPath, copy.cli)
  assert.deepEqual(status.launch?.args, [copy.cli])
  assert.match(status.launch?.command ?? '', /node(\.exe)?$/)
  assert.equal(status.installDir, prefix)
  assert.ok(status.updatedAt && Date.now() - status.updatedAt < 60_000)
})

test('install: a failing installer reports its own reason', async () => {
  const prefix = join(mkdtempSync(join(tmpdir(), 'eaon-code-prefix-')), 'eaon-code')
  const outcome = await installEaonCode(() => {}, {
    env: { ...process.env, EAON_CODE_PREFIX: prefix },
    fetchScript: async () => 'echo "eaon-code: Node.js >= 22.19 is required (found v20.1.0)." >&2; exit 1'
  })
  assert.deepEqual(outcome, { ok: false, message: 'Node.js >= 22.19 is required (found v20.1.0).' })
  const unreachable = await installEaonCode(() => {}, {
    env: { ...process.env, EAON_CODE_PREFIX: prefix },
    fetchScript: async () => {
      throw new Error('fetch failed')
    }
  })
  assert.equal(unreachable.ok, false)
  assert.match(unreachable.message, /Could not download Eaon Code's installer: fetch failed/)
})

test("locate: a half-made checkout (no marker, or no built CLI) isn't an install", () => {
  const prefix = mkdtempSync(join(tmpdir(), 'eaon-code-half-'))
  const env = { ...process.env, EAON_CODE_PREFIX: prefix }
  mkdirSync(join(prefix, '.git'), { recursive: true })
  writeFileSync(join(prefix, '.git', 'eaon-code-install.json'), '{"kind":"eaon-code-source-install"}')
  assert.equal(findInstallerCopy(env), null, 'marker without the CLI')
  mkdirSync(join(prefix, 'packages/coding-agent/dist/bundle'), { recursive: true })
  writeFileSync(join(prefix, 'packages/coding-agent/dist/bundle/cli.js'), '')
  assert.ok(findInstallerCopy(env))
  writeFileSync(join(prefix, '.git', 'eaon-code-install.json'), '{"kind":"something-else"}')
  assert.equal(findInstallerCopy(env), null, 'a marker that is not the installer\'s')
})

test("terminals: the installer's cli.js is known by its whole path, not by the name `cli`", () => {
  const cli = '/Users/me/.local/share/eaon-code/packages/coding-agent/dist/bundle/cli.js'
  assert.equal(agentOfArgs(`node ${cli} --session 0b4d`), null)
  setAgentScript(cli, 'eaon-code')
  try {
    assert.equal(agentOfArgs(`node ${cli} --session 0b4d`), 'eaon-code')
    assert.equal(agentOfArgs(`/opt/homebrew/bin/node ${cli}`), 'eaon-code')
    assert.equal(agentOfArgs('node /somewhere/else/dist/cli.js'), null, "a different tool's cli.js")
  } finally {
    setAgentScript(null, 'eaon-code')
  }
})
