import type { Chat, ChatMessage, ChatToolPart, StreamEvent } from '@shared/types'
import {
  MAX_WORKERS,
  TRADING_DESK,
  TRADING_INTERVALS,
  WORKER_ACCESS,
  WORKER_COLORS,
  WORKER_PERSONALITIES,
  nextRoutine,
  relativeTime,
  workerMood,
  type Worker,
  type WorkerDraft,
  type WorkerMessageEvent,
  type WorkerMood,
  type WorkerStreamEvent,
  type WorkerThread
} from '@shared/workers'
import { WORKFLOW_TOOLS } from '@main/agent/tools'
import { applyEvent } from '../../core/chat'
import { availableModels, modelLabel } from '../../core/models'
import { events, hasHandler, invoke } from '../../runtime/ipc'
import type { App, StatusSegment, View } from '../app'
import { EditForm } from '../form'
import type { InputEvent } from '../input'
import { renderMarkdown, wrapSegments, type Line } from '../markdown'
import { ConfirmModal } from '../modals'
import type { Canvas } from '../screen'
import { truncate, type Style } from '../term'
import { C, S } from '../theme'
import { describeToolCall, outputSummary } from '../toolText'
import { panel, scanner, spinner, Table, TextField } from '../widgets'

/**
 * Workers: the user's team of always-on agents. A table of the team with
 * each worker's face, status and what it's doing; beside it the selected
 * worker's thread, live while it works, any question it is waiting on, and
 * a box to write to it. Workers run in the session that holds the engines;
 * any other terminal sees and drives the same team.
 */

const FACES: Record<WorkerMood, string> = {
  neutral: '(•‿•)',
  happy: '(^‿^)',
  serious: '(•_•)',
  angry: '(ò_ó)',
  asleep: '(-_-)',
  dead: '(x_x)'
}

const STATUS_STYLE: Record<Worker['status'], Style> = {
  idle: { fg: C.text },
  working: { fg: C.amber, bold: true },
  asleep: { fg: C.muted },
  paused: { fg: C.muted },
  failed: { fg: C.red }
}

function nextWake(worker: Worker): number | null {
  const routine = nextRoutine(worker)
  const times = [worker.heartbeat.nextAt, routine?.nextAt ?? null].filter((t): t is number => typeof t === 'number')
  return times.length ? Math.min(...times) : null
}

export class WorkersView implements View {
  private workers: Worker[] = []
  private threads = new Map<string, ChatMessage[]>()
  private loadError: string | null = null
  private readonly table: Table<Worker>
  private readonly field = new TextField({ placeholder: 'Write to this worker… (⏎ sends)', multiline: true })
  private composing = false
  private scrollBack = 0
  private visible = false

  constructor(private readonly app: App) {
    this.table = new Table<Worker>([
      { title: '', width: 5, cell: (w) => ({ text: FACES[workerMood(w)], style: { fg: w.color, bold: true } }) },
      { title: 'NAME', width: 12, cell: (w) => ({ text: w.name, style: { fg: C.text, bold: true } }) },
      { title: 'STATUS', width: 8, cell: (w) => ({ text: w.status === 'working' ? `${spinner()} work` : w.status, style: STATUS_STYLE[w.status] }) },
      { title: 'DOING', flex: 1, cell: (w) => ({ text: w.asks.length ? `? ${w.asks[0].question}` : w.activity || w.purpose, style: w.asks.length ? S.yellow : S.muted }) },
      {
        title: 'NEXT',
        width: 8,
        cell: (w) => {
          const at = nextWake(w)
          return { text: at ? relativeTime(at).replace('in ', '') : '—', style: S.muted }
        }
      },
      { title: 'ACCESS', width: 8, cell: (w) => ({ text: w.access === 'autonomous' ? 'auto' : w.access === 'safe' ? 'careful' : 'look', style: w.access === 'autonomous' ? S.yellow : S.muted }) },
      { title: 'TRADES', width: 6, cell: (w) => ({ text: w.trading ? (w.trading.autoPlace ? 'auto' : 'asks') : '', style: S.cyan }) },
      { title: '✉', width: 2, align: 'right', cell: (w) => ({ text: w.unread ? String(Math.min(9, w.unread)) : '', style: S.amberBold }) }
    ])
    events.on('workers:changed', (workers: Worker[]) => {
      this.workers = workers
      if (this.visible) app.invalidate()
    })
    events.on('workers:message', ({ workerId, message }: WorkerMessageEvent) => {
      const thread = this.threads.get(workerId)
      if (!thread) return
      const at = thread.findIndex((m) => m.id === message.id)
      if (at === -1) thread.push(message)
      else thread[at] = message
      if (this.visible) app.invalidate()
    })
    events.on('workers:event', (payload: WorkerStreamEvent | WorkerStreamEvent[]) => {
      for (const { workerId, event } of Array.isArray(payload) ? payload : [payload]) this.applyStream(workerId, event)
      if (this.visible) app.invalidate()
    })
    events.on('engines:role', () => void this.load())
  }

  private applyStream(workerId: string, event: StreamEvent): void {
    const thread = this.threads.get(workerId)
    if (!thread) return
    const chat = { id: workerId, messages: thread } as unknown as Chat
    const next = applyEvent(chat, event)
    if (next !== chat) this.threads.set(workerId, next.messages)
  }

  async load(): Promise<void> {
    if (!hasHandler('workers:list')) {
      this.loadError = 'Workers run in the session that holds the engines; it isn’t reachable yet.'
      return
    }
    try {
      this.workers = await invoke<Worker[]>('workers:list')
      this.loadError = null
      const selected = this.selected()
      if (selected) void this.loadThread(selected.id)
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error)
    }
    this.app.invalidate()
  }

  private async loadThread(id: string): Promise<void> {
    try {
      const thread = await invoke<WorkerThread>('workers:thread', id)
      this.threads.set(id, thread.messages)
      void invoke('workers:mark-read', id).catch(() => {})
      this.app.invalidate()
    } catch {
      /* shown as empty */
    }
  }

  enter(): void {
    this.visible = true
    void this.load()
  }

  leave(): void {
    this.visible = false
    this.composing = false
  }

  typing(): boolean {
    return this.composing
  }

  animating(): boolean {
    return this.workers.some((w) => w.status === 'working')
  }

  private selected(): Worker | undefined {
    return this.workers[this.table.selected]
  }

  /* -------------------------------------------------------------- draw */

  private threadLines(messages: ChatMessage[], width: number, worker: Worker): Line[] {
    const out: Line[] = []
    for (const message of messages.slice(-60)) {
      if (message.role === 'user') {
        out.push([])
        if (message.heartbeat) out.push([{ text: '  ⏰ ', style: S.amber }, { text: truncate(message.heartbeat, width - 6), style: S.muted }])
        const mail = message.mail?.length ? message.mail : [{ fromName: 'You', text: message.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''), from: 'user' }]
        for (const piece of mail) {
          if (!piece.text.trim()) continue
          const from = piece.from === 'user' ? 'You' : piece.fromName
          out.push(...wrapSegments([{ text: piece.text, style: { fg: '#F2F2F2' } }], width, [{ text: ` ${from} › `, style: { fg: piece.from === 'user' ? C.amber : C.cyan, bold: true } }], [{ text: '   ' }]))
        }
        continue
      }
      if (message.role !== 'assistant') continue
      const face = [{ text: ` ${worker.name} `, style: { fg: worker.color, bold: true } }]
      let first = true
      for (const part of message.parts) {
        if (part.type === 'text' && part.text.trim()) {
          const md = renderMarkdown(part.text, width - 2)
          md.forEach((line, i) => out.push(first && i === 0 ? [...face, ...line] : [{ text: '  ' }, ...line]))
          first = false
        } else if (part.type === 'tool') {
          const tool = part as ChatToolPart
          if (WORKFLOW_TOOLS.has(tool.name)) continue
          const { verb, target } = describeToolCall(tool.name, tool.input)
          const glyph = tool.status === 'running' ? spinner() : tool.status === 'done' ? '●' : tool.status === 'denied' ? '○' : '●'
          const color = tool.status === 'running' ? C.amber : tool.status === 'done' ? C.green : tool.status === 'denied' ? C.yellow : C.red
          out.push([{ text: `  ${glyph} `, style: { fg: color } }, { text: verb, style: S.bold }, { text: ` ${truncate(target, width - verb.length - 6)}`, style: S.muted }])
          if (tool.output && tool.status !== 'running') out.push([{ text: '    ⎿ ', style: S.faint }, { text: truncate(outputSummary(tool.name, tool.output), width - 6), style: S.faint }])
        }
      }
      if (message.error) out.push([{ text: `  ✗ ${truncate(message.error, width - 4)}`, style: S.red }])
    }
    return out
  }

  private drawWorker(c: Canvas, worker: Worker): void {
    const inner = panel(c, `${worker.name} · ${worker.status}`, {
      right: [{ text: `${worker.access === 'autonomous' ? 'autonomous' : worker.access === 'safe' ? 'careful' : 'look only'} · ${worker.model ? worker.model.modelId : 'app model'}`, style: S.muted }],
      focused: this.composing
    })
    let y = 0
    inner.segments(0, y++, [
      { text: `${FACES[workerMood(worker)]} `, style: { fg: worker.color, bold: true } },
      { text: truncate(worker.purpose || 'No purpose set', inner.w - 8), style: S.text }
    ])
    const wake = nextWake(worker)
    inner.text(0, y++, `${worker.activity || 'Nothing going on.'}${wake ? ` · wakes ${relativeTime(wake)}` : ''}${worker.trading ? ` · trades ${worker.trading.via === TRADING_DESK ? 'on the desk' : `via ${worker.trading.via}`} every ${worker.trading.everyMinutes}m` : ''}`, S.muted, inner.w)
    if (worker.goal) inner.text(0, y++, `goal: ${worker.goal}`, S.cyan, inner.w)
    inner.hline(0, y++, inner.w, S.border)
    // A question the worker is waiting on goes above the thread.
    const ask = worker.asks[0]
    const composerH = this.composing ? Math.min(6, this.field.height(inner.w - 4, 5) + 2) : 1
    let askH = 0
    if (ask) {
      const lines = wrapSegments([{ text: ask.question, style: { fg: C.text, bold: true } }], inner.w - 4)
      const opts = ask.approve ? ['y approve once', 'n refuse'] : ask.options.map((o, i) => `${i + 1} ${o}`)
      askH = lines.length + 3
      const box = inner.sub(0, inner.h - composerH - askH, inner.w, askH)
      box.box({ fg: C.yellow }, { rounded: true, title: ask.approve ? 'Wants to do this' : 'Asks', titleStyle: { fg: C.yellow, bold: true } })
      lines.forEach((line, i) => box.segments(2, 1 + i, line, box.w - 4))
      box.text(2, 1 + lines.length, opts.join('   ') + '   ⏎ answer in your words', S.muted, box.w - 4)
    }
    const area = inner.sub(0, y, inner.w, inner.h - y - composerH - askH)
    const thread = this.threads.get(worker.id)
    if (!thread) area.text(0, 0, 'Loading…', S.faint)
    else if (thread.length === 0) area.text(0, 0, `Nothing yet. ⏎ to write to ${worker.name}.`, S.faint)
    else {
      const lines = this.threadLines(thread, area.w, worker)
      this.scrollBack = Math.min(this.scrollBack, Math.max(0, lines.length - area.h))
      const start = Math.max(0, lines.length - area.h - this.scrollBack)
      for (let i = 0; i < area.h && start + i < lines.length; i++) area.segments(0, i, lines[start + i], area.w)
    }
    const composer = inner.sub(0, inner.h - composerH, inner.w, composerH)
    if (this.composing) {
      composer.box({ fg: C.amber }, { rounded: true })
      composer.text(1, 1, '›', S.amberBold)
      this.field.draw(composer.sub(3, 1, composer.w - 4, composer.h - 2), S.text, !this.app.hasModal())
    } else if (worker.status === 'working') {
      // The same light as the chat's, in the worker's colour, with what it's doing.
      composer.segments(0, 0, [...scanner(Date.now(), worker.color), { text: `  ${worker.activity || 'Working'}`, style: S.text }, { text: '  ·  ⏎ write · S stop the turn', style: S.faint }], composer.w)
    } else composer.text(0, 0, `⏎ write to ${worker.name} · W check in now · P ${worker.paused ? 'resume' : 'pause'} · E edit · S stop the turn`, S.faint, composer.w)
  }

  draw(c: Canvas): void {
    const wide = c.w >= 120
    const tableC = wide ? c.sub(0, 0, Math.floor(c.w * 0.5), c.h) : c.sub(0, 0, c.w, Math.max(8, Math.floor(c.h * 0.4)))
    const team = panel(tableC, `Team [${this.workers.length}/${MAX_WORKERS}]`, {
      right: [{ text: 'N new · D delete', style: S.faint }],
      focused: !this.composing
    })
    if (this.loadError) team.text(0, 0, this.loadError, S.yellow, team.w)
    else
      this.table.draw(team, this.workers, {
        empty: 'No workers yet. N creates one: an agent that keeps working on its own, on a schedule it sets itself.',
        focused: !this.composing
      })
    const worker = this.selected()
    const rest = wide ? c.sub(tableC.w, 0, c.w - tableC.w, c.h) : c.sub(0, tableC.h, c.w, c.h - tableC.h)
    if (worker) this.drawWorker(rest, worker)
    else {
      const inner = panel(rest, 'Workers')
      const lines = [
        'Workers are agents that live on this computer and keep going without you:',
        '',
        '•  each has one endless thread, a purpose and its own folder',
        '•  it wakes when you write, when a colleague mails it, or on a heartbeat it sets',
        '•  it can trade for you on the desk (or a broker plugin), inside your limits',
        '•  it asks you before anything it may not do alone',
        '',
        'N  create one'
      ]
      let y = 0
      lines.forEach((line, i) => {
        const style = i === lines.length - 1 ? S.amberBold : S.muted
        const bullet = line.startsWith('•')
        const text = bullet ? line.slice(1).trim() : line
        const first = bullet ? [{ text: '•  ', style: S.amber }] : []
        for (const part of wrapSegments([{ text, style }], inner.w, first, bullet ? [{ text: '   ' }] : [])) inner.segments(0, y++, part, inner.w)
      })
    }
  }

  status(): StatusSegment[] {
    const working = this.workers.filter((w) => w.status === 'working').length
    const asks = this.workers.reduce((n, w) => n + w.asks.length, 0)
    return [
      { text: `${this.workers.length} workers`, style: S.text },
      { text: ` · ${working} working`, style: working ? { fg: C.amber } : S.muted },
      ...(asks ? [{ text: ` · ${asks} waiting on you`, style: S.yellow }] : [])
    ]
  }

  hints(): [string, string][] {
    return this.composing ? [['⏎', 'send'], ['esc', 'back']] : [['↑↓', 'worker'], ['⏎', 'write'], ['N', 'new'], ['W', 'check in']]
  }

  /* -------------------------------------------------------------- keys */

  private run(channel: string, ...args: unknown[]): void {
    void invoke(channel, ...args).catch((error) => this.app.toast(error instanceof Error ? error.message : String(error), 'error'))
  }

  onEvent(event: InputEvent): boolean {
    const worker = this.selected()
    if (this.composing && worker) {
      if (event.type === 'key' && event.name === 'escape') {
        this.composing = false
        return true
      }
      const result = this.field.handle(event, 60)
      if (result === 'submit') {
        const text = this.field.value.trim()
        if (text) {
          const ask = worker.asks[0]
          if (ask) this.run('workers:answer', worker.id, ask.id, { text })
          else this.run('workers:send', worker.id, text, [], {})
          this.field.remember(text)
          this.field.clear()
          this.scrollBack = 0
        }
        return true
      }
      return result !== 'ignored'
    }
    if (event.type === 'mouse') {
      if (event.action === 'wheelup') this.scrollBack += 3
      else if (event.action === 'wheeldown') this.scrollBack = Math.max(0, this.scrollBack - 3)
      return true
    }
    if (event.type !== 'key') return false
    if (event.name === 'up' || event.name === 'down') {
      this.table.move(event.name === 'up' ? -1 : 1, this.workers.length)
      this.scrollBack = 0
      const next = this.selected()
      if (next) void this.loadThread(next.id)
      return true
    }
    if (event.name === 'pageup') return void (this.scrollBack += 10), true
    if (event.name === 'pagedown') return void (this.scrollBack = Math.max(0, this.scrollBack - 10)), true
    if (event.name === 'enter' && worker) {
      this.composing = true
      return true
    }
    const ch = (event.ch ?? '').toLowerCase()
    if (event.ctrl || event.meta) return false
    const ask = worker?.asks[0]
    if (ask && worker) {
      if (ask.approve && (ch === 'y' || ch === 'n')) {
        this.run('workers:answer', worker.id, ask.id, { approved: ch === 'y', text: ch === 'y' ? 'Approved.' : 'No.' })
        return true
      }
      if (/^[1-9]$/.test(ch) && ask.options[Number(ch) - 1]) {
        this.run('workers:answer', worker.id, ask.id, { text: ask.options[Number(ch) - 1] })
        return true
      }
    }
    switch (ch) {
      case 'n':
        this.edit(null)
        return true
      case 'e':
        if (worker) this.edit(worker)
        return true
      case 'w':
        if (worker) {
          this.run('workers:wake', worker.id)
          this.app.toast(`${worker.name}: checking in`, 'info', 1500)
        }
        return true
      case 'p':
        if (worker) this.run('workers:set-paused', worker.id, !worker.paused)
        return true
      case 's':
        if (worker?.status === 'working') this.run('workers:stop', worker.id)
        return true
      case 'd':
        if (worker)
          this.app.push(
            new ConfirmModal({
              title: `Delete ${worker.name}?`,
              body: `Its thread, notes and routines go. Files in its folder stay.`,
              danger: true,
              yes: 'delete',
              onAnswer: (yes) => yes && this.run('workers:remove', worker.id)
            })
          )
        return true
    }
    return false
  }

  private edit(worker: Worker | null): void {
    if (!hasHandler('workers:save')) return this.app.toast(this.loadError ?? 'Workers aren’t available', 'error')
    const models = availableModels().slice(0, 40)
    const modelKey = (m: { providerId: string; modelId: string } | null): string => (m ? `${m.providerId}::${m.modelId}` : 'app')
    const personalities = WORKER_PERSONALITIES.map((p) => ({ value: p.text, label: p.label }))
    const known = personalities.some((p) => p.value === worker?.personality)
    this.app.push(
      new EditForm({
        title: worker ? `Edit ${worker.name}` : 'New worker',
        width: 96,
        submitLabel: worker ? 'save' : 'create',
        initial: {
          name: worker?.name ?? '',
          purpose: worker?.purpose ?? '',
          personality: worker && known ? worker.personality : (worker?.personality ?? personalities[0].value),
          color: worker?.color ?? WORKER_COLORS[Math.floor(Math.random() * WORKER_COLORS.length)],
          access: worker?.access ?? 'safe',
          model: modelKey(worker?.model ?? null),
          trading: worker?.trading ? 'desk' : 'off',
          strategy: worker?.trading?.strategy ?? '',
          every: String(worker?.trading?.everyMinutes ?? 15),
          autoPlace: String(worker?.trading?.autoPlace ?? false)
        },
        fields: [
          { key: 'name', label: 'Name', kind: 'text', placeholder: 'Nova' },
          { key: 'purpose', label: 'Purpose', kind: 'multiline', placeholder: 'What it is for, in a sentence or two' },
          { key: 'personality', label: 'Personality', kind: 'choice', options: known || !worker ? personalities : [...personalities, { value: worker.personality, label: 'Custom' }] },
          { key: 'color', label: 'Colour', kind: 'choice', options: WORKER_COLORS.map((c) => ({ value: c, label: c })) },
          { key: 'access', label: 'Access', kind: 'choice', options: WORKER_ACCESS.map((a) => ({ value: a.id, label: a.label })), hint: '' },
          { key: 'model', label: 'Model', kind: 'choice', options: [{ value: 'app', label: 'The app’s model' }, ...models.map((m) => ({ value: modelKey({ providerId: m.providerId, modelId: m.id }), label: modelLabel(m) }))] },
          { key: 'trading', label: 'Trading', kind: 'choice', options: [{ value: 'off', label: 'Doesn’t trade' }, { value: 'desk', label: 'Trades on the desk' }] },
          { key: 'strategy', label: 'Strategy', kind: 'multiline', visible: (v) => v.trading === 'desk' },
          { key: 'every', label: 'Look every', kind: 'choice', options: TRADING_INTERVALS.map((m) => ({ value: String(m), label: `${m} min` })), visible: (v) => v.trading === 'desk' },
          { key: 'autoPlace', label: 'Place orders alone', kind: 'toggle', hint: 'off: each order waits for your approval', visible: (v) => v.trading === 'desk' }
        ],
        preview: (v) => [[{ text: WORKER_ACCESS.find((a) => a.id === v.access)?.description ?? '', style: S.muted }]],
        onSubmit: async (v) => {
          if (!v.name.trim()) return 'Give it a name.'
          const [providerId, modelId] = v.model === 'app' ? [] : v.model.split('::')
          const draft: WorkerDraft = {
            ...(worker ? { id: worker.id } : {}),
            name: v.name.trim(),
            purpose: v.purpose.trim(),
            personality: v.personality,
            color: v.color,
            access: v.access as Worker['access'],
            model: providerId && modelId ? { providerId, modelId } : null,
            trading: v.trading === 'desk' ? { via: TRADING_DESK, strategy: v.strategy.trim(), everyMinutes: Number(v.every), autoPlace: v.autoPlace === 'true' } : null
          }
          try {
            const saved = await invoke<Worker>('workers:save', draft)
            this.app.toast(worker ? `${saved.name} saved` : `${saved.name} joined the team`, 'success')
            await this.load()
            const at = this.workers.findIndex((w) => w.id === saved.id)
            if (at !== -1) this.table.selected = at
          } catch (error) {
            return error instanceof Error ? error.message : String(error)
          }
        }
      })
    )
  }
}
