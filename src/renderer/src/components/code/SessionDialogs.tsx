import { useEffect, useMemo, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Folder, GitBranch } from 'lucide-react'
import { Modal, Select } from '../ui'
import { useCode } from './codeStore'
import { useAdeSessions } from './sessionsStore'
import { AgentMark } from './terminal/TerminalWorkspace'
import { useTerminals } from './terminal/terminalStore'
import {
  branchForTitle,
  branchNameProblem,
  folderName,
  groupSessions,
  homeRelative,
  sessionTitle,
  worktreeFolderFor,
  type AdeSession,
  type ProjectGroup
} from '@shared/adeSessions'
import type { TerminalAgentId } from '@shared/terminals'

/** The agent a new session starts with, when it is installed: the first of these. */
const PREFERRED: TerminalAgentId[] = ['claude', 'codex', 'eaon-code', 'opencode', 'antigravity']

/** The home folder, once main has said it, so paths under it read as ~. */
let knownHome: string | null = null
const tidy = (path: string): string => homeRelative(path, knownHome)

/**
 * New session: what it is for, the branch it gets (from the title, until
 * edited), and the agent it starts with. The worktree is made from the
 * project folder's current branch.
 */
export function NewSessionDialog(): JSX.Element | null {
  const { creatingIn, sessions, close, create } = useAdeSessions(
    useShallow((s) => ({ creatingIn: s.creatingIn, sessions: s.sessions, close: s.closeNewSession, create: s.create }))
  )
  const { recents, chooseFolder } = useCode(useShallow((s) => ({ recents: s.recents, chooseFolder: s.chooseFolder })))
  const { agents, refreshAgents } = useTerminals(useShallow((s) => ({ agents: s.agents, refreshAgents: s.refreshAgents })))
  const open = creatingIn !== undefined
  const projects = useMemo(() => groupSessions(sessions, recents).map((g) => g.project), [sessions, recents])

  const [project, setProject] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [branch, setBranch] = useState('')
  const [branchEdited, setBranchEdited] = useState(false)
  const [agent, setAgent] = useState<TerminalAgentId | null>(null)
  const [root, setRoot] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A fresh form each time it opens, in the project it was opened from.
  useEffect(() => {
    if (!open) return
    setProject(creatingIn ?? projects[0] ?? null)
    setTitle('')
    setBranch('')
    setBranchEdited(false)
    setError(null)
    setBusy(false)
    void refreshAgents().catch(() => undefined)
    void window.api.ade.worktreesRoot().then(
      (info) => {
        knownHome = info.home
        setRoot(info.path)
      },
      () => setRoot('')
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const installed = agents.filter((a) => a.installed && a.id !== 'shell')
  useEffect(() => {
    if (!open) return
    setAgent((current) => current ?? PREFERRED.find((id) => installed.some((a) => a.id === id)) ?? 'shell')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agents])

  if (!open) return null

  const own = sessions.find((s) => s.cwd === project)
  const notGit = Boolean(own && !own.repo)
  const effective = branchEdited ? branch : title.trim() ? branchForTitle(title) : ''
  const problem = branchEdited || title.trim() ? branchNameProblem(effective) : null
  const where = project && effective && root ? `${tidy(root)}/${worktreeFolderFor(folderName(project))}/${worktreeFolderFor(effective)}` : null

  const submit = async (): Promise<void> => {
    if (!project || !title.trim() || problem || busy) return
    setBusy(true)
    setError(null)
    const failed = await create({ project, title: title.trim(), ...(branchEdited ? { branch: branch.trim() } : {}) }, agent)
    setBusy(false)
    if (failed) setError(failed)
  }

  if (!project) {
    return (
      <Modal
        open
        onClose={close}
        title="New session"
        actions={
          <>
            <button type="button" className="btn btn--ghost" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                close()
                void chooseFolder()
              }}
            >
              Open a project folder…
            </button>
          </>
        }
      >
        <p className="ade-dialog__lede">A session belongs to a project. Open the project’s folder first.</p>
      </Modal>
    )
  }

  return (
    <Modal
      open
      onClose={() => !busy && close()}
      title="New session"
      width={480}
      actions={
        <>
          <button type="button" className="btn btn--ghost" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={!title.trim() || Boolean(problem) || busy || notGit} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create session'}
          </button>
        </>
      }
    >
      <form
        className="ade-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {projects.length > 1 && (
          <div className="field">
            <span className="field-label">Project</span>
            <Select
              value={project}
              options={projects.map((p) => ({ value: p, label: folderName(p), icon: <Folder size={14} strokeWidth={1.8} /> }))}
              onChange={(value) => setProject(value)}
            />
          </div>
        )}
        <label className="field">
          <span className="field-label">What are you working on?</span>
          <input
            autoFocus
            className="input"
            value={title}
            maxLength={120}
            placeholder="Fix CI checks detail link"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Branch</span>
          <span className="ade-dialog__branch">
            <GitBranch size={14} strokeWidth={1.9} aria-hidden />
            <input
              className="input"
              value={effective}
              spellCheck={false}
              placeholder="feature/…"
              aria-invalid={Boolean(problem) || undefined}
              onChange={(e) => {
                setBranch(e.target.value)
                setBranchEdited(true)
              }}
            />
          </span>
        </label>
        <p className="ade-dialog__hint" aria-live="polite">
          {notGit
            ? `${folderName(project)} isn’t a git repository, so a session there can’t have a branch of its own.`
            : (problem ??
              `A new branch${own?.branch ? ` from ${own.branch}` : ''}, in its own folder${where ? ` (${where})` : ''}. Your project folder isn’t touched.`)}
        </p>
        <div className="field">
          <span className="field-label">Start with</span>
          <div className="ade-dialog__agents" role="radiogroup" aria-label="Start with">
            {[...installed.map((a) => ({ id: a.id, label: a.label })), { id: 'shell' as TerminalAgentId, label: 'Shell' }].map((a) => (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={agent === a.id}
                className="ade-dialog__agent"
                data-on={agent === a.id || undefined}
                onClick={() => setAgent(a.id)}
              >
                <AgentMark agent={a.id} size={15} />
                {a.label}
              </button>
            ))}
          </div>
        </div>
        {error && (
          <p className="ade-dialog__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  )
}

export function RenameSessionDialog({ session, onClose }: { session: AdeSession; onClose: () => void }): JSX.Element {
  const rename = useAdeSessions((s) => s.rename)
  const [title, setTitle] = useState(sessionTitle(session))
  const save = (): void => {
    void rename(session, title)
    onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Rename session"
      actions={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={save}>
            Rename
          </button>
        </>
      }
    >
      <form
        className="ade-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <label className="field">
          <span className="field-label">Name</span>
          <input autoFocus className="input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <p className="ade-dialog__hint">Leave it empty to name it after its branch again.</p>
      </form>
    </Modal>
  )
}

export function RemoveSessionDialog({ session, onClose }: { session: AdeSession; onClose: () => void }): JSX.Element {
  const remove = useAdeSessions((s) => s.remove)
  const [deleteWorktree, setDeleteWorktree] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const title = sessionTitle(session)
  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const failed = await remove(session, deleteWorktree)
    setBusy(false)
    if (failed) setError(failed)
    else onClose()
  }
  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title={`Remove “${title}”?`}
      width={460}
      actions={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--danger" onClick={() => void confirm()} disabled={busy}>
            {busy ? 'Removing…' : 'Remove'}
          </button>
        </>
      }
    >
      <div className="ade-dialog">
        <p className="ade-dialog__lede">
          Its terminals close. Claude Code and Codex keep their conversations{session.worktree ? '' : ', and the folder stays where it is'}.
        </p>
        {session.worktree && (
          <label className="ade-dialog__check">
            <input type="checkbox" checked={deleteWorktree} onChange={(e) => setDeleteWorktree(e.target.checked)} />
            <span>
              Also delete its worktree folder ({tidy(session.cwd)}).
              {session.branch ? ` The branch ${session.branch} stays.` : ''} Git won’t delete a folder with changes nobody committed.
            </span>
          </label>
        )}
        {error && (
          <p className="ade-dialog__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}

/** Takes a project off the sidebar: its sessions leave the list and their terminals close; nothing on disk goes. */
export function RemoveProjectDialog({ group, onClose }: { group: ProjectGroup; onClose: () => void }): JSX.Element {
  const removeProject = useAdeSessions((s) => s.removeProject)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = folderName(group.project)
  const count = group.sessions.length
  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const failed = await removeProject(group.project)
    setBusy(false)
    if (failed) setError(failed)
    else onClose()
  }
  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title={`Remove ${name} from the ADE?`}
      width={460}
      actions={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--danger" onClick={() => void confirm()} disabled={busy}>
            {busy ? 'Removing…' : 'Remove'}
          </button>
        </>
      }
    >
      <div className="ade-dialog">
        <p className="ade-dialog__lede">
          {count === 1 ? 'Its session leaves' : `Its ${count} sessions leave`} the sidebar and their terminals close. Nothing on disk is deleted: the
          project folder, any worktrees and their branches stay, and Claude Code and Codex keep their conversations. Open the folder again to bring it back.
        </p>
        {error && (
          <p className="ade-dialog__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
