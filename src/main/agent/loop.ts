import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, powerSaveBlocker } from 'electron'
import type { GoalState, ModelInfo, Provider, Settings, StreamEvent, StreamRequest, TokenUsage } from '@shared/types'
import { adapterFor, getProvider, noteProviderHealth } from '../providers'
import { classifyProviderError } from '../providers/errors'
import { findModel } from '@shared/modelSelection'
import { addUsage, emptyUsage, HEADERS_TIMEOUT_MESSAGE, isHeadersTimeout, ProviderHttpError, type Adapter, type Credentials, type NeutralImage, type NeutralMessage, type NeutralToolResult, type TurnRequest, type TurnResult } from '../providers/adapters/types'
import { credentialAttempts, isAuthError } from '../providers/credentials'
import { contextWindowFor } from '../providers/models'
import { store } from '../store'
import { cancelApprovals, requestApproval, type Approver } from './approvals'
import { buildHistory, estimateMessages, estimateTokens, pruneImages, pruneInFlight, stripImages, transcriptText } from './context'
import { chatSystemPrompt, COMPACTION_PROMPT, workSystemPrompt } from './prompts'
import { CallGuard } from './guards'
import { callFacts, decide, USER_DENIED, type RunPolicy, type ToolGate, type TurnOrigin, type UnattendedPolicy } from './policy'
import { capOutput, guidanceFor, isMutating, toolsFor, toSpec, WORKFLOW_TOOLS, type AgentTool, type ToolContext, type ToolQuery, type TurnState } from './tools'

export type { ToolGate, TurnOrigin, UnattendedPolicy } from './policy'
import { redactSecrets } from '../providers/redact'
import { engine as engineAdapter } from '../engines'
import { recordUsage } from '../features/usage/ledger'
import { runEngineChat } from './engineChat'
import type { EngineId } from '@shared/engines'

/**
 * The agent loop — one implementation for every provider and both modes.
 *
 * A turn is: build the transcript to send (trimmed, compacted if needed) →
 * ask the model → run the tools it called → repeat until it answers without
 * calling any. Provider differences live entirely in the adapters; the loop
 * only sees the neutral transcript.
 */

const activeRuns = new Map<string, AbortController>()
/** Runs working toward a goal with an end time: they keep the computer awake whatever the setting says, or sleep would end them early. */
const untilRuns = new Set<string>()
/** Goal runs the user paused: they finish the step in hand and stop instead of continuing. */
const pausedGoals = new Set<string>()

/** Messages whose reply is being written right now, by any window or by a scheduled run. */
export function activeRunIds(): string[] {
  return [...activeRuns.keys()]
}

export function cancelRun(messageId: string): void {
  activeRuns.get(messageId)?.abort()
  activeRuns.delete(messageId)
  cancelApprovals(messageId)
}

/**
 * Pauses a running goal. The model call in flight is left to finish — cutting
 * it off would lose work — and the loop stops at its next continuation point.
 */
export function pauseGoal(messageId: string): void {
  if (activeRuns.has(messageId)) pausedGoals.add(messageId)
}

/** Why a goal run must stop before continuing again, or null to keep going. */
export function goalBudgetExceeded(
  settings: Settings,
  startedAt: number,
  usage: TokenUsage,
  now = Date.now(),
  /** A goal given an end time runs until then instead of for `goalMaxMinutes`. */
  until: number | null = null
): string | null {
  const { goalMaxMinutes, goalMaxTokens } = settings.work
  if (until) {
    if (now >= until) return `the end time (${new Date(until).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}) arrived`
  } else if (goalMaxMinutes > 0 && now - startedAt >= goalMaxMinutes * 60_000) return `time limit of ${goalMaxMinutes} min reached`
  if (goalMaxTokens > 0 && usage.input + usage.output >= goalMaxTokens) {
    return `token limit of ${goalMaxTokens.toLocaleString('en-US')} reached`
  }
  return null
}

/**
 * Settings → General → Prevent sleep while running: one blocker held while
 * any run (chat, Work or scheduled) is in progress.
 */
let sleepBlocker: number | null = null
function holdAwake(): void {
  const wanted = untilRuns.size > 0 || (activeRuns.size > 0 && store.getSettings().general.preventSleep)
  if (wanted && sleepBlocker === null) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension')
  else if (!wanted && sleepBlocker !== null) {
    powerSaveBlocker.stop(sleepBlocker)
    sleepBlocker = null
  }
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

/**
 * `work`, or a rejection the moment `signal` aborts. Stop must end the turn
 * even when a tool ignores the signal (a hung plugin call, a slow fetch): the
 * tool is left to finish on its own and its result is dropped.
 */
function unlessAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(new Error('aborted'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

/**
 * Models found to refuse images, by `provider::model`, for the rest of the
 * session: once one rejects a screenshot, every later request (a worker's
 * thread keeps the image forever) leaves images out from the start.
 */
const textOnlyModels = new Set<string>()

/**
 * A provider refusing the request because it carries an image the model
 * can't take: OpenRouter's "No endpoints found that support image input",
 * OpenAI's "image_url is only supported by certain models", and the like.
 */
export function isImageUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    /no endpoints? found that supports? image/i.test(message) ||
    /(does not|doesn'?t|do not|cannot|can'?t) (support|accept|handle|process) (image|vision|multimodal)/i.test(message) ||
    /image[\w\s_-]{0,40}(is |are )?(not supported|unsupported|only supported|not enabled|not allowed)/i.test(message) ||
    /(vision|multimodal|image input)[\w\s-]{0,20}(is )?not (supported|available|enabled)/i.test(message) ||
    /unsupported (content|input) type[^.]{0,20}image/i.test(message)
  )
}

/** Whether this turn's model is known not to see images: the catalog says so, or it already refused one. */
function textOnly(params: Pick<LoopParams, 'provider' | 'modelId' | 'model'>): boolean {
  return params.model?.vision === false || textOnlyModels.has(`${params.provider.id}::${params.modelId}`)
}

/** Forgets what the session learned about models refusing images; for tests. */
export function resetTextOnlyModels(): void {
  textOnlyModels.clear()
}

function isRetryable(error: unknown): boolean {
  if (error instanceof ProviderHttpError) return [408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529].includes(error.status)
  const message = error instanceof Error ? `${error.name} ${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : String(error)
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|terminated|network|overloaded|Connection error|stream ended before/i.test(message)
}

/** "2 h 10 min" until `until`, for a goal with an end time. */
export function timeLeft(until: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((until - now) / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
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
  /** See `RunOptions.allowOnce`. */
  allowOnce?: (tool: string, input: Record<string, unknown>) => boolean
  /** See `RunOptions.onToolRun`. */
  onToolRun?: (name: string, mutating: boolean) => void
  /** See `RunOptions.toolGate`. */
  toolGate?: ToolGate
  /** See `RunOptions.origin`. */
  origin?: TurnOrigin
  maxRounds: number
  /** Goal mode: the loop sends the agent back to work until it resolves the goal. */
  goal: GoalState | null
  /** Accumulates the run's token usage as it goes, so a caller still has the count when the loop throws. */
  usage?: TokenUsage
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
        // A local model still reading a long prompt after 5 minutes would take
        // as long again on every retry, and it is not "unreachable" either.
        if (params.provider.local && isHeadersTimeout(error)) throw new Error(HEADERS_TIMEOUT_MESSAGE)
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
        // The model can't take images: leave them out, for this request and
        // every later one this session, and ask again at once.
        if (!streamed && isImageUnsupported(error) && stripImages(messages)) {
          textOnlyModels.add(`${params.provider.id}::${params.modelId}`)
          note(`${params.model?.label ?? params.modelId} can't see images, so they were left out. Pick a model that can see images to work from screenshots.`)
          retry--
          continue
        }
        if (!streamed && retry < 3 && isRetryable(error)) {
          const wait = Math.min(
            (error instanceof ProviderHttpError ? error.retryAfterMs : undefined) ?? [2000, 6000, 15000][retry],
            60_000
          )
          const status = error instanceof ProviderHttpError ? ` (${error.status})` : ''
          const cutOff = error instanceof Error && /stream ended before/.test(error.message)
          note(`${cutOff ? 'The reply was cut off' : `The provider is busy${status}`} — retrying in ${Math.round(wait / 1000)}s.`)
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
  guard: CallGuard,
  tool: AgentTool | undefined,
  call: { id: string; name: string; input: Record<string, unknown> }
): Promise<NeutralToolResult & { status: 'done' | 'denied' | 'error' }> {
  const { emit, request } = params
  emit({ type: 'tool-call', messageId: request.messageId, toolId: call.id, name: call.name, input: call.input })

  /** `forModel` replaces what the model is sent; the user always sees `output`. */
  const finish = (
    output: string,
    status: 'done' | 'denied' | 'error',
    images: NeutralImage[] = [],
    forModel = output
  ): NeutralToolResult & { status: 'done' | 'denied' | 'error' } => {
    const paths = images.map(saveImage)
    emit({ type: 'tool-result', messageId: request.messageId, toolId: call.id, output, status, ...(paths.length ? { images: paths } : {}) })
    return { id: call.id, name: call.name, output: forModel, status, ...(images.length ? { images } : {}), ...(status === 'error' ? { isError: true } : {}) }
  }

  const refusal = guard.refuse(call.name, call.input)
  if (refusal) return finish(refusal, 'error')

  if (!tool) {
    const names = params.tools.map((t) => t.name).join(', ')
    return finish(`Unknown tool "${call.name}". Available tools: ${names || 'none'}.`, 'error')
  }
  if ('__invalid_json' in call.input) {
    return finish(`Your arguments were not valid JSON: ${String(call.input.__invalid_json).slice(0, 500)}. Re-issue the call with valid JSON.`, 'error')
  }
  const policy: RunPolicy = {
    readOnly: params.readOnly,
    unattended: params.unattended,
    allowOnce: params.allowOnce,
    toolGate: params.toolGate,
    origin: params.origin
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
    confirm: (title, detail, summary) => params.approver(title, detail, summary),
    policy
  }

  // Every rule about whether this call may run — plan mode, a guest's cap,
  // who the work came from, the unattended policy or the approval mode, and
  // the tool's own risk — is in agent/policy.ts, shared with sub-agents and
  // the CLI.
  const decision = decide(tool, call.input, callFacts(tool, call.input, ctx, params.settings), policy, params.settings.approvalMode)
  if (decision.kind === 'deny') return finish(decision.reason, 'denied')
  if (decision.kind === 'ask' && !(await params.approver(call.name, call.input, tool.describe?.(call.input)))) {
    return finish(USER_DENIED, 'denied')
  }

  const mutating = decision.mutating
  params.onToolRun?.(call.name, mutating)
  let output: string
  let status: 'done' | 'error'
  let images: NeutralImage[] | undefined
  try {
    const result = await unlessAborted(Promise.resolve(tool.run(call.input, ctx)), params.signal)
    const normalized = typeof result === 'string' ? { text: result } : result
    output = capOutput(normalized.text || '(no output)')
    status = normalized.isError ? 'error' : 'done'
    images = normalized.images
  } catch (error) {
    if (params.signal.aborted) return finish('Stopped by the user.', 'error')
    // Reported to the model rather than failing the turn: models routinely
    // recover by trying different arguments.
    output = `Error: ${error instanceof Error ? error.message : String(error)}`
    status = 'error'
  }

  // Goal evidence: a change is a successful mutating call; running a command
  // or looking at anything counts as checking — `npm test` is how most work
  // gets checked, and a command's non-zero exit is still a result. A call
  // that failed outright neither changed nor checked anything.
  if (!WORKFLOW_TOOLS.has(call.name) && status === 'done') {
    const evidence = (turn.evidence ??= { seq: 0 })
    evidence.seq++
    if (mutating && call.name !== 'run_command') evidence.lastChange = { seq: evidence.seq, tool: call.name }
    else evidence.lastCheck = evidence.seq
  }

  const note = guard.record(call.name, call.input, status, output, mutating)
  const repeat =
    status === 'done' && !mutating && !images?.length ? guard.dedupe(call.name, call.input, call.id, output, params.messages) : null
  return finish(output, status, images, repeat ?? (note ? output + note : output))
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
  const guard = new CallGuard()
  const usage = params.usage ?? emptyUsage()
  const attempts = await credentialAttempts(params.provider)
  const window = contextWindowFor(params.provider, params.modelId, params.model)
  const toolsByName = new Map(params.tools.map((tool) => [tool.name, tool]))
  /**
   * Call ids already in the transcript. Some runtimes number calls per
   * response ("call_0") or derive the id from the call, so a call repeated
   * later repeats its id — and its result then landed on the earlier call's
   * card while its own stayed "running", and was replayed as interrupted.
   */
  const callIds = new Set(messages.flatMap((m) => (m.role === 'assistant' ? m.calls.map((c) => c.id) : [])))
  const note = (text: string): void => params.onReasoning(`\n${text}\n`)
  let text = ''
  let goalIterations = 0
  let emptyNudges = 0
  let announcedNudged = false
  let goal = params.goal
  const startedAt = Date.now()
  // A goal with an end time is bounded by that time, not by how often it was sent back.
  const goalIterationsLeft = (): boolean => Boolean(goal?.until) || goalIterations < params.settings.work.goalMaxIterations
  /** Why an active goal run must stop now, or null. A pause or spent budget is honoured between rounds, not only when the model stops. */
  const goalStop = (atContinuation: boolean): string | null =>
    pausedGoals.has(request.messageId)
      ? 'paused by you'
      : atContinuation && !goalIterationsLeft()
        ? `continuation limit of ${params.settings.work.goalMaxIterations} reached`
        : goalBudgetExceeded(params.settings, startedAt, usage, Date.now(), goal?.until ?? null)
  const pauseGoalRun = (reason: string): LoopOutcome => {
    const byUser = pausedGoals.has(request.messageId)
    note(byUser ? 'Goal paused.' : `Goal paused: ${reason}. Resume it to keep going.`)
    emit({
      type: 'goal',
      messageId: request.messageId,
      chatId: request.chatId,
      goal: { ...goal!, status: 'paused', ...(byUser ? {} : { summary: reason }) }
    })
    return { text, usage, turn, stopped: 'goal-limit' }
  }
  const goalActive = (): boolean => params.depth === 0 && goal?.status === 'active' && !turn.goalResolution && !turn.yielded && !signal.aborted

  for (let round = 0; round < params.maxRounds; round++) {
    if (round > 0 && goalActive()) {
      const reason = goalStop(false)
      if (reason) return pauseGoalRun(reason)
    }
    // Providers that cannot clear stale tool output server-side get it pruned
    // here, in large batches, once the transcript nears the window.
    if (round > 0 && !params.adapter.managesContext) {
      pruneInFlight(messages, Math.floor(window * 0.55))
      pruneImages(messages)
    }

    if (textOnly(params)) stripImages(messages)
    const result = await callModel(params, attempts, messages, note)
    addUsage(usage, result.usage)
    if (params.depth === 0) emit({ type: 'usage', messageId: request.messageId, usage: { ...usage } })

    if (result.stop === 'refusal') throw new Error(result.refusal ?? 'The model declined this request.')
    // Each call's reply is its own paragraph, so a turn that spoke, used a
    // tool and spoke again does not read as one run-on sentence.
    text = text && result.text ? `${text}\n\n${result.text}` : text + result.text

    if (result.stop === 'max_tokens') {
      // A call cut off mid-way may have truncated arguments; never run it.
      messages.push({ role: 'assistant', text: result.text || '(output cut off)', calls: [] })
      // A final answer cut off after tool work stands as the answer; breaking
      // out of the loop here used to report it as the round limit.
      if (result.calls.length === 0 && round > 0) return { text, usage, turn, stopped: 'done' }
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

    for (const call of result.calls) {
      if (!call.id || callIds.has(call.id)) call.id = `${call.id || 'call'}_${randomUUID().slice(0, 8)}`
      callIds.add(call.id)
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
      if (goalActive() && goal) {
        const stopReason = goalStop(true)
        if (!stopReason) {
          goalIterations++
          goal = { ...goal, iterations: goal.iterations + 1 }
          emit({ type: 'goal', messageId: request.messageId, chatId: request.chatId, goal })
          const left = goal.until ? timeLeft(goal.until) : null
          note(left ? `Continuing toward the goal (${left} left).` : `Continuing toward the goal (${goalIterations}/${params.settings.work.goalMaxIterations}).`)
          messages.push({
            role: 'user',
            text: left
              ? `Keep going toward the goal; you have ${left} left. Take the next concrete step, or call wait if you are waiting for something to happen. If it is achieved and verified, call goal_complete; if you are blocked, call goal_blocked.`
              : request.workerId
                ? // A worker waits by sleeping: the turn ends and it wakes when it said.
                  'Keep going toward the goal. Take the next concrete step, or call sleep if you are waiting for something to happen. If it is achieved and verified, call goal_complete; if you are blocked, call goal_blocked.'
                : 'Keep going toward the goal. Take the next concrete step. If it is achieved and verified, call goal_complete; if you are blocked, call goal_blocked.'
          })
          continue
        }
        return pauseGoalRun(stopReason)
      }
      return { text, usage, turn, stopped: 'done' }
    }

    // Read-only calls run together; anything that changes state runs in the
    // order the model asked for it.
    const tools = result.calls.map((call) => toolsByName.get(call.name))
    const allReadOnly = tools.every((tool, i) => tool && !isMutating(tool, result.calls[i].input, { settings: params.settings, cwd: params.cwd } as ToolContext))
    const results: NeutralToolResult[] = []
    if (allReadOnly && result.calls.length > 1) {
      results.push(...(await Promise.all(result.calls.map((call, i) => runTool(params, turn, guard, tools[i], call)))))
    } else {
      for (let i = 0; i < result.calls.length; i++) {
        if (signal.aborted) break
        results.push(await runTool(params, turn, guard, tools[i], result.calls[i]))
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
    // So does a worker going to sleep: it wakes when it scheduled.
    if (turn.yielded) return { text, usage, turn, stopped: 'done' }
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
  window: number,
  usage: TokenUsage
): Promise<string> {
  const attempts = await credentialAttempts(params.provider)
  const transcript = transcriptText(messages, Math.floor(window * 0.5 * 3.6))
  const result = await callModel(
    { ...params, system: COMPACTION_PROMPT, tools: [], messages: [], maxRounds: 1, goal: null, onText: () => {}, onReasoning: () => {} } as LoopParams,
    attempts,
    [{ role: 'user', text: `${transcript}\n\n---\nWrite the summary now.` }],
    () => {}
  )
  // The summary request reads up to half the window; it is part of what the turn cost.
  addUsage(usage, result.usage)
  return result.text.trim()
}

/* ------------------------------------------------------------- entry point */

export interface RunOptions {
  /** Headless runs (scheduled tasks) answer approvals themselves. */
  approver?: Approver
  signal?: AbortSignal
  /** Set by scheduled tasks; decides mutating calls without asking anyone. */
  unattended?: UnattendedPolicy
  /**
   * For an unattended run: the user approved this exact call in advance (a
   * worker's answered ask_user). Consulted only where the call would be
   * refused; true spends that approval.
   */
  allowOnce?: (tool: string, input: Record<string, unknown>) => boolean
  /**
   * Told as each tool is about to run (after any approval), and whether the
   * call changes things outside the conversation. A worker's run records it,
   * so a run cut off by a crash is never replayed if it may already have acted.
   */
  onToolRun?: (name: string, mutating: boolean) => void
  /**
   * Refuses a tool call outright, whatever it is: a reason for the model, or
   * null to let the usual rules decide. A worker answering a guest in a chat
   * app uses it to hold the turn to what that guest may do.
   */
  toolGate?: ToolGate
  /**
   * Who the turn's work came from. A worker's turn that carries a guest's
   * message, or work a colleague handed over, sets it so nothing in the turn
   * can spend the user's money. Unset means the user.
   */
  origin?: TurnOrigin
  /**
   * Which tools to offer at all. A run that may only use a few (a trading
   * session) leaves the rest out of the request: the gate still refuses them,
   * but their schemas would cost tokens on every call and tempt the model.
   */
  offer?: (name: string) => boolean
}

export interface RunOutcome {
  text: string
  error?: string
  usage: TokenUsage
  /** Stopped before it finished — Stop, Emergency Stop, or the caller's own signal. */
  cancelled?: boolean
}

/** Each chat's own conversation on an agent engine (a Codex thread), so the next message continues it. */
const ENGINE_SESSIONS = 'chat-engine-sessions.json'
type EngineSessions = Record<string, Partial<Record<EngineId, string>>>

/**
 * A Chat turn on an agent engine (Codex) rather than Eaon's own loop. It is
 * registered as a run like any other, so Stop, "which reply is being
 * written" and the approval dialog behave the same; see agent/engineChat.ts.
 */
async function runOnEngine(request: StreamRequest, engineId: EngineId, emit: (event: StreamEvent) => void, options: RunOptions): Promise<RunOutcome> {
  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', forwardAbort, { once: true })
  controller.signal.addEventListener('abort', () => cancelApprovals(request.messageId), { once: true })
  activeRuns.set(request.messageId, controller)
  holdAwake()
  try {
    const settings = store.getSettings()
    const cwd = await ensureWorkFolder(request.cwd, settings)
    const outcome = await runEngineChat(
      { request, engine: engineId, cwd, settings, signal: controller.signal, emit },
      {
        adapter: (id) => engineAdapter(id),
        session: (chatId, id) => store.getJson<EngineSessions>(ENGINE_SESSIONS, {})[chatId]?.[id] ?? null,
        saveSession: (chatId, id, sessionId) => {
          const all = store.getJson<EngineSessions>(ENGINE_SESSIONS, {})
          const mine = { ...all[chatId] }
          if (sessionId) mine[id] = sessionId
          else delete mine[id]
          all[chatId] = mine
          store.setJson(ENGINE_SESSIONS, all)
        },
        ask: (tool, input, summary) => (controller.signal.aborted ? Promise.resolve(false) : requestApproval(request.messageId, tool, input, emit, summary)),
        record: (account, model, used) => recordUsage(account, model, used, new Date(), 'chat')
      }
    )
    return { text: outcome.text, usage: outcome.usage, ...(outcome.error ? { error: outcome.error } : {}), ...(controller.signal.aborted ? { cancelled: true } : {}) }
  } finally {
    options.signal?.removeEventListener('abort', forwardAbort)
    activeRuns.delete(request.messageId)
    holdAwake()
  }
}

export async function runAgent(request: StreamRequest, emit: (event: StreamEvent) => void, options: RunOptions = {}): Promise<RunOutcome> {
  if (request.engine && request.engine !== 'native') return runOnEngine(request, request.engine, emit, options)
  const usage = emptyUsage()
  const provider = getProvider(request.providerId)
  if (!provider) {
    const error = `Unknown provider "${request.providerId}"`
    emit({ type: 'error', messageId: request.messageId, error })
    return { text: '', error, usage }
  }

  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', forwardAbort, { once: true })
  // However the run is stopped, nothing may stay parked on an approval.
  controller.signal.addEventListener('abort', () => cancelApprovals(request.messageId), { once: true })
  activeRuns.set(request.messageId, controller)
  if (request.goal?.status === 'active' && request.goal.until) untilRuns.add(request.messageId)
  holdAwake()
  let text = ''

  try {
    // Stopped while the run was being set up: end it here, as cancelled.
    if (controller.signal.aborted) throw new Error('aborted')
    const settings = store.getSettings()
    const raw = request.rawSystem !== undefined
    const mode = request.mode
    const cwd = mode === 'work' && !raw ? await ensureWorkFolder(request.cwd, settings) : ''
    const readOnly = mode === 'work' && request.work.plan
    const query: ToolQuery = { mode, cwd: cwd || null, depth: 0, readOnly, settings, request }
    const offered = raw ? [] : toolsFor(query)
    const tools = options.offer ? offered.filter((tool) => options.offer!(tool.name)) : offered
    const system = raw
      ? (request.rawSystem ?? '')
      : mode === 'chat'
        ? chatSystemPrompt(request.projectInstructions, tools.some((t) => t.name === 'web_search'))
        : workSystemPrompt({
            cwd,
            projectInstructions: request.projectInstructions,
            guidance: guidanceFor(query, options.offer),
            swarm: request.work.swarm && !readOnly,
            plan: readOnly,
            goal: request.goal,
            autonomy: settings.approvalMode === 'full' && !options.unattended,
            // A worker speaks as itself rather than as the generic agent.
            ...(request.persona ? { roleBrief: request.persona } : {})
          })

    // By id or by an alias folded into it (a dated snapshot chosen before it was folded).
    const model = findModel(provider.models, request.modelId)
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
      // A tool still finishing after Stop (see unlessAborted) may ask late;
      // the answer is no, and the dialog is never shown.
      approver:
        options.approver ??
        ((tool: string, input: Record<string, unknown>, summary?: string) =>
          controller.signal.aborted ? Promise.resolve(false) : requestApproval(request.messageId, tool, input, emit, summary)),
      unattended: options.unattended,
      allowOnce: options.allowOnce,
      onToolRun: options.onToolRun,
      toolGate: options.toolGate,
      origin: options.origin,
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
      // A worker's thread never ends, so it always compacts whatever the
      // chat setting says — otherwise it would outgrow the model and stop.
      (settings.context.autoCompact || Boolean(request.workerId)) &&
      messages.length >= 6 &&
      overhead + estimateMessages(messages) > window * settings.context.compactAt
    ) {
      const last = messages[messages.length - 1]
      const older = messages.slice(0, -1)
      const throughIndex = built.sourceIds.length - 2
      const throughMessageId = built.sourceIds[throughIndex]
      base.onReasoning('\nCompacting earlier conversation to save tokens…\n')
      const summary = await compact(base, older, window, usage)
      if (summary && throughMessageId && throughMessageId !== 'summary' && throughMessageId !== 'placeholder') {
        emit({ type: 'compacted', messageId: request.messageId, chatId: request.chatId, summary, throughMessageId })
        messages = [{ role: 'user', text: `Summary of the conversation so far:\n${summary}` }, last]
      }
    }

    // A goal with an end time is bounded by that time; the usual round cap would end it hours early.
    const runsUntil = request.goal?.status === 'active' && request.goal.until && request.goal.until > Date.now()
    const maxRounds = raw ? 1 : mode === 'chat' ? 8 : runsUntil ? 10_000 : Math.min(Math.max(settings.codeIndex.maxToolRounds || 40, 1), 200)
    // The loop adds into `usage` as it goes, so a stopped or failed run still reports what it spent.
    const outcome = await runLoop({ ...base, system, tools, messages, maxRounds, goal: request.goal, usage })
    // The provider answered: a failed check from before (a key since fixed) no longer applies.
    if (provider.health && !provider.health.ok) noteProviderHealth(provider.id, null)
    emit({ type: 'done', messageId: request.messageId })
    return { text: outcome.text || text, usage, ...(controller.signal.aborted ? { cancelled: true } : {}) }
  } catch (error) {
    if (controller.signal.aborted) {
      emit({ type: 'done', messageId: request.messageId })
      return { text, usage, cancelled: true }
    }
    // A provider failure becomes what to do about it ("Your ChatGPT session
    // expired. Sign in again."), with the raw words kept for Copy details;
    // anything else keeps its own message.
    const issue = classifyProviderError(error, provider)
    const message = issue.kind === 'other' ? redactSecrets(error instanceof Error ? error.message : String(error)) : issue.message
    noteProviderHealth(provider.id, issue)
    emit({ type: 'error', messageId: request.messageId, error: message, ...(issue.kind === 'other' ? {} : { issue }) })
    return { text, error: message, usage }
  } finally {
    options.signal?.removeEventListener('abort', forwardAbort)
    activeRuns.delete(request.messageId)
    untilRuns.delete(request.messageId)
    pausedGoals.delete(request.messageId)
    holdAwake()
  }
}
