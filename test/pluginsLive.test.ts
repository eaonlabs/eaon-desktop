import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import type { IpcMain } from 'electron'
import type { McpServerStatus, StreamRequest } from '@shared/types'
import { MCP_CATALOG } from '@shared/mcpCatalog'
import { store } from '../src/main/store'
import { callMcpTool, getTools, shutdownMcp } from '../src/main/mcp'
import '../src/main/agent/pluginTools'
import { toolsFor } from '../src/main/agent/tools'
import { pluginsFeature } from '../src/main/features/plugins'

/**
 * The no-sign-in plugins, for real: each one is connected through the same
 * IPC the Plugins page uses, against the vendor's live server, and must come
 * back ready with tools. Skipped offline (or with EAON_OFFLINE=1), since it
 * needs the internet; `scripts/verify-plugins.mjs` covers the sign-in ones.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>()
pluginsFeature.register({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn), on: () => {} } as unknown as IpcMain,
  getWindow: () => null,
  send: () => {},
  emitStream: () => {}
})
const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => Promise.resolve(handlers.get(channel)!({}, ...args) as T)

let online = false
before(async () => {
  if (process.env.EAON_OFFLINE) return
  try {
    await fetch('https://mcp.deepwiki.com/mcp', { method: 'HEAD', signal: AbortSignal.timeout(8000) })
    online = true
  } catch {
    online = false
  }
})

after(async () => {
  await shutdownMcp()
})

const open = MCP_CATALOG.filter((entry) => entry.authMode === 'none')

test('the catalog has one-click plugins', () => {
  assert.ok(open.length >= 5)
})

for (const entry of open) {
  test(`${entry.displayName} connects with one click and lists its tools`, { timeout: 60_000 }, async (t) => {
    if (!online) return t.skip('offline')
    const statuses = await invoke<McpServerStatus[]>('plugins:enable', entry.id)
    const status = statuses.find((s) => s.serverId === `plugin-${entry.id}`)
    assert.equal(status?.state, 'ready', status?.error)
    assert.ok((status?.toolCount ?? 0) > 0)
    assert.ok(getTools().some((tool) => tool.serverId === `plugin-${entry.id}`))
    assert.ok((await invoke<string[]>('plugins:connected')).includes(entry.id))
  })
}

test('their tools reach the agent with unique names, and a real call works', { timeout: 60_000 }, async (t) => {
  if (!online) return t.skip('offline')
  const names = toolsFor({
    mode: 'work',
    cwd: process.cwd(),
    depth: 0,
    readOnly: false,
    settings: store.getSettings(),
    request: {} as StreamRequest
  }).map((tool) => tool.name)
  assert.equal(new Set(names).size, names.length)

  const text = await callMcpTool('microsoft_docs_search', { query: 'Azure Functions HTTP trigger' }, 45_000, 'plugin-microsoft-learn')
  assert.match(text, /Azure Functions/i)
})

test('disconnecting removes the server and its tools', async (t) => {
  if (!online) return t.skip('offline')
  await invoke('plugins:disconnect', 'deepwiki')
  assert.ok(!(await invoke<string[]>('plugins:connected')).includes('deepwiki'))
  assert.ok(!getTools().some((tool) => tool.serverId === 'plugin-deepwiki'))
  assert.ok(!store.getMcpServers().some((server) => server.pluginId === 'deepwiki'))
})
