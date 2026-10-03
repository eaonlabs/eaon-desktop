// Adapted from MIT and Apache-2.0 components; see components/agent/LICENSES.txt.
import { memo, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Ban, ChevronDown, SquareTerminal, TriangleAlert } from 'lucide-react'
import type { ChatToolPart } from '@shared/types'
import { useApp } from '../../state/store'
import { commandSummary, splitCommandOutput } from './commandText'
import { FileDiff, diffStats } from './FileDiff'
import { FileIcon, splitPath } from './FileIcon'
import { Spinner } from './Loaders'

/**
 * The two calls that keep a card of their own in the transcript, where the
 * rest fold into a run's line: an edit, shown as its diff, and a command,
 * shown as the command and the end of its output. They are what a reader of a
 * coding turn actually reviews, so they sit in the reply where they happened
 * rather than behind a click.
 */

/**
 * Whether this call is waiting on the user. The loop announces a call before
 * it asks, so a call stuck at the approval card would otherwise read as
 * running. Chat's approvals only: a worker asks through its own card.
 */
function useAwaitingApproval(part: ChatToolPart): boolean {
  return useApp((s) => {
    if (part.status !== 'running' || (!s.pendingApproval && s.approvalQueue.length === 0)) return false
    const input = JSON.stringify(part.input)
    const asks = s.pendingApproval ? [s.pendingApproval, ...s.approvalQueue] : s.approvalQueue
    return asks.some((ask) => ask.tool === part.name && JSON.stringify(ask.input) === input)
  })
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** How much of a diff a card shows before "Show more". */
const CLIPPED = 168

/** An `edit_file` or `write_file` call: the file, its counts, and the diff. */
export const EditCard = memo(function EditCard({ part }: { part: ChatToolPart }): JSX.Element {
  const path = text(part.input.path) || 'file'
  const { name, folder } = splitPath(path)
  const write = part.name === 'write_file'
  const before = write ? '' : text(part.input.old_text)
  const after = write ? text(part.input.content) : text(part.input.new_text)
  const hasDiff = before.length > 0 || after.length > 0
  const stats = useMemo(() => diffStats(before, after), [before, after])
  const waiting = useAwaitingApproval(part)

  const running = part.status === 'running'
  const failed = part.status === 'error'
  const skipped = part.status === 'denied'
  // A skipped or failed edit folds to its line; what it would have done is a click away.
  const [chosen, setChosen] = useState<boolean | null>(null)
  const open = chosen ?? !(skipped || failed)
  const [more, setMore] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (body.current) setOverflows(body.current.scrollHeight > CLIPPED + 24)
  }, [open, before, after])

  const verb = running
    ? waiting
      ? write
        ? 'Write'
        : 'Edit'
      : write
        ? 'Writing'
        : 'Editing'
    : skipped
      ? 'Skipped'
      : failed
        ? write
          ? "Couldn't write"
          : "Couldn't edit"
        : write
          ? 'Wrote'
          : 'Edited'

  return (
    <div className="step-card edit-card" data-status={part.status} data-open={open || undefined}>
      <button className="step-card__head" onClick={() => setChosen(!open)} aria-expanded={open} title={path}>
        <span className="step-card__icon">
          {skipped ? <Ban size={13} strokeWidth={2} /> : failed ? <TriangleAlert size={13} strokeWidth={2} /> : <FileIcon file={name} size={13} />}
        </span>
        <span className={`step-card__title${running && !waiting ? ' step-shimmer' : ''}`}>
          {verb} <span className="step-card__file">{name}</span>
        </span>
        {folder && <span className="step-card__folder">{folder}</span>}
        <span className="step-card__end">
          {waiting ? (
            <span className="step-card__note">Waiting for approval</span>
          ) : running ? (
            <Spinner />
          ) : (
            hasDiff &&
            !failed && (
              <span className="step-card__stat">
                <span className="diff__stat-add">+{stats.added}</span>
                {stats.removed > 0 && <span className="diff__stat-del">−{stats.removed}</span>}
              </span>
            )
          )}
          <ChevronDown size={13} strokeWidth={2} className="step-card__chevron" />
        </span>
      </button>
      {open && (
        <div className="step-card__panel">
          <div>
            {failed && part.output ? (
              <pre className="step-card__message">{part.output}</pre>
            ) : hasDiff ? (
              <div className="edit-card__body" ref={body} data-clipped={(overflows && !more) || undefined}>
                <FileDiff file={path} before={before} after={after} bare />
                {overflows && (
                  <button className="step-card__more" onClick={() => setMore(!more)} aria-expanded={more}>
                    {more ? 'Show less' : 'Show more'}
                    <ChevronDown size={13} strokeWidth={2} />
                  </button>
                )}
              </div>
            ) : (
              <div className="step-card__message">{part.output || 'No changes.'}</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
})

/** A `run_command` call: the command line, then the end of what it printed. */
export const CommandCard = memo(function CommandCard({ part }: { part: ChatToolPart }): JSX.Element {
  const command = text(part.input.command)
  const background = part.input.background === true
  const waiting = useAwaitingApproval(part)
  const running = part.status === 'running'
  const skipped = part.status === 'denied'
  const failed = part.status === 'error'
  const { exit, signal, text: printed } = useMemo(() => splitCommandOutput(part.output), [part.output])
  const output = running ? (part.progress ?? '') : skipped ? '' : printed
  const [open, setOpen] = useState(false)
  const pane = useRef<HTMLPreElement>(null)
  // Folded, the output shows its tail: where a build or a test run says how it ended.
  useLayoutEffect(() => {
    const el = pane.current
    if (!el) return
    if (!open) el.scrollTop = el.scrollHeight
    el.dataset.overflow = String(el.scrollHeight > el.clientHeight + 1)
  }, [output, open])

  const programs = commandSummary(command) || 'command'
  const title = waiting
    ? `Run ${programs}?`
    : running
      ? `Running ${programs}`
      : skipped
        ? `Skipped ${programs}`
        : failed
          ? `Couldn't run ${programs}`
          : background
            ? `Started ${programs} in the background`
            : `Ran ${programs}`
  const badExit = (exit !== null && exit !== 0) || signal !== null

  return (
    <div className="step-card command-card" data-status={part.status} data-open={open || undefined} data-exit={badExit || undefined}>
      <button className="step-card__head" onClick={() => setOpen(!open)} aria-expanded={open} disabled={!output}>
        <span className="step-card__icon">
          {skipped ? <Ban size={13} strokeWidth={2} /> : failed ? <TriangleAlert size={13} strokeWidth={2} /> : <SquareTerminal size={13} strokeWidth={1.9} />}
        </span>
        <span className={`step-card__title${running && !waiting ? ' step-shimmer' : ''}`}>{title}</span>
        <span className="step-card__end">
          {waiting ? (
            <span className="step-card__note">Waiting for approval</span>
          ) : running ? (
            <Spinner />
          ) : (
            badExit && <span className="step-card__exit">{signal ? signal : `exit ${exit}`}</span>
          )}
          {output && <ChevronDown size={13} strokeWidth={2} className="step-card__chevron" />}
        </span>
      </button>
      <div className="command-card__body">
        <div className="command-card__line">
          <span className="command-card__prompt" aria-hidden>
            $
          </span>
          <span className="command-card__command">{command}</span>
        </div>
        {output && (
          <pre ref={pane} className="command-card__output scroll" data-open={open || undefined}>
            {output}
          </pre>
        )}
      </div>
    </div>
  )
})
