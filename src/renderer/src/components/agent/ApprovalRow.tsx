import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import { useApp, type PendingApproval } from '../../state/store'
import { approvalDoes, approvalRisk, CallPreview, CommandPreview, enterApproves } from './ApprovalCard'
import { approvalRow, approvalSummary, askerName } from './approvalText'
import { FileDiff } from './FileDiff'

/**
 * The open chat asks in the conversation itself, where the call is: one row
 * under the work so far, with what it wants to do, who wants it, the thing
 * itself as a link that opens it in full, and Allow or Stop. The dialog over
 * other pages (ChatView's ApprovalPrompt) asks the same question as a card.
 */

/** Exactly what will happen: the command as it will run, the diff, or the call. */
export function ApprovalPreview({ ask }: { ask: PendingApproval }): JSX.Element {
  const { tool, input } = ask
  const text = (key: string): string => String(input[key] ?? '')
  if (tool === 'run_command') return <CommandPreview command={text('command')} />
  if (tool === 'write_file' || tool === 'edit_file') {
    return (
      <div className="approval__diff">
        <FileDiff
          file={text('path')}
          // A write over a file shows what it takes away too, numbered as the file.
          before={tool === 'edit_file' ? text('old_text') : (ask.before ?? '')}
          after={tool === 'edit_file' ? text('new_text') : ask.before ? text('content') : text('content').slice(0, 6000)}
          {...(tool === 'write_file' && ask.before ? { oldStart: 1, newStart: 1 } : {})}
        />
      </div>
    )
  }
  return <CallPreview summary={ask.summary || approvalSummary(tool, input)} args={tool === 'use_plugin_tool' ? input.arguments : input} />
}

/**
 * esc says no. ⏎ says yes only from the question itself, or with nothing
 * focused: never from a text box (the message box is right there, and ⏎ in
 * it means "send"), never when a button has focus (it answers ⏎ itself), and
 * never for a call that could delete or change the system, which needs a click.
 */
export function useApprovalKeys(pending: PendingApproval | null, respond: (approved: boolean) => void): void {
  // Added once per request; reads the latest answer function from here.
  const latest = useRef(respond)
  latest.current = respond
  useEffect(() => {
    if (!pending) return
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target?.closest('textarea, input, [contenteditable="true"]')) return
      if (event.key === 'Escape') {
        // An Escape meant for something else — a menu, a dialog, the "/"
        // suggestions, the dictation bar — closes that and leaves the
        // question open. Denying on it threw away an answer nobody gave.
        if (event.defaultPrevented || document.querySelector('[role="menu"], [role="dialog"][aria-modal="true"], .voice-bar')) return
        event.preventDefault()
        latest.current(false)
        return
      }
      if (event.key !== 'Enter' || event.isComposing || event.defaultPrevented) return
      const el = event.target instanceof HTMLElement ? event.target : null
      const allowed = enterApproves(
        {
          button: el instanceof HTMLButtonElement,
          field: el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || Boolean(el?.isContentEditable),
          inCard: Boolean(el?.closest('.approval, .ask-row')),
          nothingFocused: !el || el === document.body
        },
        approvalRisk(pending.tool, pending.input)
      )
      if (!allowed) return
      event.preventDefault()
      latest.current(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pending])
}

export function ApprovalRow({ ask, waiting }: { ask: PendingApproval; waiting: number }): JSX.Element {
  const respondApproval = useApp((s) => s.respondApproval)
  const risk = approvalRisk(ask.tool, ask.input)
  const words = useMemo(() => approvalRow(ask), [ask])
  // What can't be taken back shows exactly what it would do without a click.
  const [open, setOpen] = useState(risk === 'high')
  const [answered, setAnswered] = useState(false)
  const row = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const previewId = useId()

  const respond = (approved: boolean): void => {
    if (answered) return
    setAnswered(true)
    const hadFocus = Boolean(row.current?.contains(document.activeElement))
    respondApproval(approved)
    // Answered from the row: the keyboard goes back to the message box, not
    // to the page, unless another question is next (its row takes it).
    if (hadFocus && !useApp.getState().pendingApproval) {
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.main .composer textarea')?.focus())
    }
  }
  useApprovalKeys(answered ? null : ask, respond)

  // It comes into view, so a reader scrolled up still sees the turn is
  // waiting on them, and takes focus, so ⏎ and esc answer it (⏎ never for
  // what could delete or change the system). Not from someone typing: a row
  // that took the message box's focus mid-sentence lost the rest of what was
  // typed, and the ⏎ meant to send it allowed the call. The row itself, not a
  // button, so it isn't ringed as if tabbed to.
  useEffect(() => {
    const node = row.current
    if (!node) return
    node.scrollIntoView({ block: 'nearest' })
    const typing = document.activeElement?.closest('textarea, input, select, [contenteditable="true"]')
    if (!typing) node.focus({ preventScroll: true })
  }, [])

  return (
    <div ref={row} tabIndex={-1} className="ask-row" data-risk={risk} role="group" aria-labelledby={titleId}>
      <div className="ask-row__line">
        <span className="ask-row__mark" aria-hidden="true">
          <span className="ask-row__dot" />
        </span>
        <div className="ask-row__words">
          <div className="ask-row__head">
            <span id={titleId} className="ask-row__title">
              {words.title}
            </span>
            <span className="ask-row__who">{askerName(ask.agent)}</span>
            {risk === 'high' && <span className="ask-row__warn">{approvalDoes(ask.tool, ask.input)}</span>}
            {waiting > 0 && (
              <span className="ask-row__more" title={`${waiting} more waiting after this`}>
                +{waiting}
              </span>
            )}
          </div>
          <button
            type="button"
            className="ask-row__link"
            data-code={ask.tool === 'run_command' || undefined}
            aria-expanded={open}
            aria-controls={open ? previewId : undefined}
            title={open ? 'Hide what it would do' : 'Show what it would do'}
            onClick={() => setOpen(!open)}
          >
            {words.link}
          </button>
        </div>
        <div className="ask-row__answers">
          <button type="button" className="ask-row__allow" disabled={answered} title={risk === 'high' ? undefined : 'Allow (⏎)'} onClick={() => respond(true)}>
            Allow
          </button>
          <button type="button" className="ask-row__stop" disabled={answered} title="Don’t do this (esc)" onClick={() => respond(false)}>
            Stop
          </button>
        </div>
      </div>
      {open && (
        <div id={previewId} className="ask-row__preview">
          <ApprovalPreview ask={ask} />
        </div>
      )}
    </div>
  )
}
