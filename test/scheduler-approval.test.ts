import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import { runAgent } from '../src/main/agent/loop'
import type { ToolContext } from '../src/main/agent/tools'
import { createScheduler, type SchedulerService } from '../src/main/features/scheduler/service'
import { leavesChangingTask, scheduleTool } from '../src/main/features/scheduler/tool'
import type { FeatureContext } from '../src/main/features/types'
import { secrets } from '../src/main/secrets'
import { store } from '../src/main/store'
import { WEEKDAYS, type TaskDraft } from '@shared/scheduler'
import type { StreamRequest } from '@shared/types'
import { chunk, sseServer } from './helpers'

/**
 * The `schedule` tool plants work that runs later with nobody to approve it.
 * Creating or changing a task that may make changes is therefore risky: "Approve
 * for me" asks about it, as it does about a command that can do damage. A task
 * that only reads, a rename and pausing are left as they were.
 */

let service: SchedulerService | null = null

beforeEach(() => {
  store.setJson('scheduled-tasks.json', [])
  store.setJson('scheduled-runs.json', [])
})

afterEach(async () => {
  service?.stop()
  await service?.engine.whenIdle()
  service = null
  store.patchSettings({ approvalMode: 'ask' })
  await store.flushWrites()
})

function scheduler(): SchedulerService {
  const ctx = { ipcMain: { handle: () => {} }, getWindow: () => null, send: () => {}, emitStream: () => {} } as unknown as FeatureContext
  service = createScheduler(ctx, { runAgent: async () => ({ text: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }) })
  service.start()
  return service
}

const draft = (overrides: Partial<TaskDraft> = {}): TaskDraft => ({
  name: 'Existing',
  prompt: 'Look at my notifications.',
  schedule: { kind: 'daily', time: '09:00', days: WEEKDAYS },
  mode: 'work',
  model: null,
  cwd: null,
  allowChanges: true,
  enabled: true,
  ...overrides
})

test('which schedule calls count as risky', () => {
  const { engine } = scheduler()
  const changing = engine.save(draft({ name: 'Changing', allowChanges: true }))
  const reading = engine.save(draft({ name: 'Reading', allowChanges: false }))
  const chatOnly = engine.save(draft({ name: 'Chat', mode: 'chat', allowChanges: false }))
  const tool = scheduleTool(engine)
  const ctx = { cwd: '/tmp' } as ToolContext
  const risky = (input: Record<string, unknown>): boolean => tool.risky!(input, ctx)

  // Creating
  assert.equal(risky({ action: 'create', prompt: 'p', schedule: {}, allow_changes: true }), true, 'work is the default mode')
  assert.equal(risky({ action: 'create', prompt: 'p', schedule: {}, allow_changes: true, mode: 'work' }), true)
  assert.equal(risky({ action: 'create', prompt: 'p', schedule: {}, allow_changes: true, mode: 'chat' }), false, 'chat runs cannot change anything')
  assert.equal(risky({ action: 'create', prompt: 'p', schedule: {} }), false, 'read-only by default')
  assert.equal(risky({ action: 'create', prompt: 'p', schedule: {}, allow_changes: 'yes' }), false, 'only a real true counts, as in create')

  // Changing what an existing task does, when it may make changes (or would after the update)
  assert.equal(risky({ action: 'update', id: changing.id, prompt: 'Delete everything.' }), true)
  assert.equal(risky({ action: 'update', id: changing.id, schedule: { type: 'interval', every: 1, unit: 'minutes' } }), true)
  assert.equal(risky({ action: 'update', id: changing.id, folder: '/' }), true)
  assert.equal(risky({ action: 'update', id: reading.id, allow_changes: true }), true, 'turning changes on is the dangerous edit')
  assert.equal(risky({ action: 'update', id: changing.name.toUpperCase(), prompt: 'x' }), true, 'found by name too')
  assert.equal(risky({ action: 'update', id: changing.id, prompt: 'x', mode: 'chat' }), false, 'a chat task cannot change anything')

  // Leaving it as the user approved it
  assert.equal(risky({ action: 'update', id: changing.id, name: 'Renamed' }), false)
  assert.equal(risky({ action: 'update', id: changing.id, enabled: false }), false)
  assert.equal(risky({ action: 'update', id: reading.id, prompt: 'Look at something else.' }), false, 'read-only stays read-only')
  assert.equal(risky({ action: 'update', id: chatOnly.id, prompt: 'x' }), false)
  assert.equal(risky({ action: 'update', id: changing.id, allow_changes: false, prompt: 'x' }), false)
  assert.equal(risky({ action: 'update', id: 'no-such-task', prompt: 'x' }), false, 'fails on its own; nothing to ask about')
  assert.equal(risky({ action: 'list' }), false)
  assert.equal(risky({ action: 'delete', id: changing.id }), false)
  assert.equal(risky({ action: 'run', id: changing.id }), false, 'running what the user already approved')
  assert.equal(leavesChangingTask({ action: 'create', allow_changes: true }, () => changing), true)
})

/* ----------------------------------- through the real loop, in auto mode */

async function modelThatSchedules(args: Record<string, unknown>): Promise<{ url: string; close: () => void }> {
  const { url, server } = await sseServer((body) => {
    const toolTurns = (body.messages as { role: string }[]).filter((m) => m.role === 'tool').length
    if (toolTurns === 0) {
      return [chunk({ tool_calls: [{ index: 0, id: 's1', function: { name: 'schedule', arguments: JSON.stringify(args) } }] }), chunk({}, 'tool_calls'), '[DONE]']
    }
    return [chunk({ content: 'Done.' }), chunk({}, 'stop'), '[DONE]']
  })
  store.saveProviderConfig({
    fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: url, enabled: true, models: [{ id: 'fake-1', label: 'Fake 1', providerId: 'fake' }] }
  })
  secrets.set('fake', 'test-key')
  return { url, close: () => server.close() }
}

async function askInAutoMode(args: Record<string, unknown>, answer: boolean): Promise<{ asked: string[]; tasks: number }> {
  store.patchSettings({ approvalMode: 'auto' })
  const model = await modelThatSchedules(args)
  const { engine } = scheduler()
  const asked: string[] = []
  const request = {
    chatId: 'chat-auto',
    messageId: 'msg-auto',
    providerId: 'fake',
    modelId: 'fake-1',
    effort: 'medium',
    mode: 'work',
    history: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Set something up for me.' }], createdAt: Date.now() }],
    summary: null,
    projectInstructions: '',
    cwd: mkdtempSync(join(tmpdir(), 'eaon-sched-approval-')),
    work: { swarm: false, plan: false },
    goal: null
  } as unknown as StreamRequest
  try {
    await runAgent(request, () => {}, {
      approver: async (name) => {
        asked.push(name)
        return answer
      }
    })
  } finally {
    model.close()
  }
  return { asked, tasks: engine.list().length }
}

const everyMorning = { type: 'daily', time: '09:00', days: 'weekdays' }

test('in Approve for me, a task that may make changes is asked about, and not created when refused', { timeout: 30_000 }, async () => {
  const refused = await askInAutoMode({ action: 'create', name: 'Planted', prompt: 'Run the cleanup script.', schedule: everyMorning, allow_changes: true }, false)
  assert.deepEqual(refused.asked, ['schedule'], 'the user is asked')
  assert.equal(refused.tasks, 0, 'refused: nothing was scheduled')
})

test('in Approve for me, a task that may make changes is created once the user says yes', { timeout: 30_000 }, async () => {
  const approved = await askInAutoMode({ action: 'create', name: 'Approved', prompt: 'Run the cleanup script.', schedule: everyMorning, allow_changes: true }, true)
  assert.deepEqual(approved.asked, ['schedule'])
  assert.equal(approved.tasks, 1)
})

test('in Approve for me, a read-only task is still created without asking, as before', { timeout: 30_000 }, async () => {
  const quiet = await askInAutoMode({ action: 'create', name: 'Reader', prompt: 'Summarise the news.', schedule: everyMorning }, false)
  assert.deepEqual(quiet.asked, [])
  assert.equal(quiet.tasks, 1)
})
