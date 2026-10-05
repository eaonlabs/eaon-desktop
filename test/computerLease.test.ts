import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { systemPreferences } from 'electron'
import { leaseOwnerName, type ComputerLeaseOwner, type ComputerLeaseState } from '@shared/computerUse'
import { ComputerLease, ownerLabel, REVOKED_TEXT } from '../src/main/features/computer/lease'
import { LinuxInput } from '../src/main/features/computer/linux'
import type { BackendCheck, InputBackend } from '../src/main/features/computer/input'

/**
 * The host-computer lease: one real pointer and keyboard, one run at a time.
 * The coordinator is tested with an injected clock and set of live runs; the
 * tool is tested with a recording input backend (never the real pointer).
 */

const nova: ComputerLeaseOwner = { kind: 'worker', id: 'w-nova', name: 'Nova', runId: 'run-nova' }
const ava: ComputerLeaseOwner = { kind: 'worker', id: 'w-ava', name: 'Ava', runId: 'run-ava' }
const chat: ComputerLeaseOwner = { kind: 'chat', id: 'c1', name: 'Trip planning', runId: 'run-chat' }
const task: ComputerLeaseOwner = { kind: 'scheduled', id: 't1', name: 'Daily report', runId: 'run-task' }

function lease(options: { running?: Set<string>; now?: () => number; idleMs?: number; waitMs?: number } = {}) {
  const running = options.running ?? new Set([nova.runId, ava.runId, chat.runId, task.runId])
  return {
    running,
    lease: new ComputerLease({ isRunning: (id) => running.has(id), now: options.now, idleMs: options.idleMs, waitMs: options.waitMs ?? 200, sweepMs: 20 })
  }
}

test('the first run to act gets the computer and keeps it for its whole run, however many steps', async () => {
  const { lease: l } = lease()
  assert.deepEqual(await l.acquire(nova), { ok: true, waited: false })
  assert.deepEqual(await l.acquire(nova), { ok: true, waited: false }, 'asking again is free')
  assert.equal(l.holds(nova.runId), true)
  assert.equal(l.state().holder?.name, 'Nova')
  l.dispose()
})

test('a second run waits (visibly) and gets the computer the moment the first run ends', async () => {
  const { lease: l, running } = lease()
  const seen: ComputerLeaseState[] = []
  l.onChange((s) => seen.push(s))
  await l.acquire(nova)
  let announced: ComputerLeaseOwner | null = null
  const waiting = l.acquire(ava, { onWait: (holder) => (announced = holder) })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(announced!.name, 'Nova', 'the waiter is told who has it, for "Waiting for the computer — Nova is using it"')
  assert.deepEqual(
    l.state().waiting.map((w) => w.name),
    ['Ava'],
    'and the app can show it'
  )
  running.delete(nova.runId) // Nova's turn ended (or crashed)
  assert.deepEqual(await waiting, { ok: true, waited: true })
  assert.equal(l.state().holder?.name, 'Ava')
  assert.equal(l.state().waiting.length, 0)
  assert.ok(seen.some((s) => s.waiting.length === 1), 'a change was pushed for the wait')
  l.dispose()
})

test('waiting is bounded: after waitMs the run is told who still has it and what to do meanwhile', async () => {
  const { lease: l } = lease({ waitMs: 60 })
  await l.acquire(nova)
  const result = await l.acquire(ava)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, 'timeout')
    assert.match(result.text, /Waited 0 s for the computer, but Nova \(a worker\) is still using it/)
    assert.match(result.text, /one mouse and keyboard.*web_browser/s)
  }
  assert.equal(l.state().waiting.length, 0, 'it is no longer in the queue')
  l.dispose()
})

test('a run that asks not to wait is refused at once with a reason the model understands', async () => {
  const { lease: l } = lease()
  await l.acquire(chat)
  const result = await l.acquire(task, { wait: false })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, 'busy')
    assert.match(result.text, /^The chat “Trip planning” is using the computer right now\. There is one mouse and keyboard/)
  }
  l.dispose()
})

test('a waiting run that is stopped leaves the queue at once', async () => {
  const { lease: l } = lease({ waitMs: 5000 })
  await l.acquire(nova)
  const stop = new AbortController()
  const waiting = l.acquire(ava, { signal: stop.signal })
  await new Promise((r) => setTimeout(r, 10))
  stop.abort()
  const result = await waiting
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.reason, 'aborted')
  assert.equal(l.state().waiting.length, 0)
  assert.equal(l.holds(nova.runId), true, 'the holder is untouched')
  l.dispose()
})

test('a holder that is stopped lets go at once, and the next in line goes', async () => {
  const { lease: l } = lease({ waitMs: 5000 })
  const stopNova = new AbortController()
  await l.acquire(nova, { signal: stopNova.signal })
  const waiting = l.acquire(ava)
  await new Promise((r) => setTimeout(r, 10))
  stopNova.abort()
  assert.deepEqual(await waiting, { ok: true, waited: true })
  assert.equal(l.holds(ava.runId), true)
  l.dispose()
})

test('a run already stopped when it asks gets "Stopped", not a place in the queue', async () => {
  const { lease: l } = lease()
  const stop = new AbortController()
  stop.abort()
  const result = await l.acquire(nova, { signal: stop.signal })
  assert.equal(!result.ok && result.reason, 'aborted')
  assert.equal(l.state().holder, null)
  l.dispose()
})

test('a crashed run (gone from the running set without ever stopping) frees the computer at the next look', async () => {
  const { lease: l, running } = lease({ waitMs: 5000 })
  await l.acquire(nova)
  running.delete(nova.runId)
  assert.deepEqual(await l.acquire(ava), { ok: true, waited: false })
  l.dispose()
})

test('a holder idle for too long lets go, so one slow model does not lock everyone out', async () => {
  let now = 1_000
  const { lease: l } = lease({ now: () => now, idleMs: 90_000 })
  await l.acquire(nova)
  now += 60_000
  const early = await l.acquire(ava, { wait: false })
  assert.equal(early.ok, false, 'busy at 60 s')
  now += 31_000
  assert.deepEqual(await l.acquire(ava, { wait: false }), { ok: true, waited: false })
  // Activity keeps it: touching resets the idle clock.
  now += 80_000
  l.touch(ava)
  now += 80_000
  assert.equal((await l.acquire(nova, { wait: false })).ok, false)
  l.dispose()
})

test('the user can take back control at once: holder and waiters are off the computer for the rest of their runs', async () => {
  const { lease: l, running } = lease({ waitMs: 5000 })
  await l.acquire(nova)
  const waiting = l.acquire(ava)
  await new Promise((r) => setTimeout(r, 10))
  const refused = l.revoke()
  assert.deepEqual(
    refused.map((o) => o.name),
    ['Nova', 'Ava']
  )
  const result = await waiting
  assert.equal(!result.ok && result.reason, 'revoked')
  assert.equal(!result.ok && result.text, REVOKED_TEXT)
  assert.equal(l.state().holder, null)
  assert.equal(l.isRevoked(nova.runId), true)
  const again = await l.acquire(nova)
  assert.equal(again.ok, false, 'asking again in the same run is refused')
  assert.equal(!again.ok && again.reason, 'revoked')
  // A run that was not involved can have it.
  assert.deepEqual(await l.acquire(chat), { ok: true, waited: false })
  // The next turn of the same worker is a new run and is not held to the old refusal.
  running.delete(nova.runId)
  l.sweep()
  assert.equal(l.isRevoked(nova.runId), false)
  l.dispose()
})

test('revoking with nobody on the computer is harmless', () => {
  const { lease: l } = lease()
  assert.deepEqual(l.revoke(), [])
  l.dispose()
})

test('a run learns that someone else acted on the screen after its last screenshot', async () => {
  let now = 1_000
  const { lease: l, running } = lease({ now: () => now })
  await l.acquire(nova)
  now = 2_000
  l.touch(nova)
  assert.equal(l.actedSince(1_500, ava)?.name, 'Nova', 'Ava looked at 1.5 s; Nova acted at 2 s')
  assert.equal(l.actedSince(2_500, ava), null, 'a screenshot after that is fresh')
  assert.equal(l.actedSince(1_500, nova), null, 'your own actions are not news')
  assert.equal(l.actedSince(1_500, { ...nova, runId: 'next-turn' }), null, 'nor are your own earlier turn\'s')
  void running
  l.dispose()
})

test('labels: a worker by name, a chat or task by its title', () => {
  assert.equal(ownerLabel(nova), 'Nova (a worker)')
  assert.equal(ownerLabel({ kind: 'worker', name: ' ' }), 'a worker')
  assert.equal(ownerLabel(chat), 'the chat “Trip planning”')
  assert.equal(ownerLabel(task), 'the scheduled task “Daily report”')
  assert.equal(leaseOwnerName(nova), 'Nova')
  assert.equal(leaseOwnerName(chat), 'Chat “Trip planning”')
  assert.equal(leaseOwnerName({ kind: 'chat', name: '' }), 'Eaon')
  assert.equal(leaseOwnerName({ kind: 'worker', name: 'A very long worker name that goes on and on' }), 'A very long worker name tha…')
})

/* ------------------------------------------------- the tool, with a fake pointer */

type Sent = string[]

function recordingBackend(sent: Sent, check: Partial<BackendCheck> = {}): InputBackend {
  return {
    name: 'recording',
    check: async () => ({ available: true, trusted: true, locked: false, ...check }),
    move: async () => void sent.push('move'),
    click: async (p, button) => void sent.push(`click ${Math.round(p.x)},${Math.round(p.y)} ${button}`),
    drag: async () => void sent.push('drag'),
    scroll: async () => void sent.push('scroll'),
    type: async (text) => void sent.push(`type ${text.length}`),
    key: async () => void sent.push('key'),
    cursor: async () => ({ x: 5, y: 5 }),
    frontmost: async () => null,
    activate: async () => {},
    locked: async () => false,
    openApp: async (name) => void sent.push(`open ${name}`),
    dispose: () => {}
  }
}

async function toolWith(running: Set<string>, backend: InputBackend, waitMs = 100) {
  const { store, defaultSettings } = await import('../src/main/store')
  const { setInputBackend } = await import('../src/main/features/computer/backend')
  const tool = await import('../src/main/features/computer/tool')
  tool.setComputerLease(new ComputerLease({ isRunning: (id) => running.has(id), waitMs, sweepMs: 20 }))
  tool.resetComputerState()
  setInputBackend(backend)
  store.patchSettings({ approvalMode: 'auto', computerUse: { ...defaultSettings.computerUse, enabled: true, confirmEachAction: false } })
  const ctx = (owner: ComputerLeaseOwner, signal = new AbortController().signal, progress: (text: string) => void = () => undefined) =>
    ({
      request: {
        chatId: owner.kind === 'worker' ? `chat-${owner.id}` : owner.id,
        chatTitle: owner.name,
        messageId: owner.runId,
        ...(owner.kind === 'worker' ? { workerId: owner.id, persona: `You are ${owner.name}, one of the user's Eaon Workers: an independent agent.` } : {}),
        history: owner.kind === 'scheduled' ? [{ id: 'm', role: 'user', parts: [], createdAt: 0, scheduledTaskId: owner.id }] : []
      },
      signal,
      progress,
      confirm: async () => true,
      cwd: '/tmp'
    }) as never
  const done = async (): Promise<void> => {
    const { setInputBackend: reset } = await import('../src/main/features/computer/backend')
    reset(null)
    store.patchSettings({ computerUse: { ...defaultSettings.computerUse } })
    tool.setComputerLease(new ComputerLease())
  }
  return { ...tool, ctx, done }
}

const click = { action: 'click', x: 10, y: 10, screenshot: false }
const text = (result: unknown): string => (typeof result === 'string' ? result : (result as { text: string }).text)
const failed = (result: unknown): boolean => (result as { isError?: boolean }).isError === true

test('the tool: one run at a time on the pointer; the second waits, says so, then goes when the first run ends', async () => {
  const sent: Sent = []
  const running = new Set([nova.runId, ava.runId])
  const t = await toolWith(running, recordingBackend(sent), 2000)
  try {
    const first = await t.computerTool.run(click, t.ctx(nova))
    assert.equal(failed(first), false)
    const progress: string[] = []
    const second = Promise.resolve(t.computerTool.run({ ...click, x: 20 }, t.ctx(ava, undefined, (p) => progress.push(p))))
    await new Promise((r) => setTimeout(r, 40))
    assert.deepEqual(progress, ['Waiting for the computer — Nova (a worker) is using it.'])
    assert.deepEqual(sent, ['click 11,11 left'], 'Ava has not touched the pointer')
    running.delete(nova.runId)
    assert.equal(failed(await second), false)
    assert.deepEqual(sent, ['click 11,11 left', 'click 23,11 left'])
  } finally {
    await t.done()
  }
})

test('the tool: a run that waits too long gets a structured refusal, and nothing is sent', async () => {
  const sent: Sent = []
  const running = new Set([nova.runId, task.runId])
  const t = await toolWith(running, recordingBackend(sent), 60)
  try {
    await t.computerTool.run(click, t.ctx(nova))
    const refused = await t.computerTool.run(click, t.ctx(task))
    assert.equal(failed(refused), true)
    assert.match(text(refused), /Nova \(a worker\) is still using it.*web_browser/s)
    assert.deepEqual(sent, ['click 11,11 left'])
  } finally {
    await t.done()
  }
})

test('the tool: taking back control stops the holder\'s next action, and says why', async () => {
  const sent: Sent = []
  const running = new Set([nova.runId])
  const t = await toolWith(running, recordingBackend(sent))
  try {
    await t.computerTool.run(click, t.ctx(nova))
    t.computerLease.revoke()
    const after = await t.computerTool.run(click, t.ctx(nova))
    assert.equal(failed(after), true)
    assert.equal(text(after), REVOKED_TEXT)
    assert.deepEqual(sent, ['click 11,11 left'], 'only the click before the user took control')
    // Looking is refused too: the user wants the computer, not an agent watching it.
    assert.equal(failed(await t.computerTool.run({ action: 'screenshot' }, t.ctx(nova))), true)
  } finally {
    await t.done()
  }
})

test('the tool: control taken back partway through a long text stops it between slices', async () => {
  const sent: Sent = []
  const running = new Set([nova.runId])
  const backend = recordingBackend(sent)
  const original = backend.type.bind(backend)
  let slices = 0
  backend.type = async (value) => {
    await original(value)
    if (++slices === 1) t.computerLease.revoke()
  }
  const t = await toolWith(running, backend)
  try {
    const result = await Promise.resolve(t.computerTool.run({ action: 'type', text: 'a'.repeat(300), screenshot: false }, t.ctx(nova))).catch((e: Error) => e)
    assert.match(String((result as Error).message ?? text(result)), /took back control/)
    assert.equal(sent.filter((s) => s.startsWith('type')).length, 1, 'only the first 120 characters were typed')
  } finally {
    await t.done()
  }
})

test('the tool: workers, chats and scheduled tasks are told apart for the lease', async () => {
  const { leaseOwnerOf, setLeaseNames } = await import('../src/main/features/computer/tool')
  const base = { chatId: 'c', chatTitle: 'Title', messageId: 'm', history: [] }
  assert.deepEqual(leaseOwnerOf({ ...base, workerId: 'w1', persona: "You are Nova, one of the user's Eaon Workers: x" } as never), { kind: 'worker', id: 'w1', name: 'Nova', runId: 'm' })
  setLeaseNames((id) => (id === 'w1' ? 'Nova Prime' : null))
  assert.equal(leaseOwnerOf({ ...base, workerId: 'w1' } as never).name, 'Nova Prime')
  setLeaseNames(() => null)
  assert.deepEqual(leaseOwnerOf({ ...base, history: [{ id: 'x', role: 'user', parts: [], createdAt: 0, scheduledTaskId: 'job-9' }] } as never), { kind: 'scheduled', id: 'job-9', name: 'Title', runId: 'm' })
  assert.deepEqual(leaseOwnerOf(base as never), { kind: 'chat', id: 'c', name: 'Title', runId: 'm' })
})

/* -------------------------------------------------------------- fail closed */

test('fail closed: each missing requirement is a specific error and no input is sent', async () => {
  const { inputBlocker } = await import('../src/main/features/computer/tool')
  const owner = async (): Promise<string> => 'Eaon'
  const granted = (): string => 'granted'
  assert.equal(await inputBlocker({ available: true, trusted: true, locked: false }, 'darwin', granted, owner), null)
  assert.match((await inputBlocker({ available: false, detail: 'xdotool is not installed.' }, 'linux', granted, owner))!, /^Input is unavailable on this computer: xdotool is not installed\./)
  const noAx = (await inputBlocker({ available: true, trusted: false }, 'darwin', granted, owner))!
  assert.match(noAx, /Accessibility is off for Eaon.*Settings → Computer use.*older copy of Eaon/s)
  assert.match((await inputBlocker({ available: true, trusted: true, locked: true }, 'darwin', granted, owner))!, /screen is locked.*Nothing was done/)
  assert.match((await inputBlocker({ available: true, trusted: true, asleep: true }, 'darwin', granted, owner))!, /display is asleep.*Nothing was done/)
  for (const status of ['denied', 'restricted', 'not-determined']) {
    const blocked = (await inputBlocker({ available: true, trusted: true }, 'darwin', () => status, owner))!
    assert.match(blocked, /Screen Recording is (off|not set up) for Eaon.*clicking blind.*Nothing was done/s, status)
  }
  // The screen can't be told (an API failure): the screenshot itself will say.
  assert.equal(await inputBlocker({ available: true, trusted: true }, 'darwin', () => 'unknown', owner), null)
  // Other platforms have no such gate.
  assert.equal(await inputBlocker({ available: true }, 'win32', () => 'denied', owner), null)
})

test('fail closed: through the tool, a revoked Accessibility or Screen Recording grant sends nothing, even mid-run', async () => {
  const sent: Sent = []
  const check: Partial<BackendCheck> = {}
  const running = new Set([nova.runId])
  const t = await toolWith(running, recordingBackend(sent, check))
  const original = systemPreferences.getMediaAccessStatus
  try {
    assert.equal(failed(await t.computerTool.run(click, t.ctx(nova))), false)
    // The user switches Accessibility off while the run is going.
    check.trusted = false
    const revokedAx = await t.computerTool.run(click, t.ctx(nova))
    assert.equal(failed(revokedAx), true)
    assert.match(text(revokedAx), /Accessibility is off/)
    check.trusted = true
    // Screen Recording revoked.
    ;(systemPreferences as { getMediaAccessStatus: () => string }).getMediaAccessStatus = () => 'denied'
    const revokedScreen = await t.computerTool.run(click, t.ctx(nova))
    if (process.platform === 'darwin') {
      assert.equal(failed(revokedScreen), true)
      assert.match(text(revokedScreen), /Screen Recording is off/)
    }
    ;(systemPreferences as { getMediaAccessStatus: () => string }).getMediaAccessStatus = original
    // Locked, then asleep.
    check.locked = true
    assert.match(text(await t.computerTool.run({ action: 'key', keys: 'Return' }, t.ctx(nova))), /screen is locked/)
    check.locked = false
    check.asleep = true
    assert.match(text(await t.computerTool.run({ action: 'scroll', dy: 3 }, t.ctx(nova))), /display is asleep/)
    assert.equal(sent.length, process.platform === 'darwin' ? 1 : 2, 'one click before the revocations (two where Screen Recording is not a gate)')
  } finally {
    ;(systemPreferences as { getMediaAccessStatus: () => string }).getMediaAccessStatus = original
    await t.done()
  }
})

test('fail closed: a locked screen or sleeping display also refuses a screenshot, which would only show that', async () => {
  const sent: Sent = []
  const check: Partial<BackendCheck> = { locked: true }
  const t = await toolWith(new Set([nova.runId]), recordingBackend(sent, check))
  try {
    assert.match(text(await t.computerTool.run({ action: 'screenshot' }, t.ctx(nova))), /lock screen/)
    check.locked = false
    check.asleep = true
    assert.match(text(await t.computerTool.run({ action: 'screenshot' }, t.ctx(nova))), /display is asleep/)
  } finally {
    await t.done()
  }
})

test('seeing is not control: with only Screen Recording, a screenshot is allowed to be tried while a click is refused', async () => {
  const sent: Sent = []
  const t = await toolWith(new Set([nova.runId]), recordingBackend(sent, { trusted: false }))
  try {
    assert.equal(failed(await t.computerTool.run(click, t.ctx(nova))), true)
    assert.deepEqual(sent, [])
    // And the lease was never taken: a refused click does not hold the computer.
    assert.equal(t.computerLease.state().holder, null)
  } finally {
    await t.done()
  }
})

/* ------------------------------------------------- iPhone, honestly */

test('open_app "iPhone Mirroring" on a Mac that cannot mirror says exactly why, and sends nothing', async () => {
  const { setSimulatorDeps } = await import('../src/main/features/simulator')
  const sent: Sent = []
  const t = await toolWith(new Set([nova.runId]), recordingBackend(sent))
  try {
    setSimulatorDeps({ platform: 'darwin', osRelease: () => '23.6.0' })
    const result = await t.computerTool.run({ action: 'open_app', app: 'iPhone Mirroring', screenshot: false }, t.ctx(nova))
    assert.equal(failed(result), true)
    assert.match(text(result), /needs macOS 15 Sequoia or later.*macOS 14.*can't be controlled from here/s)
    assert.match(t.computerGuidance(), /real iPhone can't be controlled from this computer.*Never present the Simulator as their phone/s)
    assert.deepEqual(sent, [])
    setSimulatorDeps({ platform: 'darwin', osRelease: () => '24.1.0', exists: () => true })
    assert.match(t.computerGuidance(), /open_app "iPhone Mirroring" shows their real phone/)
    assert.equal(failed(await t.computerTool.run({ action: 'open_app', app: 'iPhone Mirroring', screenshot: false }, t.ctx(nova))), false)
    assert.deepEqual(sent, ['open iPhone Mirroring'])
  } finally {
    setSimulatorDeps(null)
    await t.done()
  }
})

/* ------------------------------------------------------ Linux: no secrets in ps */

test('Linux types through stdin: the text (a card number) is never on the command line', async () => {
  const started: { command: string; args: string[]; stdin: string }[] = []
  const fakeSpawn = ((command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stderr: PassThrough; kill: () => void }
    child.stdin = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => undefined
    const entry = { command, args, stdin: '' }
    started.push(entry)
    child.stdin.on('data', (chunk: Buffer) => (entry.stdin += chunk.toString()))
    child.stdin.on('finish', () => setImmediate(() => child.emit('exit', 0)))
    return child
  }) as never
  const linux = new LinuxInput(() => 1, fakeSpawn)
  await linux.type('4242 4242 4242 4242')
  assert.equal(started.length, 1)
  assert.equal(started[0].command, 'xdotool')
  assert.ok(!started[0].args.join(' ').includes('4242'), `args were ${started[0].args.join(' ')}`)
  assert.deepEqual(started[0].args, ['type', '--delay', '8', '--file', '-'])
  assert.equal(started[0].stdin, '4242 4242 4242 4242')
})

test('Linux typing reports xdotool\'s own failure, and a missing xdotool by what to install', async () => {
  const exits = (code: number, stderr: string) =>
    (() => {
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stderr: PassThrough; kill: () => void }
      child.stdin = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => undefined
      child.stdin.on('finish', () => {
        child.stderr.write(stderr)
        setImmediate(() => child.emit('exit', code))
      })
      return child
    }) as never
  await assert.rejects(new LinuxInput(() => 1, exits(1, 'Error: Can\'t open display')).type('x'), /Can't open display/)
  const missing = (() => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stderr: PassThrough; kill: () => void }
    child.stdin = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => undefined
    setImmediate(() => child.emit('error', Object.assign(new Error('spawn xdotool ENOENT'), { code: 'ENOENT' })))
    return child
  }) as never
  await assert.rejects(new LinuxInput(() => 1, missing).type('x'), /xdotool is not installed.*apt install xdotool/)
})
