import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer, StreamRequest } from '@shared/types'
import { joinArgs, splitArgs } from '@shared/plugins'
import { store } from '../src/main/store'
import { getStatuses, reconnectMcpServer, shutdownMcp, syncMcpServers } from '../src/main/mcp'
import { adoptLoginShellPath } from '../src/main/shellEnv'
import '../src/main/agent/pluginTools'
import { toolsFor, type ToolContext } from '../src/main/agent/tools'
import { fakeMcp } from './mcpFixtures'

const base = { command: '', args: [], env: {}, url: '', enabled: true, official: false }

const workTools = () =>
  toolsFor({
    mode: 'work',
    cwd: process.cwd(),
    depth: 0,
    readOnly: false,
    settings: store.getSettings(),
    request: {} as StreamRequest
  })

after(async () => {
  await shutdownMcp()
})

test('two servers with the same name and tool names still get distinct, callable agent tools', async () => {
  const a = await fakeMcp({ tools: [{ name: 'echo', description: 'from A' }] })
  const b = await fakeMcp({ tools: [{ name: 'echo', description: 'from B' }] })
  try {
    const servers: McpServer[] = [
      { ...base, id: 'twin-a', name: 'Twin', transport: 'http', url: a.url },
      { ...base, id: 'twin-b', name: 'Twin', transport: 'http', url: b.url }
    ]
    store.saveMcpServers(servers)
    await syncMcpServers()
    assert.deepEqual(
      getStatuses().map((s) => s.state),
      ['ready', 'ready']
    )

    const tools = workTools().filter((t) => t.name.endsWith('__echo'))
    assert.deepEqual(tools.map((t) => t.name).sort(), ['twin_2__echo', 'twin__echo'])
    assert.equal(new Set(workTools().map((t) => t.name)).size, workTools().length, 'tool names must be unique')
    assert.match(tools.find((t) => t.name === 'twin__echo')!.description, /^\[Twin\] from A/)
    assert.match(tools.find((t) => t.name === 'twin_2__echo')!.description, /^\[Twin 2\] from B/)

    // And each one reaches its own server.
    const ctx = { settings: store.getSettings() } as unknown as ToolContext
    assert.equal(await tools.find((t) => t.name === 'twin_2__echo')!.run({ text: 'hi from b' }, ctx), 'hi from b')
  } finally {
    await a.close()
    await b.close()
  }
})

test('stdio arguments typed in one field keep paths with spaces, JSON and Windows paths intact', () => {
  assert.deepEqual(splitArgs('-y @modelcontextprotocol/server-filesystem "/Users/Jane Doe/My Notes" ~/Documents'), [
    '-y',
    '@modelcontextprotocol/server-filesystem',
    '/Users/Jane Doe/My Notes',
    '~/Documents'
  ])
  assert.deepEqual(splitArgs(`--config {"key":"a value"} 'single quoted' C:\\Tools\\bin  `), [
    '--config',
    '{"key":"a',
    'value"}',
    'single quoted',
    'C:\\Tools\\bin'
  ])
  assert.deepEqual(splitArgs('--config {"key":1}'), ['--config', '{"key":1}'])
  assert.deepEqual(splitArgs('  '), [])
  // Whatever was saved shows up in the field so that saving again changes nothing.
  for (const args of [
    ['/Users/Jane Doe/My Notes', '--flag'],
    ['{"key":"a value"}', "it's"],
    ['say "hi" and \'bye\'', '', '"quoted"'],
    ['C:\\Program Files\\node.exe', 'x']
  ]) {
    assert.deepEqual(splitArgs(joinArgs(args)), args, joinArgs(args))
  }
})

test('a stdio server launches from a Dock-style PATH once the login shell PATH is adopted', async () => {
  const fixture = join(process.cwd(), 'test/fixtures/stdio-mcp.mjs')
  const original = process.env.PATH
  // What launchd hands an app opened from the Dock or Finder.
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
  try {
    store.saveMcpServers([{ ...base, id: 'stdio', name: 'Stdio', transport: 'stdio', command: 'node', args: [fixture] }])

    // Where node lives outside the system folders (Homebrew, nvm…), this is
    // the bug the adoption fixes — reported plainly, not as a spawn errno.
    const before = await reconnectMcpServer('stdio')
    if (!existsSync('/usr/bin/node')) {
      assert.equal(before?.state, 'error')
      assert.match(before?.error ?? '', /not found on your PATH/)
    }

    await adoptLoginShellPath()
    const status = await reconnectMcpServer('stdio')
    assert.equal(status?.state, 'ready', status?.error)
    assert.equal(status?.toolCount, 1)
  } finally {
    process.env.PATH = original
  }
})
