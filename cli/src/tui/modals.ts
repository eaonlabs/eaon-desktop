import type { InputEvent } from './input'
import type { Canvas } from './screen'
import { strWidth, truncate, wrap, type Style } from './term'
import { C, S } from './theme'
import { center, keyHints, TextField } from './widgets'

/**
 * Dialogs drawn over the current screen. The top one gets every key; Esc
 * closes it unless it says otherwise. Each sizes itself and centres on the
 * screen.
 */

export interface Modal {
  draw(c: Canvas): void
  onEvent(event: InputEvent): void
  /** Set by the app: closes this modal. */
  close?: () => void
}

export interface ModalHost {
  push(modal: Modal): void
  pop(modal?: Modal): void
  invalidate(): void
  toast(text: string, kind?: 'info' | 'error' | 'success'): void
}

/** Clears and boxes a centred area of the screen, and returns the inside. */
export function frame(c: Canvas, width: number, height: number, title: string, style: Style = { fg: C.amber }): Canvas {
  const w = Math.min(c.w - 2, width)
  const h = Math.min(c.h - 2, height)
  const x = Math.floor((c.w - w) / 2)
  const y = Math.max(1, Math.floor((c.h - h) / 2))
  const box = c.sub(x, y, w, h)
  box.clear({ bg: '#111113' })
  box.box({ ...style, bg: '#111113' }, { rounded: true })
  box.text(2, 0, ` ${title} `, { fg: C.amber, bg: '#111113', bold: true }, w - 4)
  return box.sub(2, 1, w - 4, h - 2)
}

const BG = '#111113'

/* ================================================================ prompt */

export class PromptModal implements Modal {
  close?: () => void
  readonly field: TextField
  private error = ''

  constructor(
    private readonly options: {
      title: string
      label?: string
      initial?: string
      placeholder?: string
      mask?: boolean
      multiline?: boolean
      hint?: string
      onSubmit: (value: string) => void | string | Promise<void | string>
    }
  ) {
    this.field = new TextField({ placeholder: options.placeholder, mask: options.mask, multiline: options.multiline })
    if (options.initial) this.field.value = options.initial
  }

  draw(c: Canvas): void {
    const labelLines = this.options.label ? wrap(this.options.label, 66) : []
    const fieldH = this.options.multiline ? 6 : 1
    const inner = frame(c, 72, 6 + labelLines.length + fieldH + (this.error ? 1 : 0), this.options.title)
    let y = 1
    for (const line of labelLines) inner.text(0, y++, line, { fg: C.text, bg: BG })
    y++
    inner.fill(0, y, inner.w, fieldH, { bg: '#1C1C1F' })
    this.field.draw(inner.sub(1, y, inner.w - 2, fieldH), { fg: C.text, bg: '#1C1C1F' })
    y += fieldH + 1
    if (this.error) inner.text(0, y++, truncate(this.error, inner.w), { fg: C.red, bg: BG })
    keyHints(inner, 0, inner.h - 1, [['⏎', this.options.hint ?? 'ok'], ['esc', 'cancel']], inner.w, BG)
  }

  onEvent(event: InputEvent): void {
    const result = this.field.handle(event)
    if (result === 'cancel') this.close?.()
    else if (result === 'submit') {
      void Promise.resolve(this.options.onSubmit(this.field.value)).then(
        (error) => {
          if (typeof error === 'string' && error) this.error = error
          else this.close?.()
        },
        (error) => (this.error = error instanceof Error ? error.message : String(error))
      )
    } else this.error = ''
  }
}

/* =============================================================== confirm */

export class ConfirmModal implements Modal {
  close?: () => void
  constructor(
    private readonly options: {
      title: string
      body: string
      danger?: boolean
      yes?: string
      no?: string
      onAnswer: (yes: boolean) => void
    }
  ) {}

  draw(c: Canvas): void {
    const lines = this.options.body.split('\n').flatMap((p) => wrap(p, 62))
    const inner = frame(c, 68, lines.length + 5, this.options.title, this.options.danger ? { fg: C.red } : undefined)
    lines.forEach((line, i) => inner.text(0, i + 1, line, { fg: C.text, bg: BG }))
    keyHints(inner, 0, inner.h - 1, [['y', this.options.yes ?? 'yes'], ['n', this.options.no ?? 'no']], inner.w, BG)
  }

  onEvent(event: InputEvent): void {
    if (event.type !== 'key') return
    if (event.name === 'y' || (event.name === 'enter' && !this.options.danger)) {
      this.close?.()
      this.options.onAnswer(true)
    } else if (event.name === 'n' || event.name === 'escape') {
      this.close?.()
      this.options.onAnswer(false)
    }
  }
}

/* ================================================================ picker */

export interface PickItem<T> {
  label: string
  detail?: string
  /** Shown on the right, e.g. a provider name or "active". */
  tag?: string
  tagStyle?: Style
  value: T
  group?: string
}

/** A filterable list: type to narrow it, arrows to move, Enter to pick. */
export class PickerModal<T> implements Modal {
  close?: () => void
  private filter = new TextField({ placeholder: 'Type to filter' })
  private selected = 0
  private scroll = 0

  constructor(
    private readonly options: {
      title: string
      items: PickItem<T>[] | (() => PickItem<T>[])
      onPick: (value: T) => void
      /** Extra keys, e.g. `d` to delete the selected item. Return true when handled. */
      onKey?: (key: string, value: T) => boolean
      hints?: [string, string][]
      width?: number
      initial?: (value: T) => boolean
    }
  ) {
    const items = this.items()
    if (options.initial) this.selected = Math.max(0, items.findIndex((i) => options.initial!(i.value)))
  }

  private items(): PickItem<T>[] {
    const all = typeof this.options.items === 'function' ? this.options.items() : this.options.items
    const q = this.filter.value.trim().toLowerCase()
    if (!q) return all
    return all.filter((i) => `${i.label} ${i.detail ?? ''} ${i.tag ?? ''} ${i.group ?? ''}`.toLowerCase().includes(q))
  }

  draw(c: Canvas): void {
    const items = this.items()
    const height = Math.min(c.h - 4, Math.max(8, items.length + 6))
    const inner = frame(c, this.options.width ?? 84, height, this.options.title)
    inner.text(0, 0, '› ', { fg: C.amber, bg: BG })
    this.filter.draw(inner.sub(2, 0, inner.w - 2, 1), { fg: C.text, bg: BG })
    const listH = inner.h - 3
    this.selected = Math.max(0, Math.min(this.selected, items.length - 1))
    if (this.selected < this.scroll) this.scroll = this.selected
    if (this.selected >= this.scroll + listH) this.scroll = this.selected - listH + 1
    if (items.length === 0) inner.text(0, 2, 'Nothing matches.', { fg: C.faint, bg: BG })
    for (let r = 0; r < listH && this.scroll + r < items.length; r++) {
      const item = items[this.scroll + r]
      const active = this.scroll + r === this.selected
      const bg = active ? C.teal : BG
      const y = 2 + r
      inner.fill(0, y, inner.w, 1, { bg })
      inner.text(0, y, active ? '▌' : ' ', { fg: C.amber, bg })
      const tagW = item.tag ? strWidth(item.tag) + 2 : 0
      const labelW = inner.text(2, y, item.label, { fg: active ? C.tealText : C.text, bg, bold: active }, inner.w - 2 - tagW)
      if (item.detail) inner.text(2 + labelW + 2, y, item.detail, { fg: active ? '#9CC7D6' : C.muted, bg }, inner.w - 6 - labelW - tagW)
      if (item.tag) inner.text(inner.w - tagW + 1, y, item.tag, { ...(item.tagStyle ?? { fg: C.muted }), bg })
    }
    keyHints(inner, 0, inner.h - 1, [['↑↓', 'move'], ['⏎', 'choose'], ...(this.options.hints ?? []), ['esc', 'close']], inner.w, BG)
  }

  onEvent(event: InputEvent): void {
    const items = this.items()
    if (event.type === 'key') {
      if (event.name === 'escape') return this.close?.()
      if (event.name === 'up' || (event.ctrl && event.name === 'p')) return void (this.selected = Math.max(0, this.selected - 1))
      if (event.name === 'down' || (event.ctrl && event.name === 'n')) return void (this.selected = Math.min(items.length - 1, this.selected + 1))
      if (event.name === 'pageup') return void (this.selected = Math.max(0, this.selected - 10))
      if (event.name === 'pagedown') return void (this.selected = Math.min(items.length - 1, this.selected + 10))
      if (event.name === 'enter') {
        const item = items[this.selected]
        if (!item) return
        this.close?.()
        this.options.onPick(item.value)
        return
      }
      if (event.ctrl && this.options.onKey && items[this.selected] && this.options.onKey(`ctrl+${event.name}`, items[this.selected].value)) return
    }
    if (this.filter.handle(event) === 'changed') this.selected = 0
  }
}

/* ============================================================ table form */

/**
 * A settings table in the style of a "model chains" editor: one row per
 * setting, ↑↓ to choose a row, ←→ to change a choice, -/+ for a level,
 * Enter to edit text or run an action, `d` to put a row back to its default.
 */
export interface FormRow {
  label: string
  /** The value as shown. */
  value: () => string
  valueStyle?: () => Style
  /** A small level bar (effort): current index and count. */
  level?: () => { index: number; count: number; label: string } | null
  /** `◆ override` or `· default`. */
  state?: () => 'override' | 'default' | null
  cycle?: (step: 1 | -1) => void | Promise<void>
  adjust?: (step: 1 | -1) => void | Promise<void>
  edit?: () => void
  reset?: () => void | Promise<void>
  /** Explains the selected row under the table. */
  detail?: () => string[]
  section?: string
}

const LEVEL_COLORS = ['#5A6B73', '#3DDC84', '#FFA028', '#5AC8FA', '#C38BFF']

export class FormModal implements Modal {
  close?: () => void
  private selected = 0
  private message = ''

  constructor(
    private readonly options: {
      title: string
      columns?: [string, string, string, string]
      rows: () => FormRow[]
      width?: number
      footer?: () => string
      hints?: [string, string][]
    }
  ) {}

  draw(c: Canvas): void {
    const rows = this.options.rows()
    this.selected = Math.max(0, Math.min(this.selected, rows.length - 1))
    const row = rows[this.selected]
    const detail = row?.detail?.() ?? []
    const sections = rows.filter((r, i) => r.section && (i === 0 || rows[i - 1].section !== r.section)).length
    const height = Math.min(c.h - 2, rows.length + sections + detail.length + 8)
    const inner = frame(c, this.options.width ?? 100, height, this.options.title)
    const [h1, h2, h3, h4] = this.options.columns ?? ['SETTING', 'VALUE', 'LEVEL', 'STATE']
    const labelW = Math.min(26, Math.max(12, ...rows.map((r) => strWidth(r.label) + 2)))
    const levelX = inner.w - 34
    const stateX = inner.w - 12
    const valueW = levelX - labelW - 6
    inner.text(2, 0, h1, { fg: C.muted, bg: BG })
    inner.text(2 + labelW + 2, 0, h2, { fg: C.muted, bg: BG })
    inner.text(levelX, 0, h3, { fg: C.muted, bg: BG })
    inner.text(stateX, 0, h4, { fg: C.muted, bg: BG })
    let y = 1
    rows.forEach((r, i) => {
      if (r.section && (i === 0 || rows[i - 1].section !== r.section)) {
        inner.text(2, y++, r.section.toUpperCase(), { fg: C.amber, bg: BG, bold: true })
      }
      if (y >= inner.h - detail.length - 4) return
      const active = i === this.selected
      const bg = active ? C.teal : BG
      inner.fill(0, y, inner.w, 1, { bg })
      if (active) inner.text(0, y, '▌', { fg: C.cyan, bg })
      inner.text(2, y, r.label, { fg: active ? C.tealText : C.text, bg, bold: active }, labelW)
      const vx = 2 + labelW + 2
      const value = r.value()
      if (active && r.cycle) inner.text(vx - 2, y, '◂', { fg: C.cyan, bg })
      const vw = inner.text(vx, y, value, { ...(r.valueStyle?.() ?? { fg: active ? C.tealText : C.text }), bg }, valueW)
      if (active && r.cycle) inner.text(vx + vw + 1, y, '▸', { fg: C.cyan, bg })
      const level = r.level?.()
      if (level) {
        if (active && r.adjust) inner.text(levelX - 2, y, '-', { fg: C.cyan, bg })
        const color = LEVEL_COLORS[Math.min(LEVEL_COLORS.length - 1, Math.round((level.index / Math.max(1, level.count - 1)) * (LEVEL_COLORS.length - 1)))]
        const filled = level.count > 0 ? Math.round(((level.index + 1) / level.count) * 4) : 0
        for (let k = 0; k < 4; k++) inner.text(levelX + k, y, k < filled ? '█' : '▯', { fg: k < filled ? color : C.faint, bg })
        if (active && r.adjust) inner.text(levelX + 5, y, '+', { fg: C.cyan, bg })
        inner.text(levelX + 7, y, level.label, { fg: active ? C.tealText : color, bg }, 14)
      }
      const state = r.state?.()
      if (state) inner.text(stateX, y, state === 'override' ? '◆ override' : '· default', { fg: state === 'override' ? (active ? C.tealText : C.cyan) : C.muted, bg })
      y++
    })
    // Rule, the row's name, its detail lines, then the footer and the key hints.
    const top = inner.h - detail.length - 4
    inner.hline(0, top, inner.w, { fg: C.border, bg: BG })
    if (row) {
      inner.text(2, top + 1, row.label, { fg: C.text, bg: BG, bold: true })
      detail.forEach((line, i) => inner.text(2, top + 2 + i, line, { fg: C.muted, bg: BG }, inner.w - 4))
    }
    if (this.message) inner.text(2, inner.h - 2, this.message, { fg: C.yellow, bg: BG }, inner.w - 4)
    else if (this.options.footer) inner.text(2, inner.h - 2, this.options.footer(), { fg: C.faint, bg: BG }, inner.w - 4)
    keyHints(inner, 2, inner.h - 1, this.options.hints ?? [['↑↓', 'row'], ['←→', 'change'], ['-/+', 'level'], ['⏎', 'edit'], ['d', 'default'], ['esc', 'close']], inner.w - 2, BG)
  }

  private run(action: (() => void | Promise<void>) | undefined): void {
    if (!action) return
    this.message = ''
    void Promise.resolve()
      .then(action)
      .catch((error) => (this.message = error instanceof Error ? error.message : String(error)))
  }

  onEvent(event: InputEvent): void {
    if (event.type !== 'key') return
    const rows = this.options.rows()
    const row = rows[this.selected]
    switch (event.name) {
      case 'escape':
        return this.close?.()
      case 'up':
        this.selected = Math.max(0, this.selected - 1)
        this.message = ''
        return
      case 'down':
        this.selected = Math.min(rows.length - 1, this.selected + 1)
        this.message = ''
        return
      case 'left':
        return this.run(row?.cycle && (() => row.cycle!(-1)))
      case 'right':
        return this.run(row?.cycle && (() => row.cycle!(1)))
      case 'enter':
        return this.run(row?.edit ?? (row?.cycle && (() => row.cycle!(1))))
      case 'd':
        return this.run(row?.reset)
      default:
        if (event.ch === '-' || event.ch === '_') return this.run(row?.adjust && (() => row.adjust!(-1)))
        if (event.ch === '+' || event.ch === '=') return this.run(row?.adjust && (() => row.adjust!(1)))
    }
  }

  say(message: string): void {
    this.message = message
  }
}

/* ============================================================= text page */

/** Scrollable read-only text: help, a session's log, an order's details. */
export class TextModal implements Modal {
  close?: () => void
  private scroll = 0
  constructor(
    private readonly title: string,
    private readonly body: () => { text: string; style?: Style }[][],
    private readonly width = 96
  ) {}

  draw(c: Canvas): void {
    const lines = this.body()
    const inner = frame(c, this.width, Math.min(c.h - 2, lines.length + 4), this.title)
    const h = inner.h - 2
    this.scroll = Math.max(0, Math.min(this.scroll, lines.length - h))
    for (let i = 0; i < h && this.scroll + i < lines.length; i++) {
      inner.segments(
        0,
        i,
        lines[this.scroll + i].map((s) => ({ text: s.text, style: { ...(s.style ?? { fg: C.text }), bg: BG } })),
        inner.w
      )
    }
    keyHints(inner, 0, inner.h - 1, [['↑↓', 'scroll'], ['esc', 'close']], inner.w, BG)
    if (lines.length > h) inner.text(inner.w - 8, inner.h - 1, `${Math.round(((this.scroll + h) / lines.length) * 100)}%`.padStart(6), { fg: C.faint, bg: BG })
  }

  onEvent(event: InputEvent): void {
    if (event.type === 'mouse') {
      if (event.action === 'wheelup') this.scroll -= 3
      if (event.action === 'wheeldown') this.scroll += 3
      return
    }
    if (event.type !== 'key') return
    if (event.name === 'escape' || event.name === 'q' || event.name === 'enter') return this.close?.()
    if (event.name === 'up' || event.name === 'k') this.scroll--
    if (event.name === 'down' || event.name === 'j') this.scroll++
    if (event.name === 'pageup') this.scroll -= 10
    if (event.name === 'pagedown' || event.name === 'space') this.scroll += 10
    if (event.name === 'home') this.scroll = 0
    if (event.name === 'end') this.scroll = 1e9
  }
}

export { center }
