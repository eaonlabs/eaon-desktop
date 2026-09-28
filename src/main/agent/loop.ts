import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { GoalState, ModelInfo, Provider, Settings, StreamEvent, StreamRequest, TokenUsage } from '@shared/types'
import { adapterFor, getProvider } from '../providers'
import { addUsage, emptyUsage, ProviderHttpError, type Adapter, type Credentials, type NeutralImage, type NeutralMessage, type NeutralToolResult, type TurnRequest, type TurnResult } from '../providers/adapters/types'
import { credentialAttempts, isAuthError } from '../providers/credentials'
import { contextWindowFor } from '../providers/models'
import { store } from '../store'
import { cancelApprovals, requestApproval, type Approver } from './approvals'
import { buildHistory, estimateMessages, estimateTokens, pruneImages, pruneInFlight, transcriptText } from './context'
import { chatSystemPrompt, COMPACTION_PROMPT, workSystemPrompt } from './prompts'
import { capOutput, guidanceFor, isMutating, toolsFor, toSpec, type AgentTool, type ToolContext, type ToolQuery, type TurnState } from './tools'

/**
 * The agent loop — one implementation for every provider and both modes.
 *
 * A turn is: build the transcript to send (trimmed, compacted if needed) →
 * ask the model → run the tools it called → repeat until it answers without
 * calling any. Provider differences live entirely in the adapters; the loop
 * only sees the neutral transcript.
 */

const activeRuns = new Map<string, AbortController>()

export function cancelRun(messageId: string): void {
  activeRuns.get(messageId)?.abort()
  activeRuns.delete(messageId)
  cancelApprovals(messageId)
}

export function isRunning(messageId: string): boolean {
  return activeRuns.has(messageId)
}

/** Where Work mode acts when no project folder has been chosen. */
export async function ensureWorkFolder(requested: string | null, settings: Settings): Promise<string> {
  const folder = requested || settings.work.defaultFolder || join(homedir(), 'Eaon')
  await mkdir(folder, { recursive: true })
  return folder
}

function attachmentsDir(): string {
  const dir = join(app.getPath('userData'), 'attachments')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Tool images live on disk; the transcript only holds their paths. */
function saveImage(image: NeutralImage): string {
  const ext = image.mime === 'image/png' ? 'png' : image.mime === 'image/webp' ? 'webp' : 'jpg'
  const path = join(attachmentsDir(), `tool-${randomUUID()}.${ext}`)
  writeFileSync(path, Buffer.from(image.data, 'base64'))
  return path
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      },
      { once: true }
    )
  })

function isRetryable(error: unknown): boolean {
  if (error instanceof ProviderHttpError) return [408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529].includes(error.status)
  const message = error instanceof Error ? `${error.name} ${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : String(error)
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|terminated|network|overloaded|Connection error|stream ended before/i.test(message)
}

/* ---------------------------------------------------------------- the loop */

export interface LoopParams {
  request: StreamRequest
  provider: Provider
  adapter: Adapter
  modelId: string
  model: ModelInfo | undefined
  system: string
  tools: AgentTool[]
  messages: NeutralMessage[]
  cwd: string
  depth: number
  readOnly: boolean
  settings: Settings
  signal: AbortSignal
  emit: (event: StreamEvent) => void
  approver: Approver
  /** Scheduled tasks: see `RunOptions.unattended`. Unset for interactive turns. */
  unattended?: UnattendedPolicy
  maxRounds: number
  /** Goal mode: the loop sends the agent back to work until it resolves the goal. */
  goal: GoalState | null
  onText: (delta: string) => void
  onReasoning: (delta: string) => void
}

export interface LoopOutcome {
  /** Everything the model said, across rounds. */
  text: string
  usage: TokenUsage
  turn: TurnState
  stopped: 'done' | 'plan' | 'rounds' | 'goal-limit'
}

/**
 * One model request, trying each credential in turn and retrying overloads
 * with a visible status line. A request is only retried if nothing from it has
 * reached the transcript yet — retrying after partial output would duplicate
 * the text the user already saw.
 */
async function callModel(
  params: LoopParams,
  attempts: Credentials[],
  messages: NeutralMessage[],
  note: (text: string) => void
): Promise<TurnResult> {
  let lastError: unknown
  for (let k = 0; k < attempts.length; k++) {
    for (let retry = 0; retry <= 3; retry++) {
      let streamed = false
      const turn: TurnRequest = {
        provider: params.provider,
        modelId: params.modelId,
        model: params.model,
        credentials: attempts[k],
        system: params.system,
        messages,
        tools: params.tools.map(toSpec),
        effort: params.request.effort,
        signal: params.signal,
        cacheKey: params.request.chatId,
        agentic: params.request.mode === 'work',
        onText: (delta) => {
          streamed = true
          params.onText(delta)
        },
        onReasoning: (delta) => {
          streamed = true
          params.onReasoning(delta)
        }
      }
      try {
        return await params.adapter.turn(turn)
      } catch (error) {
        lastError = error
        if (params.signal.aborted) throw error
        // A local runtime that is not running will not start by itself while
        // we wait; say so now instead of after three backoffs.
        if (params.provider.local && /ECONNREFUSED|fetch failed/i.test(`${error instanceof Error ? error.message : ''} ${String((error as { cause?: unknown })?.cause ?? '')}`)) {
          const where = params.provider.baseUrl.replace(/\/v1\/?$/, '')
          throw new Error(`Couldn't reach ${params.provider.name} at ${where}. Start it and try again.`)
        }
        if (isAuthError(error) && k < attempts.length - 1) {
          note('That key was rejected — trying the next saved key.')
          break
        }
        if (!streamed && retry < 3 && isRetryable(error)) {
          const wait = Math.min(
            (error instanceof ProviderHttpError ? error.retryAfterMs : undefined) ?? [2000, 6000, 15000][retry],
            60_000
          )
          const status = error instanceof ProviderHttpError ? ` (${error.status})` : ''
          note(`The provider is busy${status} — retrying in ${Math.round(wait / 1000)}s.`)
          await sleep(wait, params.signal)
          continue
        }
        throw error
      }
    }
  }
  throw lastError
}

async function runTool(
  params: LoopParams,
  turn: TurnState,
  tool: AgentTool | undefined,
  call: { id: string; name: string; input: Record<string, unknown> }
): Promise<NeutralToolResult & { status: 'done' | 'denied' | 'error' }> {
  const { emit, request } = params
  emit({ type: 'tool-call', messageId: request.messageId, toolId: call.id, name: call.name, input: call.input })

  const finish = (
    output: string,
    status: 'done' | 'denied' | 'error',
    images: NeutralImage[] = []
  ): NeutralToolResult & { status: 'done' | 'denied' | 'error' } => {
    const paths = images.map(saveImage)
    emit({ type: 'tool-result', messageId: request.messageId, toolId: call.id, output, status, ...(paths.length ? { images: paths } : {}) })
    return { id: call.id, name: call.name, output, status, ...(images.length ? { images } : {}), ...(status === 'error' ? { isError: true } : {}) }
  }

  if (!tool) {
    const names = params.tools.map((t) => t.name).join(', ')
    return finish(`Unknown tool "${call.name}". Available tools: ${names || 'none'}.`, 'error')
  }
  if ('__invalid_json' in call.input) {
    return finish(`Your arguments were not valid JSON: ${String(call.input.__invalid_json).slice(0, 500)}. Re-issue the call with valid JSON.`, 'error')
  }

  const ctx: ToolContext = {
    request,
    turn,
    cwd: params.cwd,
    signal: params.signal,
    emit,
    toolId: call.id,
    depth: params.depth,
    readOnly: params.readOnly,
    settings: params.settings,
    progress: (output) => emit({ type: 'tool-progress', messageId: request.messageId, toolId: call.id, output }),
    confirm: (title, detail, summary) => params.approver(title, detail, summary)
  }

  if (isMutating(tool, call.input, ctx)) {
    if (params.readOnly) {
      return finish('Plan mode is on, so this tool is disabled. Finish researching and call present_plan.', 'denied')
    }
    const risky = tool.risky?.(call.input, ctx) ?? false
    // Scheduled tasks (features/scheduler): nobody is there to ask, so the
    // task's own policy stands in for the user's approval setting.
    if (params.unattended) {
      if (params.unattended === 'read-only') return finish(UNATTENDED_READ_ONLY, 'denied')
      if (risky) return finish(UNATTENDED_RISKY, 'denied')
    } else if ((params.settings.approvalMode === 'ask' || risky) && !(await params.approver(call.name, call.input, tool.describe?.(call.input)))) {
      return finish('The user denied this action. Do not retry it; continue another way or ask how they would like to proceed.', 'denied')
    }
  }

  try {
    const result = await tool.run(call.input, ctx)
    const normalized = typeof result === 'string' ? { text: result } : result
    return finish(capOutput(normalized.text || '(no output)'), normalized.isError ? 'error' : 'done', normalized.images)
  } catch (error) {
    if (params.signal.aborted) return finish('Stopped by the user.', 'error')
    // Reported to the model rather than failing the turn: models routinely
    // recover by trying different arguments.
    return finish(`Error: ${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

/**
 * True when a reply's ending is a plan for work it has not done: the last
 * stretch says what it will do next and asks the user nothing.
 */
export function announcesIntent(text: string): boolean {
  const tail = text.trim().slice(-280)
  if (!tail || /\?\s*$/.test(tail)) return false
  return /\b(I'll|I will|I'm going to|Let me|Next,? I|Now I'll|I need to|I should)\b|(^|\n)\s*(Steps?|Plan):|(^|\n)\s*1\.\s+(Create|Make|Write|Add|Run|Check|Open|Build)/i.test(tail)
}

export async function runLoop(params: LoopParams): Promise<LoopOutcome> {
  const { messages, signal, request, emit } = params
  const turn: TurnState = { notes: [] }
  const usage = emptyUsage()
  const attempts = await credentialAttempts(params.provider)
  const window = contextWindowFor(params.provider, params.modelId, params.model)
  const toolsByName = new Map(params.tools.map((tool) => [tool.name, tool]))
  const note = (text: string): void => params.onReasoning(`\n${text}\n`)
  let text = ''
  let goalIterations = 0
  let emptyNudges = 0
  let announcedNudged = false
  let goal = params.goal

  for (let round = 0; round < params.maxRounds; round++) {
    // Providers that cannot clear stale tool output server-side get it pruned
    // here, in large batches, once the transcript nears the window.
    if (round > 0 && !params.adapter.managesContext) {
      pruneInFlight(messages, Math.floor(window * 0.55))
      pruneImages(messages)
    }

    const result = await callModel(params, attempts, messages, note)
    addUsage(usage, result.usage)
    if (params.depth === 0) emit({ type: 'usage', messageId: request.messageId, usage: { ...usage } })

    if (result.stop === 'refusal') throw new Error(result.refusal ?? 'The model declined this request.')
    text += result.text

    if (result.stop === 'max_tokens') {
      // A call cut off mid-way may have truncated arguments; never run it.
      messages.push({ role: 'assistant', text: result.text || '(output cut off)', calls: [] })
      if (result.calls.length === 0 && round > 0) break
      messages.push({
        role: 'user',
        text: 'Your last reply hit the output limit and was cut off, so any tool call in it was not run. Continue, and split large files into several smaller write_file/edit_file calls.'
      })
      continue
    }

    // A reply that is only thinking — no text, no call — is a stall, not an
    // answer: smaller models plan the next step in their reasoning and then
    // stop. Treating it as "done" ended turns silently with nothing shown.
    // Nudge them to act, twice at most, without recording the empty turn.
    if (result.calls.length === 0 && !result.text.trim() && emptyNudges < 2 && !signal.aborted) {
      emptyNudges++
      messages.push({
        role: 'user',
        text: 'You only thought about it and did not act. Do the next step now: call a tool, or give your final answer.'
      })
      continue
    }

    messages.push({ role: 'assistant', text: result.text, calls: result.calls, ...(result.replay ? { replay: result.replay } : {}) })

    // The other stall: a Work reply that ends by announcing what it will do
    // ("Steps: 1. Create…", "I'll now write the file") and then stops. Once
    // per turn, and only when the reply is not a question for the user.
    if (
      result.calls.length === 0 &&
      params.request.mode === 'work' &&
      params.depth === 0 &&
      !announcedNudged &&
      !signal.aborted &&
      announcesIntent(result.text)
    ) {
      announcedNudged = true
      messages.push({ role: 'user', text: 'Go ahead and do it now with your tools, then report back.' })
      continue
    }

    if (result.calls.length === 0) {
      // Goal mode: stopping is not the same as finishing.
      if (params.depth === 0 && goal?.status === 'active' && !turn.goalResolution && !signal.aborted) {
        if (goalIterations < params.settings.work.goalMaxIterations) {
          goalIterations++
          goal = { ...goal, iterations: goal.iterations + 1 }
          emit({ type: 'goal', messageId: request.messageId, chatId: request.chatId, goal })
          note(`Continuing toward the goal (${goalIterations}/${params.settings.work.goalMaxIterations}).`)
          messages.push({
            role: 'user',
            text: 'Keep going toward the goal. Take the next concrete step. If it is achieved and verified, call goal_complete; if you are blocked, call goal_blocked.'
          })
          continue
        }
        emit({ type: 'goal', messageId: request.messageId, chatId: request.chatId, goal: { ...goal, status: 'paused' } })
        return { text, usage, turn, stopped: 'goal-limit' }
      }
      return { text, usage, turn, stopped: 'done' }
    }

    // Read-only calls run together; anything that changes state runs in the
    // order the model asked for it.
    const tools = result.calls.map((call) => toolsByName.get(call.name))
    const allReadOnly = tools.every((tool, i) => tool && !isMutating(tool, result.calls[i].input, { settings: params.settings, cwd: params.cwd } as ToolContext))
    const results: NeutralToolResult[] = []
    if (allReadOnly && result.calls.length > 1) {
      results.push(...(await Promise.all(result.calls.map((call, i) => runTool(params, turn, tools[i], call)))))
    } else {
      for (let i = 0; i < result.calls.length; i++) {
        if (signal.aborted) break
        results.push(await runTool(params, turn, tools[i], result.calls[i]))
      }
    }
    if (signal.aborted) throw new Error('aborted')
    messages.push({ role: 'tool', results })
    if (turn.extraUsage) {
      addUsage(usage, turn.extraUsage)
      turn.extraUsage = undefined
      if (params.depth === 0) emit({ type: 'usage', messageId: request.messageId, usage: { ...usage } })
    }

    if (turn.goalResolution && goal) {
      goal = { ...goal, status: turn.goalResolution.status, summary: turn.goalResolution.summary }
      emit({ type: 'goal', messageId: request.messageId, chatId: request.chatId, goal })
    }
    // A presented plan ends the turn: the user decides what happens next.
    if (turn.plan) return { text, usage, turn, stopped: 'plan' }
  }

  if (params.depth === 0) {
    const tail = `\n\n_Stopped after ${params.maxRounds} tool rounds. Say "continue" to keep going, or raise the limit in Settings → Configuration._`
    params.onText(tail)
    text += tail
  }
  return { text, usage, turn, stopped: 'rounds' }
}

/* -------------------------------------------------------------- compaction */

/**
 * Replaces everything before the current request with a summary once the
 * conversation nears the model's window.
 *
 * "Simple compaction": the summary plus the new user message is the whole
 * next request. Keeping some recent turns verbatim alongside a summary is
 * tempting, but newer Claude models bind thinking to the full prefix it was
 * produced under and reject replayed turns whose prefix changed — and a
 * summary with a clean restart is what those models are trained to continue
 * from anyway.
 */
async function compact(
  params: Omit<LoopParams, 'system' | 'tools' | 'messages' | 'maxRounds' | 'goal'>,
  messages: NeutralMessage[],
  window: number
): Promise<string> {
  const attempts = await credentialAttempts(params.provider)
  const transcript = transcriptText(messages, Math.floor(window * 0.5 * 3.6))
  const result = await callModel(
    { ...params, system: COMPACTION_PROMPT, tools: [], messages: [], maxRounds: 1, goal: null, onText: () => {}, onReasoning: () => {} } as LoopParams,
    attempts,
    [{ role: 'user', text: `${transcript}\n\n---\nWrite the summary now.` }],
    () => {}
  )
  return result.text.trim()
}

/* ------------------------------------------------------------- entry point */

/**
 * How a run with nobody watching treats changes, in place of the approval
 * prompt: 'read-only' refuses every mutating call, 'safe' runs ordinary ones
 * and refuses the risky ones "Approve for me" would still stop to ask about.
 */
export type UnattendedPolicy = 'read-only' | 'safe'

const UNATTENDED_READ_ONLY =
  'This scheduled task is read-only — the user did not allow it to make changes — so this action was not run. Do not retry it or look for another way to make the change; finish with what you can find out, and say in your report what you would have changed.'
const UNATTENDED_RISKY =
  'This action needs the user\'s approval, and a scheduled task runs with nobody to ask, so it was not run. Do not retry it; continue without it and mention it in your report.'

export interface RunOptions {
  /** Headless runs (scheduled tasks) answer approvals themselves. */
  approver?: Approver
  signal?: AbortSignal
  /** Set by scheduled tasks; decides mutating calls without asking anyone. */
  unattended?: UnattendedPolicy
}

export interface RunOutcome {
  text: string
  error?: string
  usage: TokenUsage
}

export async function runAgent(request: StreamRequest, emit: (event: StreamEvent) => void, options: RunOptions = {}): Promise<RunOutcome> {
  const usage = emptyUsage()
  const provider = getProvider(request.providerId)
  if (!provider) {
    const error = `Unknown provider "${request.providerId}"`
    emit({ type: 'error', messageId: request.messageId, error })
    return { text: '', error, usage }
  }

  const controller = new AbortController()
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true })
  activeRuns.set(request.messageId, controller)
  let text = ''

  try {
    const settings = store.getSettings()
    const raw = request.rawSystem !== undefined
    const mode = request.mode
    const cwd = mode === 'work' && !raw ? await ensureWorkFolder(request.cwd, settings) : ''
    const readOnly = mode === 'work' && request.work.plan
    const query: ToolQuery = { mode, cwd: cwd || null, depth: 0, readOnly, settings, request }
    const tools = raw ? [] : toolsFor(query)
    const system = raw
      ? (request.rawSystem ?? '')
      : mode === 'chat'
        ? chatSystemPrompt(request.projectInstructions, tools.some((t) => t.name === 'web_search'))
        : workSystemPrompt({
            cwd,
            projectInstructions: request.projectInstructions,
            guidance: guidanceFor(query),
            swarm: request.work.swarm && !readOnly,
            plan: readOnly,
            goal: request.goal
          })

    const model = provider.models.find((m) => m.id === request.modelId)
    const window = contextWindowFor(provider, request.modelId, model)
    const built = buildHistory(request.history, request.summary, settings.context.keepFullToolTurns)
    let messages = built.messages

    const base = {
      request,
      provider,
      adapter: adapterFor(provider),
      modelId: request.modelId,
      model,
      cwd,
      depth: 0,
      readOnly,
      settings,
      signal: controller.signal,
      emit,
      approver:
        options.approver ??
        ((tool: string, input: Record<string, unknown>, summary?: string) => requestApproval(request.messageId, tool, input, emit, summary)),
      unattended: options.unattended,
      onText: (delta: string) => {
        text += delta
        emit({ type: 'delta', messageId: request.messageId, text: delta })
      },
      onReasoning: (delta: string) => emit({ type: 'reasoning', messageId: request.messageId, text: delta })
    }

    // Compact before sending when this request would crowd the window.
    const overhead = estimateTokens(system) + estimateTokens(JSON.stringify(tools.map(toSpec)))
    if (
      !raw &&
      settings.context.autoCompact &&
      messages.length >= 6 &&
      overhead + estimateMessages(messages) > window * settings.context.compactAt
    ) {
      const last = messages[messages.length - 1]
      const older = messages.slice(0, -1)
      const throughIndex = built.sourceIds.length - 2
      const throughMessageId = built.sourceIds[throughIndex]
      base.onReasoning('\nCompacting earlier conversation to save tokens…\n')
      const summary = await compact(base, older, window)
      if (summary && throughMessageId && throughMessageId !== 'summary' && throughMessageId !== 'placeholder') {
        emit({ type: 'compacted', messageId: request.messageId, chatId: request.chatId, summary, throughMessageId })
        messages = [{ role: 'user', text: `Summary of the conversation so far:\n${summary}` }, last]
      }
    }

    const maxRounds = raw ? 1 : mode === 'chat' ? 8 : Math.min(Math.max(settings.codeIndex.maxToolRounds || 40, 1), 200)
    const outcome = await runLoop({ ...base, system, tools, messages, maxRounds, goal: request.goal })
    addUsage(usage, outcome.usage)
    emit({ type: 'done', messageId: request.messageId })
    return { text: outcome.text || text, usage }
  } catch (error) {
    if (controller.signal.aborted) {
      emit({ type: 'done', messageId: request.messageId })
      return { text, usage }
    }
    const message = error instanceof Error ? error.message : String(error)
    emit({ type: 'error', messageId: request.messageId, error: message })
    return { text, error: message, usage }
  } finally {
    activeRuns.delete(request.messageId)
  }
}
