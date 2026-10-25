import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_TOOLS_NAME, ClaudeTools, claudeConfigFile, type ClaudeToolsDeps } from '../src/main/features/connectApps/claudeTools'

/**
 * Eaon's tools in Claude Code (Settings → Connect apps): Eaon adds its MCP
 * server to the user's own Claude Code with Claude Code's own command, and
 * takes it out again. A stand-in `claude` keeps ~/.claude.json the way the
 * real `claude mcp add --transport http` does.
 */

interface Fake {
  tools: ClaudeTools
  calls: string[][]
  file: string
  port: { value: number }
  key: { value: string | null }
  cleanup: () => void
}

function fake(options: { installed?: boolean; addFails?: boolean; removeFails?: boolean } = {}): Fake {
  const home = mkdtempSync(join(tmpdir(), 'eaon-claude-tools-'))
  const file = join(home, '.claude.json')
  // Claude Code keeps much else in this file; none of it may be lost.
  writeFileSync(file, JSON.stringify({ numStartups: 3, mcpServers: { github: { type: 'http', url: 'https://example.com/mcp' } } }))
  const calls: string[][] = []
  const port = { value: 1337 }
  const key: { value: string | null } = { value: null }
  const read = (): { mcpServers?: Record<string, unknown> } => JSON.parse(readFileSync(file, 'utf8'))
  const deps: ClaudeToolsDeps = {
    home,
    configFile: file,
    which: (bin) => (options.installed === false || bin !== 'claude' ? null : '/usr/local/bin/claude'),
    run: async (_bin, args) => {
      calls.push(args)
      const config = read()
      const servers = (config.mcpServers ??= {})
      if (args[1] === 'add') {
        if (options.addFails) return { ok: false, output: 'Error: something went wrong\n' }
        const name = args[6]
        if (name in servers) return { ok: false, output: `MCP server ${name} already exists in user config` }
        const header = args[args.indexOf('--header') + 1]
        const [field, ...value] = header.split(': ')
        servers[name] = { type: args[3], url: args[7], headers: { [field]: value.join(': ') } }
      } else if (args[1] === 'remove') {
        if (options.removeFails) return { ok: false, output: 'Error: no permission\n' }
        delete servers[args[4]]
      }
      writeFileSync(file, JSON.stringify(config))
      return { ok: true, output: '' }
    },
    port: () => port.value,
    ensureRunning: async () => ({ port: port.value }),
    token: (create) => {
      if (!key.value && create) key.value = 'eaoncc-test-key'
      return key.value
    },
    forgetToken: () => {
      key.value = null
    }
  }
  return { tools: new ClaudeTools(deps), calls, file, port, key, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

const entry = (file: string): unknown => (JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers[CLAUDE_TOOLS_NAME]

test('connecting adds Eaon’s control API to Claude Code for every folder, with its own key, and keeps the rest of the file', async () => {
  const f = fake()
  try {
    assert.deepEqual(f.tools.status(), { installed: true, connected: false, stale: false, name: CLAUDE_TOOLS_NAME, file: '~/.claude.json' })
    const result = await f.tools.connect()
    assert.equal(result.ok, true)
    assert.deepEqual(f.calls, [
      ['mcp', 'add', '--transport', 'http', '--scope', 'user', CLAUDE_TOOLS_NAME, 'http://127.0.0.1:1337/control/mcp', '--header', 'Authorization: Bearer eaoncc-test-key']
    ])
    assert.deepEqual(entry(f.file), { type: 'http', url: 'http://127.0.0.1:1337/control/mcp', headers: { Authorization: 'Bearer eaoncc-test-key' } })
    const config = JSON.parse(readFileSync(f.file, 'utf8'))
    assert.equal(config.numStartups, 3)
    assert.ok(config.mcpServers.github, 'the user’s other servers stay')
    assert.deepEqual(result.status, { installed: true, connected: true, stale: false, name: CLAUDE_TOOLS_NAME, file: '~/.claude.json' })
  } finally {
    f.cleanup()
  }
})

test('a change of port leaves the entry stale; reconnecting replaces it rather than failing on the old one', async () => {
  const f = fake()
  try {
    await f.tools.connect()
    f.port.value = 4242
    assert.equal(f.tools.status().stale, true)
    assert.equal((await f.tools.connect()).ok, true)
    assert.deepEqual(f.calls.at(-2), ['mcp', 'remove', '--scope', 'user', CLAUDE_TOOLS_NAME])
    assert.equal((entry(f.file) as { url: string }).url, 'http://127.0.0.1:4242/control/mcp')
    assert.equal(f.tools.status().stale, false)
  } finally {
    f.cleanup()
  }
})

test('refreshStale puts a stale entry right on its own, and leaves a current or missing one alone', async () => {
  const f = fake()
  try {
    assert.equal(await f.tools.refreshStale(), false, 'nothing to refresh')
    await f.tools.connect()
    assert.equal(await f.tools.refreshStale(), false, 'already current')
    f.port.value = 5000
    assert.equal(await f.tools.refreshStale(), true)
    assert.equal(f.tools.status().stale, false)
  } finally {
    f.cleanup()
  }
})

test('disconnecting deletes the key first, then takes the entry out', async () => {
  const f = fake()
  try {
    await f.tools.connect()
    const result = await f.tools.disconnect()
    assert.equal(result.ok, true)
    assert.equal(f.key.value, null)
    assert.equal(entry(f.file), undefined)
    assert.equal(result.status.connected, false)
  } finally {
    f.cleanup()
  }
})

test('when Claude Code can’t remove the entry, the key is gone anyway and the message says how to remove it', async () => {
  const f = fake({ removeFails: true })
  try {
    await f.tools.connect()
    const result = await f.tools.disconnect()
    assert.equal(result.ok, false)
    assert.equal(f.key.value, null, 'the entry left behind opens nothing')
    assert.match(result.ok ? '' : result.error, /no longer works.*claude mcp remove --scope user eaon-app/)
    assert.equal(result.status.stale, true)
  } finally {
    f.cleanup()
  }
})

test('without Claude Code on PATH, connecting says so and changes nothing; the command to run by hand still works', async () => {
  const f = fake({ installed: false })
  try {
    const result = await f.tools.connect()
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.error, /isn’t installed/)
    assert.equal(f.calls.length, 0)
    assert.equal(
      await f.tools.command(),
      'claude mcp add --transport http --scope user eaon-app http://127.0.0.1:1337/control/mcp --header "Authorization: Bearer eaoncc-test-key"'
    )
  } finally {
    f.cleanup()
  }
})

test('a failed `claude mcp add` comes back with Claude Code’s own words', async () => {
  const f = fake({ addFails: true })
  try {
    const result = await f.tools.connect()
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.error, /claude mcp add.*something went wrong/)
    assert.equal(result.status.connected, false)
  } finally {
    f.cleanup()
  }
})

test('an entry the user removed in Claude Code reads as not connected; an unreadable file counts as none', async () => {
  const f = fake()
  try {
    await f.tools.connect()
    writeFileSync(f.file, JSON.stringify({ mcpServers: {} }))
    assert.equal(f.tools.status().connected, false)
    writeFileSync(f.file, '{ not json')
    assert.equal(f.tools.status().connected, false)
  } finally {
    f.cleanup()
  }
})

test('Claude Code’s settings file follows CLAUDE_CONFIG_DIR', () => {
  assert.equal(claudeConfigFile('/Users/me', {}), join('/Users/me', '.claude.json'))
  assert.equal(claudeConfigFile('/Users/me', { CLAUDE_CONFIG_DIR: '/tmp/cc' }), join('/tmp/cc', '.claude.json'))
})
