import { useEffect, useRef, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronDown, CircleAlert, Folder, FolderOpen, FolderPlus, Hand, ShieldCheck, X } from 'lucide-react'
import type { WorkspaceEntry } from '@shared/workspaceFiles'
import { codeProject, useApp } from '../../state/store'
import { fileName } from '../../lib/files'
import { MenuItem, MenuSearch, MenuSeparator, Popover, useDisclosure } from '../ui'

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
      <button ref={anchor} className="composer-pill composer-pill--permission" data-tone={mode === 'full' ? 'warn' : undefined} data-open={menu.open || undefined} onClick={menu.toggle} title="What Eaon may do without asking">
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
 * "Work in a project": the folder a chat codes in, which is its project.
 * Above the message box on the start page it is a pill; in the workspace
 * card beside a conversation (`row`), the card's first row. Choosing a
 * folder puts the chat in that folder's project (made for it the first
 * time); a chat in no project is an ordinary one, with no coding tools.
 */
export function ProjectPicker({ row = false }: { row?: boolean } = {}): JSX.Element {
  const { project, inChat, workIn } = useApp(useShallow((s) => ({ project: codeProject(s), inChat: s.activeChatId !== null, workIn: s.workIn })))
  const cwd = project?.folder ?? null
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const label = project && cwd ? project.name : 'Work in a project'
  return (
    <>
      {row ? (
        <button ref={anchor} className="ws-row" data-open={menu.open || undefined} onClick={menu.toggle} title={cwd ?? 'Choose the folder Eaon works in'}>
          <span className="ws-row__icon">{cwd ? <FolderOpen size={15} strokeWidth={1.8} /> : <Folder size={15} strokeWidth={1.8} />}</span>
          <span className="ws-row__label">{label}</span>
          <ChevronDown size={14} strokeWidth={2} className="ws-row__chev" />
        </button>
      ) : (
        <button ref={anchor} className="composer-pill composer-pill--project" data-set={cwd ? true : undefined} data-open={menu.open || undefined} onClick={menu.toggle} title={cwd ?? 'Choose the folder Eaon works in'}>
          {cwd ? <FolderOpen size={14} strokeWidth={1.9} /> : <Folder size={14} strokeWidth={1.9} />}
          <span className="composer-pill__label">{label}</span>
        </button>
      )}
      <FolderMenu
        anchor={anchor}
        open={menu.open}
        onClose={menu.close}
        placement={row ? 'bottom-end' : 'top-start'}
        current={cwd}
        onChoose={workIn}
        none={cwd ? (inChat ? 'Move this chat to Chats' : 'Start an ordinary chat') : undefined}
      />
    </>
  )
}

/**
 * Picks a folder to work in: this tab's projects, folders picked before,
 * the folders in the home folder, searchable, and the open dialog for
 * anything else. `none`, when given, is the last item, choosing no folder.
 */
export function FolderMenu({
  anchor,
  open,
  onClose,
  onChoose,
  current = null,
  none,
  placement = 'bottom-start'
}: {
  anchor: React.RefObject<HTMLElement>
  open: boolean
  onClose: () => void
  onChoose: (folder: string | null) => void
  current?: string | null
  none?: string
  placement?: 'bottom-start' | 'bottom-end' | 'top-start'
}): JSX.Element {
  const projects = useApp(useShallow((s) => s.visibleProjects().filter((p) => p.folder)))
  const [query, setQuery] = useState('')
  const [places, setPlaces] = useState<WorkspaceEntry[]>([])
  const [recent, setRecent] = useState<string[]>([])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setRecent(recentProjects())
    window.api.workspaceFiles
      .places()
      .then(setPlaces)
      .catch(() => setPlaces([]))
  }, [open])

  const choose = (path: string | null): void => {
    if (path) rememberProject(path)
    onChoose(path)
    onClose()
  }
  const q = query.trim().toLowerCase()
  const match = (name: string): boolean => !q || name.toLowerCase().includes(q)
  const known = new Set(projects.map((p) => p.folder))
  const mine = projects.filter((p) => p.folder !== current && (match(p.name) || match(fileName(p.folder!))))
  const recents = recent.filter((p) => p !== current && !known.has(p) && match(fileName(p)))
  const folders = places.filter((p) => p.path !== current && !known.has(p.path) && !recent.includes(p.path) && match(p.name))

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement={placement} width={300} className="project-menu">
      <MenuSearch value={query} onChange={setQuery} placeholder="Search projects" />
      {mine.length > 0 && (
        <>
          <div className="menu__label">Projects</div>
          {mine.map((project) => (
            <MenuItem key={project.id} icon={<FolderOpen size={15} strokeWidth={1.8} />} title={project.name} onClick={() => choose(project.folder!)} />
          ))}
        </>
      )}
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
      {mine.length === 0 && recents.length === 0 && folders.length === 0 && q && <div className="menu__empty">No folders match</div>}
      <MenuSeparator />
      <MenuItem
        icon={<FolderPlus size={15} strokeWidth={1.8} />}
        title="Choose another folder…"
        onClick={() => {
          onClose()
          void window.api.app.openFiles({ properties: ['openDirectory'] }).then((paths) => paths[0] && choose(paths[0]))
        }}
      />
      {none && <MenuItem icon={<X size={15} strokeWidth={1.8} />} title={none} onClick={() => choose(null)} />}
    </Popover>
  )
}

