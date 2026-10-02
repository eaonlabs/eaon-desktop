import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import '../src/main/features/computerUse'
import { runAgent } from '../src/main/agent/loop'
import { store, defaultSettings } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import { setInputBackend } from '../src/main/features/computer/backend'
import type { InputBackend } from '../src/main/features/computer/input'
import type { StreamEvent, StreamRequest } from '@shared/types'
import { chunk, sseServer } from './helpers'

/**
 * The computer tool's approval paths, through the real loop with a scripted
 * provider and a recording input backend — so "was this click performed
 * without asking?" is answered without sending a single real event.
 */

const calls: string[] = []
const fake: InputBackend = {
  name: 'fake',
  check: async () => ({ available: true, trusted: true, locked: false }),
  move: async (p) => void calls.push(`move ${p.x},${p.y}`),
  click: async (p, button, clicks) => void calls.push(`click ${p.x},${p.y} ${button} ${clicks}`),
  drag: async () => void calls.push('drag'),
  scroll: async () => void calls.push('scroll'),
  type: async (text) => void calls.push(`type ${text}`),
  key: async (combo) => void calls.push(`key ${[...combo.modifiers, combo.key].join('+')}`),
  cursor: async () => ({ x: 10, y: 10 }),
  frontmost: async () => ({ name: 'TextEdit', pid: 99999, bundleId: 'com.apple.TextEdit' }),
  activate: async () => {},
  locked: async () => false,
  openApp: async (name) => void calls.push(`open ${name}`),
  dispose: () => {}
}

const toolCall = (args: Record<string, unknown>): string[] => [
  chunk({ tool_calls: [{ index: 0, id: 'c_computer', function: { name: 'computer', arguments: JSON.stringify(args) } }] }, 'tool_calls')
]
const say = (text: string): string[] => [chunk({ content: text }, 'stop')]

async function turn(
  args: Record<string, unknown>,
  approve: boolean
): Promise<{ asked: { tool: string; input: Record<string, unknown> }[]; result: Extract<StreamEvent, { type: 'tool-result' }> }> {
  let index = 0
  const { server, url } = await sseServer(() => (index++ === 0 ? toolCall(args) : say('done')))
  store.saveProviderConfig({
    fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: url, models: [{ id: 'fake-model', label: 'Fake', providerId: 'fake' }] }
  })
  secrets.set('fake', 'key')
  const request: StreamRequest = {
    chatId: 'cu-chat',
    messageId: `m${Math.random()}`,
    providerId: 'fake',
    modelId: 'fake-model',
    effort: 'medium',
    mode: 'work',
    history: [{ id: 'u1', role: 'user', createdAt: 0, parts: [{ type: 'text', text: 'use the computer' }] }],
    summary: null,
    projectInstructions: '',
    cwd: mkdtempSync(join(tmpdir(), 'eaon-cu-')),
    work: { swarm: false, plan: false },
    goal: null
  }
  const asked: { tool: string; input: Record<string, unknown> }[] = []
  const events: StreamEvent[] = []
  await runAgent(request, (e) => events.push(e), { approver: async (tool, input) => (asked.push({ tool, input }), approve) })
  server.close()
  const result = events.find((e) => e.type === 'tool-result') as Extract<StreamEvent, { type: 'tool-result' }>
  return { asked, result }
}

function configure(approvalMode: 'ask' | 'auto', confirmEachAction: boolean): void {
  store.patchSettings({ approvalMode, computerUse: { ...defaultSettings.computerUse, enabled: true, confirmEachAction } })
  calls.length = 0
}

before(() => setInputBackend(fake))
after(() => {
  setInputBackend(null)
  store.patchSettings({ computerUse: { ...defaultSettings.computerUse } })
})

test('ask mode: a denied click is not performed, and the user is asked once', async () => {
  configure('ask', true)
  const { asked, result } = await turn({ action: 'click', x: 640, y: 400, screenshot: false }, false)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].tool, 'computer')
  assert.deepEqual(calls, [])
  assert.equal(result.status, 'denied')
})

test('ask mode: an approved click lands on the mapped screen point, with no second prompt', async () => {
  configure('ask', true)
  const { asked, result } = await turn({ action: 'click', x: 640, y: 400, screenshot: false }, true)
  assert.equal(asked.length, 1, 'the loop asked; the tool did not ask again')
  // Stub main display: 1440×900 pt at 2× → a 1280×800 screenshot.
  assert.deepEqual(calls, ['click 720,450 left 1'])
  assert.equal(result.status, 'done')
})

test('auto mode with "Confirm each action": clicks and typing still ask, naming the app', async () => {
  configure('auto', true)
  const click = await turn({ action: 'click', x: 10, y: 10, screenshot: false }, false)
  assert.equal(click.asked.length, 1)
  assert.equal(click.asked[0].tool, 'computer')
  assert.equal(click.asked[0].input.app, 'TextEdit')
  const typed = await turn({ action: 'type', text: 'hello', screenshot: false }, false)
  assert.equal(typed.asked.length, 1)
  assert.deepEqual(calls, [], 'nothing was performed after a denial')
  assert.match(typed.result.output, /declined/)
})

test('auto mode with "Confirm each action": pointer moves and scrolls do not ask', async () => {
  configure('auto', true)
  const move = await turn({ action: 'move', x: 100, y: 100, screenshot: false }, false)
  const scroll = await turn({ action: 'scroll', dy: 3, screenshot: false }, false)
  assert.equal(move.asked.length + scroll.asked.length, 0)
  assert.deepEqual(calls, ['move 112.5,112.5', 'scroll'])
})

test('auto mode without confirmation: a click runs without asking, but cmd+q still asks', async () => {
  configure('auto', false)
  const click = await turn({ action: 'click', x: 0, y: 0, screenshot: false }, false)
  assert.equal(click.asked.length, 0)
  assert.deepEqual(calls, ['click 0,0 left 1'])
  calls.length = 0
  const quit = await turn({ action: 'key', keys: 'cmd+q', screenshot: false }, false)
  assert.equal(quit.asked.length, 1, 'risky combos ask even in auto mode')
  assert.deepEqual(calls, [])
})
