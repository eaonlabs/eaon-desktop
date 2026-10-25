// A stand-in agent CLI that speaks the Agent Client Protocol over stdio, for
// test/acpEngine.test.ts. Behaviour comes from FAKE_ACP_* variables; every
// request it receives is appended (with its argv) to FAKE_ACP_LOG.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const env = process.env
const log = (entry) => env.FAKE_ACP_LOG && appendFileSync(env.FAKE_ACP_LOG, `${JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), ...entry })}\n`)
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } })

let nextId = 1000
const waiting = new Map()
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++
    waiting.set(id, resolve)
    send({ id, method, params })
  })

const signedIn = env.FAKE_ACP_SIGNED_OUT !== '1'
// Copilot's plan answers to `/model <id>`: "auto-only", or "refuse:<id>,<id>" for a plan without those models.
const plan = env.FAKE_ACP_PLAN ?? null
const models = env.FAKE_ACP_MODELS ? env.FAKE_ACP_MODELS.split(',') : null
const sessions = new Set()
let cancelled = null

function sessionResult(sessionId) {
  return {
    sessionId,
    ...(models
      ? { configOptions: [{ id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: models[0], options: models.map((m) => ({ value: m, name: `Model ${m}` })) }] }
      : {})
  }
}

async function prompt(id, params) {
  const { sessionId, prompt } = params
  if (!signedIn || env.FAKE_ACP_EXPIRE_ON_PROMPT === '1') return send({ id, error: { code: -32000, message: 'Authentication required' } })
  cancelled = null
  const text = prompt.find((b) => b.type === 'text')?.text ?? ''
  if (plan && text.startsWith('/model ')) {
    // Answered by the CLI itself, as Copilot does: no model, no tools.
    const model = text.slice('/model '.length)
    const refused = plan === 'auto-only' || (plan.startsWith('refuse:') && plan.slice('refuse:'.length).split(',').includes(model))
    const answer = !refused
      ? `Model changed to: ${model} for this session`
      : plan === 'auto-only'
        ? `Model "${model}" can't be selected — only Auto mode is available on your plan.\n\nUse /model auto to continue, or upgrade your plan for access to individual models.`
        : `Model "${model}" isn't available on your plan.`
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } })
    return send({ id, result: { stopReason: 'end_turn' } })
  }
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking about it.' } })
  if (env.FAKE_ACP_SLOW === '1') {
    await new Promise((resolve) => {
      cancelled = resolve
    })
    return send({ id, result: { stopReason: 'cancelled' } })
  }
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run the tests', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } })
  const answer = await ask('session/request_permission', {
    sessionId,
    toolCall: { toolCallId: 't1', title: 'Run the tests', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } },
    options: [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' }
    ]
  })
  log({ permissionAnswer: answer })
  const allowed = answer?.outcome?.outcome === 'selected' && answer.outcome.optionId === 'yes'
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: allowed ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: allowed ? '3 passing' : 'Rejected' } }] })
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Edit a.txt', kind: 'edit', status: 'pending', locations: [{ path: '/w/a.txt' }] })
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'completed', content: [{ type: 'diff', path: '/w/a.txt', oldText: 'old', newText: 'new' }] })
  update(sessionId, { sessionUpdate: 'plan', entries: [{ content: 'Run tests', status: 'completed', priority: 'high' }, { content: 'Fix', status: 'in_progress', priority: 'high' }] })
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'You said: ' } })
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  send({ id, result: { stopReason: 'end_turn' } })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.jsonrpc !== '2.0') {
    if (message.id !== undefined) send({ id: message.id, error: { code: -32600, message: 'jsonrpc 2.0 required' } })
    return
  }
  if (message.method === undefined) {
    waiting.get(message.id)?.(message.result)
    waiting.delete(message.id)
    return
  }
  log({ method: message.method, params: message.params })
  const { id, method, params } = message
  switch (method) {
    case 'initialize':
      return send({
        id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'fake', title: 'Fake Agent', version: env.FAKE_ACP_VERSION ?? '9.9.9' },
          agentCapabilities: { loadSession: env.FAKE_ACP_NO_LOAD !== '1', sessionCapabilities: { close: {} }, promptCapabilities: { image: true } },
          authMethods: env.FAKE_ACP_TERMINAL_AUTH === '1'
            ? [{ id: 'login', name: 'Log in', _meta: { 'terminal-auth': { command: '/opt/fake', args: ['login'] } } }]
            : [{ id: 'api-key', name: 'API key' }, { id: 'oauth-personal', name: 'Log in with Google' }]
        }
      })
    case 'authenticate':
      return send({ id, result: {} })
    case 'session/new': {
      if (!signedIn) return send({ id, error: { code: -32000, message: 'Authentication required' } })
      const sessionId = `s-${process.pid}-${sessions.size + 1}`
      sessions.add(sessionId)
      send({ id, result: sessionResult(sessionId) })
      // Copilot lists its slash commands just after it answers.
      if (plan && env.FAKE_ACP_NO_COMMANDS !== '1') update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'model', description: 'Select AI model' }, { name: 'usage' }] })
      return
    }
    case 'session/load':
      // A real agent replays the conversation before it answers.
      update(params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier question' } })
      update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'EARLIER ANSWER' } })
      sessions.add(params.sessionId)
      return send({ id, result: {} })
    case 'session/close':
    case 'session/set_config_option':
      return send({ id, result: {} })
    case 'session/prompt':
      return void prompt(id, params)
    case 'session/cancel':
      cancelled?.()
      return
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `no ${method}` } })
  }
})
