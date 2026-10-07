import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import type { RunOptions, RunOutcome } from '../src/main/agent/loop'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import { createWorkersService } from '../src/main/features/workers/service'
import type { RunAgent } from '../src/main/features/workers/runner'
import type { FeatureContext } from '../src/main/features/types'
import { Bonjour } from '../src/main/remote/bonjour'
import { createRemote, lanAddresses } from '../src/main/remote'
import type { StreamEvent, StreamRequest } from '@shared/types'
import { chunk, sseServer } from './helpers'

/**
 * The REAL remote server (routes, key, rate limit, event stream, Bonjour, the
 * gateway's /v1) over a workers engine whose model is fake, so the iPhone app
 * can be developed against it without the Electron app, a window, or any
 * real model. Skips unless EAON_REMOTE_DEMO=1; then it runs until killed.
 *
 *   node scripts/test-main.mjs remote-demo           # bundles it to out/test/ (and skips: no env)
 *   EAON_REMOTE_DEMO=1 node out/test/remote-demo.test.mjs
 *
 * Why not run it through the test runner: `node --test` holds each file's
 * output back until the file ends, so the line with the address would never
 * show. Run directly, the same bundle is a plain process that prints at once
 * and stops on Ctrl-C or SIGTERM.
 *
 *   EAON_REMOTE_DEMO_PORT      default 3266
 *   EAON_REMOTE_DEMO_KEY       default eaonr-demo-key
 *   EAON_REMOTE_DEMO_BONJOUR=0 don't announce over Bonjour (macOS)
 *
 * What the fake agent does with a message (words, any case):
 *   (anything)  two tool steps, then a reply streamed word by word
 *   approve     also asks for approval to send an email (an `approve` ask)
 *   ask         also asks a plain question with options
 *   fail        the turn fails with an error
 *   slow        holds for ten minutes (Stop works), after a first few words
 * It starts with two workers, Nova and Atlas, and a little history. State
 * lives in a throwaway folder; the real app's settings and workers are not
 * touched.
 */

const demo = process.env.EAON_REMOTE_DEMO === '1'
const PORT = Number(process.env.EAON_REMOTE_DEMO_PORT || 3266)
const KEY = process.env.EAON_REMOTE_DEMO_KEY || 'eaonr-demo-key'
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
  })

const has = (text: string, word: string): boolean => new RegExp(`\\b${word}\\b`, 'i').test(text)

test('remote demo: the real remote server over a fake agent, until killed', { skip: !demo && 'set EAON_REMOTE_DEMO=1' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'eaon-remote-demo-'))
  store.setJson('workers.json', [])
  store.patchSettings({ work: { ...store.getSettings().work, defaultFolder: root } })

  // A model for the Mac's chat (/v1) and for workers to be pinned to, behind a fake upstream.
  const upstream = await sseServer((body) => {
    const messages = (body.messages ?? []) as { role: string; content: unknown }[]
    const last = [...messages].reverse().find((m) => m.role === 'user')
    const said = typeof last?.content === 'string' ? last.content : 'something'
    return `This is the demo model on the Mac. You said: ${said}`.split(/(?<= )/).map((word, i, all) => chunk({ content: word }, i === all.length - 1 ? 'stop' : null))
  })
  store.saveProviderConfig({
    ollama: { enabled: false },
    'lm-studio': { enabled: false },
    'llama-cpp': { enabled: false },
    mlx: { enabled: false },
    vllm: { enabled: false },
    jan: { enabled: false },
    demo: { name: 'Demo', kind: 'openai-compatible', baseUrl: upstream.url, models: [{ id: 'demo-fast', label: 'Demo Fast', providerId: 'demo' }, { id: 'demo-deep', label: 'Demo Deep', providerId: 'demo' }] }
  })
  secrets.set('demo', 'demo-key')
  store.patchSettings({ selectedModelId: 'demo-fast', selectedProviderId: 'demo' })

  const ctx = {
    ipcMain: { handle: () => {} },
    getWindow: () => null,
    send: () => {},
    emitStream: () => {}
  } as unknown as FeatureContext

  // The workers engine, created below; the agent needs it to ask questions and set a status.
  let engine: ReturnType<typeof createWorkersService>['engine']

  const runAgent: RunAgent = async (request: StreamRequest, emit: (event: StreamEvent) => void, options: RunOptions): Promise<RunOutcome> => {
    const id = request.messageId
    const workerId = request.workerId!
    const signal = options.signal
    const last = request.history.at(-1)
    const said = (last?.mail?.length ? last.mail.map((m) => m.text).join(' ') : '').trim()
    const prompted = said.length > 0
    const worker = engine.list().find((w) => w.id === workerId)!

    const speak = async (text: string, gap = 40): Promise<void> => {
      for (const word of text.split(/(?<=\s)/)) {
        if (signal?.aborted) return
        emit({ type: 'delta', messageId: id, text: word })
        await sleep(gap, signal)
      }
    }
    const step = async (toolId: string, name: string, input: Record<string, unknown>, output: string): Promise<void> => {
      emit({ type: 'tool-call', messageId: id, toolId, name, input })
      await sleep(350, signal)
      emit({ type: 'tool-result', messageId: id, toolId, output, status: 'done' })
    }
    const cancelled = (text: string): RunOutcome => {
      engine.setStatus(workerId, 'Stopped')
      emit({ type: 'done', messageId: id })
      return { text, usage, cancelled: true }
    }

    if (has(said, 'fail')) {
      await speak('Let me try that… ')
      const error = 'The demo model failed on purpose.'
      emit({ type: 'error', messageId: id, error })
      return { text: '', usage, error }
    }

    engine.setStatus(workerId, prompted ? 'Looking into it' : 'Checking in')
    await speak(prompted ? 'Let me have a look. ' : 'Quick check-in. ')
    await step('demo-1', 'web_search', { query: said || 'anything new' }, 'Three results found.')
    await step('demo-2', 'run_command', { command: 'ls notes' }, 'notes.md\nreport.md\ntodo.md')
    if (signal?.aborted) return cancelled('')

    if (has(said, 'approve')) {
      engine.ask(workerId, {
        question: 'May I email the report to demo@example.com?',
        options: [],
        approve: { tool: 'email_send', input: { to: 'demo@example.com', subject: 'The report' }, summary: 'Send the report to demo@example.com' }
      })
    }
    if (has(said, 'ask')) engine.ask(workerId, { question: 'Which colour should the chart be?', options: ['Red', 'Green', 'Blue'] })

    const reply = prompted
      ? `${worker.name} here. You said "${said.slice(0, 80)}". I looked around and found three notes in my folder:\n- notes.md\n- report.md\n- todo.md\nNothing needs your attention right now.`
      : 'All quiet. Nothing new since the last time I looked.'
    await speak(`\n${reply}`)
    if (signal?.aborted) return cancelled(reply)

    if (has(said, 'slow')) {
      await speak('\nThis one takes a while… ', 120)
      await sleep(10 * 60_000, signal)
      if (signal?.aborted) return cancelled(reply)
    }

    engine.setStatus(workerId, prompted ? 'Reported back' : 'All quiet')
    if (request.goal) {
      // A goal ends after one round, instead of being carried on every minute for ever.
      emit({ type: 'goal', messageId: id, chatId: request.chatId, goal: { text: request.goal.text, status: 'achieved', iterations: 0, summary: 'Done, in the demo.' } })
    }
    emit({ type: 'done', messageId: id })
    return { text: reply, usage }
  }

  const service = createWorkersService(ctx, { runAgent, startDelayMs: 60_000 })
  engine = service.engine
  service.start()
  engine.start()

  const nova = engine.save({
    name: 'Nova',
    color: '#3E86C6',
    personality: 'Warm and curious. Likes a tidy summary.',
    purpose: 'Keeps an eye on the research folder and reports what changed.',
    access: 'autonomous',
    model: { providerId: 'demo', modelId: 'demo-fast' }
  })
  const atlas = engine.save({
    name: 'Atlas',
    color: '#8E5CE6',
    personality: 'Careful and exact. Never touches anything it was not asked to.',
    purpose: 'Reads and summarises papers. Look only: it never changes a file.',
    access: 'read-only',
    model: { providerId: 'demo', modelId: 'demo-deep' }
  })
  engine.addRoutine(atlas.id, { name: 'Morning briefing', task: 'Summarise what is new in the research folder.', daily: '08:30' })
  engine.send(nova.id, 'Hi Nova, what can you do?')
  await engine.whenIdle()
  engine.receive(atlas.id, { from: nova.id, fromName: 'Nova', fromColor: nova.color, text: 'Atlas, could you look into tidal power for me?', files: [] })
  await engine.whenIdle()
  engine.markRead(nova.id)

  store.patchSettings({ remote: { enabled: true, port: PORT, token: KEY } })
  const remote = createRemote({
    hub: service.hub,
    engine,
    remove: service.remove,
    ...(process.env.EAON_REMOTE_DEMO_BONJOUR === '0' ? { bonjour: new Bonjour({ platform: 'linux' }) } : {})
  })
  await remote.launch()
  const status = remote.server.status()
  if (!status.running) {
    upstream.server.close()
    service.stop()
    throw new Error(`The demo server could not start: ${status.error}`)
  }
  const info = await remote.info()
  const host = lanAddresses()[0] ?? '127.0.0.1'
  console.log(`Eaon remote demo ready: url=http://${host}:${status.port} (or http://127.0.0.1:${status.port}) key=${KEY} pair=${info.link} workers=Nova,Atlas`)

  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve())
    process.once('SIGTERM', () => resolve())
  })
  await remote.stop()
  service.stop()
  await engine.whenIdle()
  upstream.server.close()
  await store.flushWrites()
})
