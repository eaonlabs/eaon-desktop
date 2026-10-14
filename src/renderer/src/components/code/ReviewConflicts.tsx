import { useEffect, useMemo, useState, type JSX } from 'react'
import { ChevronRight, Loader2, Send } from 'lucide-react'
import { conflictCount, formatConflictRequest, parseConflicts, resolveConflicts, type ConflictChoice, type ReviewAction, type ReviewState } from '@shared/adeReview'

/**
 * Conflicts in the review panel: the files a merge (or rebase) left in
 * conflict, each one handed to an agent or resolved here block by block, then
 * marked resolved, and the merge finished or abandoned. git does the work
 * (main/features/ade/review.ts); the markers are read by shared/adeReview.ts.
 */

type Act = (label: string, run: () => Promise<ReviewAction>, after?: () => void) => Promise<void>

const NOUN = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick' } as const

export function ReviewConflicts({
  cwd,
  state,
  busy,
  act,
  send
}: {
  cwd: string
  state: ReviewState
  busy: string | null
  act: Act
  send: (text: string, what: string) => boolean
}): JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  /** Abort asks once more before it goes: the first click arms it for a few seconds. */
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), 4000)
    return () => window.clearTimeout(timer)
  }, [armed])

  const base = state.base.replace(/^origin\//, '')
  const noun = state.merging ? NOUN[state.merging] : 'merge'
  const files = state.conflicted
  const What = noun[0].toUpperCase() + noun.slice(1)

  return (
    <section className="review__section review-conflicts">
      <div className="review__label">
        {state.merging ? `${What} in progress` : 'Conflicts'}
        {files.length > 0 && ` · ${files.length} ${files.length === 1 ? 'file has' : 'files have'} conflicts`}
      </div>
      {files.length === 0 && <p className="review__muted">Every conflict is resolved. Finish the {noun} to commit it.</p>}
      {files.map((file) => (
        <div key={file} className="review-conflict">
          <div className="review-conflict__row">
            <button type="button" className="review-conflict__file" aria-expanded={open === file} onClick={() => setOpen(open === file ? null : file)} title="Resolve it here">
              <ChevronRight size={13} strokeWidth={2} className="review-file__chev" data-open={open === file || undefined} />
              <span className="review-file__path">{file}</span>
            </button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy !== null} onClick={() => void act(`resolved:${file}`, () => window.api.ade.markResolved(cwd, file))}>
              {busy === `resolved:${file}` ? 'Marking…' : 'Mark resolved'}
            </button>
          </div>
          {open === file && (
            <ConflictResolver
              cwd={cwd}
              path={file}
              busy={busy}
              act={act}
              onDone={() => setOpen(null)}
            />
          )}
        </div>
      ))}
      <div className="review__actions">
        {files.length > 0 && (
          <button
            type="button"
            className="btn btn--sm review-conflicts__ask"
            onClick={() => send(formatConflictRequest(files, base, state.merging), files.length === 1 ? 'the conflict' : 'the conflicts')}
          >
            <Send size={13} strokeWidth={2} />
            Ask agent to resolve
          </button>
        )}
        {state.merging && (
          <>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy !== null}
              onClick={() => {
                if (!armed) return setArmed(true)
                setArmed(false)
                void act('abort', () => window.api.ade.abortMerge(cwd))
              }}
            >
              {busy === 'abort' ? 'Aborting…' : armed ? `Abort the ${noun}?` : `Abort ${noun}`}
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={busy !== null || files.length > 0}
              title={files.length > 0 ? 'Resolve every file first' : undefined}
              onClick={() => void act('finish', () => window.api.ade.finishMerge(cwd))}
            >
              {busy === 'finish' ? 'Finishing…' : `Finish ${noun}`}
            </button>
          </>
        )}
      </div>
    </section>
  )
}

/** One file's conflicts, each with ours and theirs (and the common base, with diff3), and a choice for each. */
function ConflictResolver({ cwd, path, busy, act, onDone }: { cwd: string; path: string; busy: string | null; act: Act; onDone: () => void }): JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [choices, setChoices] = useState<(ConflictChoice | undefined)[]>([])

  useEffect(() => {
    let live = true
    setText(null)
    setError(null)
    setChoices([])
    window.api.ade.conflictFile(cwd, path).then(
      (res) => live && (res.ok ? setText(res.text) : setError(res.error)),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e))
    )
    return () => {
      live = false
    }
  }, [cwd, path])

  const segments = useMemo(() => (text === null ? [] : parseConflicts(text)), [text])
  const total = conflictCount(segments)
  const chosen = choices.filter(Boolean).length

  if (error) return <p className="review__muted review-resolver__note review__empty--error">{error}</p>
  if (text === null)
    return (
      <p className="review__muted review-resolver__note">
        <Loader2 size={13} className="spinner" /> Reading the file…
      </p>
    )
  if (total === 0) return <p className="review__muted review-resolver__note">No conflict markers are left in it. Mark it resolved when it’s right.</p>

  const save = (): void => {
    const resolved = resolveConflicts(segments, choices)
    const all = chosen === total
    void act(
      `save:${path}`,
      async () => {
        const wrote = await window.api.ade.writeConflictFile(cwd, path, resolved)
        return wrote.ok && all ? window.api.ade.markResolved(cwd, path) : wrote
      },
      onDone
    )
  }

  let n = -1
  return (
    <div className="review-resolver">
      {segments.map((seg, i) => {
        if (seg.kind === 'text') return null
        const at = ++n
        // The two lines before it, for bearings.
        const prev = segments[i - 1]
        const lead = prev?.kind === 'text' ? prev.lines.slice(-2).join('\n') : ''
        const pick = (choice: ConflictChoice): void => setChoices((c) => Object.assign([...c], { [at]: c[at] === choice ? undefined : choice }))
        return (
          <div key={i} className="review-resolver__block" data-chosen={choices[at] ?? undefined}>
            <div className="review-resolver__head">
              Conflict {at + 1} of {total}
            </div>
            {lead.trim() && <pre className="review-resolver__lead">{lead}</pre>}
            <div className="review-resolver__side" data-side="ours">
              <span className="review-resolver__label">Ours{seg.oursLabel ? ` · ${seg.oursLabel}` : ''}</span>
              <pre>{seg.ours.join('\n') || ' '}</pre>
            </div>
            {seg.base && (
              <div className="review-resolver__side" data-side="base">
                <span className="review-resolver__label">Common base</span>
                <pre>{seg.base.join('\n') || ' '}</pre>
              </div>
            )}
            <div className="review-resolver__side" data-side="theirs">
              <span className="review-resolver__label">Theirs{seg.theirsLabel ? ` · ${seg.theirsLabel}` : ''}</span>
              <pre>{seg.theirs.join('\n') || ' '}</pre>
            </div>
            <div className="review__actions review-resolver__choices">
              {(['ours', 'theirs', 'both'] as const).map((choice) => (
                <button key={choice} type="button" className="btn btn--ghost btn--sm" aria-pressed={choices[at] === choice} data-on={choices[at] === choice || undefined} onClick={() => pick(choice)}>
                  {choice === 'ours' ? 'Use ours' : choice === 'theirs' ? 'Use theirs' : 'Use both'}
                </button>
              ))}
            </div>
          </div>
        )
      })}
      <div className="review__actions">
        <span className="review__muted review-resolver__count">
          {chosen} of {total} chosen
        </span>
        <button type="button" className="btn btn--primary btn--sm" disabled={busy !== null || chosen === 0} onClick={save}>
          {busy === `save:${path}` ? 'Saving…' : chosen === total ? 'Save and mark resolved' : 'Save'}
        </button>
      </div>
    </div>
  )
}
