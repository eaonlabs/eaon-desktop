import { useEffect, useState, useSyncExternalStore, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Folder, FolderPlus, Loader2, Maximize2, Trash2, X } from 'lucide-react'
import { ContextMenu } from '../Sidebar'
import { folderName } from './CodeHeader'
import { useCode } from './codeStore'
import { AgentMark } from './terminal/TerminalWorkspace'
import { terminals } from './terminal/registry'
import { useTerminals } from './terminal/terminalStore'
import { revealLabel } from '../../lib/files'
import type { TerminalPaneSpec } from '@shared/terminals'

/** The ADE's sidebar section: this folder's terminals, then the folders opened recently. */
export function CodeSidebar(): JSX.Element | null {
  const { cwd, recents, openFolder, chooseFolder, forgetFolder } = useCode(
    useShallow((s) => ({
      cwd: s.cwd,
      recents: s.recents,
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

  return (
    <>
      <TerminalList cwd={cwd} />

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
            { icon: <Folder size={15} strokeWidth={1.9} />, label: revealLabel(), action: () => void window.api.app.showItem(menu.path) },
            { icon: <Trash2 size={15} strokeWidth={1.9} />, label: 'Remove from recents', action: () => void forgetFolder(menu.path) }
          ]}
        />
      )}
    </>
  )
}

/** In the terminal view: this folder's terminals, with what each is doing. */
function TerminalList({ cwd }: { cwd: string | null }): JSX.Element {
  const panes = useTerminals((s) => (cwd ? s.layout[cwd] : undefined))
  const { toggleMaximized, close } = useTerminals(useShallow((s) => ({ toggleMaximized: s.toggleMaximized, close: s.close })))
  useSyncExternalStore(terminals.subscribe, terminals.getVersion)
  const [menu, setMenu] = useState<{ x: number; y: number; pane: TerminalPaneSpec } | null>(null)
  return (
    <>
      <div className="sidebar__section">{cwd ? `Terminals · ${folderName(cwd)}` : 'Terminals'}</div>
      {!cwd || !panes || panes.length === 0 ? (
        <div className="sidebar__empty">{cwd ? 'No terminals yet' : 'Open a folder to start one'}</div>
      ) : (
        panes.map((pane, index) => {
          const status = terminals.statusOf(pane.id).status
          return (
            <div
              key={pane.id}
              className="nav-item nav-item--staggered code-term-row"
              data-status={status}
              style={{ ['--i' as string]: Math.min(index, 12) }}
              role="button"
              tabIndex={0}
              onClick={() => terminals.focus(pane.id)}
              onDoubleClick={() => toggleMaximized(pane.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, pane })
              }}
            >
              <span className="nav-item__icon">
                <AgentMark agent={pane.agent} size={14} />
              </span>
              <span className="nav-item__label">{pane.name}</span>
              <span className="nav-item__trail" data-always={status === 'working' ? 'true' : undefined}>
                {status === 'working' ? <Loader2 size={13} strokeWidth={2} className="spinner" /> : null}
              </span>
            </div>
          )
        })
      )}
      {menu && cwd && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { icon: <Maximize2 size={15} strokeWidth={1.9} />, label: 'Fill the view', action: () => toggleMaximized(menu.pane.id) },
            { icon: <X size={15} strokeWidth={1.9} />, label: 'Close', danger: true, action: () => close(cwd, menu.pane.id) }
          ]}
        />
      )}
    </>
  )
}
