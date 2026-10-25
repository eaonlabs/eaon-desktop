import { memo, useMemo, useState, type JSX } from 'react'
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, FileDiff as FileDiffIcon, Folder, FolderOpen } from 'lucide-react'
import { FileIcon } from '../agent/FileIcon'
import type { FileChange } from '../agent/FilesChanged'
import { useApp } from '../../state/store'
import { useIde } from '../ide/ideStore'
import { useChatCode } from './chatCodeStore'
import { fileTree, relativePath, type FileTreeNode } from './changes/build'
import { DiffStat } from './diff/DiffCard'
import { countChanges } from './diff/model'
import { SnippetDiff } from './diff/SnippetDiff'

/**
 * What a turn changed, once, at the end of the reply: "3 changed files" and
 * the lines added and removed, then the files as a tree, folders folding.
 * Open diff, and a file's row, open the code panel's Changes pane on this
 * turn (at that file). A chat with no folder has no panel to open, so its
 * rows open their diff in place instead.
 */

interface EditedFile {
  path: string
  changes: FileChange[]
  added: number
  removed: number
  created: boolean
}

/** Folders start open while the tree is this small; a bigger one starts folded. */
const OPEN_UP_TO = 8

/** Which reply of the chat this is, counting from 1: the turn the Changes pane scopes to. */
function turnOf(messageId: string): number | null {
  let turn = 0
  for (const m of useApp.getState().activeChat()?.messages ?? []) {
    if (m.role !== 'assistant') continue
    turn++
    if (m.id === messageId) return turn
  }
  return null
}

export const EditedFiles = memo(function EditedFiles({ messageId, changes, work }: { messageId: string; changes: FileChange[]; work: boolean }): JSX.Element | null {
  const root = useIde((s) => s.root)
  const folder = useChatCode((s) => s.folder)
  const files = useMemo(() => {
    const byFile = new Map<string, EditedFile>()
    for (const change of changes) {
      const path = relativePath(folder ?? root, change.file)
      let entry = byFile.get(path)
      if (!entry) byFile.set(path, (entry = { path, changes: [], added: 0, removed: 0, created: change.before === '' }))
      const stats = countChanges(change.before, change.after)
      entry.changes.push(change)
      entry.added += stats.added
      entry.removed += stats.removed
    }
    return [...byFile.values()]
  }, [changes, folder, root])
  const tree = useMemo(() => fileTree(files), [files])
  const hasFolders = tree.some((n) => !n.file)
  const [allOpen, setAllOpen] = useState(() => files.length <= OPEN_UP_TO)
  // A folder the reader opened or closed by itself, until the next open-all or fold-all.
  const [chosen, setChosen] = useState<Record<string, boolean>>({})
  const [inline, setInline] = useState<string | null>(null)
  const canReview = work && Boolean(folder)

  if (files.length === 0) return null
  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)

  const review = (path?: string): void => {
    const turn = turnOf(messageId)
    useIde.getState().reviewChanges(turn ? { kind: 'turn', turn } : { kind: 'chat' }, path)
  }
  const isOpen = (path: string): boolean => chosen[path] ?? allOpen

  const rows: JSX.Element[] = []
  const walk = (nodes: FileTreeNode<EditedFile>[], depth: number): void => {
    for (const node of nodes) {
      const pad = { paddingLeft: 8 + depth * 14 }
      if (!node.file) {
        const open = isOpen(node.path)
        rows.push(
          <button
            key={`d:${node.path}`}
            type="button"
            className="cfiles__row cfiles__row--dir"
            style={pad}
            aria-expanded={open}
            onClick={() => setChosen((now) => ({ ...now, [node.path]: !open }))}
          >
            <ChevronRight size={14} strokeWidth={2} className="cfiles__chev" />
            {open ? <FolderOpen size={14} strokeWidth={1.8} className="cfiles__icon" /> : <Folder size={14} strokeWidth={1.8} className="cfiles__icon" />}
            <span className="cfiles__name">{node.name}</span>
            <DiffStat added={node.added} removed={node.removed} className="cfiles__stat" />
          </button>
        )
        if (open) walk(node.children, depth + 1)
        continue
      }
      const file = node.file
      rows.push(
        <div key={`f:${node.path}`} className="cfiles__file" data-inline={inline === file.path || undefined}>
          <button
            type="button"
            className="cfiles__row"
            style={pad}
            title={canReview ? `Review ${file.path}` : file.path}
            onClick={() => (canReview ? review(file.path) : setInline(inline === file.path ? null : file.path))}
          >
            {hasFolders && <span className="cfiles__gap" aria-hidden />}
            <span className="cfiles__icon">
              <FileIcon file={node.name} size={14} />
            </span>
            <span className="cfiles__name cfiles__name--file">{node.name}</span>
            {file.created && <span className="cfiles__new">New</span>}
            <DiffStat added={file.added} removed={file.removed} className="cfiles__stat" />
          </button>
          {inline === file.path && (
            <div className="cfiles__diff">
              <SnippetDiff path={file.path} changes={file.changes} />
            </div>
          )}
        </div>
      )
    }
  }
  walk(tree, 0)

  return (
    <div className="cfiles">
      <div className="cfiles__head">
        <span className="cfiles__title">{files.length === 1 ? '1 changed file' : `${files.length} changed files`}</span>
        <DiffStat added={added} removed={removed} className="cfiles__total" />
        <span className="cfiles__tools">
          {hasFolders && (
            <button
              type="button"
              className="cfiles__tool"
              aria-label={allOpen ? 'Collapse all folders' : 'Expand all folders'}
              title={allOpen ? 'Collapse all folders' : 'Expand all folders'}
              onClick={() => {
                setAllOpen(!allOpen)
                setChosen({})
              }}
            >
              {allOpen ? <ChevronsDownUp size={13} strokeWidth={2} /> : <ChevronsUpDown size={13} strokeWidth={2} />}
            </button>
          )}
          {canReview && (
            <button type="button" className="cfiles__tool cfiles__tool--label" onClick={() => review()} title="Open the full diff">
              <FileDiffIcon size={13} strokeWidth={1.9} />
              <span>Open diff</span>
            </button>
          )}
        </span>
      </div>
      <div className="cfiles__body">{rows}</div>
    </div>
  )
})
