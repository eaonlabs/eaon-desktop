import { randomUUID } from 'node:crypto'
import { describeSchedule, type ScheduledTask } from '@shared/scheduler'
import type { Chat, ChatMessage, ModelInfo, Provider, Settings, StreamEvent, StreamRequest } from '@shared/types'
import type { RunOptions, RunOutcome } from '../../agent/loop'
import { listProviders } from '../../providers'
import { store } from '../../store'
import type { RunHandle, RunResult } from './engine'
import { applyStreamEvent, summariseReply } from './transcript'

/**
 * One scheduled run: build the chat, run the agent headlessly, report back.
 *
 * The runner keeps the authoritative copy of the chat and hands it to a
 * `ChatSink` at the start and the end; the sink decides whether that means
 * the renderer (window open) or chats.json (window closed). Stream events go
 * to the sink too, so a chat the user has open fills in live.
 */

export interface ChatSink {
  /** The chat as it stands. Called when the run starts and when it ends. */
  put: (chat: Chat) => Promise<void>
  stream: (event: StreamEvent) => void
}

export type RunAgent = (request: StreamRequest, emit: (event: StreamEvent) => void, options: RunOptions) => Promise<RunOutcome>

export interface RunnerDeps {
  runAgent: RunAgent
  sink: ChatSink
  notify: (task: ScheduledTask, chatId: string, result: RunResult) => void
}

type Resolved = { ok: true; providerId: string; modelId: string; model: ModelInfo | undefined } | { ok: false; error: string }

/**
 * The model a task runs on. A task pinned to a model uses it as long as its
 * provider is usable; otherwise it follows the app's current choice, resolved
 * the way the composer does (`currentModel()` in the renderer store).
 */
export function resolveModel(task: ScheduledTask, settings: Settings, providers: Provider[] = listProviders()): Resolved {
  const usable = providers.filter((p) => p.enabled && (p.hasKey || p.local))
  if (task.model) {
    const provider = usable.find((p) => p.id === task.model!.providerId)
    if (!provider) {
      const known = providers.find((p) => p.id === task.model!.providerId)
      return {
        ok: false,
        error: known
          ? `${known.name} is turned off or has no key, so this task's model (${task.model.modelId}) is unavailable. Fix it in Settings → Model providers, or edit the task to use another model.`
          : `This task's model provider (${task.model.providerId}) no longer exists. Edit the task to pick another model.`
      }
    }
    return { ok: true, providerId: provider.id, modelId: task.model.modelId, model: provider.models.find((m) => m.id === task.model!.modelId) }
  }
  const models = usable.flatMap((p) => p.models)
  const chosen =
    models.find((m) => m.id === settings.selectedModelId && m.providerId === settings.selectedProviderId) ??
    models.find((m) => m.id === settings.selectedModelId) ??
    models[0]
  if (!chosen) return { ok: false, error: 'No model is available. Add an API key in Settings → Model providers, or pick a model for this task.' }
  return { ok: true, providerId: chosen.providerId, modelId: chosen.id, model: chosen }
}

/** Chat workspace is id `work`, Work is `code` — see DEFAULT_WORKSPACES for why. */
function workspaceFor(task: ScheduledTask): { id: string; cwd: string | null } {
  const kind = task.mode === 'work' ? 'work' : 'chat'
  const workspace = store.getWorkspaces().find((w) => w.kind === kind)
  return { id: workspace?.id ?? (kind === 'work' ? 'code' : 'work'), cwd: workspace?.cwd ?? null }
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
  // Effort vocabularies differ per model; clamp the app's level the way the
  // composer does when the model changes.
  const efforts = target.ok ? (target.model?.efforts ?? []) : []
  const effort = efforts.length > 0 && !efforts.includes(settings.effort) ? efforts[efforts.length - 1] : settings.effort
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
    await deps.sink.put(chat)
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
    const outcome = await deps.runAgent(
      request,
      (event) => {
        applyStreamEvent(chat, event)
        deps.sink.stream(event)
      },
      {
        signal: handle.signal,
        unattended: task.mode === 'work' && task.allowChanges ? 'safe' : 'read-only',
        // Only reached by a tool's own extra confirmation (computer use asking
        // before each click); with nobody to ask, the answer is no.
        approver: async () => false
      }
    )
    const cancelled = handle.signal.aborted && !outcome.error
    if (outcome.error && !assistant.error) assistant.error = outcome.error
    chat.updatedAt = Date.now()
    await deps.sink.put(chat)
    const summary = summariseReply(outcome.text)
    result = {
      status: outcome.error ? 'failed' : cancelled ? 'cancelled' : 'succeeded',
      chatId: chat.id,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(summary ? { summary } : !outcome.error && !cancelled ? { summary: 'Finished without a written reply.' } : {})
    }
  }
  deps.notify(task, chat.id, result)
  return result
}
