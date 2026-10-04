import { checkForUpdate, detectInstall, manualUpdate, remindLater, runUpdate, shouldOffer, skipVersion, updated, updatesDisabled, type Install, type UpdateOffer, type UpdateResult } from '../core/update'
import { CLI_BETA, CLI_VERSION } from '../core/version'
import type { App } from './app'
import type { InputEvent } from './input'
import { frame, type Modal } from './modals'
import type { Canvas } from './screen'
import { truncate, wrap, type Style } from './term'
import { C } from './theme'
import { keyHints, spinner } from './widgets'

/**
 * The update popup. When the background check (`core/update.ts`) finds a
 * newer version on npm, it asks: update now, later (tomorrow), or skip this
 * version. Updating installs it over this copy while the app keeps running;
 * the new version starts the next time eaon opens, so the popup then offers
 * to quit. The header shows "⬆ update" meanwhile, and /update reopens it.
 */

const BG = '#111113'
/** Keys typed in the moment the popup appears were meant for the screen under it. */
const SETTLE_MS = 700

export interface UpdateHost {
  invalidate(): void
  toast(text: string, kind?: 'info' | 'error' | 'success', ms?: number): void
  quit(): Promise<void>
  /** Whether this window runs the trading and workers engines. */
  ownsEngines?: () => boolean
  /** Told when the update is installed (the header changes to "restart"). */
  onInstalled?: (version: string) => void
}

type Phase = 'ask' | 'updating' | 'done' | 'failed'

export class UpdateModal implements Modal {
  close?: () => void
  private phase: Phase = 'ask'
  private output: string[] = []
  private result: UpdateResult | null = null
  private shownAt = 0
  /** Closed while updating: say how it went with a toast instead. */
  private hidden = false
  private readonly install: Install
  private readonly run: typeof runUpdate

  constructor(
    private readonly host: UpdateHost,
    readonly offer: UpdateOffer,
    options: { install?: Install; run?: typeof runUpdate } = {}
  ) {
    this.install = options.install ?? detectInstall()
    this.run = options.run ?? runUpdate
  }

  /** Whether eaon can install it itself (npm, pnpm, yarn or bun), rather than say how. */
  get managed(): boolean {
    return this.install.kind !== 'source' && this.install.kind !== 'npx'
  }

  get installed(): boolean {
    return this.phase === 'done'
  }

  draw(c: Canvas): void {
    if (!this.shownAt) this.shownAt = Date.now()
    this.hidden = false
    const { current, latest } = this.offer
    const width = Math.min(c.w - 4, 80)
    const textW = width - 4
    const lines: { text: string; style: Style }[] = []
    const add = (text: string, style: Style = { fg: C.text }): void => {
      for (const line of text ? wrap(text, textW) : ['']) lines.push({ text: line, style })
    }
    // A command keeps its indent when it wraps (a long prefix path).
    const addCommand = (command: string): void => {
      for (const line of wrap(command, textW - 2)) lines.push({ text: `  ${line}`, style: { fg: C.cyan } })
    }
    const manual = manualUpdate(this.install, latest)
    let hints: [string, string][]
    let title = '⬆ Update available'
    let border: Style = { fg: C.amber }
    switch (this.phase) {
      case 'ask':
        add(`Eaon CLI ${latest} is out. You have ${current}.`, { fg: C.text, bold: true })
        if (CLI_BETA) add('Eaon CLI is in beta, so updates bring fixes and new features often.', { fg: C.muted })
        add('')
        if (this.managed) {
          add('Updating runs:', { fg: C.muted })
          addCommand(manual)
          if (this.host.ownsEngines?.()) {
            add('')
            add('This window runs the trading and workers engines. They keep going while it installs; the new version starts when you open eaon again.', { fg: C.muted })
          }
          hints = [
            ['⏎', 'update now'],
            ['l', 'later'],
            ['s', 'skip this version']
          ]
        } else {
          add(this.install.kind === 'npx' ? 'This copy runs through npx. Run the new one with:' : 'This copy runs from a source checkout. Update it with:', { fg: C.muted })
          addCommand(manual)
          hints = [
            ['esc', 'close'],
            ['s', 'skip this version']
          ]
        }
        break
      case 'updating':
        title = '⬆ Updating'
        add(`${spinner()} Installing Eaon CLI ${latest}…`, { fg: C.amber, bold: true })
        add('')
        for (const line of this.output.slice(-5)) lines.push({ text: truncate(line, textW), style: { fg: C.faint } })
        hints = [['esc', 'hide (it keeps going)']]
        break
      case 'done': {
        title = '✓ Updated'
        border = { fg: C.green }
        const installed = this.result?.installed ?? latest
        add(`Eaon CLI ${installed} is installed.`, { fg: C.green, bold: true })
        add('It starts the next time you open eaon. This window keeps running the version it started with.', { fg: C.text })
        if (this.host.ownsEngines?.()) {
          add('')
          add('Quitting pauses the trading engine and workers here until eaon is open again; an armed mission picks up then.', { fg: C.muted })
        }
        hints = [
          ['q', 'quit now'],
          ['esc', 'keep working']
        ]
        break
      }
      case 'failed':
        title = '✗ Update didn’t finish'
        border = { fg: C.red }
        add(this.result?.hint ?? 'The update didn’t finish.', { fg: C.text })
        if (this.result?.command) addCommand(this.result.command)
        if (this.output.length) add('')
        for (const line of this.output.slice(-4)) lines.push({ text: truncate(line, textW), style: { fg: C.faint } })
        hints = this.managed
          ? [
              ['⏎', 'try again'],
              ['esc', 'close']
            ]
          : [['esc', 'close']]
        break
    }
    const inner = frame(c, width, lines.length + 5, title, border)
    lines.forEach((line, i) => inner.text(0, i + 1, line.text, { ...line.style, bg: BG }, inner.w))
    keyHints(inner, 0, inner.h - 1, hints, inner.w, BG)
  }

  onEvent(event: InputEvent): void {
    if (event.type !== 'key') return
    if (Date.now() - this.shownAt < SETTLE_MS) return
    const key = event.ch?.toLowerCase()
    switch (this.phase) {
      case 'ask':
        if (event.name === 'enter' && this.managed) return this.start()
        if (key === 's') {
          skipVersion(this.offer.latest)
          this.host.toast(`Won’t ask about ${this.offer.latest} again. /update installs it any time.`)
          return this.close?.()
        }
        if (key === 'l' || event.name === 'escape') {
          remindLater()
          if (this.managed) this.host.toast('Later, then. /update installs it any time.')
          return this.close?.()
        }
        return
      case 'updating':
        if (event.name === 'escape') {
          this.hidden = true
          this.close?.()
        }
        return
      case 'done':
        if (key === 'q') {
          this.close?.()
          void this.host.quit()
        } else if (event.name === 'escape' || event.name === 'enter') this.close?.()
        return
      case 'failed':
        if (event.name === 'enter' && this.managed) this.start()
        else if (event.name === 'escape') this.close?.()
        return
    }
  }

  private start(): void {
    this.phase = 'updating'
    this.output = []
    this.result = null
    void this.run(
      this.offer.latest,
      (line) => {
        this.output.push(line)
        if (this.output.length > 40) this.output.shift()
        this.host.invalidate()
      },
      this.install
    ).then((result) => {
      this.result = result
      this.phase = result.ok ? 'done' : 'failed'
      if (result.ok) {
        updated()
        this.host.onInstalled?.(result.installed ?? this.offer.latest)
      }
      if (this.hidden)
        this.host.toast(
          result.ok ? `Eaon CLI ${result.installed ?? this.offer.latest} is installed — it starts the next time you open eaon` : `The update didn’t finish. /update says why.`,
          result.ok ? 'success' : 'error',
          8000
        )
      this.host.invalidate()
    })
  }
}

/** What the app knows about updates, for the header and /update. */
export interface UpdateStatus {
  offer: UpdateOffer
  modal: UpdateModal
  installed: boolean
}

function hostFor(app: App): UpdateHost {
  return {
    invalidate: () => app.invalidate(),
    toast: (text, kind, ms) => app.toast(text, kind, ms),
    quit: () => app.quit(),
    ownsEngines: () => app.deps.role() === 'owner',
    onInstalled: () => {
      if (app.update) app.update.installed = true
      app.invalidate()
    }
  }
}

/**
 * Checks for a newer version shortly after the app opens, and asks about it
 * once nothing else is on screen: no other dialog, not inside Claude Code,
 * and no key pressed for a moment, so it doesn't land mid-sentence.
 */
export function watchForUpdates(app: App, delayMs = 2500): void {
  const timer = setTimeout(() => {
    void checkForUpdate()
      .then((offer) => {
        if (!offer) return
        app.update = { offer, modal: new UpdateModal(hostFor(app), offer), installed: false }
        app.invalidate()
        if (!shouldOffer(offer.latest)) return
        const show = (): void => {
          const busy = app.hasModal() || app.mode === 'claude' || Date.now() - app.lastInputAt < 2000
          if (!busy) return app.push(app.update!.modal)
          setTimeout(show, 1500).unref?.()
        }
        show()
      })
      .catch(() => {})
  }, delayMs)
  timer.unref?.()
}

/** /update: the update popup, or a check right now when no update is known yet. */
export function openUpdate(app: App): void {
  if (app.update) return app.push(app.update.modal)
  if (updatesDisabled()) return app.toast('Update checks are off here (EAON_NO_UPDATE_CHECK, NO_UPDATE_NOTIFIER or CI is set).')
  app.toast('Checking npm for a newer version…')
  void checkForUpdate({ force: true }).then(
    (offer) => {
      if (!offer) return app.toast(`Eaon CLI ${CLI_VERSION} is the newest${CLI_BETA ? ' beta' : ''}.`, 'success')
      app.update = { offer, modal: new UpdateModal(hostFor(app), offer), installed: false }
      app.push(app.update.modal)
    },
    (error) => app.toast(error instanceof Error ? error.message : String(error), 'error')
  )
}
