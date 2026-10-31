import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../src/main/agent/sources'
import { runAgent } from '../src/main/agent/loop'
import { registerAdapter } from '../src/main/providers'
import type { TurnRequest } from '../src/main/providers/adapters/types'
import { ClaudeAgentError } from '../src/main/providers/claudeAgent/session'
import { noteClaudeCodeStatus } from '../src/main/engines/claude/status'
import type { StreamEvent, StreamRequest } from '@shared/types'

/**
 * Claude Agent as Eaon's loop sees it: Claude Code retries for itself, so
 * the loop doesn't again; and the loop says which turn each step is of, and
 * when that turn is over, so a session waiting on a call can be let go.
 */

// Claude Code signed in with a Claude account, as the engine's check would have found it.
noteClaudeCodeStatus({
  id: 'claude',
  name: 'Claude Agent',
  installed: true,
  path: '/usr/local/bin/claude',
  foundIn: 'PATH',
  version: '2.1.304',
  latestVersion: null,
  updateAvailable: false,
  outdated: false,
  minVersion: null,
  updateHint: null,
  auth: { state: 'signed-in', method: 'Claude account', plan: 'Max' },
  error: null,
  checkedAt: Date.now()
})

function turn(messageId: string): StreamRequest {
  return {
    chatId: 'claude-loop',
    messageId,
    providerId: 'claude-agent',
    modelId: 'haiku',
    effort: 'medium',
    mode: 'chat',
    history: [{ id: 'u1', role: 'user', createdAt: 0, parts: [{ type: 'text', text: 'hello' }] }],
    summary: null,
    projectInstructions: '',
    cwd: null,
    work: { swarm: false, plan: false },
    goal: null
  }
}

test('a Claude Agent failure is said at once, not retried as if the provider were busy', async () => {
  let calls = 0
  const ended: string[] = []
  registerAdapter('claude-agent', {
    id: 'claude-agent',
    managesContext: true,
    async turn() {
      calls++
      throw new ClaudeAgentError('Claude: API Error: Repeated 529 Overloaded errors')
    },
    endTurn: (id) => ended.push(id)
  })
  const events: StreamEvent[] = []
  const started = Date.now()
  await runAgent(turn('reply-retry'), (e) => events.push(e), { approver: async () => true })
  assert.equal(calls, 1, 'Claude Code already retried; the loop starts no new session for it')
  assert.ok(Date.now() - started < 1500)
  const said = JSON.stringify(events)
  assert.doesNotMatch(said, /retrying in/i)
  assert.match(said, /Overloaded/)
  assert.deepEqual(ended, ['reply-retry'], 'the turn’s end is said, failed or not')
})

test('each step names its turn, and the turn’s end is said once it is over', async () => {
  const seen: (string | undefined)[] = []
  const ended: string[] = []
  registerAdapter('claude-agent', {
    id: 'claude-agent',
    managesContext: true,
    async turn(request: TurnRequest) {
      seen.push(request.turnId)
      request.onText('Hi.')
      return { text: 'Hi.', calls: [], stop: 'end', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }
    },
    endTurn: (id) => ended.push(id)
  })
  await runAgent(turn('reply-ok'), () => {}, { approver: async () => true })
  assert.deepEqual(seen, ['reply-ok'])
  assert.deepEqual(ended, ['reply-ok'])
})
