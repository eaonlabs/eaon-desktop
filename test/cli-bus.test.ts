import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '../src/main/agent/tools'
import { BusNode, busDir, claimEngines, isAlive, listPeers, readEngineLock, releaseEngines, resolvePeer, type PeerMessage, type RemoteToolSpec } from '../cli/src/bus/bus'
import { createEaonMcpTools } from '../cli/src/bus/mcpServer'
import { peerTools } from '../cli/src/bus/peerTools'
import {
  claudeProjectSlug,
  claudeSessions,
  classifyCommand,
  codexSessions,
  codexTomlHasBridge,
  codexTomlWithBridge,
  codexTomlWithoutBridge,
  connectionStatus
} from '../cli/src/bus/external'
import { formatTradingSummary, localTradingSnapshot } from '../cli/src/bus/summaries'

/**
 * The session bus: discovery, messages and replies, the engines lock, the
 * owner's handlers, tools and events over a socket, the agent's peer tools,
 * the MCP bridge's tools, and the read-only views of Claude Code and Codex.
 * Every node here lives in this process, each on its own socket, under a
 * throwaway profile.
 */

// The bus reads cliHome() on every call, so this takes effect before any node opens.
const home = mkdtempSync(join(tmpdir(), 'eaon-cli-bus-'))
process.env.EAON_CLI_HOME = home

const nodes: BusNode[] = []
async function node(name: string, kind: BusNode['self']['kind'] = 'eaon'): Promise<BusNode> {
  const created = await new BusNode({ name, kind, cwd: '/tmp/project' }).open()
  nodes.push(created)
  return created
}

after(async () => {
  for (const n of nodes) await n.close()
  rmSync(home, { recursive: true, force: true })
})

/** A pid that isn't running. */
function deadPid(): number {
  for (let pid = 999_999; pid > 900_000; pid -= 7) if (!isAlive(pid)) return pid
  throw new Error('no free pid')
}

async function until<T>(fn: () => T | undefined | null | false, ms = 3000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 15))
  }
}

test('two sessions find each other and resolve by name or id prefix', async () => {
  const a = await node('alpha')
  const b = await node('beta', 'claude-code')
  assert.ok(a.peers().some((p) => p.id === b.self.id))
  assert.ok(b.peers().some((p) => p.id === a.self.id))
  assert.equal(resolvePeer('ALPHA')?.id, a.self.id)
  assert.equal(resolvePeer('@beta')?.id, b.self.id)
  assert.equal(resolvePeer(b.self.id.slice(0, 4))?.id, b.self.id)
  assert.equal(resolvePeer('nobody-here'), null)
})

test('a taken name gets a suffix', async () => {
  const first = await node('gamma')
  const second = await node('gamma')
  assert.equal(first.self.name, 'gamma')
  assert.equal(second.self.name, 'gamma-2')
})

test('a message gets an answer the sender waits for', async () => {
  const a = await node('asker')
  const b = await node('answerer')
  const seen: PeerMessage[] = []
  b.onMessage((message) => {
    seen.push(message)
    if (message.expectReply) void b.send(message.from.id, `echo: ${message.text}`, { replyTo: message.id })
  })
  const result = await a.send('answerer', 'hello there', { waitMs: 3000 })
  assert.equal(result.delivered, true)
  assert.equal(result.to?.id, b.self.id)
  assert.equal(result.reply?.text, 'echo: hello there')
  assert.equal(seen[0].from.name, 'asker')
  assert.equal(seen[0].expectReply, true)
})

test('no reply in time is not an error, and an unknown session is', async () => {
  const a = await node('patient')
  await node('silent')
  const quiet = await a.send('silent', 'anyone?', { waitMs: 100 })
  assert.equal(quiet.delivered, true)
  assert.equal(quiet.reply, undefined)
  const missing = await a.send('ghost', 'hello')
  assert.equal(missing.delivered, false)
  assert.match(missing.error ?? '', /No session called/)
})

test('a registration left by a dead process is cleaned up', async () => {
  mkdirSync(busDir(), { recursive: true })
  const file = join(busDir(), 'deadbeef.json')
  writeFileSync(file, JSON.stringify({ id: 'deadbeef', name: 'zombie', kind: 'eaon', pid: deadPid(), cwd: '/', startedAt: 1, socket: join(busDir(), 'deadbeef.sock') }))
  assert.ok(!listPeers().some((p) => p.id === 'deadbeef'))
  assert.equal(existsSync(file), false)
})

test('the engines lock is exclusive, and a dead holder is taken over', () => {
  const lock = join(home, 'engines.lock')
  // Held by another live process (the test runner's parent).
  writeFileSync(lock, JSON.stringify({ pid: process.ppid, peerId: 'someone', at: Date.now() }))
  assert.equal(claimEngines('me'), false)
  assert.equal(readEngineLock()?.peerId, 'someone')
  // Held by a process that died.
  writeFileSync(lock, JSON.stringify({ pid: deadPid(), peerId: 'gone', at: Date.now() }))
  assert.equal(readEngineLock(), null)
  assert.equal(claimEngines('me'), true)
  assert.equal(readEngineLock()?.peerId, 'me')
  releaseEngines()
  assert.equal(existsSync(lock), false)
})

test("another session calls the owner's handlers and tools and follows its events", async () => {
  const owner = await node('owner')
  const other = await node('other')
  const spec: RemoteToolSpec = { name: 'trading_quote', description: 'Quote', inputSchema: { type: 'object' }, mutating: 'never', source: 'trading' }
  owner.serve({
    channels: () => ['trading:snapshot'],
    invoke: async (channel, args) => ({ channel, args }),
    tools: () => [spec],
    tool: async (name, input, meta) => `${name} ${JSON.stringify(input)} for ${meta.chatId}`
  })
  writeFileSync(join(home, 'engines.lock'), JSON.stringify({ pid: process.pid, peerId: owner.self.id, at: Date.now() }))
  try {
    assert.equal(owner.owner(), null, 'the owner is not its own owner')
    assert.equal(other.owner()?.id, owner.self.id)
    assert.deepEqual(await other.invokeOwner('trading:snapshot', [1, 'x']), { channel: 'trading:snapshot', args: [1, 'x'] })
    assert.deepEqual(await other.ownerChannels(), ['trading:snapshot'])
    assert.deepEqual(await other.ownerTools(), [spec])
    const ran = await other.callOwnerTool('trading_quote', { symbol: 'AAPL' }, { chatId: 'c1', messageId: 'm1', cwd: '/', providerId: 'p', modelId: 'm' })
    assert.equal(ran, 'trading_quote {"symbol":"AAPL"} for c1')

    const received: { channel: string; args: unknown[] }[] = []
    const stop = other.subscribeOwner(['trading:*'], (channel, args) => received.push({ channel, args }))
    // Publish until the subscription has reached the owner.
    await until(() => {
      owner.publish('trading:changed', [{ equity: 1 }])
      owner.publish('workers:changed', [[]])
      return received.length > 0
    })
    stop()
    assert.equal(received[0].channel, 'trading:changed')
    assert.ok(received.every((e) => e.channel.startsWith('trading:')), 'only the channels asked for')
  } finally {
    rmSync(join(home, 'engines.lock'), { force: true })
  }
})

test("a session without the engines says so instead of hanging", async () => {
  const plain = await node('plain')
  const asker = await node('asker-2')
  writeFileSync(join(home, 'engines.lock'), JSON.stringify({ pid: process.pid, peerId: plain.self.id, at: Date.now() }))
  try {
    await assert.rejects(asker.invokeOwner('trading:snapshot', []), /does not run Eaon/)
  } finally {
    rmSync(join(home, 'engines.lock'), { force: true })
  }
})

test("the agent's session_send delivers, and sessions_list hints at connecting Claude Code", async () => {
  // The hint shows only while no Claude Code or Codex session is on the bus.
  for (const n of nodes.filter((n) => n.self.kind !== 'eaon')) {
    await n.close()
    nodes.splice(nodes.indexOf(n), 1)
  }
  const me = await node('eaon-agent')
  const them = await node('listener')
  const got: string[] = []
  them.onMessage((m) => got.push(m.text))
  const [list, send] = peerTools(me)
  const ctx = {} as ToolContext
  const listing = (await list.run({}, ctx)) as string
  assert.match(listing, /This session: eaon-agent/)
  assert.match(listing, /listener/)
  assert.match(listing, /eaon connect claude/)
  const out = (await send.run({ to: 'listener', text: 'build is green' }, ctx)) as string
  assert.match(out, /Delivered to listener/)
  await until(() => got.length > 0)
  assert.deepEqual(got, ['build is green'])
  assert.ok((send.describe?.({ to: 'listener', text: 'x'.repeat(100) }) ?? '').length < 90)
})

test('the MCP bridge reads its inbox, replies, and waits for the next message', async () => {
  const bridge = await node('claude-code@repo', 'claude-code')
  const eaon = await node('eaon@repo')
  const { call, inbox } = createEaonMcpTools(bridge)

  const sessions = await call('eaon_sessions', {})
  assert.match(sessions.text, /eaon@repo \(Eaon CLI\)/)

  // Eaon asks and waits; the bridge's model reads the inbox and replies.
  const asking = eaon.send('claude-code@repo', 'what changed in the API?', { waitMs: 3000 })
  const pending = await until(() => inbox.unread()[0])
  const read = await call('eaon_inbox', {})
  assert.match(read.text, /from eaon@repo \(Eaon CLI\)/)
  assert.match(read.text, /waiting for a reply/)
  assert.equal(inbox.unread().length, 0)
  const replied = await call('eaon_reply', { message_id: pending.id.slice(0, 8), text: 'Two new endpoints.' })
  assert.equal(replied.isError, false)
  const answer = await asking
  assert.equal(answer.reply?.text, 'Two new endpoints.')
  assert.equal(answer.reply?.replyTo, pending.id)

  // eaon_wait returns the next message as it arrives.
  const waiting = call('eaon_wait', { timeout_seconds: 5 })
  setTimeout(() => void eaon.send('claude-code@repo', 'deploy finished'), 50)
  assert.match((await waiting).text, /deploy finished/)
  assert.match((await call('eaon_wait', { timeout_seconds: 0 })).text, /No message in 0s/)

  // eaon_send from the bridge, with the answer read straight away.
  eaon.onMessage((m) => {
    if (m.expectReply) void eaon.send(m.from.id, 'on it', { replyTo: m.id })
  })
  const sent = await call('eaon_send', { to: 'eaon@repo', message: 'please re-run the checks', wait_seconds: 3 })
  assert.match(sent.text, /Reply from eaon@repo:\non it/)
  assert.equal(inbox.unread().length, 0, 'the awaited reply is not left unread')

  const bad = await call('eaon_reply', { message_id: 'nope', text: 'x' })
  assert.equal(bad.isError, true)
  const trading = await call('eaon_trading', {})
  assert.match(trading.text, /hasn’t traded/)
  const workers = await call('eaon_workers', {})
  assert.match(workers.text, /isn’t running/)
})

test('agent CLIs are recognised from their command lines', () => {
  assert.equal(classifyCommand('claude'), 'claude-code')
  assert.equal(classifyCommand('node /Users/x/.local/bin/claude --resume'), 'claude-code')
  assert.equal(classifyCommand('node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'), 'claude-code')
  assert.equal(classifyCommand('/opt/homebrew/bin/codex app-server'), 'codex')
  assert.equal(classifyCommand('zsh -l'), null)
  assert.equal(classifyCommand('node /repo/out/cli/eaon.mjs mcp'), null)
})

test("Claude Code's project folder names and session titles", () => {
  assert.equal(claudeProjectSlug('/Users/ada/Downloads/Eaon Desktop'), '-Users-ada-Downloads-Eaon-Desktop')
  assert.equal(claudeProjectSlug('/private/var/folders/ds/b9_qs/T/eaon.fleet'), '-private-var-folders-ds-b9-qs-T-eaon-fleet')

  const fakeHome = mkdtempSync(join(tmpdir(), 'eaon-home-'))
  const project = '/work/api'
  const dir = join(fakeHome, '.claude', 'projects', claudeProjectSlug(project))
  mkdirSync(dir, { recursive: true })
  const lines = [
    { type: 'mode', mode: 'default', sessionId: 's1' },
    { type: 'user', isMeta: true, cwd: project, message: { role: 'user', content: '<local-command-caveat>ignore</local-command-caveat>' } },
    { type: 'user', cwd: project, message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { type: 'user', cwd: project, message: { role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'Fix the   flaky\nlogin test' }] } }
  ]
  writeFileSync(join(dir, 'older.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'))
  // A first message too long for the bytes read: its text still comes out of the cut-off line.
  const huge = JSON.stringify({ type: 'user', cwd: project, message: { role: 'user', content: [{ type: 'text', text: 'Add a CLI for the app' }, { type: 'image', data: 'x'.repeat(100_000) }] } })
  writeFileSync(join(dir, 'newer.jsonl'), `${JSON.stringify(lines[0])}\n${huge}\n`)
  const now = Date.now() / 1000
  utimesSync(join(dir, 'older.jsonl'), now - 100, now - 100)

  const sessions = claudeSessions(project, 10, fakeHome)
  assert.deepEqual(
    sessions.map((s) => [s.id, s.title, s.cwd]),
    [
      ['newer', 'Add a CLI for the app', project],
      ['older', 'Fix the flaky login test', project]
    ]
  )
  assert.deepEqual(claudeSessions('/elsewhere', 10, fakeHome), [])
  rmSync(fakeHome, { recursive: true, force: true })
})

test('Codex sessions are read from their rollout files, filtered by folder', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'eaon-home-'))
  const dir = join(fakeHome, '.codex', 'sessions', '2026', '09', '25')
  mkdirSync(dir, { recursive: true })
  const rollout = (id: string, cwd: string, ask: string): string =>
    [
      { type: 'session_meta', payload: { session_id: id, id, cwd, base_instructions: { text: 'x'.repeat(5000) } } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: ask } }
    ]
      .map((l) => JSON.stringify(l))
      .join('\n')
  writeFileSync(join(dir, 'rollout-2026-09-25T06-22-02-aaaa.jsonl'), rollout('id-a', '/work/api', 'Speed up the build'))
  writeFileSync(join(dir, 'rollout-2026-09-25T07-00-00-bbbb.jsonl'), rollout('id-b', '/work/web', 'Fix the header'))
  const api = codexSessions('/work/api', 10, fakeHome)
  assert.deepEqual(
    api.map((s) => [s.id, s.title, s.cwd]),
    [['id-a', 'Speed up the build', '/work/api']]
  )
  assert.equal(codexSessions(undefined, 10, fakeHome).length, 2)
  assert.deepEqual(codexSessions('/work/api', 10, join(fakeHome, 'missing')), [])
  rmSync(fakeHome, { recursive: true, force: true })
})

test("the Codex config gets exactly one bridge table, and loses it cleanly", () => {
  const original = '# my settings\nmodel = "gpt-6"\n\n[mcp_servers.node_repl]\ncommand = "node"\n\n[mcp_servers.node_repl.env]\nA = "1"\n'
  const command = ['/usr/local/bin/node', '/Users/me/Eaon Desktop/out/cli/eaon.mjs', 'mcp']
  const added = codexTomlWithBridge(original, command)
  assert.ok(codexTomlHasBridge(added))
  assert.match(added, /\[mcp_servers\.eaon\]\ncommand = "\/usr\/local\/bin\/node"\nargs = \["\/Users\/me\/Eaon Desktop\/out\/cli\/eaon\.mjs", "mcp"\]/)
  assert.match(added, /\[mcp_servers\.node_repl\.env\]\nA = "1"/)
  const twice = codexTomlWithBridge(`${added}\n[mcp_servers.eaon.env]\nX = "y"\n`, command)
  assert.equal(twice.match(/\[mcp_servers\.eaon\]/g)?.length, 1)
  assert.doesNotMatch(twice, /mcp_servers\.eaon\.env/)
  const removed = codexTomlWithoutBridge(twice)
  assert.equal(codexTomlHasBridge(removed), false)
  assert.match(removed, /\[mcp_servers\.node_repl\]\ncommand = "node"/)
  assert.match(removed, /model = "gpt-6"/)
  assert.equal(codexTomlWithBridge('', command).startsWith('[mcp_servers.eaon]'), true)
})

test('connection status reads the Claude and Codex configs without running them', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'eaon-home-'))
  let status = await connectionStatus(fakeHome)
  assert.equal(status.claude.connected, false)
  assert.equal(status.codex.connected, false)
  writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({ mcpServers: { eaon: { command: 'node' } } }))
  mkdirSync(join(fakeHome, '.codex'))
  writeFileSync(join(fakeHome, '.codex', 'config.toml'), '[mcp_servers."eaon"]\ncommand = "node"\n')
  status = await connectionStatus(fakeHome)
  assert.equal(status.claude.connected, true)
  assert.equal(status.codex.connected, true)
  rmSync(fakeHome, { recursive: true, force: true })
})

test("the desk is read from the profile's last save when no session runs the engines", () => {
  const store = join(home, 'store')
  mkdirSync(store, { recursive: true })
  const at = Date.now() - 60_000
  writeFileSync(join(store, 'trading-config.json'), JSON.stringify({ broker: 'simulator' }))
  writeFileSync(join(store, 'trading-equity.json'), JSON.stringify({ simulator: { start: 100_000, points: [{ at, equity: 100_250 }] } }))
  writeFileSync(
    join(store, 'trading-orders.json'),
    JSON.stringify([
      { id: 'o1', broker: 'simulator', symbol: 'AAPL', side: 'buy', type: 'market', qty: 2, status: 'filled', filledQty: 2, filledAvgPrice: 200, submittedAt: at, filledAt: at, source: 'agent', reason: 'Breakout above resistance' },
      { id: 'o2', broker: 'simulator', symbol: 'TSLA', side: 'buy', type: 'market', qty: 50, status: 'rejected', submittedAt: at + 1, source: 'session', reason: 'Momentum', error: 'Over the $2,000 per-order limit' }
    ])
  )
  const snapshot = localTradingSnapshot()
  assert.ok(snapshot)
  const text = formatTradingSummary(snapshot, false)
  assert.match(text, /^Broker: Simulator/)
  assert.match(text, /figures are from its last save/)
  assert.match(text, /Equity \$100,250\.00/)
  assert.match(text, /Buy 2 AAPL: filled @ \$200\.00 \(agent\) — Breakout above resistance/)
  assert.match(text, /refused: Over the \$2,000 per-order limit/)
  assert.match(text, /No trading session is running/)
  rmSync(store, { recursive: true, force: true })
  assert.equal(localTradingSnapshot(), null)
})
