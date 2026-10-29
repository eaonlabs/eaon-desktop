import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRcHandler } from '../src/main/features/rc/handler'
import { createGuestTerminals, type GuestTerminals } from '../src/main/features/rc/guestTerminals'
import type { TerminalsControl } from '../src/main/features/terminals'
import type { TerminalAgent } from '../src/shared/terminals'

/**
 * Guests on Eaon Remote (rc/handler.ts, rc/guestTerminals.ts): the computer
 * checks every guest message itself. A guest types only into its own locked
 * terminal, never into one of the user's; can't start the user's terminals or
 * reach Workers; and a guest with the whole computer who opens a terminal
 * gets a locked one.
 */

function fakeTerminals() {
  const writes: [string, string][] = []
  const started: string[] = []
  const running = new Set<string>()
  const terminals = {
    layout: () => ({ '/work/app': [{ id: 'pane-owner', name: 'Main', agent: 'shell' }] }),
    tap: () => () => undefined,
    agents: async () => [],
    status: () => 'idle',
    task: () => null,
    snapshot: () => ({ data: '', cols: 80, rows: 24, running: true }),
    write: (id: string, data: string) => writes.push([id, data]),
    startPane: async (id: string) => void started.push(`owner:${id}`),
    running: (id: string) => running.has(id),
    startGuest: (id: string) => void running.add(id),
    kill: (id: string) => void running.delete(id)
  } as unknown as TerminalsControl
  return { terminals, writes, started, running }
}

/** Guest terminals without a sandbox: just who owns which pane, and what was started. */
function fakeGuests(): GuestTerminals & { startedGuests: string[]; adhocOpened: string[] } {
  const owners: Record<string, string> = { 'guest-ada1': 'ada', 'guest-bob1': 'bob' }
  const startedGuests: string[] = []
  const adhocOpened: string[] = []
  return {
    startedGuests,
    adhocOpened,
    pane: (id: string) => (owners[id] ? { paneId: id, folder: '/work/app/shared', label: 'shared', login: owners[id], agent: null, locked: true } : null),
    owns: (id: string, login: string) => owners[id]?.toLowerCase() === login.toLowerCase(),
    start: async (id: string) => void startedGuests.push(id),
    openAdhoc: async (folder: string, login: string, agent?: string | null) => {
      adhocOpened.push(`${login}@${folder}:${agent}`)
      owners['guest-xnew'] = login
      return { paneId: 'guest-xnew', folder, label: 'app', login, agent: agent === 'shell' ? null : (agent ?? null), locked: false }
    }
  } as unknown as GuestTerminals & { startedGuests: string[]; adhocOpened: string[] }
}

function setup() {
  const t = fakeTerminals()
  const guests = fakeGuests()
  const sent: Record<string, unknown>[] = []
  const handler = createRcHandler({
    terminals: t.terminals,
    ade: { list: () => [{ id: 's1', cwd: '/work/app' } as never], changes: async () => null },
    workers: null,
    guests,
    send: (m) => sent.push(m)
  })
  const res = (id: string) => sent.find((m) => m.t === 'res' && m.id === id) as { status: number; body: unknown } | undefined
  return { ...t, guests, sent, handler, res }
}

test('a guest types only into its own locked terminal, never into the user’s', async () => {
  const s = setup()
  await s.handler.handle({ t: 'input', from: 'g1', guest: 'ada', pane: 'pane-owner', data: 'rm -rf ~\r' })
  await s.handler.handle({ t: 'input', from: 'g1', guest: 'ada', pane: 'guest-bob1', data: 'cat secrets\r' })
  await s.handler.handle({ t: 'input', from: 'g1', guest: 'ADA', pane: 'guest-ada1', data: 'ls\r' })
  await s.handler.handle({ t: 'input', from: 'me', pane: 'pane-owner', data: 'echo mine\r' })
  assert.deepEqual(s.writes, [
    ['guest-ada1', 'ls\r'],
    ['pane-owner', 'echo mine\r']
  ])
})

test('a guest can’t start the user’s terminals, reach Workers, or open the user’s shells', async () => {
  const s = setup()
  await s.handler.handle({ t: 'req', from: 'g1', guest: 'ada', id: 'a', method: 'POST', path: '/ade/panes/pane-owner/start' })
  assert.equal(s.res('a')?.status, 403)
  assert.deepEqual(s.started, [])

  await s.handler.handle({ t: 'req', from: 'g1', guest: 'ada', id: 'b', method: 'GET', path: '/remote/v1/workers' })
  assert.equal(s.res('b')?.status, 403)

  await s.handler.handle({ t: 'req', from: 'g1', guest: 'ada', id: 'c', method: 'POST', path: '/ade/panes/guest-ada1/start' })
  assert.equal(s.res('c')?.status, 200)
  assert.deepEqual(s.guests.startedGuests, ['guest-ada1'])

  await s.handler.handle({ t: 'req', from: 'g1', guest: 'ada', id: 'd', method: 'POST', path: '/ade/panes/guest-bob1/start' })
  assert.equal(s.res('d')?.status, 403)

  // A new terminal from a guest is a locked one in that session's folder, running what they picked.
  await s.handler.handle({ t: 'req', from: 'g1', guest: 'ada', id: 'e', method: 'POST', path: '/ade/sessions/s1/panes', body: { agent: 'claude' } })
  assert.equal(s.res('e')?.status, 201)
  assert.equal((s.res('e')?.body as { pane: { id: string; agent: string } }).pane.id, 'guest-xnew')
  assert.equal((s.res('e')?.body as { pane: { id: string; agent: string } }).pane.agent, 'claude')
  // Anything that isn't a terminal Eaon knows is a shell.
  await s.handler.handle({ t: 'req', from: 'g1', guest: 'ada', id: 'e2', method: 'POST', path: '/ade/sessions/s1/panes', body: { agent: 'rm -rf ~' } })
  assert.equal(s.res('e2')?.status, 201)
  assert.deepEqual(s.guests.adhocOpened, ['ada@/work/app:claude', 'ada@/work/app:shell'])

  // Anything else a guest asks for is refused.
  await s.handler.handle({ t: 'req', from: 'g1', guest: 'ada', id: 'f', method: 'DELETE', path: '/ade/panes/pane-owner' })
  assert.equal(s.res('f')?.status, 403)
})

test('a guest watches only its own locked terminal, which starts when first opened', async () => {
  const s = setup()
  await s.handler.handle({ t: 'sub', from: 'g1', guest: 'ada', pane: 'guest-bob1' })
  assert.equal(s.sent.filter((m) => m.t === 'snap').length, 0)
  await s.handler.handle({ t: 'sub', from: 'g1', guest: 'ada', pane: 'guest-ada1' })
  assert.equal(s.sent.filter((m) => m.t === 'snap').length, 1)
  assert.deepEqual(s.guests.startedGuests, ['guest-ada1'])
})

/* ------------------------------------------------------- the saved shares */

function memoryStore() {
  const docs = new Map<string, unknown>()
  return { getJson: <T>(name: string, fallback: T): T => (docs.has(name) ? (docs.get(name) as T) : fallback), setJson: (name: string, value: unknown) => void docs.set(name, value) }
}

test('locked shares: checked when made, owned by one login, and gone when they expire', async () => {
  const t = fakeTerminals()
  const share = fs.mkdtempSync(path.join(os.homedir(), '.eaon-guest-test-'))
  try {
    let clock = 1_000_000
    const agents: TerminalAgent[] = [{ id: 'claude', label: 'Claude Code', command: 'claude --dangerously-skip-permissions', installed: true }]
    const found: string[] = []
    const guests = createGuestTerminals({
      terminals: { ...t.terminals, agents: async () => agents } as TerminalsControl,
      store: memoryStore(),
      homesDir: fs.mkdtempSync(path.join(os.tmpdir(), 'guest-homes-')),
      findBin: (bin) => (found.push(bin), bin === 'claude' ? '/usr/bin/true' : null),
      now: () => clock
    })
    if (!guests.support().ok) return // no sandbox on this platform: nothing to make

    await assert.rejects(guests.prepare({ folder: share, mode: 'shell', login: 'not a login!' }), /GitHub username/)
    await assert.rejects(guests.prepare({ folder: os.homedir(), mode: 'shell', login: 'ada' }), /home folder itself/)
    await assert.rejects(guests.prepare({ folder: share, mode: 'cli', agent: 'nope', login: 'ada' }), /Pick a CLI/)

    // The CLI is found by its binary alone: the flags your own panes use never reach a guest.
    const cli = await guests.prepare({ folder: share, mode: 'cli', agent: 'claude', login: '@Ada', hours: 2 })
    assert.deepEqual(found, ['claude'])
    assert.equal(cli.saved.login, 'Ada')
    assert.equal(cli.saved.network, true)
    assert.match(cli.paneId, /^guest-/)

    const shell = await guests.prepare({ folder: share, mode: 'shell', login: 'bob', network: false })
    guests.commit(cli.saved, 'share-cli')
    guests.commit(shell.saved, 'share-shell')
    assert.equal(guests.owns(cli.paneId, 'ada'), true)
    assert.equal(guests.owns(cli.paneId, 'bob'), false)
    assert.equal(guests.pane(shell.paneId)?.label, path.basename(fs.realpathSync(share)))

    // Revoked on the website: pruned here.
    assert.deepEqual(guests.prune(new Set(['share-cli'])), ['share-shell'])
    assert.equal(guests.pane(shell.paneId), null)

    // Two hours later the CLI share has run out.
    clock += 2 * 3_600_000 + 1
    assert.equal(guests.pane(cli.paneId), null)
    assert.deepEqual(guests.prune(null), ['share-cli'])
    assert.equal(guests.list().length, 0)
  } finally {
    fs.rmSync(share, { recursive: true, force: true })
  }
})

test('a friend’s terminals share one home, so what they sign in to carries over, until nothing is shared with them', async () => {
  const t = fakeTerminals()
  const homes: Record<string, string> = {}
  const terminals = {
    ...t.terminals,
    startGuest: (id: string, launch: { home: string }) => {
      homes[id] = launch.home
      t.running.add(id)
    }
  } as unknown as TerminalsControl
  const share = fs.mkdtempSync(path.join(os.homedir(), '.eaon-guest-test-'))
  const homesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-homes-'))
  try {
    const guests = createGuestTerminals({ terminals, store: memoryStore(), homesDir, findBin: () => null })
    if (!guests.support().ok) return // no sandbox on this platform: nothing to start

    const one = await guests.prepare({ folder: share, mode: 'shell', login: 'Ada' })
    const two = await guests.prepare({ folder: share, mode: 'shell', login: 'ada' })
    const bob = await guests.prepare({ folder: share, mode: 'shell', login: 'bob' })
    guests.commit(one.saved, 's1')
    guests.commit(two.saved, 's2')
    guests.commit(bob.saved, 's3')
    for (const p of [one, two, bob]) await guests.start(p.paneId)
    assert.equal(homes[one.paneId], homes[two.paneId])
    assert.notEqual(homes[one.paneId], homes[bob.paneId])

    // Signed in from one terminal: signed in in the other.
    fs.writeFileSync(path.join(homes[one.paneId], '.claude.json'), '{}')
    assert.ok(fs.existsSync(path.join(homes[two.paneId], '.claude.json')))
    // A terminal they open in one of your sessions (the whole computer shared) has it too.
    const adhoc = await guests.openAdhoc(share, 'ADA')
    assert.equal(homes[adhoc.paneId], homes[one.paneId])

    // Revoking one share keeps the home; Eaon closing keeps it; revoking the last one deletes it.
    guests.remove(one.saved.id)
    guests.dispose()
    assert.ok(fs.existsSync(path.join(homes[two.paneId], '.claude.json')))
    guests.remove(two.saved.id)
    assert.equal(fs.existsSync(homes[one.paneId]), false)
    assert.ok(fs.existsSync(homes[bob.paneId]))

    // A friend with only the whole computer keeps theirs while the website still lists a share for them.
    const carol = await guests.openAdhoc(share, 'carol')
    guests.dispose()
    assert.deepEqual(guests.prune(new Set(['s3']), new Set(['bob', 'Carol'])), [])
    assert.ok(fs.existsSync(homes[carol.paneId]))
    // Revoked on the website: bob's share and home go, and carol's, now nothing is shared with her.
    assert.deepEqual(guests.prune(new Set(), new Set()), ['s3'])
    assert.equal(fs.existsSync(homes[bob.paneId]), false)
    assert.equal(fs.existsSync(homes[carol.paneId]), false)
  } finally {
    fs.rmSync(share, { recursive: true, force: true })
    fs.rmSync(homesDir, { recursive: true, force: true })
  }
})

test('what you watch: the friends’ terminals started this run, told as they start and stop', async () => {
  const t = fakeTerminals()
  const terminals = { ...t.terminals, startGuest: (id: string) => void t.running.add(id) } as unknown as TerminalsControl
  const share = fs.mkdtempSync(path.join(os.homedir(), '.eaon-guest-test-'))
  const homesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-homes-'))
  let changes = 0
  try {
    let clock = 1000
    const guests = createGuestTerminals({ terminals, store: memoryStore(), homesDir, findBin: () => null, onChange: () => void changes++, now: () => clock })
    if (!guests.support().ok) return // no sandbox on this platform: nothing to start

    const shell = await guests.prepare({ folder: share, mode: 'shell', login: 'ada' })
    guests.commit(shell.saved, 's1')
    // Shared but not opened yet: nothing to watch.
    assert.deepEqual(guests.watching(), [])
    assert.equal(guests.watchable(shell.paneId), false)

    await guests.start(shell.paneId)
    clock += 10
    const adhoc = await guests.openAdhoc(share, 'bob')
    assert.equal(changes, 2)
    assert.deepEqual(
      guests.watching().map((v) => [v.paneId, v.login, v.locked, v.running]),
      [
        [adhoc.paneId, 'bob', false, true],
        [shell.paneId, 'ada', true, true]
      ],
      'newest first'
    )
    assert.equal(guests.watchable(shell.paneId), true)
    assert.equal(guests.watchable('pane-owner'), false, 'never one of yours')

    // Stopped: still there to look back at, not running; the share stays.
    guests.stop(shell.paneId)
    assert.equal(guests.watching().find((v) => v.paneId === shell.paneId)?.running, false)
    assert.equal(guests.list().length, 1)
    // Revoked: gone.
    guests.remove(shell.saved.id)
    assert.deepEqual(guests.watching().map((v) => v.paneId), [adhoc.paneId])
  } finally {
    fs.rmSync(share, { recursive: true, force: true })
    fs.rmSync(homesDir, { recursive: true, force: true })
  }
})
