import { useRef, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronDown, Folder, FolderOpen } from 'lucide-react'
import { TopBar } from '../TopBar'
import { MenuItem, MenuSeparator, Popover, useDisclosure } from '../ui'
import { useCode } from './codeStore'
import { useAdeSessions } from './sessionsStore'
import { sessionTitle } from '@shared/adeSessions'
import { NewTerminalButton } from './terminal/TerminalWorkspace'
import { UsagePlacement } from '../UsagePlacement'
import { ReviewButton } from './ReviewPanel'
import { revealLabel } from '../../lib/files'
import { shortcutLabel } from '../../lib/platform'
import { DockToggle } from '../ide/Dock'
import { useAdeDock } from '../ide/adeDock'

export const folderName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** The ADE's top bar: the project folder, plan usage, review, a new terminal and the dock's switch. */
export function CodeHeader(): JSX.Element {
  const cwd = useCode((s) => s.cwd)
  // Open, the dock has its own switch in the same corner.
  const dockOpen = useAdeDock((s) => s.open)
  return (
    <TopBar
      className="code-header"
      left={cwd ? <FolderChip /> : null}
      right={
        <div className="chat-header__actions">
          <UsagePlacement />
          <ReviewButton />
          <NewTerminalButton />
          {cwd && !dockOpen && <DockToggle store={useAdeDock} holds={`browser (${shortcutLabel('⇧⌘B')}), files, diff, pull request`} />}
        </div>
      }
    />
  )
}

function FolderChip(): JSX.Element {
  const { cwd, recents, chooseFolder, openFolder } = useCode(
    useShallow((s) => ({ cwd: s.cwd, recents: s.recents, chooseFolder: s.chooseFolder, openFolder: s.openFolder }))
  )
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const others = recents.filter((path) => path !== cwd)
  const session = useAdeSessions((s) => s.sessions.find((x) => x.cwd === cwd) ?? null)
  // The project, then the session when it isn't the project folder itself.
  const project = session?.project ?? cwd
  const inner = session && session.cwd !== session.project ? sessionTitle(session) : null

  return (
    <>
      <button ref={anchor} className="header-btn code-folder" data-open={menu.open || undefined} onClick={menu.toggle} title={cwd ?? ''}>
        <Folder size={14} strokeWidth={1.9} />
        <span className="code-folder__name">{project ? folderName(project) : 'Choose folder'}</span>
        {inner && (
          <>
            <span className="code-folder__sep" aria-hidden>
              /
            </span>
            <span className="code-folder__name">{inner}</span>
          </>
        )}
        <ChevronDown size={13} strokeWidth={2} className="code-folder__chevron" />
      </button>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="bottom-start" width={300}>
        {cwd && (
          <>
            <div className="menu__label">Project folder</div>
            {/* The folder already open: picking it again just closes the menu. */}
            <MenuItem icon={<FolderOpen size={16} strokeWidth={1.8} />} title={folderName(cwd)} description={cwd} checked onClick={menu.close} />
          </>
        )}
        {others.length > 0 && (
          <>
            <div className="menu__label">Recent</div>
            {others.map((path) => (
              <MenuItem
                key={path}
                icon={<Folder size={16} strokeWidth={1.8} />}
                title={folderName(path)}
                description={path}
                onClick={() => {
                  menu.close()
                  void openFolder(path)
                }}
              />
            ))}
          </>
        )}
        <MenuSeparator />
        <MenuItem
          title="Open another folder…"
          onClick={() => {
            menu.close()
            void chooseFolder()
          }}
        />
        {cwd && (
          <MenuItem
            title={revealLabel()}
            onClick={() => {
              menu.close()
              void window.api.app.showItem(cwd)
            }}
          />
        )}
      </Popover>
    </>
  )
}
