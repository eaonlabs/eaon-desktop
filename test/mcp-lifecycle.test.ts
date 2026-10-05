import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServer, StreamRequest } from '@shared/types'
import { store } from '../src/main/store'
import { getStatuses, getTools, reconnectMcpServer, shutdownMcp, syncMcpServers } from '../src/main/mcp'
import '../src/main/agent/pluginTools'
import { toolsFor, type AgentTool, type ToolContext, type ToolResult } from '../src/main/agent/tools'
import { alive, eventually, fakeMcp, fakeSseMcp, pidsIn, stdioScript, type StdioScript } from './mcpFixtures'

/**
 * Connection lifecycle and tool calls against local fixture servers: no
 * process may outlive its connection, a stale connect must not win, and what
 * a tool returns (errors, images) reaches the agent as what it is.
 */

const base = { command: '', args: [], env: {}, url: '', enabled: true, official: false }
const scratch = mkdtempSync(join(tmpdir(), 'eaon-mcp-lifecycle-'))
let pidCounter = 0
const pidFile = (): string => join(scratch, `pids-${++pidCounter}`)

const stdio = (id: string, script: StdioScript): McpServer => ({
  ...base,
  id,
  name: id,
  transport: 'stdio',
  command: process.execPath,
  args: [stdioScript(), JSON.stringify(script)]
})
const http = (id: string, url: string): McpServer => ({ ...base, id, name: id, transport: 'http', url })
const statusOf = (id: string) => getStatuses().find((s) => s.serverId === id)

const workTools = (): AgentTool[] =>
  toolsFor({ mode: 'work', cwd: process.cwd(), depth: 0, readOnly: false, settings: store.getSettings(), request: {} as StreamRequest })
const ctx = (signal = new AbortController().signal): ToolContext => ({ settings: store.getSettings(), signal }) as unknown as ToolContext
const tool = (name: string): AgentTool => {
  const found = workTools().find((t) => t.name === name)
  assert.ok(found, `no agent tool ${name}; have ${workTools().map((t) => t.name).join(', ')}`)
  return found
}

after(async () => {
  store.saveMcpServers([])
  await shutdownMcp()
})

test('stopping a turn cancels a plugin call that is still waiting on its server', async () => {
  const fake = await fakeMcp({ tools: [{ name: 'hang', description: 'Never answers' }], hang: ['hang'] })
  try {
    store.saveMcpServers([http('slow', fake.url)])
    await syncMcpServers()
    const stop = new AbortController()
    const started = Date.now()
    const call = tool('slow__hang').run({}, ctx(stop.signal))
    setTimeout(() => stop.abort(), 100)
    await assert.rejects(call)
    // The timeout is 30 s; the call must end with the turn, not with it.
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`)
    // And the server is told, so it can stop working on it too.
    assert.ok(await eventually(() => fake.cancelled === 1, 2000), 'the server got notifications/cancelled')
  } finally {
    await fake.close()
  }
})

test('a tool result flagged isError reaches the agent as an error', async () => {
  const fake = await fakeMcp({
    tools: [{ name: 'fail', description: 'Always fails' }],
    results: { fail: { content: [{ type: 'text', text: 'Repository not found' }], isError: true } }
  })
  try {
    store.saveMcpServers([http('errs', fake.url)])
    await syncMcpServers()
    const result = (await tool('errs__fail').run({}, ctx())) as ToolResult
    assert.equal(typeof result, 'object')
    assert.equal(result.isError, true)
    assert.equal(result.text, 'Repository not found')
  } finally {
    await fake.close()
  }
})

test('images, resources and structured content come through as themselves, not as a JSON dump', async () => {
  const png = Buffer.from('fake png bytes '.repeat(2000)).toString('base64')
  const fake = await fakeMcp({
    tools: [
      { name: 'shot', description: 'Returns a screenshot' },
      { name: 'files', description: 'Returns resources' },
      { name: 'data', description: 'Structured only' }
    ],
    results: {
      shot: { content: [{ type: 'text', text: 'Here it is' }, { type: 'image', data: png, mimeType: 'image/png' }] },
      files: {
        content: [
          { type: 'resource', resource: { uri: 'file:///notes.md', mimeType: 'text/markdown', text: '# Notes' } },
          { type: 'resource_link', uri: 'file:///big.csv', name: 'big.csv' },
          { type: 'resource', resource: { uri: 'file:///blob.bin', blob: png } }
        ]
      },
      data: { content: [], structuredContent: { count: 3 } }
    }
  })
  try {
    store.saveMcpServers([http('media', fake.url)])
    await syncMcpServers()

    const shot = (await tool('media__shot').run({}, ctx())) as ToolResult
    assert.equal(shot.text, 'Here it is')
    assert.deepEqual(shot.images, [{ mime: 'image/png', data: png }])

    const files = (await tool('media__files').run({}, ctx())) as ToolResult | string
    const text = typeof files === 'string' ? files : files.text
    assert.match(text, /# Notes/)
    assert.match(text, /file:\/\/\/big\.csv/)
    assert.match(text, /file:\/\/\/blob\.bin/)
    assert.ok(!text.includes(png.slice(0, 200)), 'binary payloads are not pasted into the text')

    const data = (await tool('media__data').run({}, ctx())) as ToolResult | string
    assert.equal(typeof data === 'string' ? data : data.text, '{"count":3}')
  } finally {
    await fake.close()
  }
})

test('deferred plugin calls take arguments sent as a JSON string, and refuse ones that are not an object', async () => {
  const fake = await fakeMcp({
    tools: [{ name: 'echo', description: 'Echoes' }, ...Array.from({ length: 12 }, (_, i) => ({ name: `extra_${i}`, description: 'Filler' }))]
  })
  try {
    store.saveMcpServers([http('many', fake.url)])
    await syncMcpServers()
    const use = tool('use_plugin_tool')
    assert.equal(await use.run({ name: 'many/echo', arguments: { text: 'as object' } }, ctx()), 'as object')
    assert.equal(await use.run({ name: 'many/echo', arguments: '{"text":"as string"}' }, ctx()), 'as string')
    const bad = (await use.run({ name: 'many/echo', arguments: 'text=hi' }, ctx())) as ToolResult
    assert.equal(bad.isError, true)
    assert.equal(fake.calls.length, 2, 'a call with unreadable arguments never reaches the server')
  } finally {
    await fake.close()
  }
})

test('a server whose tool listing fails does not leave its process running', async () => {
  const pids = pidFile()
  store.saveMcpServers([stdio('broken-list', { pidFile: pids, toolsListError: true })])
  const status = await reconnectMcpServer('broken-list')
  assert.equal(status?.state, 'error')
  assert.match(status?.error ?? '', /tools are broken/)
  const [pid] = pidsIn(pids)
  assert.ok(pid)
  assert.ok(await eventually(() => !alive(pid)), 'the server process was left running')
})

test('a server without tools is connected with none, not reported broken', async () => {
  store.saveMcpServers([stdio('prompts-only', { noTools: true })])
  const status = await reconnectMcpServer('prompts-only')
  assert.equal(status?.state, 'ready', status?.error)
  assert.equal(status?.toolCount, 0)
})

test('a stdio server that dies on start says why', async () => {
  store.saveMcpServers([stdio('dies', { dieWith: 'Error: GITHUB_TOKEN is not set' })])
  const status = await reconnectMcpServer('dies')
  assert.equal(status?.state, 'error')
  assert.match(status?.error ?? '', /GITHUB_TOKEN is not set/)
})

test('turning a server off while it is still starting leaves nothing running', async () => {
  const pids = pidFile()
  const server = stdio('late', { pidFile: pids, initDelayMs: 400 })
  store.saveMcpServers([server])
  const first = syncMcpServers()
  assert.ok(await eventually(() => pidsIn(pids).length === 1, 3000))
  store.saveMcpServers([{ ...server, enabled: false }])
  await syncMcpServers()
  await first
  assert.equal(statusOf('late')?.state, 'stopped')
  assert.ok(!getTools().some((t) => t.serverId === 'late'), 'a disabled server offers no tools')
  const [pid] = pidsIn(pids)
  assert.ok(await eventually(() => !alive(pid)), 'the late connection kept its process')
})

test('two reconnects at once leave exactly one server process', async () => {
  const pids = pidFile()
  store.saveMcpServers([stdio('twice', { pidFile: pids, initDelayMs: 200 })])
  await Promise.all([reconnectMcpServer('twice'), reconnectMcpServer('twice')])
  assert.equal(statusOf('twice')?.state, 'ready')
  assert.equal(pidsIn(pids).length, 2)
  assert.ok(await eventually(() => pidsIn(pids).filter(alive).length === 1), `alive: ${pidsIn(pids).filter(alive)}`)
  await reconnectMcpServer('twice')
  assert.ok(await eventually(() => pidsIn(pids).filter(alive).length === 1))
  store.saveMcpServers([])
  await syncMcpServers()
  assert.ok(await eventually(() => pidsIn(pids).filter(alive).length === 0), 'removing the server stops it')
})

test('a server that crashes mid-session says why and is started again', async () => {
  const pids = pidFile()
  store.saveMcpServers([stdio('crashy', { pidFile: pids, crashable: true })])
  assert.equal((await reconnectMcpServer('crashy'))?.state, 'ready')
  await assert.rejects(tool('crashy__crash').run({}, ctx()))
  assert.ok(await eventually(() => statusOf('crashy')?.state === 'error', 2000))
  assert.match(statusOf('crashy')?.error ?? '', /out of memory/)
  // Back on its own, with a new process, and its tools callable again.
  assert.ok(await eventually(() => statusOf('crashy')?.state === 'ready', 4000), statusOf('crashy')?.error)
  assert.equal(pidsIn(pids).length, 2)
  assert.equal(await tool('crashy__ping').run({}, ctx()), 'pong')
})

test('editing a connected server reconnects it with the new settings', async () => {
  const a = await fakeMcp({ tools: [{ name: 'from_a', description: 'A' }] })
  const b = await fakeMcp({ tools: [{ name: 'from_b', description: 'B' }] })
  try {
    store.saveMcpServers([http('edited', a.url)])
    await syncMcpServers()
    assert.deepEqual(getTools().map((t) => t.name), ['from_a'])
    // What Settings → MCP Servers does on Save: rewrite the row, then sync.
    store.saveMcpServers([http('edited', b.url)])
    await syncMcpServers()
    assert.equal(statusOf('edited')?.state, 'ready')
    assert.deepEqual(getTools().map((t) => t.name), ['from_b'])
  } finally {
    await a.close()
    await b.close()
  }
})

test('a server that announces new tools gets its list refreshed', async () => {
  store.saveMcpServers([stdio('grows', { listChanged: true })])
  await syncMcpServers()
  assert.deepEqual(getTools().map((t) => t.name), ['grow', 'ping'])
  assert.equal(await tool('grows__grow').run({}, ctx()), 'pong')
  assert.ok(await eventually(() => getTools().some((t) => t.name === 'grown'), 3000), 'the new tool never showed up')
  assert.equal(statusOf('grows')?.toolCount, 3)
})

test('a remote server that forgot the session is reconnected and the call goes through', async () => {
  const fake = await fakeMcp({ sessions: true })
  try {
    store.saveMcpServers([http('stateful', fake.url)])
    await syncMcpServers()
    assert.equal(await tool('stateful__echo').run({ text: 'one' }, ctx()), 'one')
    // The server restarts (a redeploy) and no longer knows the session.
    fake.dropSessions()
    assert.equal(await tool('stateful__echo').run({ text: 'two' }, ctx()), 'two')
    assert.equal(statusOf('stateful')?.state, 'ready')
  } finally {
    await fake.close()
  }
})

test('a server that only speaks the older SSE transport still connects', async () => {
  const fake = await fakeSseMcp()
  try {
    store.saveMcpServers([http('legacy', fake.url)])
    await syncMcpServers()
    assert.equal(statusOf('legacy')?.state, 'ready', statusOf('legacy')?.error)
    assert.equal(await tool('legacy__legacy').run({}, ctx()), 'over sse')
  } finally {
    await fake.close()
  }
})

test('a ~ in a stdio argument means the home folder', async () => {
  const home = mkdtempSync(join(tmpdir(), 'eaon-mcp-home-'))
  const original = process.env.HOME
  process.env.HOME = home
  try {
    writeFileSync(join(home, 'server.cjs'), `require(${JSON.stringify(stdioScript())})`)
    store.saveMcpServers([{ ...base, id: 'tilde', name: 'tilde', transport: 'stdio', command: process.execPath, args: ['~/server.cjs', '{}'] }])
    const status = await reconnectMcpServer('tilde')
    assert.equal(status?.state, 'ready', status?.error)
  } finally {
    process.env.HOME = original
  }
})

test('a result with hundreds of images or a huge text keeps a bounded amount', async () => {
  const { toToolResult } = await import('../src/main/mcp')
  const png = Buffer.from('fake png').toString('base64')
  const many = toToolResult({ content: Array.from({ length: 300 }, () => ({ type: 'image' as const, data: png, mimeType: 'image/png' })) })
  assert.equal(many.images?.length, 8)
  assert.match(many.text, /only the first 8 images are kept/)
  const huge = toToolResult({ content: [{ type: 'text' as const, text: 'x'.repeat(5_000_000) }] })
  assert.ok(huge.text.length < 2_100_000)
  assert.match(huge.text, /5,000,000-character result was dropped/)
})
