import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startLocalServer, stopLocalServer } from '../src/main/localServer'
import { gatewayInfo } from '../src/main/gateway'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import { chunk, sseServer } from './helpers'

/**
 * The real Claude Code and Codex CLIs, pointed at the gateway, finish a turn
 * that needs a tool call. The model behind the gateway is a fake that asks
 * to read a file and then repeats what it said, so nothing reaches a real API
 * and nothing is spent. Each CLI runs with its own temporary home and config
 * folder, so the user's own setup is not read or changed.
 *
 * Skips unless EAON_GATEWAY_CLI_LIVE=1. `claude` comes from PATH; `codex`
 * from PATH or EAON_CODEX_BIN.
 */

const live = process.env.EAON_GATEWAY_CLI_LIVE === '1'
const SECRET = 'hello from the gateway test'
let upstream: Awaited<ReturnType<typeof sseServer>>
let base = ''
let workdir = ''

/**
 * Runs a CLI without blocking: the gateway answering it lives in this same
 * process, so spawnSync would leave its request hanging until the timeout.
 */
function run(bin: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

const which = (name: string): string | null => {
  const found = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' }).stdout.trim()
  return found || null
}

/** Calls whichever shell-like tool the app offers, in that tool's own argument shape. */
function shellCall(names: string[]): { name: string; args: Record<string, unknown> } | null {
  if (names.includes('Read')) return { name: 'Read', args: { file_path: join(workdir, 'notes.txt') } }
  if (names.includes('shell')) return { name: 'shell', args: { command: ['cat', 'notes.txt'], workdir } }
  if (names.includes('shell_command')) return { name: 'shell_command', args: { command: 'cat notes.txt', workdir } }
  if (names.includes('exec_command')) return { name: 'exec_command', args: { cmd: 'cat notes.txt', workdir } }
  return null
}

before(async () => {
  if (!live) return
  workdir = realpathSync(mkdtempSync(join(tmpdir(), 'eaon-gw-cli-')))
  writeFileSync(join(workdir, 'notes.txt'), `${SECRET}\n`)
  upstream = await sseServer((body) => {
    const messages = (body.messages ?? []) as { role: string; content: unknown }[]
    const tools = ((body.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name)
    // A tool result since the model's last turn means the read is done. Claude
    // Code puts reminders in text next to its tool results, so it isn't always last.
    const lastAssistant = messages.map((m) => m.role).lastIndexOf('assistant')
    const result = messages.slice(lastAssistant + 1).find((m) => m.role === 'tool')
    if (lastAssistant >= 0 && result) {
      const output = typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
      const said = output.includes(SECRET) ? SECRET : output.slice(0, 200)
      return [chunk({ content: `notes.txt says: ${said}` }, 'stop')]
    }
    const call = shellCall(tools)
    if (call) return [chunk({ tool_calls: [{ index: 0, id: 'call_live_1', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }), chunk({}, 'tool_calls')]
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
  store.patchSettings({ localServer: { ...store.getSettings().localServer, port: 47341, defaultModelId: 'fake/fake-coder' } })
  const status = await startLocalServer()
  base = status.url!
})

after(async () => {
  if (!live) return
  await stopLocalServer()
  upstream.server.close()
})

test('Claude Code reads a file through the gateway and answers', { skip: !live || !which('claude'), timeout: 180_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'eaon-gw-claude-home-'))
  const result = await run(
    which('claude')!,
    ['-p', 'What does notes.txt say? Read it, then tell me.', '--allowedTools', 'Read', '--output-format', 'json', '--max-turns', '4', ...(process.env.EAON_GATEWAY_CLI_DEBUG ? ['--debug'] : [])],
    {
      cwd: workdir,
      timeout: Number(process.env.EAON_GATEWAY_CLI_TIMEOUT) || 170_000,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        ANTHROPIC_BASE_URL: base,
        ANTHROPIC_AUTH_TOKEN: gatewayInfo().token,
        DISABLE_TELEMETRY: '1',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_ERROR_REPORTING: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
      }
    }
  )
  const output = `${result.stdout}\n${result.stderr}`
  if (process.env.EAON_GATEWAY_CLI_DEBUG) console.log('UPSTREAM REQUESTS', upstream.requests.length, '\nOUTPUT', output.slice(-6000))
  assert.equal(result.status, 0, output.slice(-2000))
  assert.match(output, new RegExp(`notes.txt says: ${SECRET}`), output.slice(-2000))
  const sawTool = upstream.requests.some((r) => ((r.messages ?? []) as { role: string }[]).some((m) => m.role === 'tool'))
  assert.ok(sawTool, 'the Read result came back through the gateway')
})

test('Codex reads a file through the gateway and answers', { skip: !live || !(process.env.EAON_CODEX_BIN || which('codex')), timeout: 180_000 }, async () => {
  const bin = process.env.EAON_CODEX_BIN || which('codex')!
  const home = mkdtempSync(join(tmpdir(), 'eaon-gw-codex-home-'))
  // Codex refuses a CODEX_HOME that doesn't exist yet.
  mkdirSync(join(home, '.codex'))
  const before = upstream.requests.length
  const result = await run(
    bin,
    [
      'exec',
      '--skip-git-repo-check',
      '-c', 'model_provider="eaon"',
      '-c', `model_providers.eaon={ name = "Eaon", base_url = "${base}/v1", env_key = "EAON_API_KEY", wire_api = "responses" }`,
      '-m', 'fake/fake-coder',
      'What does notes.txt say? Read it, then tell me.'
    ],
    {
      cwd: workdir,
      timeout: 170_000,
      env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, '.codex'), EAON_API_KEY: gatewayInfo().token }
    }
  )
  const output = `${result.stdout}\n${result.stderr}`
  if (process.env.EAON_GATEWAY_CLI_DEBUG) console.log('CODEX OUTPUT', output.slice(-6000))
  assert.equal(result.status, 0, output.slice(-2000))
  assert.match(output, new RegExp(`notes.txt says: ${SECRET}`), output.slice(-3000))
  const sawTool = upstream.requests.slice(before).some((r) => ((r.messages ?? []) as { role: string }[]).some((m) => m.role === 'tool'))
  assert.ok(sawTool, 'the command output came back through the gateway')
})
