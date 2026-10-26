import { useEffect, useRef, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ArrowDown, ArrowUp, ChevronDown, CloudUpload, ExternalLink, GitBranch, GitCommitHorizontal, GitCompareArrows, GitPullRequest, GitPullRequestCreate, Loader2 } from 'lucide-react'
import type { PullRequestInfo, ReviewFile } from '@shared/adeReview'
import type { ChatGitStatus } from '@shared/chatCode'
import { MenuItem, MenuSeparator, Modal, Popover, Switch, useDisclosure } from '../ui'
import { notify } from '../Notice'
import { useIde } from '../ide/ideStore'
import { useChatCode } from './chatCodeStore'
import { DiffStat } from './diff/DiffCard'

/**
 * The top bar's Git control: one button for the next thing the branch needs
 * — Commit while something is uncommitted, then Push (or Publish for a branch
 * that was never pushed), then the pull request — and a menu with every step,
 * Pull, and the uncommitted changes as a review.
 */

type Action = 'commit' | 'commit-push' | 'push' | 'pull' | 'create-pr' | 'view-pr'

const errorText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))

interface Primary {
  action: Action | null
  label: string
  icon: JSX.Element
  title: string
}

/** What the button offers first, from where the branch stands. */
function primaryFor(status: ChatGitStatus, pr: PullRequestInfo | null | undefined): Primary {
  const dirty = (status.changes?.files ?? 0) > 0
  if (dirty) return { action: 'commit', label: 'Commit', icon: <GitCommitHorizontal size={14} strokeWidth={2} />, title: 'Commit the uncommitted changes' }
  if (status.remote && status.branch && !status.upstream)
    return { action: 'push', label: 'Publish', icon: <CloudUpload size={14} strokeWidth={2} />, title: `Push ${status.branch} to origin for the first time` }
  if (status.upstream && status.ahead > 0)
    return { action: 'push', label: 'Push', icon: <ArrowUp size={14} strokeWidth={2} />, title: `Push ${status.ahead} ${status.ahead === 1 ? 'commit' : 'commits'} to ${status.upstream}` }
  if (pr && pr.state === 'OPEN') return { action: 'view-pr', label: 'View PR', icon: <GitPullRequest size={14} strokeWidth={2} />, title: `#${pr.number} ${pr.title}` }
  if (status.behind > 0)
    return { action: 'pull', label: 'Pull', icon: <ArrowDown size={14} strokeWidth={2} />, title: `Pull ${status.behind} ${status.behind === 1 ? 'commit' : 'commits'} from ${status.upstream}` }
  if (pr === null && status.remote && status.branch && status.upstream)
    return { action: 'create-pr', label: 'Create PR', icon: <GitPullRequestCreate size={14} strokeWidth={2} />, title: 'Open a pull request for this branch' }
  return { action: null, label: 'Commit', icon: <GitCommitHorizontal size={14} strokeWidth={2} />, title: 'Nothing to commit' }
}

export function GitActions({ row = false }: { row?: boolean } = {}): JSX.Element | null {
  const { folder, status, refresh } = useChatCode(useShallow((s) => ({ folder: s.folder, status: s.status, refresh: s.refresh })))
  const anchor = useRef<HTMLDivElement>(null)
  const menu = useDisclosure()
  const [busy, setBusy] = useState<Action | null>(null)
  const [dialog, setDialog] = useState<'commit' | 'commit-push' | 'create-pr' | null>(null)
  // undefined: not asked yet; null: asked, none open.
  const [pr, setPr] = useState<PullRequestInfo | null | undefined>(undefined)
  const branch = status?.branch ?? null

  const loadPr = (): void => {
    if (!folder || !status?.remote) return
    void window.api.chatCode
      .pullRequest(folder)
      .then((res) => setPr(res.ok ? res.pr : undefined))
      .catch(() => setPr(undefined))
  }
  // Once per branch: `gh` is slow, and a pull request doesn't come and go on its own.
  useEffect(() => {
    setPr(undefined)
    loadPr()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, branch, status?.remote])

  if (!folder || !status?.repo) return null
  const primary = primaryFor(status, pr)
  const changes = status.changes

  const run = async (action: Action): Promise<void> => {
    if (action === 'commit' || action === 'commit-push' || action === 'create-pr') {
      setDialog(action)
      return
    }
    if (action === 'view-pr') {
      if (pr) void window.api.app.openExternal(pr.url)
      return
    }
    setBusy(action)
    try {
      const res = action === 'push' ? await window.api.ade.push(folder) : await window.api.chatCode.pull(folder)
      if (res.ok) notify(res.message ?? 'Done.', 'done')
      else notify(res.error, 'error')
    } catch (e) {
      notify(errorText(e), 'error')
    } finally {
      setBusy(null)
      void refresh()
      loadPr()
    }
  }

  const dirty = (changes?.files ?? 0) > 0
  const canPush = Boolean(status.remote && status.branch && (!status.upstream || status.ahead > 0))
  const more = (): void => {
    if (!menu.open) loadPr()
    menu.toggle()
  }
  return (
    <>
      {row ? (
        <div ref={anchor} className="ws-row ws-row--split" data-open={menu.open || undefined}>
          <button type="button" className="ws-row__main" disabled={!primary.action || busy !== null} title={primary.title} onClick={() => primary.action && void run(primary.action)}>
            <span className="ws-row__icon">{busy ? <Loader2 size={15} className="spinner" /> : primary.icon}</span>
            <span className="ws-row__label">{busy === 'push' ? 'Pushing…' : busy === 'pull' ? 'Pulling…' : primary.label}</span>
            {primary.action === 'push' && status.ahead > 0 && <span className="ws-row__meta git-actions__count">{status.ahead}</span>}
          </button>
          <button type="button" className="ws-row__more" aria-label="Git actions" title="Git actions" onClick={more}>
            <ChevronDown size={14} strokeWidth={2} />
          </button>
        </div>
      ) : (
      <div ref={anchor} className="split-btn git-actions" data-open={menu.open || undefined}>
        <button
          type="button"
          className="split-btn__main"
          disabled={!primary.action || busy !== null}
          title={primary.title}
          onClick={() => primary.action && void run(primary.action)}
        >
          {busy ? <Loader2 size={14} className="spinner" /> : primary.icon}
          <span>{busy === 'push' ? 'Pushing…' : busy === 'pull' ? 'Pulling…' : primary.label}</span>
          {primary.action === 'commit' && changes && <DiffStat added={changes.added} removed={changes.removed} className="git-actions__stat" />}
          {primary.action === 'push' && status.ahead > 0 && <span className="git-actions__count">{status.ahead}</span>}
        </button>
        <button
          type="button"
          className="split-btn__more"
          aria-label="Git actions"
          title="Git actions"
          onClick={more}
        >
          <ChevronDown size={13} strokeWidth={2} />
        </button>
      </div>
      )}
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={262}>
        <div className="menu__label git-actions__branch">
          <GitBranch size={12} strokeWidth={2} />
          {status.branch ?? (status.detached ? `Detached at ${status.detached}` : 'No branch')}
          {status.upstream && <span className="git-actions__upstream">→ {status.upstream}</span>}
        </div>
        <MenuItem
          icon={<GitCommitHorizontal size={15} strokeWidth={1.8} />}
          title="Commit…"
          hint={changes && dirty ? <DiffStat added={changes.added} removed={changes.removed} /> : undefined}
          disabled={!dirty}
          onClick={() => {
            menu.close()
            void run('commit')
          }}
        />
        {status.remote && (
          <MenuItem
            icon={<CloudUpload size={15} strokeWidth={1.8} />}
            title="Commit and push…"
            disabled={!dirty || !status.branch}
            onClick={() => {
              menu.close()
              void run('commit-push')
            }}
          />
        )}
        <MenuSeparator />
        {status.remote && (
          <MenuItem
            icon={<ArrowUp size={15} strokeWidth={1.8} />}
            title={status.upstream ? 'Push' : 'Publish branch'}
            hint={status.ahead > 0 ? String(status.ahead) : undefined}
            disabled={!canPush || busy !== null}
            onClick={() => {
              menu.close()
              void run('push')
            }}
          />
        )}
        {status.upstream && (
          <MenuItem
            icon={<ArrowDown size={15} strokeWidth={1.8} />}
            title="Pull"
            hint={status.behind > 0 ? String(status.behind) : undefined}
            disabled={busy !== null}
            onClick={() => {
              menu.close()
              void run('pull')
            }}
          />
        )}
        {status.remote &&
          (pr && pr.state === 'OPEN' ? (
            <MenuItem
              icon={<ExternalLink size={15} strokeWidth={1.8} />}
              title={`View pull request #${pr.number}`}
              onClick={() => {
                menu.close()
                void run('view-pr')
              }}
            />
          ) : (
            <MenuItem
              icon={<GitPullRequestCreate size={15} strokeWidth={1.8} />}
              title="Create pull request…"
              disabled={!status.branch}
              onClick={() => {
                menu.close()
                void run('create-pr')
              }}
            />
          ))}
        <MenuSeparator />
        <MenuItem
          icon={<GitCompareArrows size={15} strokeWidth={1.8} />}
          title="Review uncommitted changes"
          disabled={!dirty}
          onClick={() => {
            menu.close()
            useIde.getState().reviewChanges({ kind: 'git' })
          }}
        />
      </Popover>
      {(dialog === 'commit' || dialog === 'commit-push') && (
        <CommitDialog
          folder={folder}
          status={status}
          push={dialog === 'commit-push'}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null)
            void refresh()
            loadPr()
          }}
        />
      )}
      {dialog === 'create-pr' && (
        <PullRequestDialog
          folder={folder}
          status={status}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null)
            void refresh()
            loadPr()
          }}
        />
      )}
    </>
  )
}

const STATUS_MARK: Record<ReviewFile['status'], string> = { added: 'A', deleted: 'D', modified: 'M', renamed: 'R' }

/** A message for the commit, the files it takes, and whether to push it after. */
function CommitDialog({ folder, status, push: pushFirst, onClose, onDone }: { folder: string; status: ChatGitStatus; push: boolean; onClose: () => void; onDone: () => void }): JSX.Element {
  const [message, setMessage] = useState('')
  const [push, setPush] = useState(pushFirst)
  const [files, setFiles] = useState<ReviewFile[] | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void window.api.chatCode
      .diff(folder)
      .then((res) => live && setFiles(res.ok ? res.files : []))
      .catch(() => live && setFiles([]))
    return () => {
      live = false
    }
  }, [folder])

  const commit = async (): Promise<void> => {
    if (!message.trim() || busy) return
    setBusy(true)
    try {
      const res = await window.api.ade.commit(folder, message)
      if (!res.ok) {
        notify(res.error, 'error')
        return
      }
      if (push) {
        const pushed = await window.api.ade.push(folder)
        notify(pushed.ok ? `${res.message ?? 'Committed.'} Pushed.` : `${res.message ?? 'Committed.'} The push failed: ${pushed.error}`, pushed.ok ? 'done' : 'error')
      } else notify(res.message ?? 'Committed.', 'done')
      onDone()
    } catch (e) {
      notify(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Commit changes"
      width={500}
      actions={
        <>
          {status.remote && status.branch && (
            <label className="git-dialog__push">
              <Switch checked={push} onChange={setPush} label="Push after committing" />
              Push after committing
            </label>
          )}
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={!message.trim() || busy} onClick={() => void commit()}>
            {busy ? <Loader2 size={13} className="spinner" /> : <GitCommitHorizontal size={14} strokeWidth={2} />}
            {push ? 'Commit and push' : 'Commit'}
          </button>
        </>
      }
    >
      <div className="git-dialog">
        <div className="git-dialog__branch">
          <GitBranch size={13} strokeWidth={2} />
          <span>{status.branch ?? 'Detached HEAD'}</span>
          {files ? (
            <DiffStat added={files.reduce((n, f) => n + f.added, 0)} removed={files.reduce((n, f) => n + f.removed, 0)} className="git-dialog__stat" />
          ) : (
            status.changes && <DiffStat added={status.changes.added} removed={status.changes.removed} className="git-dialog__stat" />
          )}
        </div>
        <textarea aria-label="Commit message"
          className="input git-dialog__message"
          autoFocus
          rows={3}
          value={message}
          placeholder="What changed, in a line (and why, below it)"
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void commit()
            }
          }}
        />
        <div className="git-dialog__files scroll">
          {files === null ? (
            <div className="git-dialog__muted">
              <Loader2 size={13} className="spinner" /> Reading the changes…
            </div>
          ) : files.length === 0 ? (
            <div className="git-dialog__muted">No changed files.</div>
          ) : (
            files.map((f) => (
              <div key={f.path} className="git-dialog__file" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                <span className="git-dialog__mark" data-status={f.status}>
                  {STATUS_MARK[f.status]}
                </span>
                <span className="git-dialog__path">{f.path}</span>
                <DiffStat added={f.added} removed={f.removed} className="git-dialog__stat" />
              </div>
            ))
          )}
        </div>
        <p className="git-dialog__hint">Every change in the folder is committed, new files included. {navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+'}↵ commits.</p>
      </div>
    </Modal>
  )
}

/** A pull request for the branch: its title and description (filled from the commits), and the branch it goes into. */
function PullRequestDialog({ folder, status, onClose, onDone }: { folder: string; status: ChatGitStatus; onClose: () => void; onDone: () => void }): JSX.Element {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(false)
  const [base, setBase] = useState('')
  const [bases, setBases] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void window.api.ade.baseBranches(folder).then(
      async (b) => {
        if (!live) return
        const chosen = b.default ?? b.branches[0] ?? ''
        setBases(b.branches.filter((x) => x !== status.branch))
        setBase(chosen)
        if (!chosen) return
        const filled = await window.api.ade.prFromCommits(folder, chosen).catch(() => null)
        if (live && filled && !('error' in filled)) {
          setTitle((t) => t || filled.title)
          setBody((x) => x || filled.body)
        }
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [folder, status.branch])

  const onDefault = Boolean(base && status.branch === base)
  const dirty = (status.changes?.files ?? 0) > 0
  const create = async (): Promise<void> => {
    if (!title.trim() || busy || onDefault) return
    setBusy(true)
    try {
      const res = await window.api.ade.createPr(folder, { title, body, draft, ...(base ? { base } : {}) })
      if (!res.ok) {
        notify(res.error, 'error')
        return
      }
      notify(res.message ?? 'Pull request opened.', 'done')
      if (res.url) void window.api.app.openExternal(res.url)
      onDone()
    } catch (e) {
      notify(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Create pull request"
      width={520}
      actions={
        <>
          <label className="git-dialog__push">
            <Switch checked={draft} onChange={setDraft} label="Draft" />
            Draft
          </label>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={!title.trim() || busy || onDefault} onClick={() => void create()}>
            {busy ? <Loader2 size={13} className="spinner" /> : <GitPullRequestCreate size={14} strokeWidth={2} />}
            Push and create
          </button>
        </>
      }
    >
      <div className="git-dialog">
        <div className="git-dialog__branch">
          <GitBranch size={13} strokeWidth={2} />
          <span>{status.branch}</span>
          <span className="git-dialog__into">into</span>
          {bases.length > 0 ? (
            <select aria-label="Base branch" className="input git-dialog__base" value={base} onChange={(e) => setBase(e.target.value)}>
              {bases.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          ) : (
            <span>{base || 'the default branch'}</span>
          )}
        </div>
        {onDefault && <p className="git-dialog__warn">This is the default branch. Make a branch for the work first (the branch pill under the conversation).</p>}
        {dirty && <p className="git-dialog__warn">There are uncommitted changes. Only what is committed goes into the pull request.</p>}
        <input aria-label="Title" className="input" placeholder="Title" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} />
        <textarea aria-label="Description" className="input git-dialog__message" rows={6} placeholder="What it changes and why" value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
    </Modal>
  )
}
