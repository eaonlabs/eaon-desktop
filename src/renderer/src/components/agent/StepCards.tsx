// Adapted from MIT and Apache-2.0 components; see components/agent/LICENSES.txt.
import { createContext, memo, useContext, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Ban, ChevronDown, ChevronRight, Code2, Pencil, SquareTerminal, TriangleAlert } from 'lucide-react'
import type { ChatToolPart } from '@shared/types'
import { useApp, useIsWork } from '../../state/store'
import { openInCode } from '../ide/ideStore'
import { commandSummary, splitCommandOutput } from './commandText'
import { countChanges } from '../chatCode/diff/model'
import { SnippetDiff } from '../chatCode/diff/SnippetDiff'
import { splitPath } from './FileIcon'
import { PeekLine } from './ToolPeek'

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

/**
 * Whether the turn these cards sit in is still being written. A live turn's
 * edits show their diffs as they land; a finished turn folds them to a line
 * each, and its files-changed card at the end is where they are reviewed.
 */
export const TurnLive = createContext(false)

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** How much of a diff a card shows before "Show more". */
const CLIPPED = 168

/** An `edit_file` or `write_file` call: the file, its counts, and the diff. */
export const EditCard = memo(function EditCard({ part }: { part: ChatToolPart }): JSX.Element {
  const path = text(part.input.path) || 'file'
  const { name } = splitPath(path)
  const write = part.name === 'write_file'
  const before = write ? '' : text(part.input.old_text)
  const after = write ? text(part.input.content) : text(part.input.new_text)
  const hasDiff = before.length > 0 || after.length > 0
  const stats = useMemo(() => countChanges(before, after), [before, after])
  const waiting = useAwaitingApproval(part)
  // Chat's code panel opens the file; a worker's transcript has no panel.
  const canOpen = useIsWork() && part.status === 'done'

  const running = part.status === 'running'
  const failed = part.status === 'error'
  const skipped = part.status === 'denied'
  // Open while the turn is live; folded to its line once it is finished, and
  // always for a skipped or failed edit. What it did is a click away.
  const live = useContext(TurnLive)
  const [chosen, setChosen] = useState<boolean | null>(null)
  // Waiting on approval, the diff is in the approval itself; showing it here too only repeated it.
  const open = chosen ?? (live && !(skipped || failed || waiting))
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
      <PeekLine className="step-card__bar" summary={`${verb} ${path}`}>
        <button className="step-card__head" onClick={() => setChosen(!open)} aria-expanded={open}>
          <span className="step-card__icon">
            {skipped ? <Ban size={14} strokeWidth={1.9} /> : failed ? <TriangleAlert size={14} strokeWidth={1.9} /> : <Pencil size={14} strokeWidth={1.8} />}
          </span>
          <span className={`step-card__title${running && !waiting ? ' step-shimmer' : ''}`}>{verb}</span>
          <span className="step-card__file">{name}</span>
          {waiting ? (
            <span className="step-card__note">Waiting for approval</span>
          ) : (
            hasDiff &&
            !failed &&
            !running && (
              <span className="step-card__stat">
                <span className="diff__stat-add">+{stats.added}</span>
                {stats.removed > 0 && <span className="diff__stat-del">−{stats.removed}</span>}
              </span>
            )
          )}
          <ChevronRight size={13} strokeWidth={2} className="step-card__chevron" />
        </button>
        {canOpen && (
          <button className="step-card__open" onClick={() => void openInCode(path)} aria-label={`Open ${name} in Code`} title="Open in Code">
            <Code2 size={13} strokeWidth={1.9} />
          </button>
        )}
      </PeekLine>
      {open && (
        <div className="step-card__panel">
          <div className="step-card__box">
            {failed && part.output ? (
              <pre className="step-card__message">{part.output}</pre>
            ) : hasDiff ? (
              <div className="edit-card__body" ref={body} data-clipped={(overflows && !more) || undefined}>
                <SnippetDiff path={path} changes={[{ before, after }]} />
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

  const verb = waiting ? 'Run' : running ? 'Running' : skipped ? 'Skipped' : failed ? "Couldn't run" : background ? 'Started' : 'Ran'
  const badExit = (exit !== null && exit !== 0) || signal !== null
  // The line shows the command's first line; the whole of it is in the card a hover raises.
  const line = command.split('\n')[0] || commandSummary(command) || 'command'
  // Running, the output's tail shows under the line as it prints; done, it is a click away.
  const showOutput = Boolean(output) && (open || running)

  return (
    <div className="step-card command-card" data-status={part.status} data-open={showOutput || undefined} data-exit={badExit || undefined}>
      <PeekLine className="step-card__bar" summary={`${verb} ${commandSummary(command) || 'a command'}${background ? ' in the background' : ''}`} raw={command}>
        <button className="step-card__head" onClick={() => setOpen(!open)} aria-expanded={output ? open : undefined} disabled={!output}>
          <span className="step-card__icon">
            {skipped ? <Ban size={14} strokeWidth={1.9} /> : failed ? <TriangleAlert size={14} strokeWidth={1.9} /> : <SquareTerminal size={14} strokeWidth={1.8} />}
          </span>
          <span className={`step-card__title${running && !waiting ? ' step-shimmer' : ''}`}>{verb}</span>
          <code className="step-card__cmd">{line}</code>
          {waiting ? (
            <span className="step-card__note">Waiting for approval</span>
          ) : (
            badExit && <span className="step-card__exit">{signal ? signal : `exit ${exit}`}</span>
          )}
          {output && <ChevronRight size={13} strokeWidth={2} className="step-card__chevron" />}
        </button>
      </PeekLine>
      {showOutput && (
        <div className="step-card__panel">
          <div className="step-card__box command-card__body">
            <pre ref={pane} className="command-card__output scroll" data-open={open || undefined}>
              {output}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
})
