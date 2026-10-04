import { app as electronApp } from 'electron'
import type { Chat, ChatMessage, PlanProposal, TodoItem } from '@shared/types'
import { store } from '@main/store'
import type { ChatController, CliMessage, CliToolPart, ShellRun, TurnChanges } from '../../core/chat'
import { chatModel, effectiveEffort, effortLabel, modelLabel, viewSettings } from '../../core/models'
import { fuzzyFiles, projectFiles } from '../../coding/files'
import { loadInstructions } from '../../coding/instructions'
import { lspStatus } from '../../coding/lsp'
import { previewChange } from '../../coding/tools'
import type { App, StatusSegment, View } from '../app'
import { renderCode, renderDiff, stats, STATUS_MARK } from '../diffview'
import { highlightLine } from '../highlight'
import type { InputEvent } from '../input'
import { plainLines, renderMarkdown, wrapSegments, type Line, type Segment } from '../markdown'
import type { Canvas } from '../screen'
import { plainOutput, strWidth, truncate, type Style } from '../term'
import { C, S } from '../theme'
import { describeToolCall, shortPath } from '../toolText'
import { scanner, spinner, TextField } from '../widgets'
import { drawSpinningLogo, logoWidth } from '../logo3d'
import { matchCommands, runSlash, type SlashContext } from '../slash'

/**
 * Chat: the agent in a terminal, built to code the way opencode does.
 *
 * The transcript shows the conversation and everything the agent does:
 * reads, searches and lookups as one line each; every edit or write as a
 * real diff (with line numbers, syntax colour, and any errors the
 * language server found); every command with its output; the checklist as
 * it changes; and, when a turn ends, the files it changed. Approvals for
 * changes show the diff before anything is written.
 *
 * The composer completes /commands and @files, runs `!commands` in the
 * project, and on wide terminals a sidebar shows the context used, the
 * files changed in this chat, the checklist and the language servers.
 */

const LOGO = ['█▀▀ ▄▀█ █▀█ █▄ █', '██▄ █▀█ █▄█ █ ▀█']

const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))
const str = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))

/** Pins the view to one chat (the trading desk's) instead of the active one. */
export interface ChatTarget {
  id(): string | null
  set(id: string): void
  title: string
  empty: [string, string][]
}

interface Rendered {
  width: number
  key: string
  lines: Line[]
}

const SIDEBAR_WIDTH = 36
const INLINE_ICON: Record<string, string> = {
  read_file: '→',
  list_dir: '◇',
  grep: '✱',
  glob: '✱',
  find_file: '✱',
  codebase_search: '✱',
  find_symbol: '✱',
  web_search: '◎',
  web_fetch: '%',
  load_skill: '✦',
  generate_image: '▣',
  sessions_list: '↔',
  session_send: '↔'
}

/** describeToolCall's verbs, as what the agent is doing now. */
const DOING: Record<string, string> = {
  Read: 'Reading',
  Write: 'Writing',
  Edit: 'Editing',
  Delete: 'Deleting',
  Move: 'Moving',
  List: 'Listing',
  Search: 'Searching',
  Find: 'Finding',
  $: 'Running',
  'Search web': 'Searching the web',
  Fetch: 'Fetching',
  'Update plan': 'Updating the plan',
  Plan: 'Writing a plan'
}

/** A thought: ∴ on its first line, the rest indented under it. */
function thoughtLines(text: string, width: number, style: Style): Line[] {
  const first = [{ text: '  ∴ ', style: S.faint }]
  const rest = [{ text: '    ' }]
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .flatMap((para, i) => wrapSegments([{ text: para.replace(/\t/g, '  '), style }], width, i === 0 ? first : rest, rest))
}

/** "12s", "1m 04s", "1h 02m". */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

export class ChatView implements View {
  readonly field = new TextField({ placeholder: 'Ask anything · @ to add files · ! to run a command · / for commands', multiline: true })
  /** Lines scrolled up from the bottom; 0 follows the newest. */
  private scrollBack = 0
  private cache = new WeakMap<ChatMessage, Rendered>()
  showThinking = false
  verbose = false
  /** The right-hand panel on wide screens. */
  sidebar = true
  /** False when the trading desk has taken the keyboard back from this box. */
  focused = true
  private menuIndex = 0
  private lastHeight = 20
  /** The transcript as last drawn, so scrolling back can hold its place as lines arrive. */
  private seen = { chatId: '', width: 0, lines: 0 }
  /** The welcome screen's turning logo was drawn last frame, so frames keep coming. */
  private logoShown = false

  constructor(
    private readonly app: App,
    private readonly chat: ChatController,
    private readonly slash: SlashContext,
    private readonly target: ChatTarget | null = null
  ) {
    chat.on('change', () => app.invalidate())
    chat.on('approval', () => app.invalidate())
    chat.on('notice', (text: string) => app.toast(text))
  }

  typing(): boolean {
    return this.focused && this.chat.approvals.length === 0
  }

  animating(): boolean {
    return this.chat.runningCount() > 0 || this.chat.shellRunning() || (this.logoShown && !this.current()?.messages.length)
  }

  private currentId(): string | null {
    return this.target ? this.target.id() : this.chat.activeId
  }

  private current(): Chat | null {
    const id = this.currentId()
    return id ? this.chat.get(id) : null
  }

  /** Puts text back in the composer (after /undo). */
  setDraft(text: string): void {
    this.field.value = text
  }

  /* -------------------------------------------------------------- status */

  status(): StatusSegment[] {
    const settings = viewSettings()
    const model = chatModel(settings)
    const effort = effectiveEffort(model, settings.effort)
    const mode = settings.approvalMode
    const out: StatusSegment[] = [
      { text: modelLabel(model), style: { fg: model ? C.text : C.red, bold: true } },
      ...(effort ? [{ text: ` · ${effortLabel(effort)}`, style: S.muted }] : []),
      { text: ' · ', style: S.faint },
      { text: mode === 'ask' ? 'ask first' : mode === 'auto' ? 'approve for me' : 'full access', style: { fg: mode === 'full' ? C.red : mode === 'auto' ? C.yellow : C.muted } },
      ...(settings.planMode ? [{ text: ' · plan', style: { fg: C.cyan } }] : []),
      ...(settings.work.swarm ? [{ text: ' · swarm', style: { fg: C.purple } }] : []),
      { text: ` · ${shortPath(this.chat.cwd)}`, style: S.faint }
    ]
    const running = this.chat.runningCount()
    if (running > 1) out.push({ text: ` · ${running} replies running`, style: { fg: C.amber } })
    return out
  }

  hints(): [string, string][] {
    if (this.chat.approvals.length) return [['y', 'allow'], ['n', 'deny'], ['a', 'allow all']]
    if (this.chat.isRunning(this.currentId())) return [['esc', 'stop'], ['⇞⇟', 'scroll'], ['⌃O', 'details']]
    return [['⏎', 'send'], ['⇥', 'switch tab'], ['⇧⇥', 'approvals'], ['⌃P', 'model'], ['⌃R', 'chats']]
  }

  /* --------------------------------------------------------- transcript */

  private renderMessage(message: ChatMessage, width: number, running: boolean, chat: Chat): Line[] {
    const key = `${this.showThinking ? 1 : 0}${this.verbose ? 1 : 0}`
    const live = running || (message as CliMessage).shell?.running
    if (!live) {
      const cached = this.cache.get(message)
      if (cached && cached.width === width && cached.key === key) return cached.lines
    }
    const lines =
      message.role === 'user'
        ? this.userLines(message, width)
        : (message as CliMessage).shell
          ? this.shellLines((message as CliMessage).shell!, width)
          : this.assistantLines(message, width, running, chat)
    if (!live) this.cache.set(message, { width, key, lines })
    return lines
  }

  private userLines(message: ChatMessage, width: number): Line[] {
    let text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
    const peer = /^\[From ([^,\]]+), another session\] /.exec(text)
    if (peer) text = text.slice(peer[0].length)
    const bg = '#18181B'
    const body: Style = { fg: '#F2F2F2', bg }
    const first = peer ? [{ text: ` ↘ ${peer[1]} `, style: { fg: C.cyan, bg, bold: true } }] : [{ text: ' › ', style: { fg: C.amber, bg, bold: true } }]
    const rest = [{ text: '   ', style: body }]
    // @mentions read as file chips.
    const segments = (para: string): Segment[] =>
      para.split(/(@[^\s]+)/g).filter(Boolean).map((piece) => (piece.startsWith('@') && piece.length > 1 ? { text: piece, style: { fg: C.cyan, bg, bold: true } } : { text: piece, style: body }))
    const lines = text.split('\n').flatMap((para, i) => wrapSegments(segments(para), width - 1, i === 0 ? first : rest, rest))
    for (const line of lines) {
      const used = line.reduce((s, seg) => s + strWidth(seg.text), 0)
      if (used < width) line.push({ text: ' '.repeat(width - used), style: { bg } })
    }
    // Files the user attached; a ! command's output is already shown above, so it's left out here.
    const shellDir = electronApp.getPath('userData')
    const files = (message.attachments ?? []).filter((a) => !a.startsWith(shellDir))
    if (files.length) lines.push([{ text: '   📎 ', style: S.muted }, { text: files.map((a) => shortPath(a, this.chat.cwd)).join(', '), style: S.muted }])
    return lines
  }

  private shellLines(run: ShellRun, width: number): Line[] {
    const out: Line[] = []
    const head: Segment[] = [{ text: '  ', style: undefined }, { text: run.running ? `${spinner()} ` : '! ', style: { fg: C.amber, bold: true } }, ...highlightLine(run.command, 'sh')]
    out.push(...wrapSegments(head, width))
    const lines = plainOutput(run.output).trimEnd().split('\n').filter((l, i, all) => l !== '' || i < all.length - 1)
    const max = this.verbose ? 200 : 12
    const shown = lines.length > max ? lines.slice(-max) : lines
    if (lines.length > max) out.push([{ text: `    … ${lines.length - max} earlier lines`, style: S.faint }])
    for (const line of shown) out.push([{ text: '    ' }, { text: truncate(line, width - 5), style: { fg: '#BDBDC2' } }])
    if (!run.running) {
      const ok = run.exitCode === 0
      out.push([{ text: '    ' }, { text: ok ? '✓ done' : `✗ exit ${run.exitCode ?? '?'}`, style: ok ? S.faint : S.red }, { text: '  · the output goes to the agent with your next message', style: S.faint }])
    }
    return out
  }

  /** One line for a lookup: icon, what, and how much it found. */
  private inlineTool(part: CliToolPart, width: number, running: boolean): Line[] {
    const meta = part.meta
    let verb: string
    let target: string
    let suffix = ''
    switch (part.name) {
      case 'read_file':
        verb = 'Read'
        target = shortPath(str(part.input.path), this.chat.cwd)
        if (meta?.lines) suffix = meta.lines.from === 1 && meta.lines.to === meta.lines.total ? `${meta.lines.total} lines` : `lines ${meta.lines.from}–${meta.lines.to} of ${meta.lines.total}`
        break
      case 'grep':
        verb = 'Grep'
        target = `"${str(part.input.pattern)}"${part.input.include ? ` in ${str(part.input.include)}` : ''}`
        if (meta?.count !== undefined) suffix = `${meta.count} match${meta.count === 1 ? '' : 'es'}`
        break
      case 'glob':
        verb = 'Glob'
        target = `"${str(part.input.pattern)}"`
        if (meta?.count !== undefined) suffix = `${meta.count} file${meta.count === 1 ? '' : 's'}`
        break
      default: {
        const d = describeToolCall(part.name, part.input, this.chat.cwd)
        verb = d.verb
        target = d.target
      }
    }
    const icon = INLINE_ICON[part.name] ?? '⚙'
    const glyph =
      part.status === 'running'
        ? { text: running ? spinner() : '◌', style: { fg: C.amber } }
        : part.status === 'error'
          ? { text: '✗', style: { fg: C.red } }
          : part.status === 'denied'
            ? { text: '○', style: { fg: C.yellow } }
            : { text: icon, style: { fg: C.muted } }
    const line = wrapSegments(
      [
        { text: verb, style: { fg: C.text } },
        ...(target ? [{ text: ` ${target}`, style: S.muted }] : []),
        ...(suffix ? [{ text: ` · ${suffix}`, style: S.faint }] : [])
      ],
      width,
      [{ text: '  ' }, glyph, { text: ' ' }],
      [{ text: '    ' }]
    ).slice(0, 2)
    if (part.status === 'error' && part.output) line.push([{ text: '    ⎿ ', style: S.faint }, { text: truncate(part.output.split('\n')[0], width - 6), style: S.red }])
    if (part.status === 'denied') line.push([{ text: '    ⎿ ', style: S.faint }, { text: 'not allowed', style: S.yellow }])
    if (this.verbose && part.status === 'done' && part.output && part.name !== 'read_file') {
      for (const l of plainOutput(part.output).split('\n').slice(0, 20)) line.push([{ text: '      ' }, { text: truncate(l, width - 6), style: S.faint }])
    }
    return line
  }

  /** An edit, a new file, a deletion or a move: a header and the diff, then any errors. */
  private changeBlock(part: CliToolPart, width: number, running: boolean): Line[] {
    const meta = part.meta
    const path = meta?.path ?? shortPath(str(part.input.path ?? part.input.to), this.chat.cwd)
    const verb = { edit_file: 'Edit', write_file: 'Write', delete_file: 'Delete', move_file: 'Move' }[part.name] ?? part.name
    if (part.status === 'running') {
      return [[{ text: '  ' }, { text: running ? spinner() : '◌', style: { fg: C.amber } }, { text: ` ${verb}`, style: { fg: C.text } }, { text: ` ${path}`, style: S.muted }]]
    }
    if (part.status !== 'done' || !meta?.diff) {
      const out: Line[] = [[{ text: '  ' }, { text: part.status === 'denied' ? '○' : '✗', style: part.status === 'denied' ? S.yellow : S.red }, { text: ` ${verb}`, style: { fg: C.text } }, { text: ` ${path}`, style: S.muted }]]
      if (part.status === 'denied') out.push([{ text: '    ⎿ ', style: S.faint }, { text: 'not allowed', style: S.yellow }])
      else if (part.output) for (const l of plainLines(part.output.split('\n')[0], width - 6, S.red, '    ⎿ ').slice(0, 3)) out.push(l)
      return out
    }
    const diff = meta.diff
    const created = diff.status === 'added'
    const head: Segment[] = [
      { text: '  ' },
      { text: '← ', style: { fg: created ? C.green : diff.status === 'deleted' ? C.red : C.amber, bold: true } },
      { text: created ? 'Write' : diff.status === 'deleted' ? 'Delete' : diff.status === 'renamed' ? 'Move' : verb, style: { fg: C.text, bold: true } },
      { text: ` ${diff.status === 'renamed' && diff.oldPath ? `${diff.oldPath} → ` : ''}${path}  `, style: { fg: C.cyan } },
      ...stats(diff.additions, diff.deletions),
      ...(created ? [{ text: '  new file', style: S.faint }] : []),
      ...(meta.strategy ? [{ text: `  matched by ${meta.strategy}`, style: { fg: C.yellow } }] : [])
    ]
    const out: Line[] = [head]
    const max = this.verbose ? Infinity : 24
    const split = width >= 150
    if (created && part.name !== 'move_file') {
      const content = str(part.input.content ?? part.input.new_text)
      out.push(...renderCode(path, content, width - 4, { maxRows: this.verbose ? Infinity : 14, indent: '    ' }))
    } else out.push(...renderDiff(diff, width, { maxRows: max, split, indent: '    ' }))
    const errors = meta.diagnostics ?? []
    if (errors.length) {
      out.push([{ text: '    ' }, { text: `✗ ${errors.length} error${errors.length === 1 ? '' : 's'} from the language server`, style: S.redBold }])
      for (const d of errors.slice(0, this.verbose ? 20 : 4)) out.push([{ text: `      [${d.range.start.line + 1}:${d.range.start.character + 1}] `, style: S.red }, { text: truncate(d.message.replace(/\s+/g, ' '), width - 16), style: { fg: '#FFB4AE' } }])
      if (errors.length > 4 && !this.verbose) out.push([{ text: `      … ${errors.length - 4} more`, style: S.faint }])
    }
    return out
  }

  /** A command: the command line, the end of its output, and how it ended. */
  private commandBlock(part: CliToolPart, width: number, running: boolean): Line[] {
    const command = str(part.input.command)
    const out: Line[] = wrapSegments(
      [...highlightLine(command, 'sh'), ...(part.input.background ? [{ text: '  (background)', style: S.faint }] : [])],
      width - 4,
      [{ text: '  ' }, { text: part.status === 'running' ? `${running ? spinner() : '◌'} ` : '$ ', style: { fg: part.status === 'running' ? C.amber : C.muted, bold: true } }],
      [{ text: '    ' }]
    ).slice(0, this.verbose ? 20 : 3)
    if (part.status === 'denied') return [...out, [{ text: '    ⎿ ', style: S.faint }, { text: 'not allowed', style: S.yellow }]]
    const raw = part.status === 'running' ? (part.progress ?? '') : (part.output ?? '')
    const [first, ...rest] = plainOutput(raw).split('\n')
    const exit = /^exit code (-?\d+)$/.exec(first?.trim() ?? '')
    const body = (exit || /^terminated/.test(first ?? '') ? rest : [first, ...rest]).join('\n').trimEnd()
    const lines = body ? body.split('\n') : []
    const max = this.verbose ? 120 : part.status === 'running' ? 6 : 10
    if (lines.length > max) out.push([{ text: `    … ${lines.length - max} earlier lines${this.verbose ? '' : ' · ⌃O shows more'}`, style: S.faint }])
    for (const line of lines.slice(-max)) out.push([{ text: '    ' }, { text: truncate(line, width - 5), style: { fg: '#BDBDC2' } }])
    if (part.status !== 'running') {
      const code = exit ? Number(exit[1]) : null
      if (code === 0) out.push([{ text: '    ✓ ', style: S.green }, { text: 'exit 0', style: S.faint }])
      else if (code !== null) out.push([{ text: '    ✗ ', style: S.red }, { text: `exit ${code}`, style: S.red }])
      else if (part.status === 'error') out.push([{ text: '    ✗ ', style: S.red }, { text: truncate(first ?? 'failed', width - 8), style: S.red }])
      else if (first && /^terminated/.test(first)) out.push([{ text: '    ✗ ', style: S.red }, { text: first, style: S.red }])
    }
    return out
  }

  private todoLines(items: TodoItem[], width: number): Line[] {
    return items.slice(0, 12).map((todo) => {
      const mark = todo.status === 'done' ? '☑' : todo.status === 'in_progress' ? '◐' : '☐'
      const color = todo.status === 'done' ? C.green : todo.status === 'in_progress' ? C.amber : C.muted
      return [{ text: '    ' }, { text: `${mark} `, style: { fg: color } }, { text: truncate(todo.text, width - 8), style: todo.status === 'done' ? { fg: C.faint } : todo.status === 'in_progress' ? { fg: C.text, bold: true } : S.text }]
    })
  }

  private toolLines(part: CliToolPart, width: number, running: boolean): Line[] {
    switch (part.name) {
      case 'edit_file':
      case 'write_file':
      case 'delete_file':
      case 'move_file':
        return this.changeBlock(part, width, running)
      case 'run_command':
        return this.commandBlock(part, width, running)
      case 'update_plan': {
        const items = Array.isArray(part.input.items) ? (part.input.items as TodoItem[]).filter((t) => t && typeof t.text === 'string') : []
        if (!items.length) return []
        return [[{ text: '  ' }, { text: '☰ ', style: S.muted }, { text: 'Plan', style: { fg: C.text } }], ...this.todoLines(items, width)]
      }
      case 'present_plan':
      case 'goal_complete':
      case 'goal_blocked':
      case 'wait':
        return []
      default:
        return this.inlineTool(part, width, running)
    }
  }

  private planLines(plan: PlanProposal, width: number): Line[] {
    const out: Line[] = [[{ text: '  ┌─ ', style: { fg: C.cyan } }, { text: plan.title || 'Plan', style: { fg: C.cyan, bold: true } }]]
    const bar = [{ text: '  │ ', style: { fg: C.cyan } }]
    if (plan.summary) out.push(...wrapSegments([{ text: plan.summary, style: S.text }], width, bar, bar))
    plan.steps.forEach((step, i) => out.push(...wrapSegments([{ text: step, style: S.text }], width, [...bar, { text: `${i + 1}. `, style: S.muted }], [...bar, { text: '   ' }])))
    const status =
      plan.status === 'pending'
        ? [{ text: '⏎', style: S.key }, { text: ' on an empty line approves · type to change it', style: S.muted }]
        : plan.status === 'approved'
          ? [{ text: '✓ approved', style: S.green }]
          : [{ text: 'revising…', style: S.muted }]
    out.push([{ text: '  └─ ', style: { fg: C.cyan } }, ...status])
    return out
  }

  /** The turn's file changes, as a card: what it changed and how to review or undo it. */
  private changesCard(changes: TurnChanges, width: number): Line[] {
    const files = changes.files
    const adds = files.reduce((n, f) => n + f.additions, 0)
    const dels = files.reduce((n, f) => n + f.deletions, 0)
    const edge = { fg: '#3A3A3D' }
    const out: Line[] = [
      [
        { text: '  ╭─ ', style: edge },
        { text: `${files.length} file${files.length === 1 ? '' : 's'} changed  `, style: { fg: C.text, bold: true } },
        ...stats(adds, dels),
        { text: '   /diff review · /undo revert', style: S.faint }
      ]
    ]
    const nameWidth = Math.min(60, Math.max(20, width - 24))
    for (const f of files.slice(0, this.verbose ? 50 : 8)) {
      const mark = STATUS_MARK[f.status]
      const name = f.status === 'renamed' && f.oldPath ? `${f.oldPath} → ${f.path}` : f.path
      out.push([{ text: '  │ ', style: edge }, mark, { text: ` ${truncate(name, nameWidth).padEnd(nameWidth)} ` }, ...stats(f.additions, f.deletions)])
    }
    if (files.length > 8 && !this.verbose) out.push([{ text: '  │ ', style: edge }, { text: `… ${files.length - 8} more`, style: S.faint }])
    out.push([{ text: '  ╰─', style: edge }])
    return out
  }

  private assistantLines(message: ChatMessage, width: number, running: boolean, chat: Chat): Line[] {
    const out: Line[] = []
    const inner = width - 2
    const parts = message.parts
    parts.forEach((part, i) => {
      if (part.type === 'reasoning') {
        const live = running && i === parts.length - 1
        const text = part.text.trim()
        const style: Style = { fg: C.muted, italic: true }
        // An empty thought (the model hasn't said anything yet): the bar under the composer shows it thinking.
        if (!text) return
        if (this.showThinking || this.verbose) out.push(...thoughtLines(text, inner - 2, style))
        // While it thinks: the newest three lines, as they arrive.
        else if (live) {
          const lines = thoughtLines(text, inner - 2, style)
          out.push(...(lines.length > 3 ? [[{ text: '  ∴ ', style: S.faint }, ...lines[lines.length - 3].slice(1)], ...lines.slice(-2)] : lines))
        }
        // Afterwards: the first line; ⌃O shows every thought in full.
        else out.push([{ text: '  ∴ ', style: S.faint }, { text: truncate(text.split('\n').find((l) => l.trim()) ?? text, inner - 4), style: { fg: C.faint, italic: true } }])
        return
      }
      if (part.type === 'text') {
        if (!part.text.trim()) return
        if (out.length) out.push([])
        out.push(...renderMarkdown(part.text, inner).map((line) => [{ text: '  ' }, ...line]))
        if (i < parts.length - 1) out.push([])
        return
      }
      if (part.type === 'tool') {
        const lines = this.toolLines(part as CliToolPart, inner, running)
        // Blocks get a little air; lookups stack.
        const block = ['edit_file', 'write_file', 'run_command', 'update_plan'].includes((part as CliToolPart).name)
        if (block && out.length && out[out.length - 1].length) out.push([])
        out.push(...lines)
        if (block && lines.length) out.push([])
      }
    })
    if (message.plan) out.push(...this.planLines(message.plan, inner))
    if (message.error) out.push(...plainLines(message.error, inner - 2, S.red, '  ✗ '))
    const changes = (message as CliMessage).changes
    if (changes?.files.length && !running) {
      if (out.length && out[out.length - 1].length) out.push([])
      out.push(...this.changesCard(changes, inner))
    }
    if (message.usage && !running && (message.usage.input || message.usage.output)) {
      const u = message.usage
      const cached = u.input > 0 ? Math.round((u.cacheRead / Math.max(1, u.input + u.cacheRead)) * 100) : 0
      out.push([{ text: `  ↳ ${fmtTokens(u.input + u.cacheRead)} in · ${fmtTokens(u.output)} out${cached ? ` · ${cached}% cached` : ''}${message.model ? ` · ${message.model}` : ''}`, style: S.faint }])
    }
    void chat
    return out
  }

  private transcript(chat: Chat, width: number): Line[] {
    const lines: Line[] = []
    const runningId = this.chat.isRunning(chat.id) ? chat.messages[chat.messages.length - 1]?.id : null
    if (chat.summary) lines.push([{ text: '  ⋯ earlier messages were summarised to save tokens', style: S.faint }], [])
    let through = -1
    if (chat.summary) through = chat.messages.findIndex((m) => m.id === chat.summary!.throughMessageId)
    chat.messages.forEach((message, i) => {
      if (message.role === 'system' && !(message as CliMessage).shell) return
      if (i <= through && i < chat.messages.length - 20) return
      if (lines.length && (message.role === 'user' || (message as CliMessage).shell)) lines.push([])
      lines.push(...this.renderMessage(message, width, message.id === runningId, chat))
      if (message.role === 'user') lines.push([])
    })
    if (chat.goal && chat.goal.status !== 'achieved') {
      lines.push([])
      const color = chat.goal.status === 'active' ? C.amber : chat.goal.status === 'blocked' ? C.red : C.muted
      lines.push([{ text: '  ◎ goal ', style: { fg: color, bold: true } }, { text: `${chat.goal.status} · ${truncate(chat.goal.text, width - 24)}`, style: S.muted }])
    }
    return lines
  }

  /* ---------------------------------------------------------------- draw */

  private drawEmpty(c: Canvas): void {
    this.logoShown = false
    const model = chatModel()
    if (this.target && model) {
      const top = Math.max(0, Math.floor(c.h / 2) - this.target.empty.length)
      const x = Math.max(0, Math.floor((c.w - 74) / 2))
      c.text(x, top, 'Try:', S.muted)
      this.target.empty.forEach(([k, text], i) => {
        c.text(x, top + 2 + i, k, { fg: C.cyan, bold: true }, 12)
        c.text(x + 12, top + 2 + i, text, S.muted, c.w - x - 12)
      })
      return
    }
    const instructions = loadInstructions(this.chat.cwd).files
    const tips: [string, string][] = model
      ? [
          ['ask', 'it reads, edits and runs code here — every change shows as a diff'],
          ['@file', 'adds a file to your message · !cmd runs a command for the agent to see'],
          ['/undo', 'takes back the last turn and its file changes · /diff reviews them'],
          ['/init', instructions.length ? `instructions loaded from ${instructions.map((f) => shortPath(f, this.chat.cwd)).join(', ')}` : 'writes an AGENTS.md so the agent learns this project'],
          ['⇥', 'switches to Workers and the Trading desk']
        ]
      : [
          ['/import', 'bring your keys, models and plugins over from Eaon Desktop'],
          ['/keys', 'add an API key: Anthropic, OpenAI, OpenRouter, Groq and 90 more'],
          ['/login', 'sign in with ChatGPT or GitHub Copilot'],
          ['ollama', 'a local model works too: start Ollama and it appears in /model']
        ]
    // The turning mark when there's room for it, then the wordmark, the tagline and the tips.
    const textRows = LOGO.length + 2 + (model ? 0 : 2) + 1 + tips.length
    const logoRows = Math.min(22, c.h - textRows - 3)
    // Under 16 rows the arrow is a blur, so short terminals keep the lettering alone.
    this.logoShown = logoRows >= 16 && logoWidth(logoRows) <= c.w - 4
    const total = (this.logoShown ? logoRows + 1 : 0) + textRows
    let y = Math.max(0, Math.floor((c.h - total) / 2))
    if (this.logoShown) {
      drawSpinningLogo(c, Math.floor((c.w - logoWidth(logoRows)) / 2), y, logoRows)
      y += logoRows + 1
    }
    LOGO.forEach((line, i) => c.text(Math.floor((c.w - strWidth(line)) / 2), y + i, line, { fg: C.amber, bold: true }))
    y += LOGO.length + 1
    const tag = 'code · chat · workers · agentic trading — in your terminal'
    c.text(Math.floor((c.w - strWidth(tag)) / 2), y, tag, S.muted)
    y += 2
    const tipW = Math.min(c.w - 4, 86)
    const x = Math.floor((c.w - tipW) / 2)
    if (!model) {
      c.text(x, y, 'No model is set up yet.', { fg: C.yellow, bold: true })
      y += 2
    }
    tips.forEach(([k, text], i) => {
      c.text(x, y + i, k.padEnd(9), { fg: C.cyan, bold: true })
      c.text(x + 9, y + i, text, S.muted, tipW - 9)
    })
  }

  private drawApproval(c: Canvas, y: number, width: number): number {
    const approval = this.chat.approvals[0]
    if (!approval) return 0
    const chat = this.chat.get(approval.chatId)
    const { verb, target } = describeToolCall(approval.tool, approval.input, this.chat.cwd)
    const preview = previewChange(approval.tool, approval.input, this.chat.cwd)
    const body: Line[] = []
    if (approval.tool === 'run_command') {
      body.push(...wrapSegments([{ text: '$ ', style: S.muted }, ...highlightLine(str(approval.input.command), 'sh')], width - 6))
    } else if (preview?.diff) {
      const d = preview.diff
      body.push([{ text: `${verb} `, style: { fg: C.text, bold: true } }, { text: `${d.path}  `, style: { fg: C.cyan } }, ...stats(d.additions, d.deletions)])
      body.push(...(d.status === 'added' ? renderCode(d.path, str(approval.input.content ?? approval.input.new_text), width - 6, { maxRows: 12 }) : renderDiff(d, width - 6, { maxRows: 14 })))
    } else {
      body.push(...wrapSegments([{ text: `${verb} ${target}`.trim(), style: { fg: C.text, bold: true } }], width - 6))
      if (preview?.error) body.push([{ text: preview.error, style: S.red }])
    }
    const detail = approval.summary && approval.tool !== 'run_command' && !preview?.diff && approval.summary !== `${verb} ${target}` ? approval.summary : ''
    const room = Math.max(6, c.h - 8)
    const shown = body.slice(0, room)
    const height = shown.length + (detail ? 1 : 0) + (chat && chat.id !== this.currentId() ? 1 : 0) + 3
    const box = c.sub(1, y - height, width, height)
    box.clear()
    box.box({ fg: C.yellow }, { rounded: true, title: approval.tool === 'run_command' ? 'Run this command?' : preview?.diff ? 'Make this change?' : 'Allow this?', titleStyle: { fg: C.yellow, bold: true } })
    let row = 1
    if (chat && chat.id !== this.currentId()) box.text(2, row++, `in “${truncate(chat.title, width - 12)}”`, S.muted)
    for (const line of shown) box.segments(2, row++, line, width - 4)
    if (detail) box.text(2, row++, detail, S.muted, width - 4)
    box.segments(2, row, [
      { text: 'y', style: S.key },
      { text: ' allow   ', style: S.muted },
      { text: 'n', style: S.key },
      { text: ' deny   ', style: S.muted },
      { text: 'a', style: S.key },
      { text: ' allow, and approve the rest for me', style: S.muted },
      ...(this.chat.approvals.length > 1 ? [{ text: `   +${this.chat.approvals.length - 1} waiting`, style: S.faint }] : [])
    ])
    return height
  }

  /** The completion menu: /commands, or files after @. */
  private menu(): { kind: 'command' | 'file'; items: { label: string; detail: string; value: string }[] } | null {
    const value = this.field.value
    if (value.startsWith('/') && !value.includes(' ') && !value.includes('\n')) {
      const items = matchCommands(value)
        .slice(0, 8)
        .map((cmd) => ({ label: cmd.name, detail: cmd.description, value: cmd.takesArgs ? `${cmd.name} ` : cmd.name }))
      return items.length ? { kind: 'command', items } : null
    }
    const word = this.field.wordAtCursor()
    if (word.text.startsWith('@')) {
      const files = fuzzyFiles(word.text.slice(1), projectFiles(this.chat.cwd), 8)
      return files.length ? { kind: 'file', items: files.map((f) => ({ label: f, detail: '', value: `@${f} ` })) } : null
    }
    return null
  }

  private drawMenu(c: Canvas, bottom: number, width: number): void {
    const menu = this.menu()
    if (!menu) return
    const { items } = menu
    this.menuIndex = Math.min(this.menuIndex, items.length - 1)
    const boxW = Math.min(width, menu.kind === 'file' ? 80 : 72)
    const box = c.sub(1, bottom - items.length - 2, boxW, items.length + 2)
    box.clear({ bg: '#121214' })
    box.box({ fg: C.border, bg: '#121214' }, { rounded: true, title: menu.kind === 'file' ? 'files · ⇥ to add' : undefined, titleStyle: { fg: C.faint, bg: '#121214' } })
    items.forEach((item, i) => {
      const active = i === this.menuIndex
      const bg = active ? C.teal : '#121214'
      box.fill(1, 1 + i, box.w - 2, 1, { bg })
      if (menu.kind === 'file') {
        const slash = item.label.lastIndexOf('/')
        box.segments(2, 1 + i, [
          { text: item.label.slice(0, slash + 1), style: { fg: active ? '#9CC7D6' : C.muted, bg } },
          { text: item.label.slice(slash + 1), style: { fg: active ? C.tealText : C.text, bg, bold: true } }
        ], box.w - 4)
      } else {
        box.text(2, 1 + i, item.label, { fg: active ? C.tealText : C.cyan, bg, bold: true })
        box.text(18, 1 + i, item.detail, { fg: active ? C.tealText : C.muted, bg }, box.w - 20)
      }
    })
  }

  /** The right-hand panel: context, files changed, checklist, language servers, instructions. */
  private drawSidebar(c: Canvas, chat: Chat | null): void {
    c.vline(0, 0, c.h, S.border)
    const x = 2
    const w = c.w - 3
    let y = 0
    const heading = (text: string): void => {
      if (y >= c.h) return
      c.text(x, y++, text, { fg: C.amber, bold: true })
    }
    heading('SESSION')
    for (const line of wrapSegments([{ text: chat?.title ?? 'New chat', style: S.text }], w).slice(0, 2)) c.segments(x, y++, line, w)
    c.text(x, y++, shortPath(this.chat.cwd), S.faint, w)
    y++
    // Context: the latest request's size against the model's window.
    const model = chatModel()
    const last = chat ? [...chat.messages].reverse().find((m) => m.usage && (m.usage.input || m.usage.cacheRead)) : undefined
    heading('CONTEXT')
    if (last?.usage) {
      const used = last.usage.input + last.usage.cacheRead + last.usage.output
      const window = model?.contextWindow
      c.text(x, y++, `${used.toLocaleString()} tokens`, S.text, w)
      if (window) {
        const pct = Math.min(100, Math.round((used / window) * 100))
        const filled = Math.round((pct / 100) * (w - 8))
        c.segments(x, y++, [
          { text: '█'.repeat(filled), style: { fg: pct > 80 ? C.red : pct > 50 ? C.amber : C.green } },
          { text: '░'.repeat(Math.max(0, w - 8 - filled)), style: S.faint },
          { text: ` ${pct}%`, style: S.muted }
        ])
      }
    } else c.text(x, y++, 'nothing sent yet', S.faint)
    y++
    const files = this.chat.modifiedFiles(chat?.id ?? null)
    if (files.length) {
      heading(`MODIFIED FILES (${files.length})`)
      for (const f of files.slice(0, Math.max(3, Math.floor((c.h - y) / 2)))) {
        if (y >= c.h - 6) break
        const st = stats(f.additions, f.deletions)
        const sw = st.reduce((n, s) => n + strWidth(s.text), 0)
        c.segments(x, y, [STATUS_MARK[f.status], { text: ` ${truncate(f.path, w - sw - 3)}`, style: S.muted }])
        c.segments(x + w - sw, y, st)
        y++
      }
      y++
    }
    const todos = chat ? [...chat.messages].reverse().find((m) => m.todos?.length)?.todos : undefined
    if (todos?.length && y < c.h - 4) {
      heading('TODO')
      for (const t of todos.slice(0, 8)) {
        if (y >= c.h - 3) break
        const mark = t.status === 'done' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'
        c.segments(x, y++, [{ text: `${mark} `, style: { fg: t.status === 'done' ? C.green : t.status === 'in_progress' ? C.amber : C.muted } }, { text: truncate(t.text, w - 2), style: t.status === 'done' ? S.faint : S.text }])
      }
      y++
    }
    const servers = lspStatus()
    if (servers.length && y < c.h - 2) {
      heading('LSP')
      for (const s of servers.slice(0, 4)) {
        const color = s.state === 'ready' ? C.green : s.state === 'starting' ? C.amber : C.red
        c.segments(x, y++, [{ text: '● ', style: { fg: color } }, { text: s.id, style: S.text }, { text: ` ${s.state}`, style: S.faint }], w)
      }
      y++
    }
    const instructions = loadInstructions(this.chat.cwd).files
    if (instructions.length && y < c.h - 1) {
      heading('INSTRUCTIONS')
      for (const f of instructions.slice(0, 3)) if (y < c.h) c.text(x, y++, shortPath(f, this.chat.cwd), S.muted, w)
    }
  }

  draw(c: Canvas): void {
    const chat = this.current()
    const wide = !this.target && this.sidebar && c.w >= 150
    const mainW = wide ? c.w - SIDEBAR_WIDTH : c.w
    if (wide) this.drawSidebar(c.sub(mainW, 1, SIDEBAR_WIDTH, c.h - 1), chat)
    const width = mainW - 2
    const fieldH = this.field.height(width - 6, 8)
    const inputH = fieldH + 2
    const infoY = c.h - 1
    const inputY = infoY - inputH

    // Header: the chat's title (a pinned chat sits in a titled panel instead).
    const top = this.target ? 0 : 1
    if (!this.target) {
      c.fill(0, 0, c.w, 1, { bg: '#0B0B0D' })
      c.text(2, 0, truncate(chat ? chat.title : 'New chat', mainW - 30), { fg: C.text, bold: true, bg: '#0B0B0D' })
      const list = this.chat.list()
      const right = `${list.length} chat${list.length === 1 ? '' : 's'} · ⌃R${wide ? '' : ' · /sidebar'}`
      c.text(mainW - strWidth(right) - 2, 0, right, { fg: C.faint, bg: '#0B0B0D' })
    }

    // Transcript.
    let bottom = inputY
    const area = c.sub(1, top, width, bottom - top)
    this.lastHeight = area.h
    if (!chat || chat.messages.length === 0) this.drawEmpty(area)
    else {
      const lines = this.transcript(chat, width)
      // Scrolled up, the view stays on what you're reading while the agent adds lines below it.
      if (this.scrollBack > 0 && this.seen.chatId === chat.id && this.seen.width === width && lines.length > this.seen.lines) this.scrollBack += lines.length - this.seen.lines
      this.seen = { chatId: chat.id, width, lines: lines.length }
      const maxBack = Math.max(0, lines.length - area.h)
      this.scrollBack = Math.min(this.scrollBack, maxBack)
      const start = Math.max(0, lines.length - area.h - this.scrollBack)
      for (let i = 0; i < area.h && start + i < lines.length; i++) area.segments(0, i, lines[start + i], area.w)
      if (maxBack > 0) {
        // A scrollbar in the gutter: where you are in the whole conversation.
        const thumb = Math.max(1, Math.round((area.h * area.h) / lines.length))
        const at = Math.round((start / maxBack) * (area.h - thumb))
        for (let i = 0; i < area.h; i++) {
          const on = i >= at && i < at + thumb
          c.text(width + 1, top + i, on ? '┃' : '│', { fg: on ? (this.scrollBack ? C.amber : C.faint) : '#232326' })
        }
      }
      if (this.scrollBack > 0) {
        const note = ` ↓ ${this.scrollBack} more lines · ⌃End to follow `
        area.text(area.w - strWidth(note) - 1, area.h - 1, note, { fg: C.ink, bg: C.amber })
      }
    }

    // Approval card, or the checklist while working, above the composer.
    const approvalH = this.drawApproval(c.sub(0, 0, mainW, c.h), bottom, width)
    bottom -= approvalH
    if (!approvalH && chat && !wide) {
      const todos = [...chat.messages].reverse().find((m) => m.todos?.length)?.todos
      if (todos && this.chat.isRunning(chat.id)) {
        const shown = todos.slice(0, 6)
        const box = c.sub(1, bottom - shown.length, width, shown.length)
        box.clear()
        shown.forEach((todo, i) => {
          const mark = todo.status === 'done' ? '☑' : todo.status === 'in_progress' ? '◐' : '☐'
          box.text(2, i, mark, { fg: todo.status === 'done' ? C.green : todo.status === 'in_progress' ? C.amber : C.muted })
          box.text(4, i, todo.text, todo.status === 'done' ? { fg: C.faint } : S.text, box.w - 6)
        })
        bottom -= shown.length
      }
    }

    // Composer: › for the agent, ! when the line is a shell command.
    const busy = this.chat.isRunning(this.currentId())
    const shell = this.field.value.startsWith('!')
    const composer = c.sub(1, inputY, width, inputH)
    composer.box(shell ? { fg: C.amber } : busy ? { fg: C.faint } : { fg: C.border }, { rounded: true, ...(shell ? { title: `shell · runs in ${shortPath(this.chat.cwd)}`, titleStyle: { fg: C.amber } } : {}) })
    composer.text(2, 1, shell ? '!' : '›', { fg: shell ? C.amber : busy ? C.faint : C.amber, bold: true })
    this.field.draw(composer.sub(4, 1, width - 6, fieldH), S.text, this.focused && !this.app.hasModal() && this.chat.approvals.length === 0)
    if (busy && !this.field.value) {
      composer.fill(4, 1, width - 6, 1, {})
      composer.text(4, 1, 'type to queue your next message', S.faint, width - 8)
    }
    this.drawMenu(c, inputY, width)

    // Under the composer: what the agent is doing, with the scanner, while it works.
    const activity = busy || this.chat.shellRunning() ? this.activity(chat) : null
    if (activity) {
      const waiting = activity.label === 'Waiting for your approval'
      const right = 'esc to stop'
      const parts = [
        ...scanner(Date.now(), waiting ? C.yellow : C.amber),
        { text: '  ' },
        { text: activity.label, style: { fg: waiting ? C.yellow : C.text } },
        ...(activity.target ? [{ text: ` ${activity.target}`, style: S.muted }] : []),
        ...activity.meta.map((m) => ({ text: ` · ${m}`, style: S.faint }))
      ]
      c.segments(2, infoY, parts, mainW - strWidth(right) - 6)
      c.text(mainW - strWidth(right) - 2, infoY, right, S.faint)
      return
    }
    const tokens = chat?.messages.reduce((sum, m) => sum + (m.usage ? m.usage.input + m.usage.cacheRead + m.usage.output : 0), 0) ?? 0
    const info = tokens ? `${fmtTokens(tokens)} tokens this chat` : ''
    c.text(mainW - strWidth(info) - 2, infoY, info, S.faint)
    const hint = shell ? 'Enter runs it here; the agent sees the output with your next message' : this.field.value.startsWith('/') ? 'commands · /help lists them' : '⇧⏎ new line · @ file · ! command · ⌃O details · ⇥ switch tab'
    c.text(2, infoY, hint, S.faint, mainW - strWidth(info) - 6)
  }

  /**
   * What the agent is doing this moment, for the line under the composer:
   * the tool it's running and on what, or thinking, or writing; how long
   * the turn has run and roughly how much it has written.
   */
  private activity(chat: Chat | null): { label: string; target: string; meta: string[] } {
    const message = chat && this.chat.isRunning(chat.id) ? chat.messages[chat.messages.length - 1] : null
    if (!message) {
      const shell = chat?.messages.findLast((m) => (m as CliMessage).shell?.running) as CliMessage | undefined
      return { label: 'Running', target: shell?.shell ? truncate(shell.shell.command, 60) : 'a command', meta: [] }
    }
    // Timed from the message that started the turn.
    const asked = chat!.messages.findLast((m) => m.role === 'user')
    const meta = [elapsed(Date.now() - (asked?.createdAt ?? message.createdAt))]
    const written = message.parts.reduce((n, p) => n + (p.type === 'tool' ? JSON.stringify(p.input).length : p.text.length), 0)
    if (written > 40) meta.push(`↓ ${fmtTokens(Math.round(written / 4))} tokens`)
    if (this.chat.approvals.some((a) => a.chatId === chat!.id)) return { label: 'Waiting for your approval', target: '', meta }
    const last = message.parts[message.parts.length - 1]
    if (!last) return { label: 'Waiting for', target: modelLabel(chatModel()), meta }
    if (last.type !== 'tool') return { label: last.type === 'reasoning' ? 'Thinking' : 'Writing', target: '', meta }
    if (last.status !== 'running') return { label: 'Thinking', target: '', meta }
    const { verb, target } = describeToolCall(last.name, last.input, this.chat.cwd)
    const doing = DOING[verb] ?? verb
    return { label: doing, target: truncate(target, 70), meta }
  }

  /* --------------------------------------------------------------- input */

  private submit(): void {
    const text = this.field.value
    const chat = this.current()
    const chatId = this.currentId()
    // An empty Enter under a waiting plan approves it.
    if (!text.trim()) {
      const pending = chat?.messages.findLast((m) => m.plan?.status === 'pending')
      if (pending && chat && !this.chat.isRunning(chat.id)) this.chat.approvePlan(pending.id, chat.id)
      return
    }
    this.field.remember(text)
    this.field.clear()
    this.scrollBack = 0
    if (text.trim().startsWith('/')) {
      void runSlash(this.slash, text.trim())
      return
    }
    if (text.startsWith('!') && !this.target) {
      const command = text.slice(1).trim()
      if (command) this.chat.runShell(command)
      return
    }
    // Files mentioned with @ go along with the message.
    const attachments = [...text.matchAll(/(?:^|\s)@([^\s]+)/g)]
      .map((m) => m[1])
      .filter((path) => projectFiles(this.chat.cwd).includes(path))
      .map((path) => `${this.chat.cwd}/${path}`)
    const send = (): void => {
      if (this.target) void this.chat.send(text, { ...(chatId ? { chatId } : { detached: true, title: this.target.title, onChat: (id) => this.target!.set(id) }) })
      else void this.chat.send(text, { ...(chatId ? { chatId } : {}), ...(attachments.length ? { attachments } : {}) })
    }
    if (chatId && this.chat.isRunning(chatId)) {
      // Queue it: send once the current reply ends.
      this.app.toast('Queued — sends when this reply finishes')
      const onDone = (finished: string): void => {
        if (finished !== chatId) return
        this.chat.off('finished', onDone)
        send()
      }
      this.chat.on('finished', onDone)
      return
    }
    send()
  }

  onEvent(event: InputEvent): boolean {
    // Approvals take the keyboard until answered.
    const approval = this.chat.approvals[0]
    if (approval && event.type === 'key') {
      if (event.name === 'y' || event.name === 'enter') this.chat.answerApproval(approval.requestId, true)
      else if (event.name === 'n' || event.name === 'escape') this.chat.answerApproval(approval.requestId, false)
      else if (event.name === 'a') {
        store.patchSettings({ approvalMode: 'auto' })
        this.app.toast('Approve for me: risky actions still ask')
        this.chat.answerApproval(approval.requestId, true)
      } else if (event.ctrl && event.name === 'c') this.chat.answerApproval(approval.requestId, false)
      return true
    }

    if (event.type === 'mouse') {
      if (event.action === 'wheelup') this.scrollBack += 3
      else if (event.action === 'wheeldown') this.scrollBack = Math.max(0, this.scrollBack - 3)
      else return false
      return true
    }

    if (event.type === 'key') {
      const menu = this.menu()
      if (menu) {
        if (event.name === 'up') return void (this.menuIndex = Math.max(0, this.menuIndex - 1)), true
        if (event.name === 'down') return void (this.menuIndex = Math.min(menu.items.length - 1, this.menuIndex + 1)), true
        const item = menu.items[this.menuIndex]
        const completes = event.name === 'tab' && !event.shift
        const enterPicks = event.name === 'enter' && item && (menu.kind === 'file' || item.value.trim() !== this.field.value.trim())
        if (item && (completes || enterPicks)) {
          if (menu.kind === 'file') {
            const word = this.field.wordAtCursor()
            this.field.replaceBeforeCursor(word.start, item.value)
          } else {
            this.field.value = item.value
            if (event.name === 'enter' && !item.value.endsWith(' ')) this.submit()
          }
          this.menuIndex = 0
          return true
        }
      }
      if (event.ctrl && event.name === 'c') {
        if (this.chat.isRunning(this.currentId())) {
          this.chat.stop(this.currentId())
          return true
        }
        if (this.chat.stopShells()) return true
        if (this.field.value) {
          this.field.clear()
          return true
        }
        return false
      }
      if (event.name === 'escape') {
        if (this.chat.isRunning(this.currentId())) this.chat.stop(this.currentId())
        else if (this.chat.stopShells()) this.app.toast('Command stopped')
        else if (this.field.value) this.field.clear()
        else if (this.target) return false
        else this.scrollBack = 0
        return true
      }
      if (event.name === 'tab' && event.shift) {
        const order = ['ask', 'auto', 'full'] as const
        const now = store.getSettings().approvalMode
        const next = order[(order.indexOf(now) + 1) % order.length]
        store.patchSettings({ approvalMode: next })
        this.app.toast(next === 'ask' ? 'Ask before changes' : next === 'auto' ? 'Approve for me — risky actions still ask' : 'Full access — nothing asks except real money', next === 'full' ? 'error' : 'info')
        return true
      }
      if (event.name === 'pageup' || (event.shift && event.name === 'up')) return void (this.scrollBack += event.name === 'pageup' ? Math.max(1, this.lastHeight - 2) : 1), true
      if (event.name === 'pagedown' || (event.shift && event.name === 'down'))
        return void (this.scrollBack = Math.max(0, this.scrollBack - (event.name === 'pagedown' ? Math.max(1, this.lastHeight - 2) : 1))), true
      if (event.ctrl && event.name === 'end') return void (this.scrollBack = 0), true
      if (event.ctrl && event.name === 'home') return void (this.scrollBack = Number.MAX_SAFE_INTEGER), true
      if (event.ctrl && event.name === 'o') {
        this.verbose = !this.verbose
        this.app.toast(this.verbose ? 'Details: every thought and all tool output' : 'Details folded', 'info', 2000)
        return true
      }
      if (event.ctrl && event.name === 'b' && !this.target) {
        this.sidebar = !this.sidebar
        return true
      }
      if (event.ctrl && event.name === 'p') return void runSlash(this.slash, '/model'), true
      if (event.ctrl && event.name === 'r') return void runSlash(this.slash, '/chats'), true
      if (event.ctrl && event.name === 'n') return void runSlash(this.slash, '/new'), true
      if (event.ctrl && event.name === 'g') return void runSlash(this.slash, '/sessions'), true
      if (event.ctrl && event.name === 'z') return void runSlash(this.slash, '/undo'), true
      // Tab with no menu open is the app's: it switches tabs.
      if (event.name === 'tab') return false
    }

    const result = this.field.handle(event, this.app.screen.width - 9)
    if (result === 'submit') this.submit()
    if (result === 'changed') this.menuIndex = 0
    return result !== 'ignored' && result !== 'cancel'
  }
}
