import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamEvent } from '@shared/types'
import { createCodexEngine } from '../src/main/engines/codex'
import type { EngineApprovalRequest, EngineTurnInput } from '../src/main/engines/types'

/**
 * The Codex engine against the REAL Codex app-server, with a throwaway
 * CODEX_HOME whose only provider is a fake Responses API on loopback: no
 * account, no real model, nothing of the user's touched.
 *
 *   EAON_CODEX_LIVE=1 EAON_CODEX_BIN=/path/to/codex node scripts/test-main.mjs engine-codex-live
 *
 * (On a Mac with the ChatGPT app: /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex)
 */

const BIN = process.env.EAON_CODEX_BIN
const LIVE = process.env.EAON_CODEX_LIVE === '1' && BIN && existsSync(BIN)

const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 130 }
const sse = (events: Record<string, unknown>[]): string => events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('')

function reply(id: string, text: string): string {
  return sse([
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', id: `m-${id}`, content: [] } },
    { type: 'response.output_text.delta', item_id: `m-${id}`, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', role: 'assistant', id: `m-${id}`, content: [{ type: 'output_text', text }] } },
    { type: 'response.completed', response: { id, usage } }
  ])
}

/** A Responses API that runs one shell command when asked to "run", hangs on "slow", and otherwise answers. */
async function fakeModel(): Promise<{ server: Server; url: string; inputs: unknown[][] }> {
  const inputs: unknown[][] = []
  let n = 0
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { input?: Record<string, unknown>[]; tools?: { name?: string }[] }
    const input = body.input ?? []
    inputs.push(input)
    const id = `resp_${++n}`
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const last = input[input.length - 1]
    const user = JSON.stringify([...input].reverse().find((i) => i.role === 'user')?.content ?? '')
    if (last?.type === 'function_call_output') return void res.end(reply(id, `Command said: ${String(last.output).includes('hello-from-codex') ? 'hello' : 'nothing'}`))
    if (user.includes('slow')) {
      res.write(sse([{ type: 'response.created', response: { id } }, { type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', id: 'm-slow', content: [] } }, { type: 'response.output_text.delta', item_id: 'm-slow', output_index: 0, content_index: 0, delta: 'Working…' }]))
      return // never finishes; the turn must be interrupted
    }
    if (user.includes('run')) {
      const tools = (body.tools ?? []).map((t) => t.name)
      const call = tools.includes('exec_command')
        ? { type: 'function_call', name: 'exec_command', call_id: `call_${n}`, arguments: JSON.stringify({ cmd: 'echo hello-from-codex' }) }
        : { type: 'function_call', name: 'shell_command', call_id: `call_${n}`, arguments: JSON.stringify({ command: 'echo hello-from-codex' }) }
      return void res.end(sse([{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', output_index: 0, item: call }, { type: 'response.completed', response: { id, usage } }]))
    }
    const turns = input.filter((i) => i.role === 'user').length
    res.end(reply(id, `Hello from turn ${turns}.`))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, inputs }
}

function input(cwd: string, text: string, extra: Partial<EngineTurnInput> = {}): EngineTurnInput & { events: StreamEvent[]; asked: EngineApprovalRequest[] } {
  const events: StreamEvent[] = []
  const asked: EngineApprovalRequest[] = []
  return {
    sessionId: null,
    messageId: 'm',
    cwd,
    model: null,
    effort: null,
    instructions: 'You are a test worker.',
    text,
    images: [],
    access: 'safe',
    signal: new AbortController().signal,
    emit: (e) => void events.push(e),
    approve: async (r) => (asked.push(r), true),
    events,
    asked,
    ...extra
  }
}

test('the real Codex app-server: turns, approvals, interrupt, resume after restart', { skip: !LIVE, timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'eaon-codex-live-'))
  const home = join(root, 'codex-home')
  const work = join(root, 'work')
  mkdirSync(home)
  mkdirSync(work)
  const model = await fakeModel()
  writeFileSync(
    join(home, 'config.toml'),
    `model = "fake-model"\nmodel_provider = "fake"\n[model_providers.fake]\nname = "Fake"\nbase_url = "${model.url}"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n`
  )
  const make = (): ReturnType<typeof createCodexEngine> =>
    createCodexEngine({
      discovery: { env: { EAON_CODEX_BIN: BIN }, home: root, appDirs: [], npmPrefix: async () => null, systemDirs: [] },
      env: () => ({ ...process.env, CODEX_HOME: home, EAON_OFFLINE: '1' }),
      store: { getJson: (_n, fallback) => fallback, setJson: () => {} },
      ownPorts: () => [1],
      isOwnServerUrl: () => false,
      controlIdleMs: 200,
      interruptGraceMs: 5000
    })
  let engine = make()
  try {
    const status = await engine.detect()
    assert.equal(status.installed, true)
    assert.equal(status.outdated, false)
    assert.equal(status.auth.state, 'not-required', 'a provider without OpenAI auth needs no sign-in')
    assert.equal(status.blockedReason, null)

    // Careful access: Codex asks before running the command; Eaon's policy allows it.
    const allowed = input(work, 'please run a command')
    const first = await engine.runTurn(allowed)
    assert.equal(first.error, undefined, first.errorDetail)
    assert.equal(allowed.asked.length, 1)
    assert.equal(allowed.asked[0].tool, 'run_command')
    assert.equal(allowed.asked[0].input.command, 'echo hello-from-codex')
    assert.equal(first.text, 'Command said: hello')
    const result = allowed.events.find((e) => e.type === 'tool-result')
    assert.ok(result && result.type === 'tool-result' && result.status === 'done' && result.output.startsWith('exit code 0'))
    assert.deepEqual(first.usage, { input: 160, output: 60, cacheRead: 40, cacheWrite: 0 })
    assert.equal(first.sideEffects, true)

    // Refused: Codex records the command as declined and tells the model.
    const refused = input(work, 'please run it again', { sessionId: first.sessionId, approve: async () => false })
    const second = await engine.runTurn(refused)
    assert.equal(second.error, undefined, second.errorDetail)
    const denied = refused.events.find((e) => e.type === 'tool-result')
    assert.ok(denied && denied.type === 'tool-result' && denied.status === 'denied')
    assert.equal(second.sideEffects, false)

    // Cancel mid-stream: turn/interrupt, and Codex confirms it.
    const controller = new AbortController()
    const slow = input(work, 'go slow', { sessionId: first.sessionId, signal: controller.signal })
    const running = engine.runTurn(slow)
    for (let i = 0; i < 200 && !slow.events.some((e) => e.type === 'delta'); i++) await new Promise((r) => setTimeout(r, 25))
    controller.abort()
    const cancelled = await running
    assert.equal(cancelled.cancelled, true)
    assert.equal(cancelled.error, undefined)

    // A new engine (as after an app restart) resumes the same thread from Codex's history.
    await engine.dispose()
    engine = make()
    const resumed = await engine.runTurn(input(work, 'are you still there', { sessionId: first.sessionId }))
    assert.equal(resumed.error, undefined, resumed.errorDetail)
    assert.equal(resumed.sessionId, first.sessionId)
    assert.equal(resumed.sessionReplaced, false)
    // Codex adds its own context messages, so check what the model was sent rather than counting.
    assert.match(JSON.stringify(model.inputs.at(-1)), /please run a command/, 'the model saw the earlier turns')

    const missing = await engine.runTurn(input(work, 'hello', { sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53' }))
    assert.equal(missing.error, undefined, missing.errorDetail)
    assert.equal(missing.sessionReplaced, true)
    assert.doesNotMatch(JSON.stringify(model.inputs.at(-1)), /please run a command/, 'a new thread carries no old history')

    const pids = engine.livePids()
    await engine.dispose()
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), 'no Codex process outlives dispose')
  } finally {
    await engine.dispose()
    model.server.closeAllConnections()
    await new Promise((r) => model.server.close(r))
    rmSync(root, { recursive: true, force: true })
  }
})
