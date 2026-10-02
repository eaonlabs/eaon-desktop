import type { EaonEvent, EaonUiRequest } from '@shared/eaonCode'

/**
 * The Code tab's transcript, built from Eaon Code's RPC event stream.
 *
 * Pure: no React, no `window`, so the reducer is unit-tested under plain Node
 * (test/eaon-code.test.ts). The store applies each IPC batch through
 * `applyEvents` in one `set`, so a frame of streamed tokens is one render.
 *
 * Assistant content is addressed the way the protocol addresses it — by
 * `contentIndex` into the message's content array — so `blocks` is kept
 * parallel to that array and every delta lands on the right block even when
 * thinking, text and tool calls interleave.
 */

export interface ToolState {
  id: string
  name: string
  args: Record<string, unknown>
  /** Raw argument JSON while the model is still writing the call. */
  argsText: string
  status: 'preparing' | 'running' | 'done' | 'error'
  output: string
  /** Live output of a running tool (cumulative, e.g. bash stdout so far). */
  partial: string
  details?: unknown
}

export type Block = { kind: 'text'; text: string } | { kind: 'thinking'; text: string } | { kind: 'tool'; id: string }

export type Item =
  | { kind: 'user'; id: string; text: string; images: number }
  | {
      kind: 'assistant'
      id: string
      blocks: (Block | null)[]
      streaming: boolean
      error?: string
      stopReason?: string
      model?: string
    }
  | {
      kind: 'bash'
      id: string
      command: string
      output: string
      running: boolean
      exitCode?: number | null
      cancelled?: boolean
      truncated?: boolean
      excluded?: boolean
    }
  | {
      kind: 'notice'
      id: string
      tone: 'info' | 'warning' | 'error'
      icon: 'compact' | 'retry' | 'info' | 'extension' | 'stop'
      text: string
      detail?: string
      pending?: boolean
    }
  | { kind: 'custom'; id: string; label: string; text: string }

export interface Transcript {
  items: Item[]
  tools: Record<string, ToolState>
  /** Between agent_start and agent_settled: the session is working. */
  running: boolean
  compacting: boolean
  queue: { steering: string[]; followUp: string[] }
  /** Extension footer statuses (`setStatus`), keyed by the extension's key. */
  statuses: Record<string, string>
  /** Extension text widgets (`setWidget`). */
  widgets: Record<string, string[]>
  /** Extension dialogs awaiting an answer, oldest first, with when each arrived. */
  dialogs: (EaonUiRequest & { receivedAt: number })[]
  /** Text an extension asked to put in the composer, consumed once. */
  editorText: string | null
  /** The assistant message currently streaming, if any. */
  currentAssistant: string | null
  /** Ids of the in-flight compaction and retry notices, so their end updates them in place. */
  compactionNotice: string | null
  retryNotice: string | null
  seq: number
}

export const emptyTranscript = (): Transcript => ({
  items: [],
  tools: {},
  running: false,
  compacting: false,
  queue: { steering: [], followUp: [] },
  statuses: {},
  widgets: {},
  dialogs: [],
  editorText: null,
  currentAssistant: null,
  compactionNotice: null,
  retryNotice: null,
  seq: 0
})

type Content = { type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown; redacted?: boolean }

/** The text of a message's content, which is a string or an array of parts. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Content[])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
}

const countImages = (content: unknown): number =>
  Array.isArray(content) ? (content as Content[]).filter((part) => part?.type === 'image').length : 0

const asArgs = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const formatTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))

/**
 * Applies a batch of events. Everything the batch touches is copied once and
 * then mutated in place, so the cost is per batch, not per event; everything
 * it does not touch keeps its identity for React.memo. `now` stamps dialogs.
 */
export function applyEvents(previous: Transcript, events: EaonEvent[], now = Date.now()): Transcript {
  const t: Transcript = { ...previous, items: previous.items.slice(), tools: { ...previous.tools } }
  const ownedItems = new Set<Item>()
  const ownedTools = new Set<ToolState>()
  let statusesOwned = false
  let widgetsOwned = false

  const nextId = (prefix: string): string => `${prefix}${++t.seq}`

  const itemIndex = (id: string | null): number => {
    if (!id) return -1
    for (let i = t.items.length - 1; i >= 0; i--) if (t.items[i].id === id) return i
    return -1
  }
  /** A writable copy of the item at `index`, made at most once per batch. */
  const own = <T extends Item>(index: number): T => {
    const item = t.items[index]
    if (ownedItems.has(item)) return item as T
    const copy = (item.kind === 'assistant' ? { ...item, blocks: item.blocks.slice() } : { ...item }) as Item
    t.items[index] = copy
    ownedItems.add(copy)
    return copy as T
  }
  const push = (item: Item): void => {
    t.items.push(item)
    ownedItems.add(item)
  }
  const tool = (id: string, name = 'tool'): ToolState => {
    const existing = t.tools[id]
    if (existing && ownedTools.has(existing)) return existing
    const next: ToolState = existing
      ? { ...existing }
      : { id, name, args: {}, argsText: '', status: 'preparing', output: '', partial: '' }
    t.tools[id] = next
    ownedTools.add(next)
    return next
  }
  const currentAssistant = (): Extract<Item, { kind: 'assistant' }> | null => {
    const index = itemIndex(t.currentAssistant)
    return index === -1 ? null : own<Extract<Item, { kind: 'assistant' }>>(index)
  }
  const notice = (existingId: string | null, fields: Omit<Extract<Item, { kind: 'notice' }>, 'kind' | 'id'>): string => {
    const index = itemIndex(existingId)
    if (index !== -1) {
      Object.assign(own(index), fields)
      return existingId!
    }
    const id = nextId('n')
    push({ kind: 'notice', id, ...fields })
    return id
  }

  for (const event of events) {
    switch (event.type) {
      case 'agent_start':
        t.running = true
        break

      case 'agent_settled': {
        t.running = false
        const assistant = currentAssistant()
        if (assistant) assistant.streaming = false
        t.currentAssistant = null
        break
      }

      case 'message_start': {
        const message = (event.message ?? {}) as { role?: string; content?: unknown; customType?: string; display?: boolean }
        if (message.role === 'user') {
          push({ kind: 'user', id: nextId('u'), text: textOf(message.content), images: countImages(message.content) })
        } else if (message.role === 'assistant') {
          const previousAssistant = currentAssistant()
          if (previousAssistant) previousAssistant.streaming = false
          const id = nextId('a')
          push({ kind: 'assistant', id, blocks: blocksFrom(message.content, tool), streaming: true })
          t.currentAssistant = id
        } else if (message.role === 'custom' && message.display !== false) {
          push({ kind: 'custom', id: nextId('c'), label: message.customType ?? 'extension', text: textOf(message.content) })
        }
        break
      }

      case 'message_update': {
        const assistant = currentAssistant()
        const update = (event.assistantMessageEvent ?? {}) as {
          type?: string
          contentIndex?: number
          delta?: string
          content?: string
          id?: string
          toolName?: string
          toolCall?: { id?: string; name?: string; arguments?: unknown }
        }
        if (!assistant || typeof update.contentIndex !== 'number') break
        const index = update.contentIndex
        const block = assistant.blocks[index]
        switch (update.type) {
          case 'text_start':
            assistant.blocks[index] = { kind: 'text', text: '' }
            break
          case 'thinking_start':
            assistant.blocks[index] = { kind: 'thinking', text: '' }
            break
          case 'text_delta':
          case 'thinking_delta': {
            const kind = update.type === 'text_delta' ? 'text' : 'thinking'
            const text = block && block.kind === kind ? block.text : ''
            assistant.blocks[index] = { kind, text: text + (update.delta ?? '') }
            break
          }
          case 'text_end':
          case 'thinking_end':
            if (typeof update.content === 'string') {
              assistant.blocks[index] = { kind: update.type === 'text_end' ? 'text' : 'thinking', text: update.content }
            }
            break
          case 'toolcall_start': {
            if (!update.id) break
            assistant.blocks[index] = { kind: 'tool', id: update.id }
            const state = tool(update.id, update.toolName)
            if (update.toolName) state.name = update.toolName
            break
          }
          case 'toolcall_delta':
            if (block?.kind === 'tool') tool(block.id).argsText += update.delta ?? ''
            break
          case 'toolcall_end': {
            const call = update.toolCall
            const id = call?.id ?? (block?.kind === 'tool' ? block.id : undefined)
            if (!id) break
            assistant.blocks[index] = { kind: 'tool', id }
            const state = tool(id, call?.name)
            if (call?.name) state.name = call.name
            state.args = asArgs(call?.arguments)
            break
          }
        }
        break
      }

      case 'message_end': {
        const message = (event.message ?? {}) as {
          role?: string
          content?: unknown
          stopReason?: string
          errorMessage?: string
          model?: string
          toolCallId?: string
          isError?: boolean
          details?: unknown
        }
        if (message.role === 'assistant') {
          const assistant = currentAssistant()
          if (!assistant) break
          // message_end is authoritative; deltas were only ever a preview of it.
          assistant.blocks = blocksFrom(message.content, tool)
          assistant.streaming = false
          assistant.stopReason = message.stopReason
          assistant.model = message.model
          if (message.stopReason === 'error') assistant.error = message.errorMessage || 'The model returned an error.'
        } else if (message.role === 'toolResult' && message.toolCallId) {
          const state = tool(message.toolCallId)
          if (state.status !== 'done' && state.status !== 'error') {
            state.status = message.isError ? 'error' : 'done'
            state.output = textOf(message.content)
            state.details = message.details
          }
        }
        break
      }

      case 'tool_execution_start': {
        const id = String(event.toolCallId ?? '')
        if (!id) break
        const state = tool(id, String(event.toolName ?? 'tool'))
        state.status = 'running'
        if (event.args) state.args = asArgs(event.args)
        break
      }

      case 'tool_execution_update': {
        const id = String(event.toolCallId ?? '')
        if (!id) break
        const partial = (event.partialResult ?? {}) as { content?: unknown }
        tool(id).partial = textOf(partial.content)
        break
      }

      case 'tool_execution_end': {
        const id = String(event.toolCallId ?? '')
        if (!id) break
        const result = (event.result ?? {}) as { content?: unknown; details?: unknown }
        const state = tool(id, String(event.toolName ?? 'tool'))
        state.status = event.isError ? 'error' : 'done'
        state.output = textOf(result.content)
        state.details = result.details
        state.partial = ''
        break
      }

      case 'queue_update':
        t.queue = {
          steering: Array.isArray(event.steering) ? (event.steering as string[]) : [],
          followUp: Array.isArray(event.followUp) ? (event.followUp as string[]) : []
        }
        break

      case 'compaction_start':
        t.compacting = true
        t.compactionNotice = notice(null, {
          tone: 'info',
          icon: 'compact',
          pending: true,
          text: event.reason === 'manual' ? 'Compacting the conversation…' : 'Context is nearly full — compacting…'
        })
        break

      case 'compaction_end': {
        t.compacting = false
        const result = event.result as { summary?: string; tokensBefore?: number; estimatedTokensAfter?: number } | null
        if (result) {
          const before = result.tokensBefore ?? 0
          const after = result.estimatedTokensAfter
          notice(t.compactionNotice, {
            tone: 'info',
            icon: 'compact',
            pending: false,
            text: `Compacted the conversation · ${formatTokens(before)}${after !== undefined ? ` → ~${formatTokens(after)}` : ''} tokens`,
            detail: result.summary
          })
        } else if (event.aborted) {
          notice(t.compactionNotice, { tone: 'info', icon: 'compact', pending: false, text: 'Compaction cancelled' })
        } else {
          notice(t.compactionNotice, {
            tone: 'error',
            icon: 'compact',
            pending: false,
            text: `Compaction failed${event.errorMessage ? `: ${String(event.errorMessage)}` : ''}`
          })
        }
        t.compactionNotice = null
        break
      }

      case 'auto_retry_start':
      case 'summarization_retry_scheduled': {
        const what = event.type === 'auto_retry_start' ? 'Retrying' : 'Retrying the summary'
        const seconds = Math.max(1, Math.round(Number(event.delayMs ?? 0) / 1000))
        t.retryNotice = notice(t.retryNotice, {
          tone: 'warning',
          icon: 'retry',
          pending: true,
          text: `${what} in ${seconds}s · attempt ${String(event.attempt)} of ${String(event.maxAttempts)}`,
          detail: event.errorMessage ? String(event.errorMessage) : undefined
        })
        break
      }

      case 'auto_retry_end':
        notice(t.retryNotice, event.success
          ? { tone: 'info', icon: 'retry', pending: false, text: `Recovered after ${String(event.attempt)} attempt${event.attempt === 1 ? '' : 's'}` }
          : {
              tone: 'error',
              icon: 'retry',
              pending: false,
              text: `Gave up after ${String(event.attempt)} attempts`,
              detail: event.finalError ? String(event.finalError) : undefined
            })
        t.retryNotice = null
        break

      case 'summarization_retry_finished':
        if (t.retryNotice) notice(t.retryNotice, { tone: 'info', icon: 'retry', pending: false, text: 'Summary retry finished' })
        t.retryNotice = null
        break

      case 'extension_error': {
        const path = String(event.extensionPath ?? '')
        notice(null, {
          tone: 'error',
          icon: 'extension',
          text: `Extension error${path ? ` in ${path.split(/[\\/]/).pop()}` : ''}`,
          detail: String(event.error ?? '')
        })
        break
      }

      case 'extension_ui_request': {
        const method = String(event.method ?? '')
        if (method === 'select' || method === 'confirm' || method === 'input' || method === 'editor') {
          // Its timeout runs from now on Eaon Code's side, not from when it is shown.
          const { type: _type, ...request } = event
          t.dialogs = [...t.dialogs, { ...(request as unknown as EaonUiRequest), receivedAt: now }]
        } else if (method === 'notify') {
          const kind = event.notifyType === 'error' ? 'error' : event.notifyType === 'warning' ? 'warning' : 'info'
          notice(null, { tone: kind, icon: 'extension', text: String(event.message ?? '') })
        } else if (method === 'setStatus') {
          if (!statusesOwned) {
            t.statuses = { ...t.statuses }
            statusesOwned = true
          }
          const key = String(event.statusKey ?? '')
          if (typeof event.statusText === 'string' && event.statusText) t.statuses[key] = stripAnsi(event.statusText)
          else delete t.statuses[key]
        } else if (method === 'setWidget') {
          if (!widgetsOwned) {
            t.widgets = { ...t.widgets }
            widgetsOwned = true
          }
          const key = String(event.widgetKey ?? '')
          if (Array.isArray(event.widgetLines)) t.widgets[key] = (event.widgetLines as string[]).map(stripAnsi)
          else delete t.widgets[key]
        } else if (method === 'set_editor_text') {
          t.editorText = String(event.text ?? '')
        }
        break
      }

      case 'bash_execution_update': {
        const index = itemIndex(String(event.id ?? ''))
        // The command's response replaces the output wholesale, and can arrive
        // before the last of these (they travel on a different IPC channel);
        // a delta for a finished command would duplicate its tail.
        const target = index === -1 ? null : t.items[index]
        if (!target || target.kind !== 'bash' || !target.running) break
        own<Extract<Item, { kind: 'bash' }>>(index).output += String(event.delta ?? '')
        break
      }
    }
  }
  return t
}

/**
 * The transcript once its process has gone mid-turn — crashed, stopped, or
 * handed to a terminal. Nothing more will arrive for what was in flight, so
 * nothing may keep spinning: the turn ends, running tools and commands read
 * as interrupted, and the dead process's dialogs, queue and extension
 * statuses go with it. Returns `t` itself when nothing was live.
 */
export function interruptTranscript(t: Transcript): Transcript {
  const liveTool = (state: ToolState): boolean => state.status === 'running' || state.status === 'preparing'
  const liveItem = (item: Item): boolean =>
    (item.kind === 'assistant' && item.streaming) || (item.kind === 'bash' && item.running) || (item.kind === 'notice' && item.pending === true)
  const tools = Object.values(t.tools).filter(liveTool)
  const live =
    t.running ||
    t.compacting ||
    t.currentAssistant !== null ||
    tools.length > 0 ||
    t.items.some(liveItem) ||
    t.dialogs.length > 0 ||
    t.queue.steering.length + t.queue.followUp.length > 0 ||
    Object.keys(t.statuses).length > 0 ||
    Object.keys(t.widgets).length > 0
  if (!live) return t

  const next: Transcript = {
    ...t,
    items: t.items.map((item) => {
      if (!liveItem(item)) return item
      if (item.kind === 'assistant') return { ...item, streaming: false }
      if (item.kind === 'bash') return { ...item, running: false, output: item.output || 'Interrupted' }
      return { ...item, pending: false }
    }),
    tools: { ...t.tools },
    running: false,
    compacting: false,
    queue: { steering: [], followUp: [] },
    statuses: {},
    widgets: {},
    dialogs: [],
    currentAssistant: null,
    compactionNotice: null,
    retryNotice: null
  }
  for (const state of tools) {
    const output = state.output || [state.partial, 'Interrupted'].filter(Boolean).join('\n\n')
    next.tools[state.id] = { ...state, status: 'error', output, partial: '' }
  }
  return next
}

/** Extensions style their status text for a terminal; the escapes mean nothing here. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

/** Blocks for an assistant message's content array, registering its tool calls. */
function blocksFrom(content: unknown, tool: (id: string, name?: string) => ToolState): (Block | null)[] {
  if (!Array.isArray(content)) return typeof content === 'string' && content ? [{ kind: 'text', text: content }] : []
  return (content as Content[]).map((part): Block | null => {
    if (part?.type === 'text') return { kind: 'text', text: part.text ?? '' }
    if (part?.type === 'thinking') return { kind: 'thinking', text: part.thinking ?? '' }
    if (part?.type === 'toolCall' && part.id) {
      const state = tool(part.id, part.name)
      if (part.name) state.name = part.name
      if (part.arguments && typeof part.arguments === 'object') state.args = asArgs(part.arguments)
      return { kind: 'tool', id: part.id }
    }
    return null
  })
}

/**
 * A resumed session's transcript, from `get_messages`. Tool results are
 * separate messages in the protocol and are folded back onto their calls.
 */
export function transcriptFromMessages(messages: unknown[]): Transcript {
  let t = emptyTranscript()
  const events: EaonEvent[] = []
  for (const raw of messages) {
    const message = (raw ?? {}) as { role?: string } & Record<string, unknown>
    switch (message.role) {
      case 'user':
      case 'assistant':
      case 'custom':
        events.push({ type: 'message_start', message }, { type: 'message_end', message })
        break
      case 'toolResult':
        events.push({ type: 'message_end', message })
        break
      default:
        break
    }
    if (message.role === 'bashExecution' || message.role === 'compactionSummary' || message.role === 'branchSummary') {
      // Flush what we have so these land in order.
      t = applyEvents(t, events.splice(0))
      t = { ...t, seq: t.seq + 1 }
      if (message.role === 'bashExecution') {
        t.items.push({
          kind: 'bash',
          id: `b${t.seq}`,
          command: String(message.command ?? ''),
          output: String(message.output ?? ''),
          running: false,
          exitCode: typeof message.exitCode === 'number' ? message.exitCode : null,
          cancelled: message.cancelled === true,
          truncated: message.truncated === true,
          excluded: message.excludeFromContext === true
        })
      } else {
        const tokens = typeof message.tokensBefore === 'number' ? ` · ${formatTokens(message.tokensBefore)} tokens before` : ''
        t.items.push({
          kind: 'notice',
          id: `n${t.seq}`,
          tone: 'info',
          icon: 'compact',
          text: message.role === 'compactionSummary' ? `Earlier conversation compacted${tokens}` : 'Summary of an abandoned branch',
          detail: String(message.summary ?? '')
        })
      }
    }
  }
  t = applyEvents(t, events)
  // Anything still "running" in a saved transcript was interrupted.
  for (const [id, state] of Object.entries(t.tools)) {
    if (state.status === 'running' || state.status === 'preparing') t.tools[id] = { ...state, status: 'error', output: state.output || 'Interrupted' }
  }
  return { ...t, running: false, currentAssistant: null }
}

/** The one argument worth showing next to a tool's name while its JSON is still streaming. */
export function peekArgument(argsText: string): string {
  const match = /"(?:path|file_path|command|pattern|query|url)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(argsText)
  if (!match) return ''
  try {
    return JSON.parse(`"${match[1].replace(/\\$/, '')}"`) as string
  } catch {
    return match[1]
  }
}
