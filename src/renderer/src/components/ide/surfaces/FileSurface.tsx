import { useEffect, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronRight, FileWarning, ListTree, WrapText } from 'lucide-react'
import { useApp } from '../../../state/store'
import { notify } from '../../Notice'
import { OpenInButton } from '../../chatCode/CodeTools'
import { languageOf } from '../../chatCode/diff/tokens'
import { CodeEditor } from '../CodeEditor'
import { isDirty, useIde, type IdeTab, type Surface } from '../ideStore'
import { FilesView } from './FilesView'

/**
 * A file in a tab of its own: where it sits in the folder, Open in the
 * editor of choice, wrap long lines, and the folder's tree beside it. The
 * editor saves with ⌘S; a file changed on disk under unsaved edits asks
 * which to keep. A line's number, clicked, puts the line in the message.
 */

const WRAP_KEY = 'eaon.dock.wrap'
const TREE_KEY = 'eaon.dock.tree'
const stored = (key: string, fallback: boolean): boolean => {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}
const keep = (key: string, value: boolean): void => {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    /* this session only */
  }
}

export function FileSurface({ surface }: { surface: Surface }): JSX.Element {
  const path = surface.path ?? ''
  const { root, tab, openFile } = useIde(useShallow((s) => ({ root: s.root, tab: s.tabs.find((t) => t.path === path), openFile: s.openFile })))
  const [wrap, setWrap] = useState(() => stored(WRAP_KEY, true))
  const [tree, setTree] = useState(() => stored(TREE_KEY, true))
  // Opened again after a reload: read the file back.
  useEffect(() => {
    if (!tab && path) void openFile(path)
  }, [tab, path, openFile])

  const rel = root && path.startsWith(root) ? path.slice(root.length).replace(/^[\\/]/, '') : path
  const parts = rel.split(/[\\/]/).filter(Boolean)
  const folder = root ? (root.split(/[\\/]/).filter(Boolean).pop() ?? root) : null

  return (
    <div className="file-surface">
      <div className="file-surface__bar">
        <nav className="file-surface__crumbs" aria-label="Where the file is">
          {folder && <span className="file-surface__crumb">{folder}</span>}
          {parts.map((part, i) => (
            <span key={i} className="file-surface__crumb" data-last={i === parts.length - 1 || undefined}>
              <ChevronRight size={13} strokeWidth={2} className="file-surface__sep" aria-hidden />
              {part}
            </span>
          ))}
          {tab && isDirty(tab) && <span className="file-surface__dirty" title="Not saved yet" aria-label="Not saved yet" />}
        </nav>
        <div className="file-surface__tools">
          <OpenInButton icon file={path} />
          <button
            type="button"
            className="file-surface__tool"
            data-active={wrap || undefined}
            aria-pressed={wrap}
            title={wrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
            aria-label="Wrap long lines"
            onClick={() => {
              setWrap(!wrap)
              keep(WRAP_KEY, !wrap)
            }}
          >
            <WrapText size={15} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            className="file-surface__tool"
            data-active={tree || undefined}
            aria-pressed={tree}
            title={tree ? 'Hide the files' : 'Show the files beside it'}
            aria-label="Files beside the editor"
            onClick={() => {
              setTree(!tree)
              keep(TREE_KEY, !tree)
            }}
          >
            <ListTree size={15} strokeWidth={1.9} />
          </button>
        </div>
      </div>
      <div className="file-surface__body">
        <div className="file-surface__main">{tab ? <TabBody tab={tab} wrap={wrap} rel={rel} /> : <div className="file-surface__loading" />}</div>
        {tree && (
          <aside className="file-surface__tree">
            <FilesView compact />
          </aside>
        )}
      </div>
    </div>
  )
}

/** A line pointed at in the file, as a reference in the message box: the agent reads it as the place meant. */
function addLine(rel: string, line: number): void {
  useApp.getState().appendToComposer({ text: `\`${rel}:${line}\` `, attachments: [] })
  notify(`Added ${rel}:${line} to your message`)
}

function TabBody({ tab, wrap, rel }: { tab: IdeTab; wrap: boolean; rel: string }): JSX.Element {
  const { edit, save, reload, setCaret } = useIde(useShallow((s) => ({ edit: s.edit, save: s.save, reload: s.reload, setCaret: s.setCaret })))
  const reveal = useIde((s) => s.reveal)
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
        lang={languageOf(tab.path)}
        wrap={wrap}
        onChange={(text) => edit(tab.path, text)}
        onSave={() => void save(tab.path)}
        onCaret={setCaret}
        reveal={reveal?.path === tab.path ? reveal : null}
        onLineAction={(line) => addLine(rel, line)}
        lineActionLabel="Add to your message"
      />
    </>
  )
}
