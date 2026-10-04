import type { InputEvent } from './input'
import { frame, type Modal } from './modals'
import type { Canvas } from './screen'
import { truncate, wrap, type Style } from './term'
import { C } from './theme'
import { keyHints, TextField } from './widgets'

/**
 * A data-entry dialog: an order ticket, a session to start, a worker to
 * create. Fields are text, numbers, choices (cycled with ←→) or switches;
 * ↑↓ or Tab move between them, Enter submits from anywhere, Esc cancels.
 * A live preview under the fields can show what the entry adds up to (an
 * order's cost against the limits) before anything is sent.
 */

export type FieldKind = 'text' | 'number' | 'choice' | 'toggle' | 'secret' | 'multiline'

export interface FormField {
  key: string
  label: string
  kind: FieldKind
  options?: { value: string; label: string }[]
  placeholder?: string
  hint?: string
  visible?: (values: Record<string, string>) => boolean
}

const BG = '#111113'
const FIELD_BG = '#1C1C1F'

export class EditForm implements Modal {
  close?: () => void
  readonly values: Record<string, string>
  private texts = new Map<string, TextField>()
  /** Fields still showing the value they opened with: typing replaces it, as with a selected default. */
  private pristine = new Set<string>()
  private selected = 0
  private error = ''
  private busy = false

  constructor(
    private readonly options: {
      title: string
      fields: FormField[]
      initial?: Record<string, string>
      submitLabel?: string
      width?: number
      intro?: string
      /** Lines under the fields, worked out from the values as they are typed. */
      preview?: (values: Record<string, string>) => { text: string; style?: Style }[][]
      /** Return an error to keep the dialog open, or nothing to close it. */
      onSubmit: (values: Record<string, string>) => void | string | Promise<void | string>
      titleStyle?: Style
    }
  ) {
    this.values = { ...(options.initial ?? {}) }
    for (const field of options.fields) {
      if (field.kind === 'choice' && this.values[field.key] === undefined) this.values[field.key] = field.options?.[0]?.value ?? ''
      if (field.kind === 'toggle' && this.values[field.key] === undefined) this.values[field.key] = 'false'
      if (field.kind === 'text' || field.kind === 'number' || field.kind === 'secret' || field.kind === 'multiline') {
        const text = new TextField({ placeholder: field.placeholder, mask: field.kind === 'secret', multiline: field.kind === 'multiline' })
        text.value = this.values[field.key] ?? ''
        if (text.value) this.pristine.add(field.key)
        this.texts.set(field.key, text)
      }
    }
  }

  private visible(): FormField[] {
    return this.options.fields.filter((f) => !f.visible || f.visible(this.values))
  }

  set(key: string, value: string): void {
    this.values[key] = value
    const text = this.texts.get(key)
    if (text) text.value = value
  }

  draw(c: Canvas): void {
    const fields = this.visible()
    this.selected = Math.max(0, Math.min(this.selected, fields.length - 1))
    const width = this.options.width ?? 84
    const intro = this.options.intro ? wrap(this.options.intro, width - 6) : []
    const rowsH = fields.reduce((sum, f) => sum + (f.kind === 'multiline' ? 4 : 1), 0)
    const preview = this.options.preview?.(this.values) ?? []
    const height = intro.length + rowsH + preview.length + (preview.length ? 2 : 0) + (this.error ? 2 : 0) + 6
    const inner = frame(c, width, height, this.options.title, this.options.titleStyle)
    let y = 1
    for (const line of intro) inner.text(0, y++, line, { fg: C.muted, bg: BG })
    if (intro.length) y++
    const labelW = Math.min(22, Math.max(...fields.map((f) => f.label.length)) + 2)
    fields.forEach((field, i) => {
      const active = i === this.selected
      const h = field.kind === 'multiline' ? 4 : 1
      inner.fill(0, y, inner.w, h, { bg: active ? '#162A31' : BG })
      inner.text(0, y, active ? '▌' : ' ', { fg: C.cyan, bg: active ? '#162A31' : BG })
      inner.text(2, y, field.label, { fg: active ? C.tealText : C.muted, bg: active ? '#162A31' : BG, bold: active }, labelW)
      const vx = 2 + labelW
      const vw = inner.w - vx - 1
      const rowBg = active ? '#162A31' : BG
      if (field.kind === 'choice') {
        const option = field.options?.find((o) => o.value === this.values[field.key])
        const label = option?.label ?? this.values[field.key]
        inner.segments(vx, y, [
          { text: active ? '◂ ' : '  ', style: { fg: C.cyan, bg: rowBg } },
          { text: label, style: { fg: C.text, bg: rowBg, bold: true } },
          { text: active ? ' ▸' : '', style: { fg: C.cyan, bg: rowBg } }
        ])
        if (field.hint) inner.text(vx + label.length + 6, y, field.hint, { fg: C.faint, bg: rowBg }, vw - label.length - 6)
      } else if (field.kind === 'toggle') {
        const on = this.values[field.key] === 'true'
        inner.segments(vx, y, [
          { text: on ? '◉ on ' : '○ off', style: { fg: on ? C.green : C.muted, bg: rowBg, bold: on } },
          ...(field.hint ? [{ text: `   ${field.hint}`, style: { fg: C.faint, bg: rowBg } }] : [])
        ])
      } else {
        const text = this.texts.get(field.key)!
        inner.fill(vx, y, vw, h, { bg: FIELD_BG })
        // A default about to be replaced reads as selected.
        const style = active && this.pristine.has(field.key) ? { fg: C.ink, bg: '#9CC7D6' } : { fg: C.text, bg: FIELD_BG }
        text.draw(inner.sub(vx + 1, y, vw - 2, h), style, active && !this.busy)
        if (field.hint && !active) {
          const hintX = vx + Math.min(vw - 20, Math.max(18, (text.value.length || (field.placeholder ?? '').length) + 3))
          inner.text(hintX, y, field.hint, { fg: C.faint, bg: FIELD_BG }, inner.w - hintX - 1)
        }
      }
      y += h
    })
    if (preview.length) {
      y++
      inner.hline(0, y++, inner.w, { fg: C.border, bg: BG })
      for (const line of preview) inner.segments(1, y++, line.map((s) => ({ text: s.text, style: { ...(s.style ?? { fg: C.text }), bg: BG } })), inner.w - 2)
    }
    if (this.error) inner.text(1, inner.h - 2, truncate(this.error, inner.w - 2), { fg: C.red, bg: BG })
    keyHints(
      inner,
      0,
      inner.h - 1,
      this.busy ? [['', 'working…']] : [['↑↓', 'field'], ['←→', 'choose'], ['⏎', this.options.submitLabel ?? 'save'], ['esc', 'cancel']],
      inner.w,
      BG
    )
  }

  private submit(): void {
    if (this.busy) return
    for (const [key, text] of this.texts) this.values[key] = text.value
    this.busy = true
    this.error = ''
    void Promise.resolve()
      .then(() => this.options.onSubmit({ ...this.values }))
      .then(
        (result) => {
          this.busy = false
          if (typeof result === 'string' && result) this.error = result
          else this.close?.()
        },
        (error) => {
          this.busy = false
          this.error = error instanceof Error ? error.message : String(error)
        }
      )
  }

  onEvent(event: InputEvent): void {
    if (this.busy) return
    const fields = this.visible()
    const field = fields[this.selected]
    if (event.type === 'key') {
      if (event.name === 'escape') return this.close?.()
      if (event.name === 'tab' || (event.name === 'down' && field?.kind !== 'multiline')) {
        this.selected = event.shift ? Math.max(0, this.selected - 1) : Math.min(fields.length - 1, this.selected + 1)
        return
      }
      if (event.name === 'up' && field?.kind !== 'multiline') {
        this.selected = Math.max(0, this.selected - 1)
        return
      }
      if (event.name === 'enter' && !(field?.kind === 'multiline' && (event.shift || event.meta))) return this.submit()
      if (field?.kind === 'choice' && (event.name === 'left' || event.name === 'right' || event.name === 'space')) {
        const options = field.options ?? []
        const at = options.findIndex((o) => o.value === this.values[field.key])
        const next = options[(at + (event.name === 'left' ? -1 : 1) + options.length) % options.length]
        if (next) this.values[field.key] = next.value
        this.error = ''
        return
      }
      if (field?.kind === 'toggle' && (event.name === 'left' || event.name === 'right' || event.name === 'space')) {
        this.values[field.key] = this.values[field.key] === 'true' ? 'false' : 'true'
        return
      }
    }
    if (!field) return
    const text = this.texts.get(field.key)
    if (!text) return
    if (field.kind === 'number' && event.type === 'key' && event.ch && !/[\d.,\-$%]/.test(event.ch)) return
    if (this.pristine.has(field.key)) {
      this.pristine.delete(field.key)
      const typing = event.type === 'paste' || (event.type === 'key' && event.ch !== undefined && !event.ctrl && !event.meta)
      if (typing || (event.type === 'key' && event.name === 'backspace')) {
        text.clear()
        this.values[field.key] = ''
        if (event.type === 'key' && event.name === 'backspace') return
      }
    }
    const result = text.handle(event)
    if (result === 'changed') {
      this.values[field.key] = text.value
      this.error = ''
    }
    if (result === 'submit') this.submit()
  }
}

/** Parses a number a person typed: "1,000", "$500", "2.5%". NaN when it isn't one. */
export function num(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return Number.NaN
  return Number(value.replace(/[$,%\s]/g, ''))
}
