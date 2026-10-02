import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import { store } from '../src/main/store'
import { createScheduler } from '../src/main/features/scheduler/service'
import type { FeatureContext } from '../src/main/features/types'
import type { ChatToolPart } from '@shared/types'

/**
 * A scheduled task against a real local model: the timer fires, the real
 * agent loop runs through Ollama with nobody watching, and the chat lands in
 * chats.json. Opt-in (EAON_LIVE=1) and skipped when Ollama or the model is
 * missing, like agent-live.
 */
const MODEL = process.env.EAON_LIVE_MODEL ?? 'nemotron-3-nano:4b'

async function ollamaUp(): Promise<boolean> {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) })
    const body = (await res.json()) as { models?: { name: string }[] }
    return Boolean(body.models?.some((m) => m.name === MODEL))
  } catch {
    return false
  }
}

const headless = {
  ipcMain: { handle: () => {} },
  getWindow: () => null,
  send: () => {},
  emitStream: () => {}
} as unknown as FeatureContext

test('a due Work task runs on a local model and writes its chat', { skip: !process.env.EAON_LIVE, timeout: 300_000 }, async (t) => {
  if (!(await ollamaUp())) return t.skip(`Ollama or ${MODEL} not available`)
  store.setJson('scheduled-tasks.json', [])
  store.saveChats([])
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-sched-live-'))
  const service = createScheduler(headless)
  service.start()
  service.engine.start()
  try {
    const task = service.engine.save({
      name: 'Live check',
      prompt: 'Create a file named status.txt in the work folder containing exactly: scheduled run ok. Then reply with one short sentence saying you did it.',
      schedule: { kind: 'once', at: Date.now() + 1500 },
      mode: 'work',
      model: { providerId: 'ollama', modelId: MODEL },
      cwd,
      allowChanges: true,
      enabled: true
    })
    const started = Date.now()
    while (service.engine.list()[0].history.length === 0) {
      if (Date.now() - started > 10_000) throw new Error('the timer never fired')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await service.engine.whenIdle()
    await store.flushWrites()

    const done = service.engine.list()[0]
    const run = done.history[0]
    const chat = store.getChats().find((c) => c.id === run.chatId)
    const tools = chat?.messages[1].parts.filter((p): p is ChatToolPart => p.type === 'tool') ?? []
    console.log(`run: ${run.status} in ${run.finishedAt! - run.startedAt}ms | tools: ${tools.map((p) => `${p.name}:${p.status}`).join(', ')} | summary: ${run.summary ?? run.error}`)
    assert.equal(run.status, 'succeeded', run.error)
    assert.equal(run.trigger, 'schedule')
    assert.equal(done.id, task.id)
    assert.ok(chat, 'the chat is in chats.json')
    assert.ok(tools.some((p) => p.name === 'write_file' && p.status === 'done'), 'write_file ran without an approval prompt')
    assert.ok(existsSync(join(cwd, 'status.txt')))
    assert.match(readFileSync(join(cwd, 'status.txt'), 'utf8'), /scheduled run ok/)
  } finally {
    service.stop()
  }
})
