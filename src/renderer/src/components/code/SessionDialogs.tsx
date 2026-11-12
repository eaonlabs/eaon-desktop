import { useEffect, useMemo, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Folder, GitBranch, LayoutGrid, Server } from 'lucide-react'
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
  parallelRuns,
  sessionTitle,
  worktreeFolderFor,
  type AdeSession,
  type ProjectGroup
} from '@shared/adeSessions'
import { copiedSummary, type CopyPlan } from '@shared/worktreeCopy'
import type { TerminalAgentId } from '@shared/terminals'
import { arrangeAgents } from '../../lib/agentPrefs'
import { useApp } from '../../state/store'
import { presetsOf, useMods } from '../../state/mods'

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
  const { creatingIn, sessions, close, create, createParallel } = useAdeSessions(
    useShallow((s) => ({ creatingIn: s.creatingIn, sessions: s.sessions, close: s.closeNewSession, create: s.create, createParallel: s.createParallel }))
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
  // A mod's session preset picked instead of one agent.
  const [preset, setPreset] = useState<string | null>(null)
  // What the agent is asked to do first, and the other agents given the same task, each in a worktree of its own.
  const [task, setTask] = useState('')
  const [also, setAlso] = useState<TerminalAgentId[]>([])
  const presets = presetsOf(useMods((s) => s.enabled))
  const [root, setRoot] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The ignored files (.env…) the project has that Settings → ADE names, and whether to copy them in.
  const [copyPlan, setCopyPlan] = useState<CopyPlan | null>(null)
  const [copyOn, setCopyOn] = useState(false)
  const [copyDefault, setCopyDefault] = useState(false)

  // A fresh form each time it opens, in the project it was opened from.
  useEffect(() => {
    if (!open) return
    setProject(creatingIn ?? projects[0] ?? null)
    setTitle('')
    setBranch('')
    setBranchEdited(false)
    setError(null)
    setBusy(false)
    setPreset(null)
    setTask('')
    setAlso([])
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

  // What this project would copy into the worktree, looked at when a project is picked.
  useEffect(() => {
    if (!open || !project) return setCopyPlan(null)
    let live = true
    void Promise.all([window.api.adeTools.previewCopy(project), window.api.adeTools.copySettings()]).then(
      ([plan, settings]) => {
        if (!live) return
        setCopyPlan(plan)
        setCopyDefault(settings.enabled)
        setCopyOn(settings.enabled)
      },
      () => live && setCopyPlan(null)
    )
    return () => {
      live = false
    }
  }, [open, project])

  const installed = arrangeAgents(agents, useApp.getState().settings?.agentProviders).filter((a) => a.installed && a.id !== 'shell')
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

  const others = installed.filter((a) => a.id !== agent)
  // Agents picked to run alongside; one that became the main agent since is no longer "also".
  const alsoOn = preset ? [] : also.filter((id) => id !== agent && others.some((a) => a.id === id))
  const needsTask = alsoOn.length > 0 && !task.trim()

  const submit = async (): Promise<void> => {
    if (!project || !title.trim() || problem || busy || needsTask) return
    setBusy(true)
    setError(null)
    const chosen = presets.find((p) => p.key === preset)
    const extras = { copyIgnored: copyOn && Boolean(copyPlan && copyPlan.copy.length > 0), ...(task.trim() && !chosen ? { prompt: task.trim() } : {}) }
    const request = { project, title: title.trim(), ...(branchEdited ? { branch: branch.trim() } : {}) }
    const failed =
      alsoOn.length > 0 && agent
        ? await createParallel(
            parallelRuns(
              title.trim(),
              effective,
              [agent, ...alsoOn].map((id) => ({ id, label: installed.find((a) => a.id === id)?.label ?? id }))
            ),
            request,
            extras
          )
        : await create(request, chosen ? chosen.panes : agent, extras)
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
            <button
              type="button"
              className="btn btn--ghost ade-dialog__ssh"
              onClick={() => {
                close()
                useAdeSessions.getState().setConnecting(true)
              }}
            >
              <Server size={14} strokeWidth={1.9} />
              On another machine (SSH)…
            </button>
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
          <button
            type="button"
            className="btn btn--ghost ade-dialog__ssh"
            onClick={() => {
              close()
              useAdeSessions.getState().setConnecting(true)
            }}
          >
            <Server size={14} strokeWidth={1.9} />
            On another machine (SSH)…
          </button>
          <button type="button" className="btn btn--ghost" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={!title.trim() || Boolean(problem) || busy || notGit || needsTask} onClick={() => void submit()}>
            {busy ? 'Creating…' : alsoOn.length > 0 ? `Create ${alsoOn.length + 1} sessions` : 'Create session'}
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
        {copyPlan && (copyPlan.copy.length > 0 || copyPlan.skipped.length > 0) && !notGit && (
          <div className="field">
            {copyPlan.copy.length > 0 && (
              <label className="ade-dialog__check">
                <input type="checkbox" checked={copyOn} onChange={(e) => setCopyOn(e.target.checked)} />
                <span>
                  Copy {copyPlan.copy.length === 1 ? 'an ignored file' : `${copyPlan.copy.length} ignored files`} from the project into the new folder:{' '}
                  <code>{copiedSummary(copyPlan.copy.map((f) => f.path))}</code>. Git ignores {copyPlan.copy.length === 1 ? 'it' : 'them'}, so a fresh checkout doesn’t have {copyPlan.copy.length === 1 ? 'it' : 'them'}.
                </span>
              </label>
            )}
            {copyPlan.skipped.length > 0 && (
              <p className="ade-dialog__hint">
                Not copied: {copyPlan.skipped.slice(0, 3).map((f) => `${f.path} (${f.reason})`).join(', ')}
                {copyPlan.skipped.length > 3 ? ` and ${copyPlan.skipped.length - 3} more` : ''}.
              </p>
            )}
            <p className="ade-dialog__hint">
              Which files count is set in Settings → ADE{copyDefault ? '; copying is ticked by default' : ''}. Dependency folders and files over 1 MB are never copied.
            </p>
          </div>
        )}
        <div className="field">
          <span className="field-label">Start with</span>
          <div className="ade-dialog__agents" role="radiogroup" aria-label="Start with">
            {[...installed.map((a) => ({ id: a.id, label: a.label })), { id: 'shell' as TerminalAgentId, label: 'Shell' }].map((a) => (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={!preset && agent === a.id}
                className="ade-dialog__agent"
                data-on={(!preset && agent === a.id) || undefined}
                onClick={() => {
                  setAgent(a.id)
                  setPreset(null)
                }}
              >
                <AgentMark agent={a.id} size={15} />
                {a.label}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span className="field-label">First task for the agent (optional)</span>
          <textarea
            className="input ade-dialog__task"
            rows={3}
            value={task}
            maxLength={4000}
            placeholder="Add a search box to the docs page and cover it with tests"
            disabled={Boolean(preset)}
            onChange={(e) => setTask(e.target.value)}
          />
        </label>
        {!preset && others.length > 0 && (
          <div className="field">
            <span className="field-label">Run the same task with more agents</span>
            <div className="ade-dialog__agents" role="group" aria-label="Run in parallel with">
              {others.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  aria-pressed={alsoOn.includes(a.id)}
                  className="ade-dialog__agent"
                  data-on={alsoOn.includes(a.id) || undefined}
                  onClick={() => setAlso((current) => (current.includes(a.id) ? current.filter((x) => x !== a.id) : [...current, a.id]))}
                >
                  <AgentMark agent={a.id} size={15} />
                  {a.label}
                </button>
              ))}
            </div>
            <p className="ade-dialog__hint" aria-live="polite">
              {alsoOn.length === 0
                ? 'Each agent works in a worktree and branch of its own, so you can compare what they made.'
                : needsTask
                  ? 'Write the task above: every agent starts with it.'
                  : `${alsoOn.length + 1} sessions start from the same point: ${effective || 'the branch'} and ${alsoOn.map((id) => `${effective || 'the branch'}-${id}`).join(', ')}.`}
            </p>
          </div>
        )}
        {presets.length > 0 && (
          <div className="field">
            <span className="field-label">Or a preset from your mods</span>
            <div className="ade-dialog__agents" role="radiogroup" aria-label="Session presets">
              {presets.map((p) => {
                const missing = [...new Set(p.panes.filter((pane) => pane.agent !== 'shell' && !installed.some((a) => a.id === pane.agent)).map((pane) => pane.agent))]
                return (
                  <button
                    key={p.key}
                    type="button"
                    role="radio"
                    aria-checked={preset === p.key}
                    className="ade-dialog__agent"
                    data-on={preset === p.key || undefined}
                    disabled={missing.length > 0}
                    title={missing.length ? `Needs ${missing.map((id) => agents.find((a) => a.id === id)?.label ?? id).join(' and ')}` : `${p.description} (${p.panes.length} panes)`}
                    onClick={() => setPreset(p.key)}
                  >
                    <LayoutGrid size={14} strokeWidth={1.9} />
                    {p.name}
                  </button>
                )
              })}
            </div>
            {preset && <p className="ade-dialog__hint">{presets.find((p) => p.key === preset)?.description}</p>}
          </div>
        )}
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

/** Archive: out of the list, terminals ended, nothing deleted; the Archived group at the foot of the sidebar brings it back. */
export function ArchiveSessionDialog({ session, onClose }: { session: AdeSession; onClose: () => void }): JSX.Element {
  const archive = useAdeSessions((s) => s.archive)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const failed = await archive(session)
    setBusy(false)
    if (failed) setError(failed)
    else onClose()
  }
  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title={`Archive “${sessionTitle(session)}”?`}
      width={460}
      actions={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void confirm()} disabled={busy}>
            {busy ? 'Archiving…' : 'Archive'}
          </button>
        </>
      }
    >
      <div className="ade-dialog">
        <p className="ade-dialog__lede">
          It moves to Archived at the foot of the sidebar and its terminals close. {session.worktree ? `Its worktree folder (${tidy(session.cwd)})${session.branch ? ` and the branch ${session.branch}` : ''} stay` : 'Its folder stays where it is'}, and so do the Claude Code and Codex conversations.
          Restoring it opens its terminals again, each on the conversation it was in.
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
