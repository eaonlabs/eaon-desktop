import { createContext, useContext, useEffect, useMemo, useState, type CSSProperties, type JSX } from 'react'
import type { FileGitState } from '@shared/chatCode'
import { useShallow } from 'zustand/react/shallow'
import { ChevronRight, ChevronsDownUp, RotateCw, Search, X } from 'lucide-react'
import { useApp } from '../../../state/store'
import { FileIcon, splitPath } from '../../agent/FileIcon'
import { useDockPlace } from '../dockPlace'
import { joinPath, touchedFiles } from '../paths'

/**
 * The folder the agent works in, as a tree: "Search files" finds any file in
 * it by name, the folders open one at a time, and a file opens in a tab of
 * its own. In Chat, files the agent changed in this chat carry a dot.
 * Files git sees as changed, new or untracked are coloured with a letter,
 * and so are the folders they are in. `compact` is the tree beside an open
 * file, the editor's project panel.
 */
export function FilesView({ compact = false }: { compact?: boolean }): JSX.Element {
  const place = useDockPlace()
  const { root, refresh } = place.store(useShallow((s) => ({ root: s.root, refresh: s.refresh })))
  const touched = useTouched(root, place.id === 'chat')
  const git = useGitStates()
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()

  return (
    <GitStates.Provider value={git}>
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
          onClick={() => root && place.store.setState({ expanded: new Set([root]) })}
        >
          <ChevronsDownUp size={14} strokeWidth={1.9} />
        </button>
      </div>
      <nav className="files-view__tree scroll" aria-label="Files">
        {!root ? (
          <div className="files-view__empty">{place.missing ? `${place.missing}.` : 'Reading the folder…'}</div>
        ) : q ? (
          <Found query={q} root={root} touched={touched} />
        ) : (
          <Folder path={root} depth={0} touched={touched} />
        )}
      </nav>
    </div>
    </GitStates.Provider>
  )
}

/** What git says of the folder's files, and of the folders they are in. */
interface GitMarks {
  files: Map<string, FileGitState>
  dirs: Set<string>
}
const NO_MARKS: GitMarks = { files: new Map(), dirs: new Set() }
const GitStates = createContext<GitMarks>(NO_MARKS)

/** The letter beside a file, as editors show it. */
const GIT_LETTER: Record<FileGitState, string> = { modified: 'M', added: 'A', untracked: 'U', deleted: 'D', conflict: '!' }
const GIT_TITLE: Record<FileGitState, string> = {
  modified: 'Changed since the last commit',
  added: 'New, added to the next commit',
  untracked: 'New, not tracked by git yet',
  deleted: 'Deleted',
  conflict: 'In conflict'
}

/** Read again whenever the tree is (the agent changed something, the window came back), and when git's status moves. */
function useGitStates(): GitMarks {
  const place = useDockPlace()
  const listed = place.store((s) => s.entries)
  const [marks, setMarks] = useState<GitMarks>(NO_MARKS)
  const { folder, status } = place
  const repo = Boolean(status?.repo)
  useEffect(() => {
    if (!folder || !repo) return setMarks(NO_MARKS)
    let live = true
    void window.api.chatCode
      .fileStates(folder)
      .then((states) => {
        if (!live) return
        const files = new Map(Object.entries(states))
        const dirs = new Set<string>()
        // Each changed file's folders, up to the top (either separator: git's paths are joined the system's way).
        const cut = (path: string, from: number): number => Math.max(path.lastIndexOf('/', from), path.lastIndexOf('\\', from))
        for (const path of files.keys()) {
          for (let at = cut(path, path.length); at > 0; at = cut(path, at - 1)) {
            const dir = path.slice(0, at)
            if (dirs.has(dir)) break
            dirs.add(dir)
          }
        }
        setMarks({ files, dirs })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [folder, repo, status, listed])
  return marks
}

const NONE: string[] = []

/** Paths the agent wrote or edited in the open chat, resolved against the folder; none outside Chat. */
function useTouched(root: string | null, chat: boolean): Set<string> {
  const paths = useApp(useShallow((s) => (chat ? touchedFiles(s.activeChat()?.messages ?? []) : NONE)))
  return useMemo(() => new Set(root ? paths.map((p) => joinPath(root, p)) : []), [paths, root])
}

/** Opens a file in a tab of its own in this dock. */
function useOpenFile(): (path: string) => void {
  const { store } = useDockPlace()
  return (path) => void store.getState().openSurface('file', { path })
}

/** Kept out of the tree, as an editor's explorer does. */
const HIDDEN = new Set(['.git', '.DS_Store'])

function Folder({ path, depth, touched }: { path: string; depth: number; touched: Set<string> }): JSX.Element | null {
  const listed = useDockPlace().store((s) => s.entries.get(path))
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
  const { store } = useDockPlace()
  const open = store((s) => s.expanded.has(path))
  const toggleDir = store((s) => s.toggleDir)
  const changed = useContext(GitStates).dirs.has(path)
  return (
    <>
      <button
        type="button"
        className="files-view__row"
        style={{ '--depth': depth } as CSSProperties}
        onClick={() => void toggleDir(path)}
        aria-expanded={open}
        title={path}
        data-git={changed ? 'modified' : undefined}
      >
        <ChevronRight size={14} strokeWidth={2} className="files-view__chev" />
        <span className="files-view__name">{name}</span>
      </button>
      {open && <Folder path={path} depth={depth + 1} touched={touched} />}
    </>
  )
}

function FileRow({ path, name, depth, touched }: { path: string; name: string; depth: number; touched: boolean }): JSX.Element {
  const active = useDockPlace().store((s) => s.surfaces.find((x) => x.id === s.activeSurface)?.path === path)
  const openFile = useOpenFile()
  const git = useContext(GitStates).files.get(path)
  return (
    <button
      type="button"
      className="files-view__row"
      style={{ '--depth': depth } as CSSProperties}
      data-active={active || undefined}
      data-git={git}
      onClick={() => openFile(path)}
      title={git ? `${path}\n${GIT_TITLE[git]}` : path}
    >
      <span className="files-view__icon">
        <FileIcon file={name} size={16} />
      </span>
      <span className="files-view__name">{name}</span>
      {touched && <span className="files-view__touched" aria-label="Changed by Eaon" />}
      {git && (
        <span className="files-view__git" aria-label={GIT_TITLE[git]}>
          {GIT_LETTER[git]}
        </span>
      )}
    </button>
  )
}

/** Files anywhere in the folder whose path has the words searched for, closest names first. */
function Found({ query, root, touched }: { query: string; root: string; touched: Set<string> }): JSX.Element {
  const { files, loadFiles } = useDockPlace()
  const openFile = useOpenFile()
  useEffect(() => loadFiles(), [loadFiles])
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
