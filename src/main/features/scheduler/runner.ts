import { randomUUID } from 'node:crypto'
import { describeSchedule, type ScheduledTask } from '@shared/scheduler'
import type { Chat, ChatMessage, ModelInfo, Provider, Settings, StreamEvent, StreamRequest } from '@shared/types'
import { clampEffort } from '@shared/effort'
import { findModel, isProviderUsable, resolveSelection } from '@shared/modelSelection'
import type { RunOptions, RunOutcome } from '../../agent/loop'
import { listProviders } from '../../providers'
import { store } from '../../store'
import type { RunHandle, RunResult } from './engine'
import { applyStreamEvent, summariseReply } from './transcript'
import { withUsageSource } from '../usage/attribution'

/**
 * One scheduled run: build the chat, run the agent headlessly, report back.
 *
 * The runner keeps the authoritative copy of the chat and hands it to a
 * `ChatSink` at the start and the end; the sink decides whether that means
 * the renderer (window open) or chats.json (window closed). Stream events go
 * to the sink too, so a chat the user has open fills in live.
 */

export interface ChatSink {
  /** The chat as it stands. Called when the run starts and when it ends (`done`). */
  put: (chat: Chat, done?: boolean) => Promise<void>
  stream: (event: StreamEvent) => void
}

export type RunAgent = (request: StreamRequest, emit: (event: StreamEvent) => void, options: RunOptions) => Promise<RunOutcome>

export interface RunnerDeps {
  runAgent: RunAgent
  sink: ChatSink
  notify: (task: ScheduledTask, chatId: string, result: RunResult) => void
  /** Overrides STALL_MS; for tests. */
  stallMs?: number
}

/**
 * A run with no sign of life for this long is presumed hung and stopped.
 * Nothing legitimate is silent that long: the model streams as it goes, and
 * the slowest tool (run_command, at most 10 minutes) is killed before then.
 * Without it a stream that died with the network — the Mac slept mid-run —
 * holds the task as running forever, and every later slot is skipped.
 */
export const STALL_MS = 15 * 60_000

type Resolved = { ok: true; providerId: string; modelId: string; model: ModelInfo | undefined } | { ok: false; error: string }

/**
 * The model a task runs on. A task pinned to a model uses it as long as its
 * provider is usable; otherwise it follows the app's current choice, resolved
 * the way the composer does (`currentModel()` in the renderer store).
 */
export function resolveModel(
  task: { model: ScheduledTask['model'] },
  settings: Settings,
  providers: Provider[] = listProviders(),
  /** What the messages call the thing that pinned the model — a task, or a worker. */
  noun = 'task'
): Resolved {
  if (task.model) {
    const provider = providers.find((p) => p.id === task.model!.providerId && isProviderUsable(p))
    if (!provider) {
      const known = providers.find((p) => p.id === task.model!.providerId)
      return {
        ok: false,
        error: known
          ? `${known.name} is turned off or has no key, so this ${noun}'s model (${task.model.modelId}) is unavailable. Fix it in Settings → Model providers, or edit the ${noun} to use another model.`
          : `This ${noun}'s model provider (${task.model.providerId}) no longer exists. Edit the ${noun} to pick another model.`
      }
    }
    // A pinned id the list doesn't show still runs: the list may just be stale
    // (a local runtime not refreshed yet), and the provider is the authority.
    const model = findModel(provider.models, task.model.modelId)
    return { ok: true, providerId: provider.id, modelId: model?.id ?? task.model.modelId, model }
  }
  // Following the app's choice: resolved by the composer's rules
  // (shared/modelSelection). A choice that can't be used fails the run with
  // why; it used to run on whichever model happened to be first instead.
  const selection = resolveSelection({ providerId: settings.selectedProviderId, modelId: settings.selectedModelId }, providers, {
    favorites: settings.favoriteModels,
    recents: settings.recentModels
  })
  if (selection.model) return { ok: true, providerId: selection.model.providerId, modelId: selection.model.id, model: selection.model }
  if (selection.status === 'unavailable') {
    return {
      ok: false,
      error: `Your chosen model (${selection.wanted?.label ?? settings.selectedModelId}) is unavailable: ${selection.reason ?? 'its provider can’t be used now.'} Choose another model in Chat, or pick one for this ${noun}.`
    }
  }
  return { ok: false, error: `No model is available. Add an API key in Settings → Model providers, or pick a model for this ${noun}.` }
}

/**
 * Every run's chat lands in Chat, which is also the agent now that the
 * separate Work tab is gone; the task's mode still decides its tools. Chat's
 * id is `work` — see DEFAULT_WORKSPACES for why.
 */
function workspaceFor(_task: ScheduledTask): { id: string; cwd: string | null } {
  const workspace = store.getWorkspaces().find((w) => w.kind === 'chat')
  return { id: workspace?.id ?? 'work', cwd: workspace?.cwd ?? null }
}

/**
 * Appended to the system prompt as project instructions. The model has to
 * know nobody is there: otherwise it ends a turn with a question nobody will
 * answer, or keeps trying a change the policy is going to refuse.
 */
export function unattendedBrief(task: ScheduledTask): string {
  const lines = [
    `This turn is the scheduled task "${task.name}" (${describeSchedule(task.schedule)}), running unattended. Nobody is watching and nobody can answer questions or approve anything: do the whole task without asking, then end with a short report of what you found or did — that report is what the user will read.`
  ]
  if (task.mode === 'work') {
    lines.push(
      task.allowChanges
        ? 'You may make the changes the task calls for. Risky actions — changing files outside the Work folder, force-pushing, sudo and the like — are refused automatically; if one is needed, say so in your report instead.'
        : 'This run is read-only: every tool that changes anything (writing or deleting files, running shell commands, acting through plugins) will be refused. Research and report; if the task needs a change, describe it rather than attempting it.'
    )
  }
  return lines.join('\n')
}

export async function runScheduledTask(task: ScheduledTask, handle: RunHandle, deps: RunnerDeps): Promise<RunResult> {
  const settings = store.getSettings()
  const target = resolveModel(task, settings)
  const workspace = workspaceFor(task)
  const now = Date.now()

  const userMessage: ChatMessage = {
    id: randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text: task.prompt }],
    createdAt: now,
    scheduledTaskId: task.id
  }
  const assistant: ChatMessage = {
    id: randomUUID(),
    role: 'assistant',
    parts: [],
    createdAt: now + 1,
    scheduledTaskId: task.id,
    ...(target.ok ? { model: target.modelId } : {})
  }
  // The app's level clamped down to what the model takes, as the composer
  // shows it — never bumped to the model's highest, which ran tasks at Max.
  const effort = (target.ok ? clampEffort(settings.effort, target.model?.efforts) : undefined) ?? settings.effort
  const chat: Chat = {
    id: randomUUID(),
    workspaceId: workspace.id,
    projectId: null,
    title: task.name,
    messages: [userMessage, assistant],
    createdAt: now,
    updatedAt: now,
    archived: false,
    pinned: false,
    unread: true,
    modelId: target.ok ? target.modelId : null,
    effort
  }
  handle.setChatId(chat.id)
  await deps.sink.put(chat)

  let result: RunResult
  if (!target.ok) {
    assistant.error = target.error
    chat.updatedAt = Date.now()
    await deps.sink.put(chat, true)
    result = { status: 'failed', chatId: chat.id, error: target.error }
  } else {
    const request: StreamRequest = {
      chatId: chat.id,
      messageId: assistant.id,
      providerId: target.providerId,
      modelId: target.modelId,
      effort,
      mode: task.mode,
      history: [userMessage],
      summary: null,
      projectInstructions: unattendedBrief(task),
      cwd: task.mode === 'work' ? (task.cwd ?? workspace.cwd) : null,
      // Swarm sub-agents run their own approval gate, which does not know
      // about the unattended policy; plan mode would stop at a plan nobody
      // approves. Scheduled runs use neither.
      work: { swarm: false, plan: false },
      goal: null
    }
    // The run's own signal: Stop (the engine's) or the stall watchdog.
    const controller = new AbortController()
    const stop = (): void => controller.abort()
    handle.signal.addEventListener('abort', stop, { once: true })
    const stallMs = deps.stallMs ?? STALL_MS
    let stalled = false
    // Monotonic, like the timer: time asleep does not count, so a local model
    // that carries on after the Mac wakes is not cut off for it.
    let lastSign = performance.now()
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const check = (): void => {
      const quiet = performance.now() - lastSign
      if (quiet < stallMs) {
        watchdog = setTimeout(check, stallMs - quiet)
        return
      }
      stalled = true
      controller.abort()
    }
    let outcome: RunOutcome
    try {
      watchdog = setTimeout(check, stallMs)
      // Stopped while the chat was being saved: an abort that has already
      // happened would never reach runAgent's listener.
      outcome = handle.signal.aborted
        ? { text: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cancelled: true }
        : // Counted under Scheduled tasks in Settings → Usage.
          await withUsageSource('schedule', () =>
            deps.runAgent(
              request,
              (event) => {
                lastSign = performance.now()
                applyStreamEvent(chat, event)
                deps.sink.stream(event)
              },
              {
                signal: controller.signal,
                unattended: task.mode === 'work' && task.allowChanges ? 'safe' : 'read-only',
                // Only reached by a tool's own extra confirmation (computer use asking
                // before each click); with nobody to ask, the answer is no.
                approver: async () => false
              }
            )
          )
    } finally {
      clearTimeout(watchdog)
      handle.signal.removeEventListener('abort', stop)
    }
    const error =
      outcome.error ??
      (stalled
        ? `No progress for ${Math.round(stallMs / 60_000)} minutes, so the run was stopped. The model or a tool stopped responding — a dropped connection, or the computer sleeping mid-run, can do that.`
        : undefined)
    // The loop's own flag as well as ours: Emergency Stop cancels the loop
    // directly, and without it that run was recorded as having succeeded.
    const cancelled = (handle.signal.aborted || outcome.cancelled === true) && !error
    if (error && !assistant.error) assistant.error = error
    chat.updatedAt = Date.now()
    await deps.sink.put(chat, true)
    const summary = summariseReply(outcome.text)
    const used = outcome.usage
    result = {
      status: error ? 'failed' : cancelled ? 'cancelled' : 'succeeded',
      chatId: chat.id,
      ...(used && used.input + used.output + used.cacheRead + used.cacheWrite > 0 ? { tokens: { ...used } } : {}),
      ...(error ? { error } : {}),
      ...(summary ? { summary } : !error && !cancelled ? { summary: 'Finished without a written reply.' } : {})
    }
  }
  deps.notify(task, chat.id, result)
  return result
}
