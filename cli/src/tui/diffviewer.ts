import type { FileDiff } from '../coding/diff'
import { renderDiff, stats, STATUS_MARK } from './diffview'
import type { InputEvent } from './input'
import type { Modal } from './modals'
import type { Canvas } from './screen'
import { strWidth, truncate } from './term'
import { C, S } from './theme'
import { keyHints } from './widgets'

/**
 * A full-screen review of changes: every changed file down the left with
 * its +/− counts, and the selected file's diff on the right, unified or side
 * by side. ↑↓ (or j/k) pick a file, PgUp/PgDn scroll its diff, s switches
 * the layout, Esc closes.
 */
export class DiffViewer implements Modal {
  close?: () => void
  private selected = 0
  private scroll = 0
  private split: boolean

  constructor(
    private readonly title: string,
    private readonly files: FileDiff[],
    wide: boolean
  ) {
    this.split = wide
  }

  draw(c: Canvas): void {
    const bg = '#0C0C0E'
    c.fill(0, 1, c.w, c.h - 1, { bg })
    const adds = this.files.reduce((n, f) => n + f.additions, 0)
    const dels = this.files.reduce((n, f) => n + f.deletions, 0)
    c.fill(0, 1, c.w, 1, { bg: C.panelBar })
    c.segments(1, 1, [
      { text: this.title.toUpperCase(), style: { fg: C.amber, bg: C.panelBar, bold: true } },
      { text: `   ${this.files.length} file${this.files.length === 1 ? '' : 's'}  `, style: { fg: C.muted, bg: C.panelBar } },
      ...stats(adds, dels).map((s) => ({ ...s, style: { ...s.style, bg: C.panelBar } }))
    ])
    const listW = Math.min(44, Math.max(28, Math.floor(c.w * 0.28)))
    const list = c.sub(0, 2, listW, c.h - 3)
    const body = c.sub(listW + 1, 2, c.w - listW - 2, c.h - 3)
    c.vline(listW, 2, c.h - 3, { fg: C.border, bg })

    this.selected = Math.max(0, Math.min(this.selected, this.files.length - 1))
    const top = Math.max(0, this.selected - list.h + 2)
    this.files.slice(top, top + list.h).forEach((file, i) => {
      const index = top + i
      const active = index === this.selected
      const rowBg = active ? C.teal : bg
      list.fill(0, i, list.w, 1, { bg: rowBg })
      const st = stats(file.additions, file.deletions)
      const sw = st.reduce((n, s) => n + strWidth(s.text), 0)
      list.segments(1, i, [{ ...STATUS_MARK[file.status], style: { ...STATUS_MARK[file.status].style, bg: rowBg } }, { text: ` ${truncate(file.path, list.w - sw - 5)}`, style: { fg: active ? C.tealText : C.text, bg: rowBg } }])
      list.segments(list.w - sw - 1, i, st.map((s) => ({ ...s, style: { ...s.style, bg: rowBg } })))
    })

    const file = this.files[this.selected]
    if (!file) {
      body.text(1, 1, 'No changes.', S.muted)
    } else {
      body.text(1, 0, file.status === 'renamed' && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path, { fg: C.cyan, bold: true, bg })
      const lines = renderDiff(file, body.w - 1, { split: this.split })
      const view = body.sub(0, 1, body.w, body.h - 1)
      this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, lines.length - view.h)))
      for (let i = 0; i < view.h && this.scroll + i < lines.length; i++) view.segments(1, i, lines[this.scroll + i], view.w - 1)
      if (lines.length > view.h) {
        const pct = `${Math.round(((this.scroll + view.h) / lines.length) * 100)}%`
        body.text(body.w - pct.length - 1, 0, pct, { fg: C.faint, bg })
      }
    }
    c.fill(0, c.h - 1, c.w, 1, S.panelBar)
    keyHints(c, 1, c.h - 1, [['↑↓', 'file'], ['⇞⇟ space', 'scroll'], ['s', this.split ? 'unified' : 'split'], ['esc', 'close']], c.w - 2, C.panelBar)
  }

  onEvent(event: InputEvent): void {
    if (event.type === 'mouse') {
      if (event.action === 'wheelup') this.scroll -= 3
      if (event.action === 'wheeldown') this.scroll += 3
      return
    }
    if (event.type !== 'key') return
    switch (event.name) {
      case 'escape':
      case 'q':
        return this.close?.()
      case 'up':
      case 'k':
        this.selected = Math.max(0, this.selected - 1)
        this.scroll = 0
        return
      case 'down':
      case 'j':
      case 'tab':
        this.selected = Math.min(this.files.length - 1, this.selected + 1)
        this.scroll = 0
        return
      case 'pageup':
        this.scroll -= 20
        return
      case 'pagedown':
      case 'space':
        this.scroll += 20
        return
      case 'home':
        this.scroll = 0
        return
      case 'end':
        this.scroll = 1e9
        return
      case 's':
        this.split = !this.split
        return
    }
  }
}
