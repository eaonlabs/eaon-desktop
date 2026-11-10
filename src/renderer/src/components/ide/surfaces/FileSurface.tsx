import { useEffect, useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronRight, FileWarning, GitBranch, PanelLeft, WrapText } from 'lucide-react'
import { OpenInButton } from '../../chatCode/CodeTools'
import { languageOf } from '../../chatCode/diff/tokens'
import { FileIcon } from '../../agent/FileIcon'
import { CodeEditor, type EditorCaret, type EditorSelection } from '../CodeEditor'
import { useDockPlace } from '../dockPlace'
import { editRequest, indentOf, languageName, lineRef, selectionSnippet } from '../editorMeta'
import { gutterMarks } from '../gitGutter'
import { isDirty, type IdeTab, type Surface } from '../ideStore'
import { FilesView } from './FilesView'
import { BlameItem, FileHistoryButton } from './FileHistory'

/**
 * A file in a tab of its own, laid out as an editor: the project's files on
 * the left (hidden with the panel button), then where the file sits, the
 * editor, and a status bar with the caret, the language, the indent, the
 * line ending and the branch. The editor saves with ⌘S; a file changed on
 * disk under unsaved edits asks which to keep. Lines changed since the last
 * commit are marked in the gutter. The agent is a keystroke away: ⌘L adds
 * the selection to what the user is writing, ⌘K asks for a change to it,
 * and a line's number, clicked, puts the line there. In a repository, History
 * lists the file's commits and the status bar names who last changed the
 * caret's line (FileHistory.tsx).
 */

const WRAP_KEY = 'eaon.dock.wrap'
const TREE_KEY = 'eaon.dock.tree'
const TREE_WIDTH_KEY = 'eaon.dock.treeWidth'
const stored = (key: string, fallback: boolean): boolean => {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}
const keep = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* this session only */
  }
}
const storedWidth = (): number => {
  try {
    const n = Number(localStorage.getItem(TREE_WIDTH_KEY))
    return n >= 140 && n <= 480 ? n : 220
  } catch {
    return 220
  }
}

export function FileSurface({ surface }: { surface: Surface }): JSX.Element {
  const path = surface.path ?? ''
  const place = useDockPlace()
  const { root, tab, openFile } = place.store(useShallow((s) => ({ root: s.root, tab: s.tabs.find((t) => t.path === path), openFile: s.openFile })))
  const [wrap, setWrap] = useState(() => stored(WRAP_KEY, false))
  const [tree, setTree] = useState(() => stored(TREE_KEY, true))
  const [treeWidth, setTreeWidth] = useState(storedWidth)
  const [caret, setCaret] = useState<EditorCaret>({ line: 1, col: 1 })
  // Opened again after a reload: read the file back.
  useEffect(() => {
    if (!tab && path) void openFile(path)
  }, [tab, path, openFile])
  // The project panel opens to the file in front, as editors do.
  useEffect(() => {
    if (!root || !path.startsWith(root)) return
    const { expanded, toggleDir } = place.store.getState()
    const dirs: string[] = []
    for (let at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')); at > root.length; at = Math.max(path.lastIndexOf('/', at - 1), path.lastIndexOf('\\', at - 1)))
      dirs.unshift(path.slice(0, at))
    void (async () => {
      for (const dir of dirs) if (!expanded.has(dir)) await toggleDir(dir)
    })()
  }, [root, path, place.store])

  const rel = root && path.startsWith(root) ? path.slice(root.length).replace(/^[\\/]/, '') : path
  const parts = rel.split(/[\\/]/).filter(Boolean)

  // The project panel's edge drags to resize it.
  const dragging = useRef<{ x: number; width: number } | null>(null)
  const onResizeDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    dragging.current = { x: event.clientX, width: treeWidth }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    setTreeWidth(Math.min(480, Math.max(140, dragging.current.width + event.clientX - dragging.current.x)))
  }
  const onResizeUp = (): void => {
    if (!dragging.current) return
    dragging.current = null
    keep(TREE_WIDTH_KEY, String(Math.round(treeWidth)))
  }

  return (
    <div className="file-surface" data-tree={tree || undefined}>
      {tree && (
        <aside className="file-surface__tree" style={{ width: treeWidth }} aria-label="Project">
          <FilesView compact />
          <div
            className="file-surface__resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the files"
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeUp}
          />
        </aside>
      )}
      <div className="file-surface__main">
        <div className="file-surface__bar">
          <button
            type="button"
            className="file-surface__tool"
            data-active={tree || undefined}
            aria-pressed={tree}
            title={tree ? 'Hide the files' : 'Show the files'}
            aria-label="Files"
            onClick={() => {
              setTree(!tree)
              keep(TREE_KEY, !tree ? '1' : '0')
            }}
          >
            <PanelLeft size={15} strokeWidth={1.8} />
          </button>
          <nav className="file-surface__crumbs" aria-label="Where the file is">
            {parts.map((part, i) => (
              <span key={i} className="file-surface__crumb" data-last={i === parts.length - 1 || undefined}>
                {i > 0 && <ChevronRight size={12} strokeWidth={2} className="file-surface__sep" aria-hidden />}
                {i === parts.length - 1 && (
                  <span className="file-surface__crumb-icon" aria-hidden>
                    <FileIcon file={part} size={14} />
                  </span>
                )}
                {part}
              </span>
            ))}
            {tab && isDirty(tab) && <span className="file-surface__dirty" title="Not saved yet (⌘S saves)" aria-label="Not saved yet" />}
          </nav>
          <div className="file-surface__tools">
            <button
              type="button"
              className="file-surface__tool"
              data-active={wrap || undefined}
              aria-pressed={wrap}
              title={wrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
              aria-label="Wrap long lines"
              onClick={() => {
                setWrap(!wrap)
                keep(WRAP_KEY, !wrap ? '1' : '0')
              }}
            >
              <WrapText size={15} strokeWidth={1.8} />
            </button>
            <FileHistoryButton path={path} rel={rel} />
            <OpenInButton icon file={path} folder={place.folder} />
          </div>
        </div>
        <div className="file-surface__body">{tab ? <TabBody tab={tab} wrap={wrap} rel={rel} onCaret={setCaret} /> : <div className="file-surface__loading" />}</div>
        {tab?.kind === 'text' && <StatusBar tab={tab} caret={caret} rel={rel} />}
      </div>
    </div>
  )
}

/** The file as the last commit has it, read when it opens and again each time it is saved or changes on disk. */
function useCommitted(tab: IdeTab): string | null {
  const { folder, status } = useDockPlace()
  const [base, setBase] = useState<string | null>(null)
  const repo = Boolean(status?.repo)
  useEffect(() => {
    if (!folder || !repo || tab.kind !== 'text') return setBase(null)
    let live = true
    void window.api.chatCode
      .textAtHead(folder, tab.path)
      .then((text) => live && setBase(text === null ? null : text.replace(/\r\n/g, '\n')))
      .catch(() => live && setBase(null))
    return () => {
      live = false
    }
    // A commit moves HEAD: git's status changes, and the committed text is read again.
  }, [folder, repo, tab.path, tab.kind, tab.modified, status?.changes?.files, status?.ahead])
  return base
}

function TabBody({ tab, wrap, rel, onCaret }: { tab: IdeTab; wrap: boolean; rel: string; onCaret: (caret: EditorCaret) => void }): JSX.Element {
  const place = useDockPlace()
  const { edit, save, reload, setCaret } = place.store(useShallow((s) => ({ edit: s.edit, save: s.save, reload: s.reload, setCaret: s.setCaret })))
  const reveal = place.store((s) => s.reveal)
  const committed = useCommitted(tab)
  const marks = useMemo(() => (tab.kind === 'text' ? gutterMarks(committed, tab.text) : undefined), [committed, tab.kind, tab.text])
  const lang = languageOf(tab.path)
  // A line pointed at in the file, as a reference where the agent reads it as the place meant.
  const addLine = (line: number): void => place.addToPrompt(`\`${rel}:${line}\` `, `${rel}:${line}`)
  const addSelection = (sel: EditorSelection): void =>
    place.addToPrompt(selectionSnippet(rel, sel.fromLine, sel.toLine, sel.text, lang), lineRef(rel, sel.fromLine, sel.toLine))
  const askEdit = (instruction: string, sel: EditorSelection): void => {
    // Unsaved edits first: the agent works on the file on disk.
    if (isDirty(tab)) void save(tab.path)
    place.askAgent(editRequest(rel, sel.fromLine, sel.toLine, sel.text, lang, instruction))
  }
  if (tab.kind !== 'text') {
    const message =
      tab.kind === 'binary' ? 'This file isn’t text, so it can’t be edited here.' : tab.kind === 'too-large' ? 'This file is too large to edit here.' : (tab.error ?? 'This file couldn’t be opened.')
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
      <CodeEditor
        text={tab.text}
        lang={lang}
        wrap={wrap}
        marks={marks}
        onChange={(text) => edit(tab.path, text)}
        onSave={() => void save(tab.path)}
        onCaret={(caret) => {
          setCaret({ line: caret.line, col: caret.col })
          onCaret(caret)
        }}
        reveal={reveal?.path === tab.path ? reveal : null}
        onLineAction={addLine}
        lineActionLabel={place.id === 'chat' ? 'Add to your message' : 'Add to the agent’s prompt'}
        onAddToChat={addSelection}
        onAskEdit={askEdit}
        askLabel={place.id === 'chat' ? 'the chat' : 'the agent'}
      />
    </>
  )
}

/** Under the editor: where the caret is and what is selected, then the language, the indent, the line ending and the branch. */
function StatusBar({ tab, caret, rel }: { tab: IdeTab; caret: EditorCaret; rel: string }): JSX.Element {
  const { status } = useDockPlace()
  const indent = useMemo(() => indentOf(tab.saved), [tab.saved])
  const branch = status?.branch ?? status?.detached ?? null
  return (
    <div className="file-status" role="status">
      <span className="file-status__item">
        Ln {caret.line}, Col {caret.col}
        {caret.selected ? (
          <span className="file-status__dim">
            {' '}
            ({caret.selected} selected{caret.selectedLines && caret.selectedLines > 1 ? `, ${caret.selectedLines} lines` : ''})
          </span>
        ) : null}
      </span>
      <BlameItem path={tab.path} rel={rel} line={caret.line} ready={!isDirty(tab)} version={tab.modified} />
      <span className="file-status__spacer" />
      {indent && <span className="file-status__item">{indent}</span>}
      <span className="file-status__item">{(tab.eol ?? '\n') === '\r\n' ? 'CRLF' : 'LF'}</span>
      <span className="file-status__item">{languageName(languageOf(tab.path))}</span>
      {branch && (
        <span className="file-status__item" title="Branch">
          <GitBranch size={12} strokeWidth={2} />
          {branch}
        </span>
      )}
    </div>
  )
}
