import { useEffect, useMemo, useState, type CSSProperties, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronRight, ChevronsDownUp, RotateCw, Search, X } from 'lucide-react'
import { useApp } from '../../../state/store'
import { FileIcon, splitPath } from '../../agent/FileIcon'
import { useChatCode } from '../../chatCode/chatCodeStore'
import { useIde } from '../ideStore'
import { joinPath, touchedFiles } from '../paths'

/**
 * The folder the agent works in, as a tree: "Search files" finds any file in
 * it by name, the folders open one at a time, and a file opens in a tab of
 * its own. Files the agent changed in this chat carry a dot. `compact` is
 * the tree beside an open file.
 */
export function FilesView({ compact = false }: { compact?: boolean }): JSX.Element {
  const { root, refresh } = useIde(useShallow((s) => ({ root: s.root, refresh: s.refresh })))
  const touched = useTouched(root)
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()

  return (
    <div className="files-view" data-compact={compact || undefined}>
      <div className="files-view__bar">
        <button type="button" className="files-view__tool" onClick={() => void refresh()} title="Read the folder again" aria-label="Refresh">
          <RotateCw size={14} strokeWidth={1.9} />
        </button>
        <label className="files-view__search">
          <Search size={13} strokeWidth={2} className="files-view__search-icon" aria-hidden />
          <input value={query} placeholder={compact ? 'Search' : 'Search files'} spellCheck={false} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQuery('')} />
          {query && (
            <button type="button" className="files-view__clear" onClick={() => setQuery('')} aria-label="Clear the search">
              <X size={12} strokeWidth={2.2} />
            </button>
          )}
        </label>
        <button
          type="button"
          className="files-view__tool"
          title="Collapse all folders"
          aria-label="Collapse all folders"
          onClick={() => root && useIde.setState({ expanded: new Set([root]) })}
        >
          <ChevronsDownUp size={14} strokeWidth={1.9} />
        </button>
      </div>
      <nav className="files-view__tree scroll" aria-label="Files">
        {!root ? (
          <div className="files-view__empty">Pick a folder for this chat to see its files.</div>
        ) : q ? (
          <Found query={q} root={root} touched={touched} />
        ) : (
          <Folder path={root} depth={0} touched={touched} />
        )}
      </nav>
    </div>
  )
}

/** Paths the agent wrote or edited in the open chat, resolved against the folder. */
function useTouched(root: string | null): Set<string> {
  const paths = useApp(useShallow((s) => touchedFiles(s.activeChat()?.messages ?? [])))
  return useMemo(() => new Set(root ? paths.map((p) => joinPath(root, p)) : []), [paths, root])
}

const openFile = (path: string): void => {
  useIde.getState().openSurface('file', { path })
}

/** Kept out of the tree, as an editor's explorer does. */
const HIDDEN = new Set(['.git', '.DS_Store'])

function Folder({ path, depth, touched }: { path: string; depth: number; touched: Set<string> }): JSX.Element | null {
  const listed = useIde((s) => s.entries.get(path))
  const entries = useMemo(() => listed?.filter((e) => !HIDDEN.has(e.name)), [listed])
  if (!entries) return null
  if (entries.length === 0 && depth === 0) return <div className="files-view__empty">This folder is empty.</div>
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
      <button type="button" className="files-view__row" style={{ '--depth': depth } as CSSProperties} onClick={() => void toggleDir(path)} aria-expanded={open} title={path}>
        <ChevronRight size={14} strokeWidth={2} className="files-view__chev" />
        <span className="files-view__name">{name}</span>
      </button>
      {open && <Folder path={path} depth={depth + 1} touched={touched} />}
    </>
  )
}

function FileRow({ path, name, depth, touched }: { path: string; name: string; depth: number; touched: boolean }): JSX.Element {
  const active = useIde((s) => s.surfaces.find((x) => x.id === s.activeSurface)?.path === path)
  return (
    <button type="button" className="files-view__row" style={{ '--depth': depth } as CSSProperties} data-active={active || undefined} onClick={() => openFile(path)} title={path}>
      <span className="files-view__icon">
        <FileIcon file={name} size={16} />
      </span>
      <span className="files-view__name">{name}</span>
      {touched && <span className="files-view__touched" aria-label="Changed by Eaon" />}
    </button>
  )
}

/** Files anywhere in the folder whose path has the words searched for, closest names first. */
function Found({ query, root, touched }: { query: string; root: string; touched: Set<string> }): JSX.Element {
  const files = useChatCode((s) => s.files)
  useEffect(() => useChatCode.getState().loadFiles(), [])
  const shown = useMemo(() => {
    if (!files) return null
    const hits = files.filter((p) => p.toLowerCase().includes(query))
    const score = (p: string): number => {
      const name = splitPath(p).name.toLowerCase()
      return name === query ? 0 : name.startsWith(query) ? 1 : name.includes(query) ? 2 : 3
    }
    return hits.sort((a, b) => score(a) - score(b) || a.length - b.length).slice(0, 200)
  }, [files, query])
  if (!shown) return <div className="files-view__empty">Looking through the folder…</div>
  if (shown.length === 0) return <div className="files-view__empty">No file matches “{query}”.</div>
  return (
    <>
      {shown.map((rel) => {
        const { name, folder } = splitPath(rel)
        const path = joinPath(root, rel)
        return (
          <button key={rel} type="button" className="files-view__row files-view__row--hit" onClick={() => openFile(path)} title={rel}>
            <span className="files-view__icon">
              <FileIcon file={name} size={16} />
            </span>
            <span className="files-view__name">{name}</span>
            {folder && <span className="files-view__dir">{folder}</span>}
            {touched.has(path) && <span className="files-view__touched" aria-label="Changed by Eaon" />}
          </button>
        )
      })}
    </>
  )
}
