import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CuaDriver, cuaDriverBinary, cuaDriverVersion, cuaEnv, socketPath, type CuaCallResult, type CuaTool } from '../src/main/features/computer/cua'
import { cuaAgentTools, cuaRisk, OFFERED, PREFIX, toToolResult } from '../src/main/features/computer/cuaTools'
import { ComputerLease } from '../src/main/features/computer/lease'
import { setComputerLease } from '../src/main/features/computer/tool'
import type { ToolContext } from '../src/main/agent/tools'
import { store } from '../src/main/store'

/**
 * Computer use on Cua Driver: Eaon's wrapper around Cua's tools (with a
 * stand-in driver), and the real bundled driver started, asked and stopped
 * the way Eaon runs it — from a scratch folder, with nothing sent anywhere.
 */

const scratch = mkdtempSync(join(tmpdir(), 'cua-test-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

function ctx(messageId = 'm1', signal = new AbortController().signal): ToolContext {
  return {
    request: { chatId: 'c1', messageId, chatTitle: 'Chat' },
    turn: { notes: [] },
    cwd: scratch,
    signal,
    emit: () => undefined,
    toolId: 't',
    depth: 0,
    readOnly: false,
    settings: {},
    progress: () => undefined,
    confirm: async () => true
  } as unknown as ToolContext
}

const tool = (name: string, description = `${name} does a thing`): CuaTool => ({ name, description, inputSchema: { type: 'object', properties: {} } })

/** A driver that answers from a script and records what it was asked. */
function fakeDriver(answer: (name: string, args: Record<string, unknown>) => CuaCallResult = () => ({ content: [{ type: 'text', text: 'ok' }], isError: false })) {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const driver = {
    call: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      return answer(name, args)
    }
  } as unknown as CuaDriver
  return { driver, calls }
}

function withComputerUse(enabled: boolean): void {
  const settings = store.getSettings()
  store.saveSettings({ ...settings, computerUse: { ...settings.computerUse, enabled } })
}

test('Eaon offers its chosen Cua tools, in its order, prefixed; Cua’s browser, recording, config and updates stay out', () => {
  const all = [...OFFERED, 'browser_click', 'start_recording', 'set_config', 'check_for_update', 'install_extension', 'kill_app', 'clipboard_read'].reverse().map((n) => tool(n))
  const { driver } = fakeDriver()
  const tools = cuaAgentTools(driver, all)
  assert.deepEqual(
    tools.map((t) => t.name),
    OFFERED.map((n) => `${PREFIX}${n}`)
  )
  assert.equal(tools.find((t) => t.name === 'desktop_click')?.description, 'click does a thing', 'Cua’s own description')
  // A tool Cua no longer has is simply not offered.
  assert.deepEqual(
    cuaAgentTools(driver, [tool('click')]).map((t) => t.name),
    ['desktop_click']
  )
})

test('looking is not mutating; acting is; destructive keys and commands need the user', () => {
  const { driver } = fakeDriver()
  const tools = new Map(cuaAgentTools(driver, OFFERED.map((n) => tool(n))).map((t) => [t.name, t]))
  const c = ctx()
  const mutating = (name: string, input: Record<string, unknown> = {}): boolean => {
    const m = tools.get(name)!.mutating
    return typeof m === 'function' ? m(input, c) : m
  }
  assert.equal(mutating('desktop_get_window_state'), false)
  assert.equal(mutating('desktop_list_apps'), false)
  assert.equal(mutating('desktop_click'), true)
  assert.equal(mutating('desktop_type_text'), true)
  // Quit and delete shortcuts, and a destructive command typed into a terminal.
  assert.ok(cuaRisk('hotkey', { keys: ['cmd', 'q'] }, 'darwin'))
  assert.ok(cuaRisk('press_key', { key: 'delete', modifiers: ['cmd'] }, 'darwin'))
  assert.ok(cuaRisk('type_text', { text: 'rm -rf ~/Documents\n' }, 'darwin'))
  assert.ok(cuaRisk('set_value', { value: 'sudo rm -rf /' }, 'darwin'))
  assert.equal(cuaRisk('hotkey', { keys: ['cmd', 'c'] }, 'darwin'), null)
  assert.equal(cuaRisk('type_text', { text: 'hello' }, 'darwin'), null)
  assert.equal(cuaRisk('click', { element_token: 't1' }, 'darwin'), null)
  assert.equal(tools.get('desktop_hotkey')!.risky!({ keys: ['cmd', 'q'] }, c), true)
  assert.equal(tools.get('desktop_type_text')!.describe!({ text: 'hello there' }, c), 'type text "hello there"')
})

test('a call runs only with computer use on, holds the pointer, and passes Cua’s answer on (text and screenshots)', async () => {
  setComputerLease(new ComputerLease({ isRunning: () => true }))
  const png = Buffer.from('fake-png').toString('base64')
  const { driver, calls } = fakeDriver((name) =>
    name === 'get_window_state'
      ? { content: [{ type: 'text', text: '[element_index 1] button "Save"' }, { type: 'image', data: png, mimeType: 'image/png' }], isError: false }
      : { content: [{ type: 'text', text: 'clicked' }], isError: false }
  )
  const tools = new Map(cuaAgentTools(driver, OFFERED.map((n) => tool(n))).map((t) => [t.name, t]))

  withComputerUse(false)
  const off = await tools.get('desktop_click')!.run({ element_token: 'x' }, ctx())
  assert.equal(typeof off === 'object' && off.isError, true)
  assert.equal(calls.length, 0, 'nothing reaches Cua with computer use off')

  withComputerUse(true)
  const state = await tools.get('desktop_get_window_state')!.run({ pid: 1, window_id: 2 }, ctx())
  assert.deepEqual(state, { text: '[element_index 1] button "Save"', images: [{ mime: 'image/png', data: png }] })
  const clicked = await tools.get('desktop_click')!.run({ element_token: 'x' }, ctx())
  assert.deepEqual(clicked, { text: 'clicked' })
  assert.deepEqual(calls, [
    { name: 'get_window_state', args: { pid: 1, window_id: 2 } },
    { name: 'click', args: { element_token: 'x' } }
  ])

  // Another run holding the pointer: this one is told, and Cua isn't called.
  const lease = new ComputerLease({ isRunning: () => true })
  setComputerLease(lease)
  await lease.acquire({ kind: 'chat', id: 'other', name: 'Other chat', runId: 'other-run' }, { signal: new AbortController().signal, onWait: () => undefined })
  const waiting = new AbortController()
  const pending = tools.get('desktop_click')!.run({ element_token: 'y' }, ctx('m2', waiting.signal))
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(calls.length, 2, 'it waits for the pointer')
  waiting.abort()
  await assert.rejects(pending, /Stopped by the user/)
  withComputerUse(false)
})

test('an error from Cua reaches the model as an error', () => {
  assert.deepEqual(toToolResult({ content: [{ type: 'text', text: 'No window 9' }], isError: true }), { text: 'No window 9', isError: true })
  assert.deepEqual(toToolResult({ content: [], isError: false }), { text: 'Done.' })
})

test('Cua runs with telemetry and update checks off, its files in Eaon’s folder, tied to Eaon’s life', () => {
  const env = cuaEnv('/data/cua', { PATH: '/bin', HOME: '/home/al' })
  assert.equal(env.DO_NOT_TRACK, '1')
  assert.equal(env.CUA_DRIVER_RS_TELEMETRY_ENABLED, '0')
  assert.equal(env.CUA_DRIVER_RS_UPDATE_CHECK, '0')
  assert.equal(env.CUA_DRIVER_RS_HOME, '/data/cua')
  assert.equal(env.CUA_HOME, '/data/cua')
  assert.equal(env.CUA_DRIVER_EMBEDDED, '1')
  assert.equal(env.CUA_DRIVER_PARENT_LIVENESS_STDIN, '1')
  assert.equal(env.PATH, '/bin')
  // Short enough for a Unix socket (about 100 characters).
  assert.ok(socketPath(999999).length < 100, socketPath(999999))
})

/* --------------------------------------------------- the real bundled driver */

const binary = cuaDriverBinary()

test('the bundled Cua Driver starts, lists its tools, answers, and stops — and leaves nothing behind but its folder', { skip: binary ? false : 'no bundled cua-driver (run scripts/fetch-cua-driver.mjs)' }, async () => {
  const home = join(scratch, 'cua-home')
  const fakeHome = join(scratch, 'home')
  const socket = join('/tmp', `eaon-cua-t${process.pid}.sock`)
  const driver = new CuaDriver({ binary: binary!, home, socket, env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome } })
  try {
    const tools = await driver.listTools()
    for (const name of OFFERED) assert.ok(tools.some((t) => t.name === name), `Cua ${cuaDriverVersion(binary)} has ${name}`)
    assert.ok(driver.running)
    const size = await driver.call('get_screen_size', {})
    assert.equal(size.isError, false, JSON.stringify(size))
    assert.match(size.content[0]?.text ?? '', /\d+x\d+/)
    // The tool list is kept for the next launch.
    assert.ok(readdirSync(home).some((f) => /^tools-.*\.json$/.test(f)))
    const again = new CuaDriver({ binary: binary!, home, socket })
    assert.equal(again.cachedTools()?.length, tools.length, 'known without starting')
    assert.equal(again.running, false)
  } finally {
    await driver.stop()
  }
  assert.equal(driver.running, false)
  assert.equal(existsSync(socket), false, 'its socket is gone')
  // Nothing in the (stand-in) home folder but the cache folder macOS gives every app, and no telemetry identity anywhere.
  const inHome = existsSync(fakeHome) ? readdirSync(fakeHome, { recursive: true }).map(String) : []
  assert.deepEqual(
    inHome.filter((f) => !['Library', join('Library', 'Caches'), join('Library', 'Caches', 'cua-driver')].includes(f) && !f.startsWith(join('.cache', 'cua-driver')) && f !== '.cache'),
    [],
    'nothing in the home folder but its cache'
  )
  const files = readdirSync(home, { recursive: true }).map(String)
  assert.ok(!files.some((f) => /telemetry_id|installation_recorded/.test(f)), files.join(', '))
})
