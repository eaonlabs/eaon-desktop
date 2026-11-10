import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { duplicateOf, parseServers, SOURCES, slug, summaryOf, toMcpServer } from '../src/main/features/importApps/sources'
import { toolEnabled, withAllTools, withTool } from '../src/shared/mcpTools'
import type { McpServer } from '../src/shared/types'

/**
 * Import from another app (main/features/importApps) and turning individual
 * MCP tools on or off (shared/mcpTools.ts).
 */

const have = (over: Partial<McpServer>): McpServer => ({ id: 'x', name: 'x', transport: 'stdio', command: 'npx', args: [], env: {}, url: '', enabled: true, official: false, ...over })
const desktop = SOURCES.find((s) => s.id === 'claude-desktop')!
const vscode = SOURCES.find((s) => s.id === 'vscode')!

test('a config file’s servers are read: commands with args and env, and web addresses', () => {
  const found = parseServers(
    desktop,
    JSON.stringify({
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me'] },
        github: { command: 'docker', args: ['run', 'ghcr.io/github/github-mcp-server'], env: { GITHUB_TOKEN: 'ghp_secret', RETRIES: 3 } },
        remote: { url: 'https://mcp.example.com/mcp' },
        sse: { serverUrl: 'https://mcp.example.com/sse' }
      },
      theme: 'dark'
    })
  )
  assert.deepEqual(
    found.map((s) => [s.name, s.transport]),
    [['filesystem', 'stdio'], ['github', 'stdio'], ['remote', 'http'], ['sse', 'http']]
  )
  assert.deepEqual(found[1].env, { GITHUB_TOKEN: 'ghp_secret', RETRIES: '3' }, 'values are strings')
  assert.equal(found[2].url, 'https://mcp.example.com/mcp')
  assert.equal(summaryOf(found[0]), 'npx -y @modelcontextprotocol/server-filesystem /Users/me')
  assert.equal(summaryOf(found[2]), 'https://mcp.example.com/mcp')
})

test('VS Code’s list is under "servers", and only that key is read', () => {
  const content = JSON.stringify({ servers: { a: { type: 'stdio', command: 'node', args: ['a.js'] } }, mcpServers: { b: { command: 'node' } } })
  assert.deepEqual(parseServers(vscode, content).map((s) => s.name), ['a'])
  assert.deepEqual(parseServers(desktop, content).map((s) => s.name), ['b'])
})

test('someone else’s file never makes the import fail', () => {
  for (const content of ['', 'not json', '[]', 'null', '{"mcpServers": 3}', '{"mcpServers": []}', '{"mcpServers": {"a": 1, "b": null, "c": {}, "d": {"url": "ftp://x"}, "e": {"command": ""}}}']) {
    assert.deepEqual(parseServers(desktop, content), [], content)
  }
  // Other settings in the file (Gemini CLI keeps its preferences beside its servers) are never touched.
  const gemini = SOURCES.find((s) => s.id === 'gemini-cli')!
  const found = parseServers(gemini, JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } }, mcpServers: { a: { command: 'a' } } }))
  assert.deepEqual(found.map((s) => s.name), ['a'])
  assert.ok(!JSON.stringify(found).includes('oauth'))
})

test('a server the other app had switched off comes over switched off', () => {
  const [server] = parseServers(desktop, JSON.stringify({ mcpServers: { a: { command: 'a', disabled: true } } }))
  assert.equal(toMcpServer(server, new Set()).enabled, false)
  const [on] = parseServers(desktop, JSON.stringify({ mcpServers: { a: { command: 'a' } } }))
  assert.equal(toMcpServer(on, new Set()).enabled, true)
})

test('what Eaon already has is recognised by what it runs, not by its name', () => {
  const [npx, remote] = parseServers(desktop, JSON.stringify({ mcpServers: { renamed: { command: 'npx', args: ['-y', 'pkg'] }, web: { url: 'https://a.example/mcp' } } }))
  assert.ok(duplicateOf(npx, [have({ name: 'other name', args: ['-y', 'pkg'] })].map((s) => ({ ...s, args: ['-y', 'pkg'] }))))
  assert.ok(!duplicateOf(npx, [have({ args: ['-y', 'other'] })]))
  assert.ok(duplicateOf(remote, [have({ transport: 'http', command: '', url: 'https://a.example/mcp' })]))
  assert.ok(!duplicateOf(remote, [have({ transport: 'http', command: '', url: 'https://b.example/mcp' })]))
})

test('an imported server never takes the id of one Eaon has', () => {
  const [server] = parseServers(desktop, JSON.stringify({ mcpServers: { 'My Server!': { command: 'a' } } }))
  const taken = new Set(['my-server'])
  assert.equal(toMcpServer(server, taken).id, 'my-server-2')
  assert.equal(toMcpServer(server, taken).id, 'my-server-3', 'ids chosen in one import are taken too')
  assert.equal(toMcpServer(server, new Set()).name, 'My Server!')
  assert.equal(slug('!!!'), 'server')
})

test('each app’s list is found where that app keeps it', () => {
  assert.equal(desktop.file('darwin', '/Users/me', ''), join('/Users/me', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'))
  assert.equal(desktop.file('win32', 'C:\\Users\\me', join('C:', 'Roaming')), join('C:', 'Roaming', 'Claude', 'claude_desktop_config.json'))
  assert.equal(desktop.file('linux', '/home/me', ''), join('/home/me', '.config', 'Claude', 'claude_desktop_config.json'))
  assert.equal(SOURCES.find((s) => s.id === 'cursor')!.file('darwin', '/Users/me', ''), join('/Users/me', '.cursor', 'mcp.json'))
  // Claude Code's file holds the account's sign-in beside its servers, so it is not a source.
  assert.ok(!SOURCES.some((s) => /claude-code|\.claude\.json/.test(s.id + s.file('darwin', '/Users/me', ''))))
})

test('every tool is on until it is turned off; a tool turned off stays listed by name', () => {
  assert.ok(toolEnabled(undefined, 'search'))
  assert.ok(toolEnabled({}, 'search'))
  let server: Pick<McpServer, 'disabledTools'> = {}
  server = { disabledTools: withTool(server, 'delete_file', false) }
  server = { disabledTools: withTool(server, 'write_file', false) }
  assert.deepEqual(server.disabledTools, ['delete_file', 'write_file'])
  assert.ok(!toolEnabled(server, 'delete_file'))
  assert.ok(toolEnabled(server, 'read_file'))
  server = { disabledTools: withTool(server, 'delete_file', true) }
  assert.deepEqual(server.disabledTools, ['write_file'])
  // Back to nothing off leaves no list at all.
  assert.equal(withTool({ disabledTools: ['a'] }, 'a', true), undefined)
})

test('turn all on or off touches the listed tools and leaves other names alone', () => {
  const server = { disabledTools: ['gone_tool'] }
  assert.deepEqual(withAllTools(server, ['a', 'b'], false), ['a', 'b', 'gone_tool'])
  assert.deepEqual(withAllTools({ disabledTools: ['a', 'b', 'gone_tool'] }, ['a', 'b'], true), ['gone_tool'])
  assert.equal(withAllTools({ disabledTools: ['a'] }, ['a'], true), undefined)
})
