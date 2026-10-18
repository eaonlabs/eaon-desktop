import { useEffect, useRef, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronDown, CircleAlert, Folder, FolderOpen, FolderPlus, GitCompareArrows, Hand, ShieldCheck, X } from 'lucide-react'
import type { WorkspaceEntry } from '@shared/workspaceFiles'
import { agentWorkspace, useApp } from '../../state/store'
import { fileName } from '../../lib/files'
import { MenuItem, MenuSearch, MenuSeparator, Popover, useDisclosure } from '../ui'
import { useIde } from '../ide/ideStore'
import { useChatChanges } from '../ide/changes'

/* ------------------------------------------------------------ Permissions */

type ApprovalMode = 'ask' | 'auto' | 'full'

const MODES: { id: ApprovalMode; title: string; description: string; icon: typeof Hand }[] = [
  { id: 'ask', title: 'Ask for approval', description: 'Eaon asks before editing files, running commands or acting in apps', icon: Hand },
  { id: 'auto', title: 'Auto-approve', description: 'Eaon only asks before actions that look unsafe', icon: ShieldCheck },
  {
    id: 'full',
    title: 'Full access',
    description: 'Eaon runs every action without asking. It still stops for sudo, erasing disks, force-pushing, passwords and payments',
    icon: CircleAlert
  }
]

/**
 * How much Eaon may do without asking, always in view beside the message box
 * rather than tucked in a menu: it decides what happens when you press send.
 * Full access is set in orange, so it is never on by accident.
 */
export function PermissionPicker(): JSX.Element {
  const { mode, patchSettings } = useApp(useShallow((s) => ({ mode: (s.settings?.approvalMode ?? 'ask') as ApprovalMode, patchSettings: s.patchSettings })))
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const current = MODES.find((m) => m.id === mode) ?? MODES[0]
  return (
    <>
      <button ref={anchor} className="composer-pill" data-tone={mode === 'full' ? 'warn' : undefined} data-open={menu.open || undefined} onClick={menu.toggle} title="What Eaon may do without asking">
        <current.icon size={14} strokeWidth={1.9} />
        <span className="composer-pill__label">{current.title}</span>
        <ChevronDown size={13} strokeWidth={2} className="composer-pill__chevron" />
      </button>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="top-start" width={340} className="perm-menu">
        {MODES.map((m) => (
          <div key={m.id} className="perm-menu__option" data-tone={m.id === 'full' ? 'warn' : undefined}>
            <MenuItem
              icon={<m.icon size={16} strokeWidth={1.8} />}
              title={m.title}
              description={m.description}
              checked={mode === m.id}
              onClick={() => {
                void patchSettings({ approvalMode: m.id })
                // Full access covers what is already waiting, not only what comes next.
                if (m.id === 'full') useApp.getState().releaseApprovals()
                menu.close()
              }}
            />
          </div>
        ))}
      </Popover>
    </>
  )
}

/* --------------------------------------------------------------- Projects */

const RECENT_KEY = 'eaon.recentProjects'

function recentProjects(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string').slice(0, 6) : []
  } catch {
    return []
  }
}

function rememberProject(path: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([path, ...recentProjects().filter((p) => p !== path)].slice(0, 6)))
  } catch {
    /* Remembered for this session only. */
  }
}

/**
 * The folder Eaon works in, above the message box: "Work in a project" until
 * one is chosen, then its name. Opens onto recent projects and the folders in
 * the home folder, searchable, with the open dialog for anything else.
 */
export function ProjectPicker(): JSX.Element {
  const { cwd, setWorkCwd } = useApp(useShallow((s) => ({ cwd: agentWorkspace(s.workspaces)?.cwd ?? null, setWorkCwd: s.setWorkCwd })))
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const [query, setQuery] = useState('')
  const [places, setPlaces] = useState<WorkspaceEntry[]>([])
  const [recent, setRecent] = useState<string[]>([])

  useEffect(() => {
    if (!menu.open) return
    setQuery('')
    setRecent(recentProjects())
    window.api.workspaceFiles
      .places()
      .then(setPlaces)
      .catch(() => setPlaces([]))
  }, [menu.open])

  const choose = (path: string): void => {
    rememberProject(path)
    setWorkCwd(path)
    menu.close()
  }
  const q = query.trim().toLowerCase()
  const match = (path: string): boolean => !q || fileName(path).toLowerCase().includes(q)
  const recents = recent.filter((p) => p !== cwd && match(p))
  const folders = places.filter((p) => !recent.includes(p.path) && match(p.path))

  return (
    <>
      <button ref={anchor} className="composer-pill composer-pill--project" data-set={cwd ? true : undefined} data-open={menu.open || undefined} onClick={menu.toggle} title={cwd ?? 'Choose the folder Eaon works in'}>
        {cwd ? <FolderOpen size={14} strokeWidth={1.9} /> : <Folder size={14} strokeWidth={1.9} />}
        <span className="composer-pill__label">{cwd ? fileName(cwd) : 'Work in a project'}</span>
      </button>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="top-start" width={300} className="project-menu">
        <MenuSearch value={query} onChange={setQuery} placeholder="Search projects" />
        {recents.length > 0 && (
          <>
            <div className="menu__label">Recent</div>
            {recents.map((path) => (
              <MenuItem key={path} icon={<Folder size={15} strokeWidth={1.8} />} title={fileName(path)} onClick={() => choose(path)} />
            ))}
          </>
        )}
        {folders.length > 0 && (
          <>
            <div className="menu__label">Folders on this computer</div>
            {folders.map((entry) => (
              <MenuItem key={entry.path} icon={<Folder size={15} strokeWidth={1.8} />} title={entry.name} onClick={() => choose(entry.path)} />
            ))}
          </>
        )}
        {recents.length === 0 && folders.length === 0 && q && <div className="menu__empty">No folders match</div>}
        <MenuSeparator />
        <MenuItem
          icon={<FolderPlus size={15} strokeWidth={1.8} />}
          title="Choose another folder…"
          onClick={() => {
            menu.close()
            void window.api.app.openFiles({ properties: ['openDirectory'] }).then((paths) => paths[0] && choose(paths[0]))
          }}
        />
        {cwd && (
          <MenuItem
            icon={<X size={15} strokeWidth={1.8} />}
            title="Stop using this folder"
            onClick={() => {
              setWorkCwd(null)
              menu.close()
            }}
          />
        )}
      </Popover>
    </>
  )
}

/* ---------------------------------------------------------------- Changes */

/**
 * What this chat has changed on disk, above the message box: its line counts,
 * opening the code panel's Changes pane to review them. Absent until there is
 * something to review.
 */
export function ChangesPill(): JSX.Element | null {
  const { files, added, removed } = useChatChanges()
  const { open, pane } = useIde(useShallow((s) => ({ open: s.open, pane: s.pane })))
  if (files === 0) return null
  const showing = open && pane === 'changes'
  return (
    <button
      className="composer-pill composer-pill--changes"
      data-open={showing || undefined}
      onClick={() => {
        const ide = useIde.getState()
        if (showing) return ide.setOpen(false)
        ide.setPane('changes')
        if (!ide.open) ide.setOpen(true)
      }}
      title={showing ? 'Hide changes' : 'Review what this chat changed'}
    >
      <GitCompareArrows size={14} strokeWidth={1.9} />
      <span className="composer-pill__label">Changes</span>
      {added > 0 && <span className="diff__stat-add">+{added}</span>}
      {removed > 0 && <span className="diff__stat-del">−{removed}</span>}
    </button>
  )
}
