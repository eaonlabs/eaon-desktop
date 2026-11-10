import { useEffect, useMemo, useState, type JSX } from 'react'
import { ExternalLink, Loader2, MessageSquarePlus, ScanSearch, X } from 'lucide-react'
import type { ReviewFile } from '@shared/adeReview'
import { REVIEW_DIFF_CAP, describeSent, diffForModel, findingMessage, findingsMessage, groupFindings, type Finding, type LocalReview as Review } from '@shared/gitAssist'
import { Modal } from '../ui'
import { notify } from '../Notice'
import { FileIcon, splitPath } from '../agent/FileIcon'
import { useApp } from '../../state/store'
import { joinPath } from '../ide/paths'
import { openInCode } from '../ide/ideStore'
import { NO_MODEL, assistError, useAssistModel } from './assist'

/**
 * Review changes: the model reads what isn't committed in a folder and lists
 * what looks wrong, by file and line. Nothing is changed. A finding opens its
 * file at the line and goes to the agent as a message; the ones that aren't
 * real are dismissed. It asks first, saying what would be sent.
 */

interface Props {
  cwd: string
  onClose: () => void
  /** Where a finding goes when added: a review comment in the ADE. Without it, the conversation's message box in Chat. */
  onAdd?: (finding: Finding) => void
  addLabel?: string
  /** Opens a finding's file at its line; Chat's code panel by default. */
  onOpen?: ((path: string, line: number) => void) | false
}

export function LocalReviewDialog({ cwd, onClose, onAdd, addLabel, onOpen }: Props): JSX.Element {
  const picked = useAssistModel()
  // null: still reading; undefined: couldn't be read here (a folder on an SSH host), so the hint is general.
  const [files, setFiles] = useState<ReviewFile[] | null | undefined>(null)
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState<{ review: Review; paths: string[]; sent: string } | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    let live = true
    void window.api.chatCode
      .diff(cwd)
      .then((res) => live && setFiles(res.ok ? res.files : undefined))
      .catch(() => live && setFiles(undefined))
    return () => {
      live = false
    }
  }, [cwd])

  const start = async (): Promise<void> => {
    if (!picked || running) return
    setRunning(true)
    setDismissed(new Set())
    try {
      const res = await window.api.gitAssist.review(cwd, picked)
      if (res.ok) setDone({ review: res.review, paths: res.paths, sent: res.sent })
      else notify(res.error, 'error')
    } catch (e) {
      notify(assistError(e), 'error')
    } finally {
      setRunning(false)
    }
  }

  const key = (f: Finding): string => `${f.path}:${f.line}:${f.body}`
  const live = useMemo(() => (done ? done.review.findings.filter((f) => !dismissed.has(key(f))) : []), [done, dismissed])
  const groups = useMemo(() => (done ? groupFindings(live, done.paths) : []), [done, live])

  const open = (f: Finding): void => {
    if (onOpen) onOpen(f.path, f.line)
    else if (onOpen === undefined) void openInCode(joinPath(cwd, f.path), f.line)
  }
  const canOpen = onOpen !== false
  const toChat = (list: Finding[]): void => {
    useApp.getState().appendToComposer({ text: list.length === 1 ? findingMessage(list[0]) : findingsMessage(list), attachments: [] })
    notify(list.length === 1 ? 'Added the finding to your message.' : `Added ${list.length} findings to your message.`)
  }
  const addAll = (): void => {
    if (onAdd) for (const f of live) onAdd(f)
    else toChat(live)
  }
  // Sent as the next message, so the agent starts on them now; not while it is still answering.
  const fixNow = (): void => {
    const app = useApp.getState()
    if (app.activeChatId && app.runs[app.activeChatId]) {
      notify('A reply is still running. Wait for it to finish, or add the findings to your message.', 'error')
      return
    }
    void app.send(findingsMessage(live))
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Review changes"
      width={620}
      actions={
        <>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
          {done && live.length > 0 && (
            <button type="button" className="btn" onClick={addAll}>
              {onAdd ? `${addLabel ?? 'Add'} all` : 'Add all to my message'}
            </button>
          )}
          {done && live.length > 0 && !onAdd && (
            <button type="button" className="btn" onClick={fixNow}>
              Fix with the agent
            </button>
          )}
          <button type="button" className="btn btn--primary" disabled={!picked || running || files === null || (files !== undefined && files.length === 0)} onClick={() => void start()}>
            {running ? <Loader2 size={13} className="spinner" /> : <ScanSearch size={14} strokeWidth={2} />}
            {running ? 'Reviewing…' : done ? 'Review again' : 'Review'}
          </button>
        </>
      }
    >
      <div className="git-dialog">
        <p className="assist-hint">
          {!picked
            ? NO_MODEL
            : done
              ? `Reviewed by ${picked.label}. ${done.sent}`
              : files === null
                ? 'Reading the changes…'
                : files === undefined
                  ? `Sends the uncommitted diff (up to ${REVIEW_DIFF_CAP.toLocaleString('en-US')} characters, long files cut, secret-looking files never read) to ${picked.label}. Nothing is changed: the model only reads.`
                  : `${describeSent(diffForModel(files, { cap: REVIEW_DIFF_CAP, numbered: true }), { to: picked.label })} Nothing is changed: the model only reads.`}
        </p>
        {done && (
          <div className="local-review">
            {done.review.summary && <p className="local-review__summary">{done.review.summary}</p>}
            {groups.length === 0 ? (
              <p className="git-dialog__muted">{done.review.findings.length === 0 ? 'The model found nothing to fix.' : 'Every finding was dismissed.'}</p>
            ) : (
              groups.map((g) => {
                const { name, folder: dir } = splitPath(g.path)
                return (
                  <section key={g.path} className="local-review__file">
                    <div className="local-review__head" title={g.path}>
                      <FileIcon file={name} size={14} />
                      <span className="local-review__name">{name}</span>
                      {dir && <span className="local-review__dir">{dir}</span>}
                      <span className="local-review__count">{g.findings.length}</span>
                    </div>
                    {g.findings.map((f) => (
                      <div key={key(f)} className="local-review__finding">
                        <div className="local-review__body">
                          <span className="local-review__line">{canOpen ? <button type="button" className="local-review__open" onClick={() => open(f)} title="Open the file at this line">Line {f.line}</button> : `Line ${f.line}`}</span>
                          {!f.onChange && <span className="local-review__note">not a changed line</span>}
                          <p>{f.body}</p>
                        </div>
                        <div className="local-review__actions">
                          {canOpen && (
                            <button type="button" className="icon-btn" aria-label="Open the file at this line" title="Open at this line" onClick={() => open(f)}>
                              <ExternalLink size={13} strokeWidth={2} />
                            </button>
                          )}
                          <button type="button" className="icon-btn" aria-label={addLabel ?? 'Add to my message'} title={addLabel ?? 'Add to my message'} onClick={() => (onAdd ? onAdd(f) : toChat([f]))}>
                            <MessageSquarePlus size={13} strokeWidth={2} />
                          </button>
                          <button type="button" className="icon-btn" aria-label="Dismiss" title="Dismiss" onClick={() => setDismissed((d) => new Set(d).add(key(f)))}>
                            <X size={13} strokeWidth={2} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </section>
                )
              })
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
