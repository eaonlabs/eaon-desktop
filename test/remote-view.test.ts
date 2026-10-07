import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { spawn as Spawn } from 'node:child_process'
import type { NetworkInterfaceInfo } from 'node:os'
import type { ChatMessage, ChatToolPart } from '@shared/types'
import { workerMood, type Worker, type WorkerMail } from '@shared/workers'
import { remotePairingLink } from '@shared/remote'
import { Bonjour, bonjourArgs, instanceName } from '../src/main/remote/bonjour'
import { lanAddresses } from '../src/main/remote'
import {
  EventTranslator,
  StreamScrub,
  nextWakeAt,
  pathScrubber,
  remoteMessage,
  remoteThreadPage,
  remoteToolPart,
  remoteWorker,
  toolDetail,
  toolTitle
} from '../src/main/remote/view'

/**
 * What a phone is shown, as pure conversions: the scrub that keeps the Mac’s
 * paths home, the tool steps, messages and workers, paging, the translation of
 * the engine’s events, and the small helpers around them (pairing link,
 * addresses, the Bonjour command).
 */

const FOLDER = '/Users/sam/Eaon/Workers/Nova'
const HOME = '/Users/sam'

function worker(extra: Partial<Worker> = {}): Worker {
  return {
    id: 'w1',
    name: 'Nova',
    color: '#3E86C6',
    personality: 'Calm.',
    purpose: 'Research',
    createdAt: 1000,
    createdBy: null,
    model: null,
    folder: FOLDER,
    paused: false,
    access: 'autonomous',
    trading: null,
    heartbeat: { nextAt: null, everyMs: null, note: '' },
    routines: [],
    goal: '',
    notes: 'private notes',
    goalRun: null,
    asks: [],
    status: 'idle',
    activity: '',
    moodHint: null,
    lastRunAt: null,
    lastOutcome: null,
    lastError: null,
    inbox: [{ id: 'm', from: 'x', fromName: 'X', text: 'secret mail', files: ['/Users/sam/secret.pdf'], at: 1 }],
    handoffs: [],
    unread: 0,
    runningMessageId: null,
    ...extra
  }
}

const scrub = pathScrubber(FOLDER, HOME)

/* ------------------------------------------------------------------- scrub */

test('the scrub turns the worker’s folder into "." and the home directory into "~"', () => {
  assert.equal(scrub(`cat ${FOLDER}/notes.md ${HOME}/Documents/a.txt`), 'cat ./notes.md ~/Documents/a.txt')
  assert.equal(scrub(`${FOLDER}`), '.')
  assert.equal(scrub('nothing to hide'), 'nothing to hide')
  assert.equal(scrub(`${FOLDER}/a and ${FOLDER}/b`), './a and ./b', 'every occurrence')
  assert.equal(scrub('a.b*c'), 'a.b*c', 'path characters are taken literally, not as a pattern')
  assert.equal(pathScrubber('/Users/sam/a.b+c(d)', HOME)('/Users/sam/a.b+c(d)/x'), './x')
  assert.equal(pathScrubber('C:\\Users\\sam\\Eaon\\Nova', 'C:\\Users\\sam')('C:\\Users\\sam\\Eaon\\Nova\\a.md and C:/Users/sam/Eaon/Nova/b.md'), '.\\a.md and ./b.md', 'both spellings on Windows')
  assert.equal(pathScrubber('/', '/')('/etc/hosts'), '/etc/hosts', 'a root is never blanked')
  assert.equal(pathScrubber('', '')('anything'), 'anything')
})

test('a stream scrub holds back only what could still become a path', () => {
  const stream = new StreamScrub(scrub)
  assert.equal(stream.push('Plain text, out at once. '), 'Plain text, out at once. ')
  assert.equal(stream.push('saved to /Users/sam/Eaon/Wor'), 'saved to ', 'a tail that looks like the start of the folder waits')
  assert.equal(stream.push('kers/No'), '')
  assert.equal(stream.push('va/a.md, then /Users/sa'), './a.md, then ')
  assert.equal(stream.flush(), '/Users/sa', 'and is let out when nothing follows')
  assert.equal(stream.flush(), '')

  const whole = new StreamScrub(scrub)
  const pieces = ['/', 'Users', '/sam', '/Eaon/Workers/Nova', '/x']
  assert.equal(pieces.map((p) => whole.push(p)).join('') + whole.flush(), './x', 'five pieces, one folder')
})

/* ------------------------------------------------------------------- tools */

test('a tool step has a title a person can read and one line of what it touched', () => {
  assert.equal(toolTitle('run_command'), 'Ran a command')
  assert.equal(toolTitle('read_file'), 'Read a file')
  assert.equal(toolTitle('web_search'), 'Searched the web')
  assert.equal(toolTitle('github__create_issue'), 'Used github create issue')
  assert.equal(toolTitle(''), 'Used a tool')
  assert.ok(toolTitle('x'.repeat(200)).length <= 60)

  const id = (s: string): string => s
  assert.equal(toolDetail('run_command', { command: 'npm test' }, id), 'npm test')
  assert.equal(toolDetail('read_file', { path: '/a/b.txt' }, id), '/a/b.txt')
  assert.equal(toolDetail('web_fetch', { url: 'https://example.com' }, id), 'https://example.com')
  assert.equal(toolDetail('web_search', { query: 'tidal power' }, id), 'tidal power')
  assert.equal(toolDetail('move_file', { from: 'a', to: 'b' }, id), 'a → b')
  assert.equal(toolDetail('grep', { pattern: 'TODO', path: 'src' }, id), 'TODO')
  assert.equal(toolDetail('run_command', { command: 'echo\n  one\ttwo' }, id), 'echo one two', 'one line')
  assert.equal(toolDetail('run_command', {}, id), '')
  assert.equal(toolDetail('run_command', undefined, id), '')
  const long = toolDetail('run_command', { command: 'z'.repeat(500) }, id)
  assert.equal(long.length, 120)
  assert.ok(long.endsWith('…'))
  assert.equal(toolDetail('web_browser', { action: 'type', text: 'hunter2', url: 'https://bank.example' }, id), 'type https://bank.example', 'what was typed stays out')
  assert.equal(toolDetail('email_send', { to: 'a@b.c', body: 'the whole letter' }, id), 'a@b.c')
  assert.equal(toolDetail('read_file', { path: `${FOLDER}/a.md` }, scrub), './a.md')
})

test('a tool part carries its status and at most 800 characters of output', () => {
  const part = (extra: Partial<ChatToolPart>): Pick<ChatToolPart, 'id' | 'name' | 'input' | 'status' | 'output'> => ({ id: 't', name: 'run_command', input: { command: 'ls' }, status: 'done', output: 'a.txt', ...extra })
  assert.deepEqual(remoteToolPart(part({}), scrub), { kind: 'tool', id: 't', name: 'run_command', title: 'Ran a command', detail: 'ls', status: 'done', output: 'a.txt' })
  assert.deepEqual(remoteToolPart(part({ status: 'running', output: null }), scrub), { kind: 'tool', id: 't', name: 'run_command', title: 'Ran a command', detail: 'ls', status: 'running' })
  assert.equal('output' in remoteToolPart(part({ output: '  \n' }), scrub), false, 'nothing to show is not shown')
  const output = remoteToolPart(part({ output: 'o'.repeat(5000) }), scrub).output!
  assert.equal(output.length, 800)
  assert.ok(output.endsWith('…'))
  assert.equal(remoteToolPart(part({ output: `at ${FOLDER}/x.ts:3` }), scrub).output, 'at ./x.ts:3')
  for (const status of ['denied', 'error'] as const) assert.equal(remoteToolPart(part({ status }), scrub).status, status)
  assert.ok(!('input' in remoteToolPart(part({}), scrub)), 'the call’s arguments are not sent')
})

/* ---------------------------------------------------------------- messages */

const view = (message: ChatMessage, extra: { runningMessageId?: string | null; heartbeat?: string } = {}) => remoteMessage(message, { scrub, runningMessageId: extra.runningMessageId ?? null, heartbeat: extra.heartbeat })

const mail = (extra: Partial<WorkerMail> = {}): WorkerMail => ({ id: 'm', from: 'user', fromName: 'You', text: 'hello', files: [], at: 1, ...extra })

test('an assistant turn keeps text and tool steps in order, drops reasoning, and scrubs what it says', () => {
  const message: ChatMessage = {
    id: 'a1',
    role: 'assistant',
    createdAt: 5,
    error: `could not write ${FOLDER}/x`,
    parts: [
      { type: 'reasoning', text: 'private thoughts' },
      { type: 'text', text: `Looking in ${FOLDER}. ` },
      { type: 'text', text: '' },
      { type: 'tool', id: 't1', name: 'list_dir', input: { path: FOLDER }, output: null, status: 'running', progress: 'live output' },
      { type: 'reasoning', text: 'more' },
      { type: 'text', text: 'Done.' }
    ]
  }
  assert.deepEqual(view(message, { runningMessageId: 'a1', heartbeat: 'Morning' }), {
    id: 'a1',
    role: 'assistant',
    at: 5,
    parts: [
      { kind: 'text', text: 'Looking in .. ' },
      { kind: 'tool', id: 't1', name: 'list_dir', title: 'Looked in a folder', detail: '.', status: 'running' },
      { kind: 'text', text: 'Done.' }
    ],
    error: 'could not write ./x',
    heartbeat: 'Morning',
    streaming: true
  })
  assert.equal(view(message)!.streaming, false)
  assert.equal('heartbeat' in view(message)!, false)
  assert.equal(view({ ...message, parts: [], error: undefined })!.parts.length, 0)
})

test('a user turn is its mail: the words, who from, and never a path', () => {
  const one = view({ id: 'u', role: 'user', createdAt: 2, parts: [{ type: 'text', text: '[Mon, Oct 5, 3:12 PM]\n[From the user] hello' }], mail: [mail()] })
  assert.deepEqual(one, { id: 'u', role: 'user', at: 2, parts: [{ kind: 'text', text: 'hello' }], streaming: false })

  const several = view({
    id: 'u',
    role: 'user',
    createdAt: 2,
    parts: [{ type: 'text', text: 'what the model reads' }],
    mail: [
      mail({ text: 'first' }),
      mail({ id: 'm2', from: 'atlas', fromName: 'Atlas', fromColor: '#8E5CE6', text: `see ${FOLDER}/r.md`, files: ['/Users/sam/Eaon/Workers/Atlas/r.md'] }),
      mail({ id: 'm3', from: 'atlas', fromName: 'Atlas', text: '', files: ['/a', '/b'] }),
      mail({ id: 'm4', text: '', files: [] }),
      mail({ id: 'm5', text: 'last' })
    ]
  })!
  assert.deepEqual(several.parts, [{ kind: 'text', text: 'first\n\nAtlas: see ./r.md\n\nAtlas: [2 files attached]\n\nlast' }], 'one text part, blank lines between, colleagues named')
  assert.deepEqual(several.from, { name: 'Atlas', color: '#8E5CE6' })
  assert.ok(!JSON.stringify(several).includes('/Users/sam'))

  const files = view({ id: 'u', role: 'user', createdAt: 2, parts: [], mail: [mail({ text: ' ', files: ['/x'] })], attachments: ['/x'] })!
  assert.deepEqual(files.parts, [{ kind: 'text', text: '[1 file attached]' }])
  assert.equal('from' in files, false)
  assert.equal('attachments' in files, false)

  const guest = view({ id: 'u', role: 'user', createdAt: 2, parts: [], mail: [mail({ from: 'guest', fromName: 'Sam on Discord', text: 'hi' })] })!
  assert.deepEqual(guest.from, { name: 'Sam on Discord' })
})

test('a turn without mail shows no message of its own, and an older plain one shows its text', () => {
  assert.equal(view({ id: 'u', role: 'user', createdAt: 1, parts: [{ type: 'text', text: '[Heartbeat] check' }], heartbeat: 'check' }), null)
  assert.equal(view({ id: 'u', role: 'user', createdAt: 1, parts: [{ type: 'text', text: '[Check-in]' }], heartbeat: '' }), null)
  assert.equal(view({ id: 's', role: 'system', createdAt: 1, parts: [{ type: 'text', text: 'x' }] }), null)
  assert.deepEqual(view({ id: 'u', role: 'user', createdAt: 1, parts: [{ type: 'text', text: `from ${FOLDER}` }] })!.parts, [{ kind: 'text', text: 'from .' }])
})

/* ---------------------------------------------------------------- the thread */

function thread(): ChatMessage[] {
  const user = (id: string, text: string, at: number): ChatMessage => ({ id, role: 'user', createdAt: at, parts: [{ type: 'text', text: `[time]\n[From the user] ${text}` }], mail: [mail({ id: `m-${id}`, text })] })
  const marker = (id: string, note: string, at: number): ChatMessage => ({ id, role: 'user', createdAt: at, parts: [{ type: 'text', text: `[time]\n[Heartbeat] ${note}` }], heartbeat: note })
  const reply = (id: string, text: string, at: number): ChatMessage => ({ id, role: 'assistant', createdAt: at, parts: [{ type: 'text', text }] })
  return [user('u1', 'one', 1), reply('a1', 'r1', 2), marker('k1', 'Morning check', 3), reply('a2', 'r2', 4), { id: 'sys', role: 'system', createdAt: 5, parts: [] }, user('u2', 'two', 6), reply('a3', 'r3', 7)]
}

test('a thread is paged over what the phone is shown, with a scheduled turn’s note on its reply', () => {
  const messages = thread()
  const page = (limit: number, before: string | null = null) => remoteThreadPage(messages, { limit, before, scrub, runningMessageId: 'a3' })!
  const everything = page(100)
  assert.deepEqual(everything.messages.map((m) => m.id), ['u1', 'a1', 'a2', 'u2', 'a3'])
  assert.equal(everything.hasMore, false)
  assert.deepEqual(everything.messages.map((m) => m.heartbeat), [undefined, undefined, 'Morning check', undefined, undefined])
  assert.deepEqual(everything.messages.map((m) => m.streaming), [false, false, false, false, true])

  assert.deepEqual([page(2).messages.map((m) => m.id), page(2).hasMore], [['u2', 'a3'], true])
  assert.deepEqual([page(2, 'u2').messages.map((m) => m.id), page(2, 'u2').hasMore], [['a1', 'a2'], true])
  assert.deepEqual([page(2, 'a1').messages.map((m) => m.id), page(2, 'a1').hasMore], [['u1'], false])
  assert.deepEqual([page(5).hasMore, page(4).hasMore], [false, true], 'hasMore is about what is shown, not what is stored')
  assert.deepEqual(page(3, 'a2').messages.map((m) => m.id), ['u1', 'a1'], 'a hidden message before the page is not a reason for more')
  assert.equal(page(3, 'a2').hasMore, false)
  assert.deepEqual(page(5, 'u1'), { messages: [], hasMore: false })
  assert.equal(remoteThreadPage(messages, { limit: 5, before: 'nope', scrub, runningMessageId: null }), null)
  assert.deepEqual(remoteThreadPage([], { limit: 5, before: null, scrub, runningMessageId: null }), { messages: [], hasMore: false })
})

/* ----------------------------------------------------------------- workers */

test('a worker is cut down to its contract, scrubbed, with a mood and the next wake-up', () => {
  const now = 1_000_000
  const w = worker({
    purpose: `Work in ${FOLDER}`,
    model: { providerId: 'fake', modelId: 'big' },
    activity: `Editing ${FOLDER}/a.md`,
    goal: 'Ship it',
    goalRun: { text: 'Ship it', status: 'active', iterations: 2, startedAt: 1, turns: 3, nextAt: now + 5000, summary: `Notes in ${FOLDER}` },
    asks: [{ id: 'k', question: `Delete ${FOLDER}/old?`, options: ['Yes'], approve: { tool: 'run_command', input: { command: 'rm -rf x', secret: 's3cret' }, summary: `Remove ${FOLDER}/old` }, at: 7 }],
    routines: [{ id: 'r', name: 'Morning', task: 'News', everyMs: null, daily: '08:30', nextAt: now + 9000, runs: [{ at: 1, ok: true }] }],
    heartbeat: { nextAt: now + 20_000, everyMs: null, note: 'later' },
    lastError: `failed in ${FOLDER}`,
    lastOutcome: { at: now - 1000, ok: true },
    unread: 2
  })
  const out = remoteWorker(w, { now, modelLabel: () => 'Big One', scrub })
  assert.deepEqual(Object.keys(out).sort(), [
    'access', 'activity', 'asks', 'color', 'createdAt', 'goal', 'goalRun', 'id', 'lastError', 'lastOutcome', 'lastRunAt', 'model', 'mood', 'name', 'nextWakeAt', 'paused', 'personality', 'purpose', 'routines', 'runningMessageId', 'status', 'unread'
  ])
  assert.equal(out.mood, workerMood(w, now))
  assert.equal(out.mood, 'curious', 'a question waiting on the user')
  assert.equal(out.nextWakeAt, now + 5000, 'the goal’s continuation is the soonest')
  assert.deepEqual(out.model, { providerId: 'fake', modelId: 'big', label: 'Big One' })
  assert.deepEqual(out.goalRun, { text: 'Ship it', status: 'active', turns: 3, summary: 'Notes in .' })
  assert.deepEqual(out.asks, [{ id: 'k', question: 'Delete ./old?', options: ['Yes'], approve: { tool: 'run_command', summary: 'Remove ./old' }, at: 7 }])
  assert.deepEqual(out.routines, [{ id: 'r', name: 'Morning', task: 'News', everyMs: null, daily: '08:30', nextAt: now + 9000 }])
  assert.equal(out.activity, 'Editing ./a.md')
  assert.equal(out.lastError, 'failed in .')
  assert.equal(out.purpose, `Work in ${FOLDER}`, 'what the user wrote is theirs, and is sent as it is')
  const text = JSON.stringify({ ...out, purpose: '' })
  for (const leak of ['private notes', 'secret mail', 'secret.pdf', 's3cret', 'rm -rf', 'iterations', 'startedAt', '"runs"', FOLDER]) assert.ok(!text.includes(leak), leak)
  assert.equal(remoteWorker(worker({ model: { providerId: 'p', modelId: 'm' } }), { scrub }).model!.label, 'm', 'the model id when nobody knows its name')
  assert.equal(remoteWorker(worker(), { scrub }).goalRun, null)
})

test('the next wake-up is the soonest of the heartbeat, the routines and an active goal, and none for a paused worker', () => {
  const routine = (nextAt: number) => ({ id: `r${nextAt}`, name: 'n', task: 't', everyMs: 60_000, daily: null, nextAt, runs: [] })
  assert.equal(nextWakeAt(worker()), null)
  assert.equal(nextWakeAt(worker({ heartbeat: { nextAt: 500, everyMs: null, note: '' } })), 500)
  assert.equal(nextWakeAt(worker({ heartbeat: { nextAt: 500, everyMs: null, note: '' }, routines: [routine(300), routine(900)] })), 300)
  assert.equal(nextWakeAt(worker({ routines: [routine(900)], goalRun: { text: 'g', status: 'active', iterations: 0, startedAt: 0, turns: 1, nextAt: 100 } })), 100)
  assert.equal(nextWakeAt(worker({ routines: [routine(900)], goalRun: { text: 'g', status: 'paused', iterations: 0, startedAt: 0, turns: 1, nextAt: 100 } })), 900, 'a paused goal does not continue')
  assert.equal(nextWakeAt(worker({ routines: [routine(900)], goalRun: { text: 'g', status: 'active', iterations: 0, startedAt: 0, turns: 1, nextAt: null } })), 900)
  assert.equal(nextWakeAt(worker({ paused: true, heartbeat: { nextAt: 500, everyMs: null, note: '' } })), null)
})

/* ------------------------------------------------------------------ events */

test('events: the opening message of a scheduled turn is folded into its reply, start and end', () => {
  let running: string | null = 'a1'
  const t = new EventTranslator({ list: () => [worker({ runningMessageId: running })], home: HOME })
  assert.equal(t.message('w1', { id: 'k1', role: 'user', createdAt: 1, parts: [], heartbeat: 'Morning check' }), null)
  const start = t.message('w1', { id: 'a1', role: 'assistant', createdAt: 2, parts: [] })!
  assert.deepEqual(start, { event: 'message', data: { workerId: 'w1', message: { id: 'a1', role: 'assistant', at: 2, parts: [], heartbeat: 'Morning check', streaming: true } } })
  running = null
  const end = t.message('w1', { id: 'a1', role: 'assistant', createdAt: 2, parts: [{ type: 'text', text: 'Done' }] })!
  assert.equal((end.data as { message: { heartbeat?: string; streaming: boolean } }).message.heartbeat, 'Morning check', 'the same reply, whole, still carries it')
  assert.equal((end.data as { message: { streaming: boolean } }).message.streaming, false)

  // The next turn's mail must not inherit the last turn's note.
  running = 'a2'
  const user = t.message('w1', { id: 'u2', role: 'user', createdAt: 3, parts: [], mail: [mail()] })!
  assert.equal((user.data as { message: { role: string } }).message.role, 'user')
  const next = t.message('w1', { id: 'a2', role: 'assistant', createdAt: 4, parts: [] })!
  assert.equal('heartbeat' in (next.data as { message: object }).message, false)
})

test('events: text is merged and scrubbed across pieces, a tool result keeps its call’s title, and the rest is left out', () => {
  const t = new EventTranslator({ list: () => [worker({ runningMessageId: 'a1' })], home: HOME })
  const text = (events: ReturnType<EventTranslator['stream']>): string => events.map((e) => (e.event === 'delta' ? e.data.text : `<${e.event}>`)).join('')

  assert.equal(text(t.stream('w1', { type: 'delta', messageId: 'a1', text: 'Opening ' })), 'Opening ')
  assert.equal(text(t.stream('w1', { type: 'delta', messageId: 'a1', text: `${FOLDER.slice(0, 15)}` })), '')
  assert.equal(text(t.stream('w1', { type: 'delta', messageId: 'a1', text: `${FOLDER.slice(15)}/a.md ` })), './a.md ')
  assert.equal(text(t.stream('w1', { type: 'delta', messageId: 'a1', text: `then ${HOME.slice(0, 6)}` })), 'then ')

  // A tool call lets the held text out first, and lands after it.
  const call = t.stream('w1', { type: 'tool-call', messageId: 'a1', toolId: 'c1', name: 'read_file', input: { path: `${FOLDER}/a.md` } })
  assert.deepEqual(call.map((e) => e.event), ['delta', 'tool'])
  assert.deepEqual(call[0], { event: 'delta', data: { workerId: 'w1', messageId: 'a1', text: HOME.slice(0, 6) } })
  assert.deepEqual(call[1], { event: 'tool', data: { workerId: 'w1', messageId: 'a1', part: { kind: 'tool', id: 'c1', name: 'read_file', title: 'Read a file', detail: './a.md', status: 'running' } } })
  const result = t.stream('w1', { type: 'tool-result', messageId: 'a1', toolId: 'c1', output: 'contents', status: 'done' })
  assert.deepEqual(result, [{ event: 'tool', data: { workerId: 'w1', messageId: 'a1', part: { kind: 'tool', id: 'c1', name: 'read_file', title: 'Read a file', detail: './a.md', status: 'done', output: 'contents' } } }])

  for (const event of [
    { type: 'reasoning', messageId: 'a1', text: 'thinking' },
    { type: 'tool-progress', messageId: 'a1', toolId: 'c1', output: 'live' },
    { type: 'usage', messageId: 'a1', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
    { type: 'todos', messageId: 'a1', todos: [] }
  ] as const) {
    assert.deepEqual(t.stream('w1', event), [], event.type)
  }
  assert.deepEqual(t.stream('w1', { type: 'done', messageId: 'a1' }), [], 'nothing held at the end')
  assert.deepEqual(t.stream('w1', { type: 'tool-result', messageId: 'a1', toolId: 'unknown', output: 'x', status: 'done' }), [], 'a result with no call to name it is skipped')
})

test('events: a result whose call was never seen is named from the thread, and a list becomes a workers event', () => {
  const call: ChatToolPart = { type: 'tool', id: 'c9', name: 'web_search', input: { query: 'tides' }, output: null, status: 'running' }
  const t = new EventTranslator({ list: () => [worker()], findTool: (_w, _m, toolId) => (toolId === 'c9' ? call : undefined), home: HOME, now: () => 5 })
  const [out] = t.stream('w1', { type: 'tool-result', messageId: 'a1', toolId: 'c9', output: 'found', status: 'done' })
  assert.deepEqual((out.data as { part: object }).part, { kind: 'tool', id: 'c9', name: 'web_search', title: 'Searched the web', detail: 'tides', status: 'done', output: 'found' })
  const list = t.workers([worker({ model: { providerId: 'p', modelId: 'm' } })])
  assert.equal(list.event, 'workers')
  assert.equal((list.data as { workers: { id: string; model: { label: string } }[] }).workers[0].model.label, 'm')
})

/* ------------------------------------------------------------ little helpers */

test('the pairing link carries version, host, port, key and name, percent-encoded', () => {
  const link = remotePairingLink({ host: '192.168.1.20', port: 3266, key: 'eaonr-a_b-c', name: 'Sam’s MacBook Pro & more' })
  assert.equal(link, 'eaon://pair?v=1&host=192.168.1.20&port=3266&key=eaonr-a_b-c&name=Sam%E2%80%99s%20MacBook%20Pro%20%26%20more')
  const parsed = new URL(link)
  assert.equal(parsed.searchParams.get('name'), 'Sam’s MacBook Pro & more')
  assert.equal(new URL(remotePairingLink({ host: 'h.local', port: 1, key: 'a b&c=d', name: 'x' })).searchParams.get('key'), 'a b&c=d')
})

test('addresses: non-internal IPv4 only, home and office ranges first, no link-local', () => {
  const nic = (address: string, extra: Partial<NetworkInterfaceInfo> = {}): NetworkInterfaceInfo =>
    ({ address, netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null, ...extra }) as NetworkInterfaceInfo
  const found = lanAddresses({
    lo0: [nic('127.0.0.1', { internal: true })],
    utun3: [nic('100.101.102.103'), nic('fe80::1', { family: 'IPv6' } as Partial<NetworkInterfaceInfo>)],
    en0: [nic('192.168.1.20'), nic('fd00::5', { family: 'IPv6' } as Partial<NetworkInterfaceInfo>)],
    en1: [nic('169.254.9.9'), nic('10.0.0.7'), nic('192.168.1.20')],
    en2: [nic('172.20.1.1'), nic('172.32.1.1')],
    gone: undefined
  })
  assert.deepEqual(found, ['192.168.1.20', '10.0.0.7', '172.20.1.1', '100.101.102.103', '172.32.1.1'])
  assert.deepEqual(lanAddresses({}), [])
})

test('the Bonjour announcement: the instance name fits, the TXT record has version, host and port, never the key', () => {
  assert.equal(instanceName('Sam’s MacBook Pro'), 'Eaon (Sam’s MacBook Pro)')
  assert.equal(instanceName('  '), 'Eaon (Mac)')
  const long = instanceName('M'.repeat(100))
  assert.ok(Buffer.byteLength(long) <= 63)
  assert.ok(long.startsWith('Eaon (M') && long.endsWith(')'))
  assert.ok(Buffer.byteLength(instanceName('é'.repeat(100))) <= 63, 'bytes, not characters')
  assert.deepEqual(bonjourArgs({ computerName: 'Sam’s Mac', hostName: 'Sams-Mac', port: 3266 }), ['-R', 'Eaon (Sam’s Mac)', '_eaon._tcp', 'local', '3266', 'v=1', 'host=Sams-Mac.local', 'port=3266'])
  assert.equal(bonjourArgs({ computerName: 'x', hostName: 'Sams-Mac.local', port: 1 })[6], 'host=Sams-Mac.local', '".local" is not doubled')
  assert.equal(bonjourArgs({ computerName: 'x', hostName: 'Sams-Mac.local.', port: 1 })[6], 'host=Sams-Mac.local')
})

test('Bonjour does nothing off macOS, and on macOS runs dns-sd, restarts it for a new address and kills it on stop', () => {
  const started: { cmd: string; args: string[]; killed: boolean; child: EventEmitter }[] = []
  const spawn = ((cmd: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      kill: () => {
        record.killed = true
        return true
      }
    })
    const record = { cmd, args, killed: false, child }
    started.push(record)
    return child
  }) as unknown as typeof Spawn
  const advert = { computerName: 'Sam’s Mac', hostName: 'Sams-Mac', port: 3266 }

  for (const platform of ['linux', 'win32'] as const) {
    const quiet = new Bonjour({ platform, spawn })
    quiet.start(advert)
    quiet.stop()
    assert.equal(quiet.running, false)
  }
  assert.equal(started.length, 0)

  const bonjour = new Bonjour({ platform: 'darwin', spawn })
  bonjour.start(advert)
  assert.equal(bonjour.running, true)
  assert.equal(started[0].cmd, 'dns-sd')
  bonjour.start(advert)
  assert.equal(started.length, 1, 'the same announcement is not repeated')
  bonjour.start({ ...advert, port: 4000 })
  assert.equal(started.length, 2)
  assert.equal(started[0].killed, true, 'the old one is ended first')
  bonjour.stop()
  assert.equal(started[1].killed, true)
  assert.equal(bonjour.running, false)
  bonjour.stop()

  // A missing binary, a child that dies: silent, and not "running" any more.
  bonjour.start(advert)
  started[2].child.emit('error', new Error('spawn dns-sd ENOENT'))
  assert.equal(bonjour.running, false)
  bonjour.start(advert)
  started[3].child.emit('exit', 1)
  assert.equal(bonjour.running, false)

  const throwing = new Bonjour({
    platform: 'darwin',
    spawn: (() => {
      throw new Error('no such thing')
    }) as unknown as typeof Spawn
  })
  assert.doesNotThrow(() => throwing.start(advert))
  assert.equal(throwing.running, false)
})
