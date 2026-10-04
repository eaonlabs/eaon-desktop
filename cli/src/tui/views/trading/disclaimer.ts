import { TRADING_DISCLAIMER, TRADING_DISCLAIMER_VERSION, type TradingSnapshot } from '@shared/trading'
import { invoke } from '../../../runtime/ipc'
import type { InputEvent } from '../../input'
import { frame, type Modal } from '../../modals'
import type { Canvas } from '../../screen'
import { wrap } from '../../term'
import { C } from '../../theme'
import { keyHints } from '../../widgets'
import type { TradingView } from './index'

/**
 * The trading disclaimer. Nothing trades — no order, no session — until the
 * user has read it, ticked the box and accepted; the trading engine refuses
 * both until then (`requireTradingDisclaimer`), so this is the only way in.
 * Space ticks the box, ⏎ accepts once it is ticked, Esc leaves it unaccepted.
 */
export class DisclaimerModal implements Modal {
  close?: () => void
  private ticked = false
  private note = ''
  private scroll = 0

  constructor(
    private readonly view: TradingView,
    private readonly onAccepted?: () => void
  ) {}

  draw(c: Canvas): void {
    const bg = '#111113'
    const width = Math.min(c.w - 4, 86)
    const textW = width - 4
    const body = TRADING_DISCLAIMER.paragraphs.flatMap((p, i) => [...(i ? [''] : []), ...wrap(p, textW)])
    const box = TRADING_DISCLAIMER.checkbox
    const boxLines = wrap(box, textW - 4)
    const height = Math.min(c.h - 2, body.length + boxLines.length + 9)
    const inner = frame(c, width, height, `⚠ ${TRADING_DISCLAIMER.title}`, { fg: C.red })
    const room = inner.h - boxLines.length - 6
    this.scroll = Math.max(0, Math.min(this.scroll, body.length - room))
    let y = 1
    for (const line of body.slice(this.scroll, this.scroll + room)) inner.text(0, y++, line, { fg: C.text, bg })
    if (body.length > room) inner.text(inner.w - 12, 0, `↑↓ ${Math.round(((this.scroll + room) / body.length) * 100)}%`, { fg: C.faint, bg })
    y = inner.h - boxLines.length - 4
    inner.hline(0, y++, inner.w, { fg: '#3A3A3D', bg })
    y++
    boxLines.forEach((line, i) => {
      if (i === 0) inner.text(0, y, this.ticked ? '[✓]' : '[ ]', { fg: this.ticked ? C.green : C.yellow, bg, bold: true })
      inner.text(4, y++, line, { fg: this.ticked ? C.text : C.muted, bg, bold: this.ticked })
    })
    if (this.note) inner.text(0, inner.h - 2, this.note, { fg: C.yellow, bg }, inner.w)
    keyHints(
      inner,
      0,
      inner.h - 1,
      [
        ['space', this.ticked ? 'untick' : 'tick the box'],
        ['⏎', this.ticked ? 'accept and continue' : 'accept (tick the box first)'],
        ['esc', 'not now']
      ],
      inner.w,
      bg
    )
  }

  onEvent(event: InputEvent): void {
    if (event.type === 'mouse') {
      if (event.action === 'wheelup') this.scroll = Math.max(0, this.scroll - 2)
      if (event.action === 'wheeldown') this.scroll += 2
      return
    }
    if (event.type !== 'key') return
    switch (event.name) {
      case 'space':
        this.ticked = !this.ticked
        this.note = ''
        return
      case 'up':
        this.scroll = Math.max(0, this.scroll - 1)
        return
      case 'down':
        this.scroll++
        return
      case 'escape':
        this.close?.()
        this.view.app.toast('Trading stays off until the disclaimer is accepted')
        return
      case 'enter':
        if (!this.ticked) {
          this.note = 'Tick the box (space) to accept. Trading can’t start without it.'
          return
        }
        void invoke<TradingSnapshot>('trading:accept-disclaimer', TRADING_DISCLAIMER_VERSION)
          .then((snapshot) => {
            this.view.snapshot = snapshot
            this.close?.()
            this.view.app.toast('Disclaimer accepted', 'success')
            this.onAccepted?.()
          })
          .catch((error) => (this.note = error instanceof Error ? error.message : String(error)))
        return
    }
  }
}

/**
 * Runs `then` if trading is allowed already; otherwise shows the disclaimer
 * and runs it once the user accepts. Returns whether it ran straight away.
 */
export function afterDisclaimer(view: TradingView, then: () => void): boolean {
  if (!view.snapshot?.needsDisclaimer) {
    then()
    return true
  }
  view.app.push(new DisclaimerModal(view, then))
  return false
}
