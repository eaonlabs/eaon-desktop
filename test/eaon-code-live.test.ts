/**
 * Drives a real `eaon-code --mode rpc` process through the Code tab's bridge,
 * against a local model in Ollama: start, stream a reply, abort a turn,
 * resume a saved session, and plan/swarm where the build supports them.
 *
 * Skips unless eaon-code is installed and Ollama answers. Nothing touches the
 * user's own Eaon Code config: the agent dir (models.json, sessions) is a
 * temp folder passed through EAON_CODE_CODING_AGENT_DIR.
 *
 *   EAON_CODE_TEST_MODEL      ollama model id (default nemotron-3-nano:4b)
 *   EAON_CODE_TEST_BINARIES   extra binaries to run the same checks against,
 *                             separated by the path delimiter (e.g. a source build)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { EaonCodeBridge } from '../src/main/features/eaonCode/bridge'
import { findOnPath } from '../src/main/features/eaonCode/locate'
import { applyEvents, emptyTranscript, transcriptFromMessages, type Transcript } from '../src/renderer/src/components/code/transcript'
import type { EaonEvent, EaonProcessInfo, EaonSessionState, EaonSessionStats } from '@shared/eaonCode'

const MODEL = process.env.EAON_CODE_TEST_MODEL ?? 'nemotron-3-nano:4b'
const OLLAMA = 'http://127.0.0.1:11434/v1'

async function ollamaUp(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA}/models`, { signal: AbortSignal.timeout(3000) })
    const body = (await res.json()) as { data?: { id: string }[] }
    return Boolean(body.data?.some((m) => m.id === MODEL))
  } catch {
    return false
  }
}

const binaries = [
  process.env.EAON_CODE_TEST_SKIP_PATH ? null : findOnPath('eaon-code'),
  ...(process.env.EAON_CODE_TEST_BINARIES ?? join(homedir(), 'Downloads/eaon-code-main/packages/coding-agent/dist/bundle/cli.js'))
    .split(delimiter)
    .filter(Boolean)
].filter((path): path is string => Boolean(path && existsSync(path)))

function harness(binary: string) {
  const agentDir = mkdtempSync(join(tmpdir(), 'eaon-code-agent-'))
  writeFileSync(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        ollama: {
          baseUrl: OLLAMA,
          api: 'openai-completions',
          apiKey: 'ollama',
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [{ id: MODEL, reasoning: true, contextWindow: 32768, maxTokens: 4096 }]
        }
      }
    })
  )
  // Pin the default model so the session does not pick something else.
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'ollama', defaultModel: MODEL }))
  const project = mkdtempSync(join(tmpdir(), 'eaon-code-project-'))
  writeFileSync(join(project, 'README.md'), '# Scratch project\n')

  const batches: EaonEvent[][] = []
  const processes: EaonProcessInfo[] = []
  let transcript: Transcript = emptyTranscript()
  let waiters: { predicate: (e: EaonEvent) => boolean; resolve: () => void }[] = []
  const bridge = new EaonCodeBridge({
    getSettings: () => ({ binaryPath: binary, shareKeys: false }),
    getKey: () => undefined,
    env: { ...process.env, EAON_CODE_CODING_AGENT_DIR: agentDir },
    onEvents: (events) => {
      batches.push(events)
      transcript = applyEvents(transcript, events)
      for (const event of events) {
        waiters = waiters.filter((w) => {
          if (!w.predicate(event)) return true
          w.resolve()
          return false
        })
      }
    },
    onProcess: (info) => processes.push(info)
  })
  const waitFor = (predicate: (e: EaonEvent) => boolean, ms = 180_000): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const seen = batches.flat().map((e) => e.type)
        const counts = seen.reduce<Record<string, number>>((acc, type) => ({ ...acc, [type]: (acc[type] ?? 0) + 1 }), {})
        const stderr = bridge.processInfo().stderr.trim().split('\n').slice(-5).join('\n')
        reject(new Error(`timed out waiting for an event after ${ms}ms; seen ${JSON.stringify(counts)}; stderr: ${stderr}`))
      }, ms)
      waiters.push({
        predicate,
        resolve: () => {
          clearTimeout(timer)
          resolve()
        }
      })
    })
  return {
    bridge,
    project,
    agentDir,
    batches,
    processes,
    waitFor,
    transcript: () => transcript,
    reset: () => {
      transcript = emptyTranscript()
    }
  }
}

const lastAssistant = (t: Transcript) => [...t.items].reverse().find((item) => item.kind === 'assistant')

for (const binary of binaries) {
  test(`live RPC session via ${binary}`, { timeout: 600_000 }, async (t) => {
    if (!(await ollamaUp())) {
      t.skip(`Ollama is not serving ${MODEL}`)
      return
    }
    const h = harness(binary)
    try {
      const status = await h.bridge.status(true)
      assert.equal(status.state, 'ready', status.error)
      t.diagnostic(`eaon-code ${status.version} at ${status.binaryPath}`)

      // --- start ---
      const snapshot = await h.bridge.start(h.project)
      assert.equal(snapshot.state.model?.provider, 'ollama')
      assert.equal(snapshot.state.model?.id, MODEL)
      assert.ok(snapshot.models.some((m) => m.id === MODEL))
      assert.ok(Array.isArray(snapshot.commands))
      assert.equal(h.processes.at(-1)?.state, 'running')
      const supportsModes = typeof snapshot.state.planMode === 'boolean'
      t.diagnostic(`plan/swarm over RPC: ${supportsModes ? 'supported' : 'not supported by this build'}`)

      // --- prompt, streamed ---
      const settled = h.waitFor((e) => e.type === 'agent_settled')
      await h.bridge.command({ type: 'prompt', message: 'Reply with the single word PONG and nothing else.' })
      await settled
      const deltas = h.batches.flat().filter((e) => e.type === 'message_update')
      const reply = lastAssistant(h.transcript())
      assert.ok(reply && reply.kind === 'assistant')
      const text = reply.blocks.map((b) => (b && b.kind !== 'tool' ? b.text : '')).join('')
      assert.ok(text.length > 0, 'the reply streamed into the transcript')
      assert.ok(h.batches.length < deltas.length + 20, 'deltas were batched, not sent one per IPC message')
      t.diagnostic(`reply: ${JSON.stringify(text.slice(-120))} · ${deltas.length} delta events in ${h.batches.length} batches`)

      const stats = (await h.bridge.command({ type: 'get_session_stats' })) as EaonSessionStats
      assert.ok(stats.tokens.total > 0, 'session stats report tokens')
      assert.equal(stats.userMessages, 1)
      t.diagnostic(`stats: ${stats.tokens.total} tokens, context ${stats.contextUsage?.percent ?? '?'}%`)

      // --- abort mid-stream ---
      const firstDelta = h.waitFor((e) => e.type === 'message_update')
      const abortSettled = h.waitFor((e) => e.type === 'agent_settled')
      await h.bridge.command({ type: 'prompt', message: 'Write the numbers from 1 to 400, one per line, with a short fact about each.' })
      await firstDelta
      await h.bridge.command({ type: 'abort' })
      await abortSettled
      const aborted = lastAssistant(h.transcript())
      assert.equal(aborted?.kind === 'assistant' && aborted.stopReason, 'aborted')
      t.diagnostic('abort: turn stopped with stopReason "aborted"')

      // --- modes, or graceful absence ---
      if (supportsModes) {
        await h.bridge.command({ type: 'set_plan_mode', enabled: true })
        await h.bridge.command({ type: 'set_swarm_mode', enabled: true })
        await h.bridge.command({ type: 'new_session' })
        const state = (await h.bridge.command({ type: 'get_state' })) as EaonSessionState
        assert.equal(state.planMode, true, 'plan mode survives new_session')
        assert.equal(state.swarmMode, true, 'swarm mode survives new_session')
        await h.bridge.command({ type: 'set_plan_mode', enabled: false })
        await h.bridge.command({ type: 'set_swarm_mode', enabled: false })
      } else {
        await assert.rejects(h.bridge.command({ type: 'set_plan_mode', enabled: true }), /Unknown command/)
      }

      // --- resume: the first session is on disk and comes back whole ---
      const sessions = await h.bridge.sessions(h.project)
      const first = sessions.find((s) => s.firstMessage.includes('PONG'))
      assert.ok(first, `saved session listed (found ${sessions.length})`)
      await h.bridge.stop()
      assert.equal(h.processes.at(-1)?.state, 'idle')
      const resumed = await h.bridge.start(h.project, { sessionPath: first.path })
      assert.equal(resumed.state.sessionFile, first.path)
      const restored = transcriptFromMessages(resumed.messages)
      const prompts = restored.items.filter((i) => i.kind === 'user').map((i) => (i.kind === 'user' ? i.text : ''))
      assert.ok(prompts.some((p) => p.includes('PONG')), 'the resumed transcript has the original prompt')
      t.diagnostic(`resume: ${restored.items.length} transcript items from ${resumed.messages.length} messages`)

      // --- switch_session on the live process ---
      await h.bridge.command({ type: 'new_session' })
      await h.bridge.command({ type: 'switch_session', sessionPath: first.path })
      const switched = (await h.bridge.command({ type: 'get_state' })) as EaonSessionState
      assert.equal(switched.sessionFile, first.path)

      // --- the RPC bash command streams and returns ---
      const bash = (await h.bridge.command({ type: 'bash', command: 'echo from-bash', id: 'bash-live' })) as { output: string; exitCode: number }
      assert.match(bash.output, /from-bash/)
      assert.equal(bash.exitCode, 0)
    } finally {
      await h.bridge.stop()
    }
  })
}

test('a crash is reported, not swallowed', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eaon-code-fake-'))
  const fake = join(dir, 'eaon-code')
  // Answers --version, then dies as soon as RPC mode starts.
  writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 9.9.9; exit 0; fi\necho "boom: config is broken" >&2\nexit 3\n', { mode: 0o755 })
  const infos: EaonProcessInfo[] = []
  const bridge = new EaonCodeBridge({
    getSettings: () => ({ binaryPath: fake, shareKeys: false }),
    getKey: () => undefined,
    onEvents: () => {},
    onProcess: (info) => infos.push(info)
  })
  await assert.rejects(bridge.start(dir), /exited with code 3[\s\S]*boom: config is broken/)
  assert.equal(infos.at(-1)?.state, 'exited')
})
