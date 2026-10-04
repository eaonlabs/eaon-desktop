import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stopLocalServer } from '../src/main/localServer'
import { ensureGatewayRunning, gatewayInfo } from '../src/main/gateway'
import { ConnectApps } from '../src/main/features/connectApps/service'
import { StateFile } from '../src/main/features/connectApps/state'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import { chunk, sseServer } from './helpers'

/**
 * Connect apps end to end, with the real CLIs: Eaon connects Claude Code and
 * OpenCode (writing their settings in a temporary home) and opens Copilot
 * CLI with its variables, and each finishes a turn that reads a file through
 * the gateway. The model is a fake, so nothing reaches a real API.
 *
 * Skips unless EAON_CONNECT_APPS_LIVE=1; each test also skips when its CLI
 * (`claude`, `copilot`, `opencode`) isn't on PATH.
 */

const live = process.env.EAON_CONNECT_APPS_LIVE === '1'
const SECRET = 'hello from connect apps'
let upstream: Awaited<ReturnType<typeof sseServer>>
let workdir = ''

const which = (name: string): string | null => spawnSync('/usr/bin/which', [name], { encoding: 'utf8' }).stdout.trim() || null

/** Not spawnSync: the gateway answering the CLI runs in this process. */
function run(bin: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, output })
    })
  })
}

type Tool = { function: { name: string; parameters?: { properties?: Record<string, unknown>; required?: string[] } } }

/** A call that reads notes.txt with whichever file-reading (or shell) tool the app offers, filled in from its schema. */
function readCall(tools: Tool[]): { name: string; arguments: string } | null {
  const pick = (re: RegExp): Tool | undefined => tools.find((t) => re.test(t.function.name))
  const tool = pick(/^(Read|view|read_file|read)$/i) ?? pick(/^(bash|shell|run_command|exec_command)$/i)
  if (!tool) return null
  const args: Record<string, unknown> = {}
  const props = Object.keys(tool.function.parameters?.properties ?? {})
  for (const name of tool.function.parameters?.required ?? props.slice(0, 1)) {
    if (/path|file/i.test(name)) args[name] = join(workdir, 'notes.txt')
    else if (/command|cmd/i.test(name)) args[name] = `cat ${join(workdir, 'notes.txt')}`
    else if (/description/i.test(name)) args[name] = 'Read notes.txt'
  }
  return { name: tool.function.name, arguments: JSON.stringify(args) }
}

before(async () => {
  if (!live) return
  workdir = realpathSync(mkdtempSync(join(tmpdir(), 'eaon-connect-live-')))
  writeFileSync(join(workdir, 'notes.txt'), `${SECRET}\n`)
  upstream = await sseServer((body) => {
    const messages = (body.messages ?? []) as { role: string; content: unknown }[]
    const lastAssistant = messages.map((m) => m.role).lastIndexOf('assistant')
    const result = messages.slice(lastAssistant + 1).find((m) => m.role === 'tool')
    if (lastAssistant >= 0 && result) {
      const output = typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
      return [chunk({ content: `notes.txt says: ${output.includes(SECRET) ? SECRET : output.slice(0, 200)}` }, 'stop')]
    }
    const call = readCall((body.tools ?? []) as Tool[])
    if (call) return [chunk({ tool_calls: [{ index: 0, id: 'call_connect_1', type: 'function', function: call }] }), chunk({}, 'tool_calls')]
    return [chunk({ content: 'ok' }, 'stop')]
  })
  store.saveProviderConfig({
    ollama: { enabled: false },
    'lm-studio': { enabled: false },
    'llama-cpp': { enabled: false },
    mlx: { enabled: false },
    vllm: { enabled: false },
    jan: { enabled: false },
    fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: upstream.url, models: [{ id: 'fake-coder', label: 'Fake coder', providerId: 'fake' }] }
  })
  secrets.set('fake', 'key')
  store.patchSettings({ localServer: { ...store.getSettings().localServer, port: 47352, autoStart: false } })
})

after(async () => {
  if (!live) return
  await stopLocalServer()
  upstream.server.close()
})

test('Claude Code, connected by Eaon, answers through the gateway with no variables of its own', { skip: !live || !which('claude'), timeout: 180_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'eaon-connect-claude-home-'))
  const apps = new ConnectApps({
    home,
    platform: process.platform,
    state: StateFile.in(mkdtempSync(join(tmpdir(), 'eaon-connect-state-'))),
    info: gatewayInfo,
    ensureRunning: ensureGatewayRunning,
    which
  })
  const connected = await apps.connect('claude-code', { model: 'fake/fake-coder' })
  assert.ok(connected.ok, !connected.ok ? connected.error : '')
  assert.equal(gatewayInfo().running, true, 'connecting started the gateway')
  assert.equal(store.getSettings().localServer.autoStart, true, 'and set it to start with Eaon')

  const result = await run(which('claude')!, ['-p', 'What does notes.txt say? Read it, then tell me.', '--allowedTools', 'Read', '--max-turns', '4'], {
    cwd: workdir,
    timeout: 170_000,
    // Only what any shell has: the gateway's address, key and model come from the settings.json Eaon wrote.
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      DISABLE_TELEMETRY: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
    }
  })
  if (process.env.EAON_CONNECT_APPS_DEBUG) console.log('CLAUDE OUTPUT', result.output.slice(-1500), '\nUPSTREAM', upstream.requests.length)
  assert.equal(result.status, 0, result.output.slice(-2000))
  assert.match(result.output, new RegExp(`notes.txt says: ${SECRET}`), result.output.slice(-2000))
  assert.ok(upstream.requests.length >= 2, 'both turns went through the gateway')

  const off = await apps.disconnect('claude-code')
  assert.ok(off.ok)
})

test('Copilot CLI, opened by Eaon, answers through the gateway', { skip: !live || !which('copilot'), timeout: 180_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'eaon-connect-copilot-home-'))
  let env: Record<string, string> = {}
  const apps = new ConnectApps({
    home,
    platform: process.platform,
    state: StateFile.in(mkdtempSync(join(tmpdir(), 'eaon-connect-state-'))),
    info: gatewayInfo,
    ensureRunning: ensureGatewayRunning,
    which,
    // Instead of a terminal window: run it here with the same variables.
    openTerminal: async (_name, _title, spec) => {
      env = spec.env
      return { ok: true }
    }
  })
  assert.ok((await apps.launch('copilot-cli', { model: 'fake/fake-coder' })).ok)
  const before = upstream.requests.length
  const result = await run(which('copilot')!, ['-p', 'What does notes.txt say? Read it, then tell me.', '--allow-all-tools', '--no-color'], {
    cwd: workdir,
    timeout: 170_000,
    env: { PATH: process.env.PATH, HOME: home, ...env }
  })
  if (process.env.EAON_CONNECT_APPS_DEBUG) console.log('COPILOT OUTPUT', result.output, '\nUPSTREAM', upstream.requests.length - before)
  assert.equal(result.status, 0, result.output.slice(-2000))
  assert.match(result.output, new RegExp(`notes.txt says: ${SECRET}`), result.output.slice(-2000))
  assert.ok(upstream.requests.length - before >= 2, 'both turns went through the gateway')
})

test('OpenCode, connected by Eaon, answers through the gateway', { skip: !live || !which('opencode'), timeout: 180_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'eaon-connect-opencode-home-'))
  const apps = new ConnectApps({
    home,
    platform: process.platform,
    state: StateFile.in(mkdtempSync(join(tmpdir(), 'eaon-connect-state-'))),
    info: gatewayInfo,
    ensureRunning: ensureGatewayRunning,
    which
  })
  assert.ok((await apps.connect('opencode', { model: 'fake/fake-coder' })).ok)
  const before = upstream.requests.length
  // No --model: the default comes from the opencode.json Eaon wrote.
  const result = await run(which('opencode')!, ['run', '--pure', 'What does notes.txt say? Read it, then tell me.'], {
    cwd: workdir,
    timeout: 170_000,
    env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local', 'state') }
  })
  if (process.env.EAON_CONNECT_APPS_DEBUG) console.log('OPENCODE OUTPUT', result.output.slice(-2500), '\nUPSTREAM', upstream.requests.length - before)
  assert.equal(result.status, 0, result.output.slice(-2000))
  // `opencode run` (1.16) can exit before printing a reply that came back this fast; the session keeps it.
  const db = join(home, '.local', 'share', 'opencode', 'opencode.db')
  const saved = spawnSync('sqlite3', [db, "select data from part where data like '%notes.txt says%'"], { encoding: 'utf8' }).stdout
  assert.match(`${result.output}\n${saved}`, new RegExp(`notes.txt says: ${SECRET}`), result.output.slice(-2000))
  assert.ok(upstream.requests.length - before >= 2, 'both turns went through the gateway')
})
