import { useRef, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronDown, Folder, FolderOpen } from 'lucide-react'
import { TopBar } from '../TopBar'
import { MenuItem, MenuSeparator, Popover, useDisclosure } from '../ui'
import { useCode } from './codeStore'
import { NewTerminalButton } from './terminal/TerminalWorkspace'
import { revealLabel } from '../../lib/files'

export const folderName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** The ADE's top bar: the project folder, the mode switch, and a new terminal. */
export function CodeHeader(): JSX.Element {
  const cwd = useCode((s) => s.cwd)
  return (
    <TopBar
      className="code-header"
      left={cwd ? <FolderChip /> : null}
      right={
        <div className="chat-header__actions">
          <NewTerminalButton />
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

  return (
    <>
      <button ref={anchor} className="header-btn code-folder" data-open={menu.open || undefined} onClick={menu.toggle} title={cwd ?? ''}>
        <Folder size={14} strokeWidth={1.9} />
        <span className="code-folder__name">{cwd ? folderName(cwd) : 'Choose folder'}</span>
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
