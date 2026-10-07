#!/usr/bin/env node
/**
 * A stand-in for the `codex` CLI, for the Codex engine tests and for
 * screenshots of Settings → Agent engines. `--version` prints a version;
 * `app-server` speaks enough of Codex's app-server protocol (JSON-RPC lines
 * on stdio, same methods and payload shapes as Codex 0.160) to drive every
 * engine path without a real Codex, account or model.
 *
 * Configured through the environment:
 *   FAKE_CODEX_VERSION   version to report (default 0.160.0)
 *   FAKE_CODEX_STATE     folder for threads, request logs and pid files (required for app-server)
 *   FAKE_CODEX_ACCOUNT   chatgpt:<plan> | apikey | none | not-required   (default chatgpt:plus)
 *   FAKE_CODEX_SESSION   ok | expired | offline   (what account/rateLimits/read does)
 *   FAKE_CODEX_MODELS    number of models to list (default 3), FAKE_CODEX_PAGE page size (default 2)
 *   FAKE_CODEX_MODELS_FAIL=1   model/list fails
 *   FAKE_CODEX_CONFIG    JSON for config/read's `config`
 *   FAKE_CODEX_LOGIN     success | fail | never  (default success), FAKE_CODEX_LOGIN_DELAY ms
 *
 * A turn's behaviour follows words in its text: run, patch, mcp, plan, slow,
 * crash, fail-auth, fail-model, fail-limit, history; anything else says hello.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const version = process.env.FAKE_CODEX_VERSION || '0.160.0'
if (args.includes('--version')) {
  process.stdout.write(`codex-cli ${version}\n`)
  process.exit(0)
}
if (args[0] !== 'app-server') {
  process.stderr.write(`fake codex: unsupported ${args.join(' ')}\n`)
  process.exit(2)
}

const state = process.env.FAKE_CODEX_STATE
if (!state) {
  process.stderr.write('fake codex: FAKE_CODEX_STATE is required\n')
  process.exit(2)
}
mkdirSync(join(state, 'threads'), { recursive: true })
const pidFile = join(state, `pid-${process.pid}`)
writeFileSync(pidFile, String(process.pid))
const log = (entry) => appendFileSync(join(state, 'requests.jsonl'), `${JSON.stringify({ pid: process.pid, ...entry })}\n`)
const exit = (code) => {
  try {
    rmSync(pidFile, { force: true })
  } catch {}
  process.exit(code)
}
process.on('SIGTERM', () => exit(0))

/* ------------------------------------------------------------- transport */

let nextServerId = 1000
const waiting = new Map()
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const notify = (method, params) => send({ method, params })
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextServerId++
    waiting.set(id, resolve)
    send({ id, method, params })
  })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let i
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i)
    buffer = buffer.slice(i + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === undefined && message.id !== undefined) {
      const resolve = waiting.get(message.id)
      waiting.delete(message.id)
      resolve?.(message.result ?? { error: message.error })
      continue
    }
    if (message.id === undefined) continue // notifications (initialized)
    log({ method: message.method, params: message.params })
    Promise.resolve(handle(message.method, message.params ?? {}))
      .then((result) => send({ id: message.id, result: result ?? {} }))
      .catch((error) => send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } }))
  }
})
// Like Codex: stdin closing is the signal to shut down.
process.stdin.on('end', () => exit(0))

const rpcError = (code, message) => Object.assign(new Error(message), { code })

/* ---------------------------------------------------------------- state */

const threadFile = (id) => join(state, 'threads', `${id}.json`)
const loadThread = (id) => (existsSync(threadFile(id)) ? JSON.parse(readFileSync(threadFile(id), 'utf8')) : null)
const saveThread = (thread) => writeFileSync(threadFile(thread.id), JSON.stringify(thread))
const loaded = new Map()
const active = new Map() // threadId -> { turnId, interrupt }

/** A sign-in that completed, kept in the state folder as the real Codex keeps it in ~/.codex: it outlasts the process. */
const signedInFile = () => join(state, 'signed-in.json')

function account() {
  // Signed in through account/login/start since: that wins over the starting account.
  const plan = existsSync(signedInFile()) ? JSON.parse(readFileSync(signedInFile(), 'utf8')).planType : null
  const spec = plan ? `chatgpt:${plan}` : process.env.FAKE_CODEX_ACCOUNT || 'chatgpt:plus'
  if (spec === 'none') return { account: null, requiresOpenaiAuth: true }
  if (spec === 'not-required') return { account: null, requiresOpenaiAuth: false }
  if (spec === 'apikey') return { account: { type: 'apiKey' }, requiresOpenaiAuth: true }
  return { account: { type: 'chatgpt', email: 'person@example.com', planType: spec.split(':')[1] || 'plus' }, requiresOpenaiAuth: true }
}

function models() {
  const count = Number(process.env.FAKE_CODEX_MODELS ?? 3)
  return Array.from({ length: count }, (_, i) => ({
    id: `fake-model-${i + 1}`,
    model: `fake-model-${i + 1}`,
    upgrade: null,
    displayName: `Fake Model ${i + 1}`,
    description: `Fake model number ${i + 1}.`,
    hidden: false,
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].slice(0, 3 + (i % 4)).map((e) => ({ reasoningEffort: e, description: e })),
    defaultReasoningEffort: 'medium',
    inputModalities: i % 2 === 0 ? ['text', 'image'] : ['text'],
    isDefault: i === 0
  }))
}

/* ---------------------------------------------------------------- methods */

async function handle(method, p) {
  switch (method) {
    case 'initialize':
      return { userAgent: `fake/${version}`, codexHome: state, platformFamily: 'unix', platformOs: 'macos' }
    case 'account/read':
      return account()
    case 'getAuthStatus':
      return { authMethod: account().account ? 'chatgpt' : null, authToken: null, requiresOpenaiAuth: account().requiresOpenaiAuth }
    case 'account/rateLimits/read': {
      const session = process.env.FAKE_CODEX_SESSION || 'ok'
      if (session === 'expired') throw rpcError(-32603, 'failed to fetch codex rate limits: 401 Unauthorized: Your refresh token has expired. Please sign in again.')
      if (session === 'offline') throw rpcError(-32603, 'failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)')
      return { rateLimits: { limitId: 'codex', primary: { usedPercent: 12 } }, rateLimitsByLimitId: null }
    }
    case 'config/read':
      return { config: JSON.parse(process.env.FAKE_CODEX_CONFIG || '{"model_provider":null}'), origins: {}, layers: null }
    case 'model/list': {
      if (process.env.FAKE_CODEX_MODELS_FAIL === '1') throw rpcError(-32603, 'failed to load the model catalog')
      const all = models()
      const page = Number(process.env.FAKE_CODEX_PAGE ?? 2)
      const start = p.cursor ? Number(p.cursor) : 0
      const limit = Math.min(page, p.limit ?? page)
      const data = all.slice(start, start + limit)
      return { data, nextCursor: start + limit < all.length ? String(start + limit) : null }
    }
    case 'account/login/start': {
      const loginId = randomUUID()
      const mode = process.env.FAKE_CODEX_LOGIN || 'success'
      if (mode !== 'never') {
        setTimeout(() => {
          notify('account/login/completed', { loginId, success: mode === 'success', error: mode === 'success' ? null : 'access_denied', onboardingEntrypoint: null })
          if (mode === 'success') {
            writeFileSync(signedInFile(), JSON.stringify({ planType: 'plus' }))
            notify('account/updated', { authMode: 'chatgpt', planType: 'plus' })
          }
        }, Number(process.env.FAKE_CODEX_LOGIN_DELAY ?? 50))
      }
      return { type: 'chatgpt', loginId, authUrl: `https://auth.example.invalid/authorize?login=${loginId}` }
    }
    case 'account/login/cancel':
      setTimeout(() => notify('account/login/completed', { loginId: p.loginId, success: false, error: 'cancelled', onboardingEntrypoint: null }), 5)
      return {}
    case 'thread/start': {
      const thread = { id: randomUUID(), cwd: p.cwd, messages: [], total: zero(), settings: p }
      saveThread(thread)
      loaded.set(thread.id, thread)
      return { thread: { id: thread.id, modelProvider: 'openai', model: p.model ?? 'fake-model-1', turns: [] }, model: p.model ?? 'fake-model-1', modelProvider: 'openai', cwd: p.cwd, approvalPolicy: p.approvalPolicy, sandbox: { type: 'workspaceWrite' } }
    }
    case 'thread/resume': {
      const thread = loadThread(p.threadId)
      if (!thread) throw rpcError(-32600, `no rollout found for thread id ${p.threadId}`)
      thread.settings = { ...thread.settings, ...p }
      loaded.set(thread.id, thread)
      // Like Codex: the stored usage is replayed right after the response, tagged with the old turn.
      if (thread.total.totalTokens > 0) {
        setTimeout(() => notify('thread/tokenUsage/updated', { threadId: thread.id, turnId: 'restored-turn', tokenUsage: { total: thread.total, last: thread.last ?? thread.total, modelContextWindow: 1000 } }), 0)
      }
      return { thread: { id: thread.id, modelProvider: 'openai', model: 'fake-model-1', turns: [] }, model: 'fake-model-1', modelProvider: 'openai', cwd: thread.cwd, approvalPolicy: p.approvalPolicy }
    }
    case 'turn/start': {
      const thread = loaded.get(p.threadId)
      if (!thread) throw rpcError(-32600, `thread not loaded: ${p.threadId}`)
      const turnId = randomUUID()
      const text = p.input?.find((i) => i.type === 'text')?.text ?? ''
      thread.messages.push(text)
      thread.turnSettings = { approvalPolicy: p.approvalPolicy, sandboxPolicy: p.sandboxPolicy, model: p.model, effort: p.effort }
      saveThread(thread)
      setTimeout(() => void runTurn(thread, turnId, text, p), 5)
      return { turn: { id: turnId, items: [], status: 'inProgress', error: null } }
    }
    case 'turn/interrupt': {
      const turn = active.get(p.threadId)
      if (turn && turn.turnId === p.turnId) turn.interrupt()
      return {}
    }
    case 'turn/steer': {
      const turn = active.get(p.threadId)
      if (!turn || turn.turnId !== p.expectedTurnId) throw rpcError(-32600, 'no active turn to steer')
      turn.steered.push(p.input?.[0]?.text ?? '')
      return { turnId: turn.turnId }
    }
    default:
      throw rpcError(-32601, `method not found: ${method}`)
  }
}

function zero() {
  return { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }
}

/* ------------------------------------------------------------------ turns */

async function runTurn(thread, turnId, text, params) {
  const threadId = thread.id
  let interrupted = false
  let wake = null
  const turn = { turnId, steered: [], interrupt: () => ((interrupted = true), wake?.()) }
  active.set(threadId, turn)
  const ev = (method, extra) => notify(method, { threadId, turnId, ...extra })
  const policy = params.approvalPolicy ?? thread.settings?.approvalPolicy
  const usage = () => {
    const last = { totalTokens: 130, inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 5 }
    for (const k of Object.keys(last)) thread.total[k] += last[k]
    thread.last = last
    saveThread(thread)
    ev('thread/tokenUsage/updated', { tokenUsage: { total: { ...thread.total }, last, modelContextWindow: 1000 } })
  }
  const message = async (id, parts) => {
    ev('item/started', { item: { type: 'agentMessage', id, text: '', phase: null }, startedAtMs: Date.now() })
    for (const part of parts) ev('item/agentMessage/delta', { itemId: id, delta: part })
    ev('item/completed', { item: { type: 'agentMessage', id, text: parts.join(''), phase: null }, completedAtMs: Date.now() })
  }
  const complete = (status, error = null) => {
    active.delete(threadId)
    notify('turn/completed', { threadId, turn: { id: turnId, items: [], status, error } })
  }

  notify('turn/started', { threadId, turn: { id: turnId, items: [], status: 'inProgress', error: null } })
  ev('item/started', { item: { type: 'userMessage', id: randomUUID(), content: [{ type: 'text', text }] } })
  ev('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'Thinking it over.', summaryIndex: 0 })

  if (text.includes('crash')) {
    ev('item/agentMessage/delta', { itemId: 'm-crash', delta: 'About to' })
    await sleep(20)
    exit(3)
    return
  }
  if (text.includes('slow')) {
    await message('m-slow', ['Working slowly…'])
    await new Promise((resolve) => {
      // "deaf": ignore the interrupt, as a stuck Codex would.
      if (!text.includes('deaf')) wake = resolve
      setTimeout(resolve, 30_000)
    })
    if (interrupted) {
      log({ method: 'interrupted', params: { threadId, turnId } })
      return complete('interrupted')
    }
  }
  if (text.includes('fail-auth')) {
    usage()
    return complete('failed', { message: 'unexpected status 401 Unauthorized: Provided authentication token is expired.', codexErrorInfo: 'unauthorized', additionalDetails: null })
  }
  if (text.includes('fail-model')) {
    return complete('failed', { message: "The 'nope' model is not supported when using Codex with a ChatGPT account.", codexErrorInfo: 'badRequest', additionalDetails: null })
  }
  if (text.includes('fail-limit')) {
    ev('error', { error: { message: 'Rate limited, retrying', codexErrorInfo: 'serverOverloaded' }, willRetry: true })
    return complete('failed', { message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded', additionalDetails: null })
  }
  if (text.includes('plan')) {
    ev('turn/plan/updated', { explanation: null, plan: [{ step: 'Look around', status: 'completed' }, { step: 'Make the change', status: 'inProgress' }, { step: 'Test it', status: 'pending' }] })
  }
  if (text.includes('run')) {
    const id = 'call-run'
    const command = "/bin/zsh -lc 'npm test'"
    ev('item/started', { item: { type: 'commandExecution', id, command, cwd: thread.cwd, status: 'inProgress', commandActions: [{ type: 'unknown', command: 'npm test' }], aggregatedOutput: null, exitCode: null }, startedAtMs: Date.now() })
    let allowed = true
    if (policy === 'untrusted' || (policy === 'on-request' && text.includes('escalate'))) {
      const answer = await ask('item/commandExecution/requestApproval', { kind: 'command', threadId, turnId, itemId: id, startedAtMs: Date.now(), environmentId: 'local', command, cwd: thread.cwd, commandActions: [{ type: 'unknown', command: 'npm test' }], availableDecisions: ['accept', 'cancel'] })
      log({ method: 'approval-answer', params: answer })
      allowed = answer.decision === 'accept'
    }
    if (!allowed) {
      ev('item/completed', { item: { type: 'commandExecution', id, command, cwd: thread.cwd, status: 'declined', commandActions: [], aggregatedOutput: null, exitCode: null } })
    } else {
      ev('item/commandExecution/outputDelta', { itemId: id, delta: 'running tests\n' })
      await sleep(200)
      ev('item/commandExecution/outputDelta', { itemId: id, delta: '3 passed\n' })
      ev('item/completed', { item: { type: 'commandExecution', id, command, cwd: thread.cwd, status: 'completed', commandActions: [], aggregatedOutput: 'running tests\n3 passed\n', exitCode: 0, durationMs: 210 } })
    }
    usage()
  }
  if (text.includes('patch')) {
    const id = 'call-patch'
    const changes = [{ path: join(thread.cwd, 'notes.txt'), kind: { type: 'add' }, diff: '+hello\n' }]
    ev('item/started', { item: { type: 'fileChange', id, changes, status: 'inProgress' } })
    let allowed = true
    if (policy === 'untrusted') {
      const answer = await ask('item/fileChange/requestApproval', { threadId, turnId, itemId: id, startedAtMs: Date.now(), reason: null })
      log({ method: 'approval-answer', params: answer })
      allowed = answer.decision === 'accept'
    }
    ev('item/completed', { item: { type: 'fileChange', id, changes, status: allowed ? 'completed' : 'declined' } })
    if (allowed) ev('turn/diff/updated', { diff: '--- /dev/null\n+++ notes.txt\n+hello\n' })
  }
  if (text.includes('mcp')) {
    const id = 'call-mcp'
    const item = { type: 'mcpToolCall', id, server: 'tickets', tool: 'close_ticket', status: 'inProgress', arguments: { id: 'T-1' }, readOnlyHint: false, result: null, error: null }
    ev('item/started', { item })
    const answer = await ask('item/tool/requestUserInput', { threadId, turnId, itemId: id, isBlocking: true, autoResolutionMs: null, questions: [{ id: `mcp_tool_call_approval_${id}`, header: 'Approve app tool call?', question: 'Allow tickets to run tool "close_ticket"?', isOther: false, isSecret: false, options: [{ label: 'Allow', description: '' }, { label: 'Cancel', description: '' }] }] })
    log({ method: 'approval-answer', params: answer })
    const allowed = answer.answers?.[`mcp_tool_call_approval_${id}`]?.answers?.[0] === 'Allow'
    ev('item/completed', { item: allowed ? { ...item, status: 'completed', result: { content: [{ type: 'text', text: 'Closed T-1.' }] } } : { ...item, status: 'failed', error: { message: 'user cancelled MCP tool call' } } })
  }
  if (text.includes('history')) {
    return message('m-history', [`I remember ${thread.messages.length - 1} earlier message(s).`]).then(() => (usage(), complete('completed')))
  }
  if (turn.steered.length) await message('m-steer', [`Steered: ${turn.steered.join(' | ')}`])
  await message('m-final', ['Hello ', 'there.'])
  usage()
  complete('completed')
}
