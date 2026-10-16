import { useEffect, useMemo, useRef, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronRight, Code2, FileWarning, FolderOpen, PanelRight, RotateCw, X } from 'lucide-react'
import { useApp } from '../../state/store'
import { FileIcon, splitPath } from '../agent/FileIcon'
import { CodeEditor } from './CodeEditor'
import { isDirty, useIde, type IdeTab } from './ideStore'
import { joinPath, touchedFiles } from './paths'

/**
 * Chat as an editor: beside the conversation, the folder the agent works in
 * as a tree, the files open in tabs, and an editor that saves with ⌘S. Files
 * the agent changed in this chat carry a dot, and the tree and open files
 * follow its edits as they land.
 */
export function CodePanel(): JSX.Element {
  const { root, tabs, active, width, setOpen, refresh, setWidth } = useIde(
    useShallow((s) => ({ root: s.root, tabs: s.tabs, active: s.active, width: s.width, setOpen: s.setOpen, refresh: s.refresh, setWidth: s.setWidth }))
  )
  const touched = useTouched(root)
  useFollowAgent()

  const tab = tabs.find((t) => t.path === active) ?? null
  const panel = useRef<HTMLElement>(null)

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startW = panel.current?.offsetWidth ?? width
    const max = Math.max(420, window.innerWidth - 480)
    const move = (e: PointerEvent): void => setWidth(Math.min(max, Math.max(360, startW + startX - e.clientX)))
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.removeAttribute('data-resizing')
    }
    document.body.setAttribute('data-resizing', 'ide')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <aside className="ide" ref={panel} style={{ width }} aria-label="Code">
      <div className="ide__resize" onPointerDown={startResize} aria-hidden />
      <div className="ide__bar">
        <span className="ide__title" title={root ?? undefined}>
          <Code2 size={14} strokeWidth={1.9} />
          {root ? splitPath(root).name || root : 'Code'}
        </span>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={() => void refresh()} aria-label="Refresh" title="Refresh">
          <RotateCw size={14} strokeWidth={1.9} />
        </button>
        {root && (
          <button className="icon-btn" onClick={() => void window.api.app.showItem(root)} aria-label="Show in folder" title="Show in folder">
            <FolderOpen size={15} strokeWidth={1.9} />
          </button>
        )}
        <button className="icon-btn" data-active onClick={() => setOpen(false)} aria-label="Close code" title="Close">
          <PanelRight size={16} strokeWidth={1.9} />
        </button>
      </div>

      <div className="ide__body">
        <nav className="ide__tree scroll" aria-label="Files">
          {root && <Folder path={root} depth={0} touched={touched} />}
        </nav>
        <div className="ide__main">
          {tabs.length > 0 && <Tabs tabs={tabs} active={active} touched={touched} />}
          {tab ? <TabBody key={tab.path} tab={tab} /> : <Empty touched={touched} />}
          {tab && <StatusBar tab={tab} root={root} />}
        </div>
      </div>
    </aside>
  )
}

/** Paths the agent wrote or edited in the open chat, resolved against the folder. */
function useTouched(root: string | null): Set<string> {
  const paths = useApp(useShallow((s) => touchedFiles(s.activeChat()?.messages ?? [])))
  return useMemo(() => new Set(root ? paths.map((p) => joinPath(root, p)) : []), [paths, root])
}

/** Calls that change files on disk; when one finishes, the panel reads again. */
const CHANGES_FILES = new Set(['edit_file', 'write_file', 'delete_file', 'move_file', 'run_command', 'generate_image'])

function useFollowAgent(): void {
  const finished = useApp((s) => {
    let n = 0
    for (const message of s.activeChat()?.messages ?? []) {
      for (const part of message.parts) if (part.type === 'tool' && part.status !== 'running' && CHANGES_FILES.has(part.name)) n++
    }
    return n
  })
  const refresh = useIde((s) => s.refresh)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    void refresh()
  }, [finished, refresh])
  // Back from another app: what changed there shows here.
  useEffect(() => {
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])
}

function Folder({ path, depth, touched }: { path: string; depth: number; touched: Set<string> }): JSX.Element | null {
  const entries = useIde((s) => s.entries.get(path))
  if (!entries) return null
  if (entries.length === 0 && depth === 0) return <div className="ide__tree-empty">This folder is empty.</div>
  return (
    <>
      {entries.map((entry) =>
        entry.directory ? (
          <DirRow key={entry.path} path={entry.path} name={entry.name} depth={depth} touched={touched} />
        ) : (
          <FileRow key={entry.path} path={entry.path} name={entry.name} depth={depth} touched={touched.has(entry.path)} />
        )
      )}
    </>
  )
}

function DirRow({ path, name, depth, touched }: { path: string; name: string; depth: number; touched: Set<string> }): JSX.Element {
  const open = useIde((s) => s.expanded.has(path))
  const toggleDir = useIde((s) => s.toggleDir)
  return (
    <>
      <button
        className="ide__row"
        style={{ '--depth': depth } as React.CSSProperties}
        onClick={() => void toggleDir(path)}
        aria-expanded={open}
        title={path}
      >
        <ChevronRight size={12} strokeWidth={2.2} className="ide__chevron" />
        <span className="ide__name">{name}</span>
      </button>
      {open && <Folder path={path} depth={depth + 1} touched={touched} />}
    </>
  )
}

function FileRow({ path, name, depth, touched }: { path: string; name: string; depth: number; touched: boolean }): JSX.Element {
  const active = useIde((s) => s.active === path)
  const openFile = useIde((s) => s.openFile)
  return (
    <button
      className="ide__row"
      style={{ '--depth': depth } as React.CSSProperties}
      data-active={active || undefined}
      onClick={() => void openFile(path)}
      title={path}
    >
      <span className="ide__file-icon">
        <FileIcon file={name} size={13} />
      </span>
      <span className="ide__name">{name}</span>
      {touched && <span className="ide__touched" aria-label="Changed by Eaon" />}
    </button>
  )
}

function Tabs({ tabs, active, touched }: { tabs: IdeTab[]; active: string | null; touched: Set<string> }): JSX.Element {
  const { openFile, closeTab } = useIde(useShallow((s) => ({ openFile: s.openFile, closeTab: s.closeTab })))
  return (
    <div className="ide__tabs scroll" role="tablist">
      {tabs.map((tab) => {
        const { name } = splitPath(tab.path)
        const dirty = isDirty(tab)
        return (
          <div key={tab.path} className="ide__tab" data-active={tab.path === active || undefined} title={tab.path}>
            <button
              className="ide__tab-open"
              role="tab"
              aria-selected={tab.path === active}
              onClick={() => void openFile(tab.path)}
              onAuxClick={(event) => event.button === 1 && closeTab(tab.path)}
            >
              <FileIcon file={name} size={12} />
              <span>{name}</span>
              {touched.has(tab.path) && !dirty && <span className="ide__touched" aria-label="Changed by Eaon" />}
            </button>
            <button className="ide__tab-close" data-dirty={dirty || undefined} onClick={() => closeTab(tab.path)} aria-label={`Close ${name}`}>
              <X size={12} strokeWidth={2.2} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

function TabBody({ tab }: { tab: IdeTab }): JSX.Element {
  const { edit, save, reload, setCaret } = useIde(useShallow((s) => ({ edit: s.edit, save: s.save, reload: s.reload, setCaret: s.setCaret })))
  if (tab.kind !== 'text') {
    const message =
      tab.kind === 'binary' ? 'This file isn’t text, so it can’t be edited here.' : tab.kind === 'too-large' ? 'This file is too large to edit here.' : tab.error ?? 'This file couldn’t be opened.'
    return (
      <div className="ide__notice">
        <FileWarning size={22} strokeWidth={1.5} />
        <p>{message}</p>
        {tab.kind !== 'error' && (
          <button className="btn btn--ghost" onClick={() => void window.api.library.open(tab.path)}>
            Open in default app
          </button>
        )}
      </div>
    )
  }
  return (
    <>
      {tab.stale && (
        <div className="ide__banner" role="status">
          <span>This file changed on disk.</span>
          <button className="ide__banner-btn" onClick={() => void reload(tab.path)}>
            Reload
          </button>
          <button className="ide__banner-btn" onClick={() => void save(tab.path)}>
            Keep mine
          </button>
        </div>
      )}
      {tab.error && (
        <div className="ide__banner" data-tone="danger" role="alert">
          <span>{tab.error}</span>
        </div>
      )}
      <CodeEditor text={tab.text} onChange={(text) => edit(tab.path, text)} onSave={() => void save(tab.path)} onCaret={setCaret} />
    </>
  )
}

/** "TypeScript" for `x.ts`: the status bar's language, from the extension alone. */
const LANGUAGE: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript JSX', js: 'JavaScript', jsx: 'JavaScript JSX', mjs: 'JavaScript', cjs: 'JavaScript',
  json: 'JSON', md: 'Markdown', css: 'CSS', scss: 'SCSS', html: 'HTML', py: 'Python', rs: 'Rust', go: 'Go',
  rb: 'Ruby', java: 'Java', kt: 'Kotlin', swift: 'Swift', c: 'C', h: 'C', cpp: 'C++', cs: 'C#', php: 'PHP',
  sh: 'Shell', zsh: 'Shell', yml: 'YAML', yaml: 'YAML', toml: 'TOML', sql: 'SQL', txt: 'Plain text', svg: 'SVG', xml: 'XML'
}

function StatusBar({ tab, root }: { tab: IdeTab; root: string | null }): JSX.Element {
  const caret = useIde((s) => s.caret)
  const ext = tab.path.split('.').pop()?.toLowerCase() ?? ''
  const rel = root && tab.path.startsWith(root) ? tab.path.slice(root.length).replace(/^[\\/]/, '') : tab.path
  return (
    <div className="ide__status">
      <span className="ide__status-path">{rel}</span>
      <div style={{ flex: 1 }} />
      {tab.kind === 'text' && (
        <>
          <span>{isDirty(tab) ? 'Unsaved' : 'Saved'}</span>
          <span>
            Ln {caret.line}, Col {caret.col}
          </span>
        </>
      )}
      <span>{LANGUAGE[ext] ?? (ext ? ext.toUpperCase() : 'Plain text')}</span>
    </div>
  )
}

function Empty({ touched }: { touched: Set<string> }): JSX.Element {
  const openFile = useIde((s) => s.openFile)
  const recent = [...touched].slice(-6).reverse()
  return (
    <div className="ide__empty">
      <p className="ide__empty-title">No file open</p>
      <p className="ide__empty-hint">Pick a file from the tree. Edits save with {navigator.platform.startsWith('Mac') ? '⌘S' : 'Ctrl+S'}.</p>
      {recent.length > 0 && (
        <div className="ide__recent">
          <div className="ide__recent-label">Changed in this chat</div>
          {recent.map((path) => {
            const { name } = splitPath(path)
            return (
              <button key={path} className="ide__row" style={{ '--depth': 0 } as React.CSSProperties} onClick={() => void openFile(path)} title={path}>
                <span className="ide__file-icon">
                  <FileIcon file={name} size={13} />
                </span>
                <span className="ide__name">{name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** The top bar's button for the panel, in an agent chat. */
export function CodeToggle(): JSX.Element | null {
  const { open, setOpen } = useIde(useShallow((s) => ({ open: s.open, setOpen: s.setOpen })))
  if (open) return null
  return (
    <button className="header-btn" onClick={() => setOpen(true)} title="Open the work folder as code">
      <Code2 size={14} strokeWidth={1.9} />
      <span>Code</span>
    </button>
  )
}
