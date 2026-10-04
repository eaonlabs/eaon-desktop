import type { Provider } from '@shared/types'
import { shell } from 'electron'
import { addCustomProvider, checkProviderKey, findKeyRow, GROUPS, keyRows, removeProviderKey, saveProviderKey, templateValues, type KeyRow, type SaveResult } from '../core/providerDirectory'
import { events } from '../runtime/ipc'
import type { App } from './app'
import { EditForm, type FormField } from './form'
import type { InputEvent } from './input'
import { ConfirmModal, frame, PromptModal, type Modal } from './modals'
import { signIn } from './panels'
import type { Canvas } from './screen'
import { strWidth, truncate, wrap, type Style } from './term'
import { C } from './theme'
import { keyHints, spinner, TextField } from './widgets'

/**
 * The API keys screen (/keys): every provider the CLI can use, grouped —
 * model makers, coding plans and sign-ins, gateways, inference hosts,
 * China and regional, your own — with which ones are set up. Type to
 * search; ⏎ adds or replaces a key (or signs in), asking for the endpoint
 * values a provider needs (an Azure resource, a Cloudflare account); the
 * key is then checked by listing the provider's models. ⌃N adds an
 * endpoint of your own. The providers themselves are in
 * `core/providerDirectory.ts`.
 */

const BG = '#111113'
const LIST_BG = '#151517'

/** A description as a sentence, so another can follow it. */
const sentence = (text: string): string => (text && !/[.!?…]$/.test(text.trim()) ? `${text.trim()}.` : text.trim())

type Line = { kind: 'group'; label: string; count: number } | { kind: 'row'; row: KeyRow } | { kind: 'add' }

/** Bumped whenever providers change (a key saved here, an import, a sign-in), so an open screen re-reads them. */
let version = 0
events.on('providers:changed', () => version++)

interface Check {
  state: 'running' | 'ok' | 'fail'
  message: string
}

const FORMATS: { value: Provider['kind']; label: string }[] = [
  { value: 'openai-compatible', label: 'OpenAI-compatible (chat completions)' },
  { value: 'anthropic', label: 'Anthropic Messages' },
  { value: 'openai-responses', label: 'OpenAI Responses' }
]

export class KeysScreen implements Modal {
  close?: () => void
  private readonly search = new TextField({ placeholder: 'type to search — a name, or what it hosts' })
  private rows: KeyRow[] = []
  private dirty = true
  private seen = -1
  /** The selected provider's id ('+' for "add your own"), kept across searches and refreshes. */
  private selectedId: string | null = null
  private scroll = 0
  private checks = new Map<string, Check>()

  constructor(
    private readonly app: App,
    focus?: string
  ) {
    if (focus) this.selectedId = focus
  }

  private refresh(): void {
    if (!this.dirty && this.seen === version) return
    this.rows = keyRows()
    this.dirty = false
    this.seen = version
  }

  /** The list as drawn: group headings, the providers matching the search, and "add your own". */
  private lines(): Line[] {
    this.refresh()
    const q = this.search.value.trim().toLowerCase()
    const match = (r: KeyRow): boolean => !q || `${r.name} ${r.id} ${r.description} ${r.baseUrl}`.toLowerCase().includes(q)
    const lines: Line[] = []
    for (const group of GROUPS) {
      const rows = this.rows.filter((r) => r.group === group.id && match(r))
      if (!rows.length) continue
      lines.push({ kind: 'group', label: group.label, count: rows.length })
      for (const row of rows) lines.push({ kind: 'row', row })
    }
    lines.push({ kind: 'add' })
    return lines
  }

  private selectable(lines: Line[]): number[] {
    return lines.flatMap((line, i) => (line.kind === 'group' ? [] : [i]))
  }

  private selectedIndex(lines: Line[]): number {
    const ids = this.selectable(lines)
    const at = ids.find((i) => {
      const line = lines[i]
      return line.kind === 'row' ? line.row.id === this.selectedId : this.selectedId === '+'
    })
    return at ?? ids[0]
  }

  private selected(): KeyRow | null {
    const lines = this.lines()
    const line = lines[this.selectedIndex(lines)]
    return line?.kind === 'row' ? line.row : null
  }

  private move(by: number): void {
    const lines = this.lines()
    const ids = this.selectable(lines)
    const at = ids.indexOf(this.selectedIndex(lines))
    const next = lines[ids[Math.max(0, Math.min(ids.length - 1, at + by))]]
    this.selectedId = next?.kind === 'row' ? next.row.id : '+'
  }

  draw(c: Canvas): void {
    const width = Math.min(c.w - 2, 132)
    const height = c.h - 2
    const inner = frame(c, width, height, '⚿ API keys')
    const lines = this.lines()
    const ready = this.rows.filter((r) => r.ready).length

    // The search line, and how many are set up.
    const count = `${ready} set up · ${this.rows.length} providers`
    inner.text(0, 1, '⌕', { fg: C.amber, bg: BG, bold: true })
    inner.fill(2, 1, inner.w - strWidth(count) - 4, 1, { bg: '#1C1C1F' })
    this.search.draw(inner.sub(3, 1, inner.w - strWidth(count) - 6, 1), { fg: C.text, bg: '#1C1C1F' }, true)
    inner.text(inner.w - strWidth(count), 1, count, { fg: ready ? C.green : C.muted, bg: BG })

    // The list on the left, the selected provider on the right (or under it on narrow screens).
    const wide = inner.w >= 96
    const listW = wide ? Math.min(54, Math.floor(inner.w * 0.45)) : inner.w
    const detailH = wide ? 0 : 6
    const listTop = 3
    const listH = inner.h - listTop - 2 - detailH
    const list = inner.sub(0, listTop, listW, listH)
    list.fill(0, 0, list.w, list.h, { bg: LIST_BG })
    const selectedAt = this.selectedIndex(lines)
    if (selectedAt < this.scroll) this.scroll = Math.max(0, selectedAt - 1)
    if (selectedAt >= this.scroll + list.h) this.scroll = selectedAt - list.h + 1
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, lines.length - list.h)))
    for (let y = 0; y < list.h && this.scroll + y < lines.length; y++) {
      const i = this.scroll + y
      this.drawLine(list, y, lines[i], i === selectedAt)
    }
    if (lines.length > list.h) {
      const thumb = Math.max(1, Math.round((list.h * list.h) / lines.length))
      const at = Math.round((this.scroll / Math.max(1, lines.length - list.h)) * (list.h - thumb))
      for (let y = 0; y < list.h; y++) list.text(list.w - 1, y, y >= at && y < at + thumb ? '┃' : '│', { fg: y >= at && y < at + thumb ? C.amber : '#2A2A2D', bg: LIST_BG })
    }

    const row = lines[selectedAt]?.kind === 'row' ? (lines[selectedAt] as { row: KeyRow }).row : null
    const detail = wide ? inner.sub(listW + 2, listTop, inner.w - listW - 2, listH) : inner.sub(0, listTop + listH + 1, inner.w, detailH - 1)
    this.drawDetail(detail, row, wide)

    const hints: [string, string][] = row
      ? [
          ['⏎', row.auth === 'oauth' ? (row.ready ? 'sign in again' : 'sign in') : row.ready ? 'replace key' : 'add key'],
          ...(row.ready ? ([['⌃T', 'check']] as [string, string][]) : []),
          ...(row.ready || row.group === 'custom' ? ([['⌃D', 'remove']] as [string, string][]) : []),
          ...(row.keyUrl ? ([['⌃O', 'get a key']] as [string, string][]) : []),
          ...(row.template || row.baseUrlLabel || row.group === 'custom' ? ([['⌃E', 'endpoint']] as [string, string][]) : []),
          ['⌃N', 'your own'],
          ['esc', this.search.value ? 'clear search' : 'close']
        ]
      : [
          ['⏎', 'add your own'],
          ['esc', this.search.value ? 'clear search' : 'close']
        ]
    keyHints(inner, 0, inner.h - 1, hints, inner.w, BG)
  }

  private drawLine(c: Canvas, y: number, line: Line, selected: boolean): void {
    if (line.kind === 'group') {
      c.text(1, y, line.label.toUpperCase(), { fg: C.amber, bg: LIST_BG, bold: true })
      c.text(2 + strWidth(line.label), y, String(line.count), { fg: C.faint, bg: LIST_BG })
      return
    }
    const bg = selected ? C.teal : LIST_BG
    c.fill(0, y, c.w - 1, 1, { bg })
    if (line.kind === 'add') {
      c.text(1, y, '+ Add your own provider…', { fg: selected ? C.tealText : C.cyan, bg, bold: selected })
      return
    }
    const r = line.row
    const check = this.checks.get(r.id)
    const mark =
      check?.state === 'running'
        ? { text: spinner(), style: { fg: C.amber } }
        : check?.state === 'fail'
          ? { text: '✗', style: { fg: C.red } }
          : r.ready
            ? { text: '●', style: { fg: C.green } }
            : { text: '○', style: { fg: '#4A4A4F' } }
    c.text(1, y, mark.text, { ...mark.style, bg })
    const failed = check?.state === 'fail'
    const status = failed
      ? 'check failed'
      : r.auth === 'oauth'
        ? r.ready
          ? 'signed in'
          : 'sign in'
        : r.ready
          ? r.models
            ? `key · ${r.models} models`
            : 'key ✓'
          : r.enabled
            ? ''
            : 'off'
    const statusW = strWidth(status)
    c.text(3, y, truncate(r.name, c.w - statusW - 7), { fg: selected ? C.tealText : r.ready ? C.text : C.muted, bg, bold: selected || r.ready })
    if (status) c.text(c.w - statusW - 2, y, status, { fg: selected ? C.tealText : failed ? C.red : r.ready ? C.green : C.faint, bg })
  }

  private drawDetail(c: Canvas, row: KeyRow | null, wide: boolean): void {
    if (!row) {
      const text = 'An endpoint of your own: a LiteLLM or company proxy, a self-hosted server, or any OpenAI-, Anthropic- or Responses-compatible API. ⏎ adds it.'
      wrap(text, c.w).forEach((line, i) => c.text(0, i, line, { fg: C.muted, bg: BG }))
      return
    }
    let y = 0
    const put = (text: string, style: Style): void => {
      for (const line of wrap(text, c.w)) if (y < c.h) c.text(0, y++, line, { ...style, bg: BG })
    }
    const field = (label: string, value: string, style: Style = { fg: C.text }): void => {
      if (y >= c.h) return
      c.text(0, y, label, { fg: C.faint, bg: BG })
      c.text(10, y++, truncate(value, c.w - 10), { ...style, bg: BG })
    }
    if (wide) {
      put(row.name, { fg: C.text, bold: true })
      if (row.description) put(sentence(row.description), { fg: C.muted })
      y++
    } else put(`${row.name} — ${sentence(row.description)}`, { fg: C.muted })
    const check = this.checks.get(row.id)
    const state =
      row.auth === 'oauth'
        ? row.ready
          ? { text: `signed in · ${row.models} models`, style: { fg: C.green } }
          : { text: 'not signed in — ⏎ signs in with your browser', style: { fg: C.muted } }
        : row.ready
          ? { text: `saved in this computer’s vault${row.models ? ` · ${row.models} models` : ''}`, style: { fg: C.green } }
          : { text: 'not set — ⏎ adds one', style: { fg: C.muted } }
    field(row.auth === 'oauth' ? 'Account' : 'Key', state.text, state.style)
    if (check) {
      // The provider's answer can be long: it wraps under the label, up to three lines.
      const text = check.state === 'running' ? `${spinner()} checking…` : check.message
      const style = { fg: check.state === 'ok' ? C.green : check.state === 'fail' ? C.red : C.amber, bg: BG }
      c.text(0, y, 'Check', { fg: C.faint, bg: BG })
      for (const line of wrap(text, c.w - 10).slice(0, 3)) if (y < c.h) c.text(10, y++, line, style)
    }
    if (row.baseUrl || row.baseUrlLabel) field('Endpoint', row.baseUrl || `set your ${row.baseUrlLabel?.toLowerCase()} with ⌃E`, { fg: row.baseUrl && !/\{[a-z_]+\}/.test(row.baseUrl) ? C.text : C.yellow })
    if (row.keyUrl) field('Get one', `${row.keyUrl}  (⌃O opens it)`, { fg: C.cyan })
    if (!row.enabled && !row.ready) field('', 'switched off; adding a key turns it on', { fg: C.faint })
    if (wide && y + 3 < c.h) {
      y++
      const note =
        row.auth === 'oauth'
          ? 'Sign-in uses your own account in the browser; Eaon keeps the token in this computer’s vault.'
          : 'Keys stay in this computer’s vault and are never shown again. Once saved, Eaon lists the provider’s models to check the key, and they appear in /model.'
      put(note, { fg: C.faint })
    }
  }

  onEvent(event: InputEvent): void {
    if (event.type === 'mouse') {
      if (event.action === 'wheelup') this.move(-3)
      if (event.action === 'wheeldown') this.move(3)
      return
    }
    if (event.type === 'paste') {
      this.search.handle(event)
      return
    }
    if (event.type !== 'key') return
    const row = this.selected()
    if (event.ctrl) {
      switch (event.name) {
        case 't':
          if (row?.ready) void this.check(row)
          return
        case 'd':
        case 'x':
          if (row) this.remove(row)
          return
        case 'o':
          if (row?.keyUrl) void shell.openExternal(row.keyUrl)
          return
        case 'e':
          if (row && (row.template || row.baseUrlLabel || row.group === 'custom')) this.openKeyForm(row, true)
          return
        case 'n':
          this.openCustom()
          return
      }
    }
    switch (event.name) {
      case 'up':
        return this.move(-1)
      case 'down':
        return this.move(1)
      case 'pageup':
        return this.move(-10)
      case 'pagedown':
        return this.move(10)
      case 'home':
        if (!this.search.value) return this.move(-10_000)
        break
      case 'end':
        if (!this.search.value) return this.move(10_000)
        break
      case 'enter':
        if (!row) return this.openCustom()
        return this.add(row)
      case 'escape':
        if (this.search.value) {
          this.search.clear()
          return
        }
        return this.close?.()
    }
    if (this.search.handle(event) === 'changed') {
      // The first match of the new search, unless the selected one still matches.
      const lines = this.lines()
      const still = lines.some((l) => l.kind === 'row' && l.row.id === this.selectedId)
      if (!still) {
        const first = lines.find((l) => l.kind === 'row')
        this.selectedId = first?.kind === 'row' ? first.row.id : '+'
        this.scroll = 0
      }
    }
  }

  /** ⏎: sign in, or a key (with the endpoint values the provider needs). */
  add(row: KeyRow): void {
    if (row.auth === 'oauth') return signIn(this.app, row.id)
    this.openKeyForm(row, false)
  }

  private openKeyForm(row: KeyRow, endpointOnly: boolean): void {
    const needsEndpoint = Boolean(row.template || row.baseUrlLabel || row.group === 'custom')
    if (!needsEndpoint) {
      this.app.push(
        new PromptModal({
          title: `${row.name} API key`,
          label: [sentence(row.description), row.keyUrl ? `Get a key at ${row.keyUrl} (⌃O on the list opens it).` : '', 'It’s kept in this computer’s vault and never shown again.'].filter(Boolean).join('\n'),
          mask: true,
          placeholder: row.ready ? 'A key is saved — paste a new one to replace it' : 'Paste the key',
          hint: 'save',
          onSubmit: (value) => {
            if (!value.trim()) return 'Paste a key, or press Esc.'
            this.save(row, value, {})
          }
        })
      )
      return
    }
    const values = templateValues(row)
    const fields: FormField[] = [
      ...row.fields.map((f): FormField => ({ key: f.key, label: f.label, kind: 'text', ...(f.placeholder ? { placeholder: f.placeholder } : {}) })),
      ...(row.baseUrlLabel || row.group === 'custom' ? [{ key: 'baseUrl', label: row.baseUrlLabel ?? 'Base URL', kind: 'text' as const, placeholder: row.baseUrlPlaceholder ?? 'https://example.com/v1' }] : []),
      { key: 'key', label: 'API key', kind: 'secret', placeholder: row.ready ? 'leave empty to keep the saved key' : row.group === 'custom' ? 'leave empty if the server needs none' : 'paste the key' }
    ]
    this.app.push(
      new EditForm({
        title: endpointOnly ? `${row.name} — endpoint` : `${row.name} API key`,
        intro: [sentence(row.description), row.keyUrl ? `Get a key at ${row.keyUrl}.` : ''].filter(Boolean).join(' '),
        width: 90,
        fields,
        initial: { ...values, ...(row.baseUrlLabel || row.group === 'custom' ? { baseUrl: /\{[a-z_]+\}/.test(row.baseUrl) ? '' : row.baseUrl } : {}) },
        submitLabel: 'save',
        onSubmit: (v) => {
          if (!v.key?.trim() && !row.ready && row.group !== 'custom') return 'Paste the API key.'
          const missing = row.fields.find((f) => !v[f.key]?.trim())
          if (missing) return `Fill in ${missing.label}.`
          if ((row.baseUrlLabel || row.group === 'custom') && !/^https?:\/\/\S+$/.test(v.baseUrl?.trim() ?? '')) return `${row.baseUrlLabel ?? 'The base URL'} starts with https:// (or http:// for a server on your network).`
          this.save(row, v.key ?? '', v)
        }
      })
    )
  }

  private save(row: KeyRow, key: string, values: Record<string, string>): void {
    this.selectedId = row.id
    this.run(row.id, row.name, () => saveProviderKey(row, key, values), 'key saved')
  }

  private check(row: KeyRow): Promise<void> {
    return this.run(row.id, row.name, () => checkProviderKey(row.id), 'works')
  }

  private async run(id: string, name: string, work: () => Promise<SaveResult>, done: string): Promise<void> {
    this.checks.set(id, { state: 'running', message: '' })
    this.app.invalidate()
    try {
      const result = await work()
      this.checks.set(id, { state: result.ok ? 'ok' : 'fail', message: result.ok ? result.message : `the provider said: ${result.message}` })
      this.app.toast(result.ok ? `${name}: ${done} — ${result.models} model${result.models === 1 ? '' : 's'} available` : `${name}: the key is saved, but the check failed — ${result.message}`, result.ok ? 'success' : 'error', result.ok ? 4500 : 8000)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.checks.set(id, { state: 'fail', message })
      this.app.toast(`${name}: ${message}`, 'error')
    }
    this.dirty = true
    this.app.invalidate()
  }

  private remove(row: KeyRow): void {
    const own = row.group === 'custom'
    if (!row.ready && !own) return
    this.app.push(
      new ConfirmModal({
        title: own ? `Remove ${row.name}?` : `Remove the ${row.name} ${row.auth === 'oauth' ? 'sign-in' : 'key'}?`,
        body: own
          ? 'Its endpoint and key are forgotten, and its models leave /model.'
          : `Eaon forgets the ${row.auth === 'oauth' ? 'sign-in' : 'key'}, and the provider’s models leave /model until you add it again. Nothing changes in your account with ${row.name}.`,
        yes: 'remove',
        onAnswer: (yes) => {
          if (!yes) return
          removeProviderKey(row)
          this.checks.delete(row.id)
          this.app.toast(`${row.name}: removed`)
        }
      })
    )
  }

  private openCustom(): void {
    this.app.push(
      new EditForm({
        title: 'Add your own provider',
        intro: 'Any API that speaks one of these formats: a LiteLLM or company proxy, a self-hosted server, a host that isn’t listed. Its models are listed from <base URL>/models.',
        width: 92,
        fields: [
          { key: 'name', label: 'Name', kind: 'text', placeholder: 'e.g. Company gateway' },
          { key: 'baseUrl', label: 'Base URL', kind: 'text', placeholder: 'https://example.com/v1' },
          { key: 'kind', label: 'Format', kind: 'choice', options: FORMATS.map((f) => ({ value: f.value, label: f.label })) },
          { key: 'key', label: 'API key', kind: 'secret', placeholder: 'leave empty if the server needs none' }
        ],
        submitLabel: 'add',
        onSubmit: async (v) => {
          try {
            this.checks.set('+', { state: 'running', message: '' })
            const result = await addCustomProvider({ name: v.name ?? '', baseUrl: v.baseUrl ?? '', kind: (v.kind as Provider['kind']) || 'openai-compatible', key: v.key })
            this.checks.delete('+')
            this.selectedId = result.id
            this.checks.set(result.id, { state: result.ok ? 'ok' : 'fail', message: result.ok ? result.message : `the provider said: ${result.message}` })
            this.dirty = true
            this.app.toast(result.ok ? `${v.name}: added — ${result.models} models` : `${v.name}: added, but listing its models failed — ${result.message}`, result.ok ? 'success' : 'error', 8000)
          } catch (error) {
            this.checks.delete('+')
            return error instanceof Error ? error.message : String(error)
          }
        }
      })
    )
  }
}

/** /keys (and /key): the API keys screen, or straight to one provider's key with `/key <name>`. */
export function openKeys(app: App, query?: string): void {
  if (query) {
    const row = findKeyRow(query)
    if (!row) return app.toast(`No provider called “${query}”. /keys lists them all.`, 'error')
    const screen = new KeysScreen(app, row.id)
    app.push(screen)
    screen.add(row)
    return
  }
  app.push(new KeysScreen(app))
}
