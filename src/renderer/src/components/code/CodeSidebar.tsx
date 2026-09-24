import { memo, useEffect, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Folder, FolderPlus, Loader2, Trash2 } from 'lucide-react'
import { ContextMenu } from '../Sidebar'
import { folderName } from './CodeHeader'
import { useCode } from './codeStore'
import type { EaonSessionInfo } from '@shared/eaonCode'

/** "5m", "3h", "2d", then a date: how long ago a session was last active. */
export function relativeTime(at: number, now = Date.now()): string {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * The Code tab's sidebar section: the sessions Eaon Code has saved for this
 * folder (click to resume) and the folders opened recently. "New session"
 * is the shared nav row above this, wired to the Code store.
 */
export function CodeSidebar(): JSX.Element | null {
  const { cwd, sessions, recents, currentFile, running, openFolder, chooseFolder, forgetFolder } = useCode(
    useShallow((s) => ({
      cwd: s.cwd,
      sessions: s.sessions,
      recents: s.recents,
      currentFile: s.session?.sessionFile ?? null,
      running: s.transcript.running,
      openFolder: s.openFolder,
      chooseFolder: s.chooseFolder,
      forgetFolder: s.forgetFolder
    }))
  )
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null)

  // The sidebar mounts before the view on first open; either may start things off.
  useEffect(() => {
    void useCode.getState().init()
  }, [])

  // The current session is not in the saved list until its first reply is written.
  const unsaved = currentFile && !sessions.some((s) => s.path === currentFile)

  return (
    <>
      <div className="sidebar__section">{cwd ? `Sessions · ${folderName(cwd)}` : 'Sessions'}</div>
      {!cwd ? (
        <div className="sidebar__empty">Open a folder to see its sessions</div>
      ) : sessions.length === 0 && !(unsaved && running) ? (
        <div className="sidebar__empty">No sessions yet</div>
      ) : (
        <>
          {unsaved && running && (
            <div className="nav-item" data-active="true">
              <span className="nav-item__label">New session</span>
              <span className="nav-item__trail" data-always="true">
                <Loader2 size={14} strokeWidth={2} className="spinner" />
              </span>
            </div>
          )}
          {sessions.map((session, index) => (
            <SessionRow
              key={session.path}
              session={session}
              index={index}
              active={session.path === currentFile}
              running={running && session.path === currentFile}
            />
          ))}
        </>
      )}

      <div className="sidebar__section">Folders</div>
      {recents.map((path) => (
        <button
          key={path}
          className="nav-item code-sidebar__folder"
          data-active={path === cwd || undefined}
          title={path}
          onClick={() => path !== cwd && void openFolder(path)}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, path })
          }}
        >
          <span className="nav-item__icon">
            <Folder size={15} strokeWidth={1.9} />
          </span>
          <span className="nav-item__label">{folderName(path)}</span>
        </button>
      ))}
      <button className="nav-item" onClick={() => void chooseFolder()}>
        <span className="nav-item__icon">
          <FolderPlus size={15} strokeWidth={1.9} />
        </span>
        <span className="nav-item__label code-sidebar__muted">Open folder…</span>
      </button>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { icon: <Folder size={15} strokeWidth={1.9} />, label: 'Reveal in Finder', action: () => void window.api.app.showItem(menu.path) },
            { icon: <Trash2 size={15} strokeWidth={1.9} />, label: 'Remove from recents', action: () => void forgetFolder(menu.path) }
          ]}
        />
      )}
    </>
  )
}

const SessionRow = memo(function SessionRow({
  session,
  index,
  active,
  running
}: {
  session: EaonSessionInfo
  index: number
  active: boolean
  running: boolean
}): JSX.Element {
  const resume = useCode((s) => s.resume)
  const title = session.name || session.firstMessage || 'Untitled session'
  return (
    <div
      className="nav-item nav-item--staggered code-session"
      data-active={active || undefined}
      style={{ ['--i' as string]: Math.min(index, 12) }}
      role="button"
      tabIndex={0}
      title={`${title}\n${session.messageCount} messages · ${new Date(session.modified).toLocaleString()}`}
      onClick={() => void resume(session.path)}
      onKeyDown={(e) => e.key === 'Enter' && void resume(session.path)}
    >
      <span className="nav-item__label">{title}</span>
      <span className="nav-item__trail" data-always="true">
        {running ? <Loader2 size={14} strokeWidth={2} className="spinner" /> : <span className="code-session__age">{relativeTime(session.modified)}</span>}
      </span>
    </div>
  )
})
