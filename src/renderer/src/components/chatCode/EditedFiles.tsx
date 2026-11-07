import { memo, useMemo, useState, type JSX } from 'react'
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, FileDiff as FileDiffIcon, Folder, FolderOpen, Redo2, TriangleAlert, Undo2 } from 'lucide-react'
import { FileIcon } from '../agent/FileIcon'
import type { FileChange } from '../agent/FilesChanged'
import { useApp } from '../../state/store'
import { useIde } from '../ide/ideStore'
import { useChatCode } from './chatCodeStore'
import { changeCounts, fileTree, foldChanges, relativePath, type FileTreeNode } from './changes/build'
import { DiffStat } from './diff/DiffCard'
import { SnippetDiff } from './diff/SnippetDiff'
import { restoreReply, useTurnChanges } from './turnUndo'

/**
 * What a turn changed, once, at the end of the reply: "3 changed files" and
 * the lines added and removed, then the files as a tree, folders folding.
 * Open diff, and a file's row, open the code panel's Changes pane on this
 * turn (at that file). A chat with no folder has no panel to open, so its
 * rows open their diff in place instead.
 *
 * In a repository the reply's folder was checkpointed before and after it,
 * so Undo puts its files back as they were (and Redo returns them). Files
 * changed since are named first, and only overwritten when confirmed.
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

export const EditedFiles = memo(function EditedFiles({
  messageId,
  changes,
  work,
  undone
}: {
  messageId: string
  changes: FileChange[]
  work: boolean
  undone: boolean
}): JSX.Element | null {
  const root = useIde((s) => s.root)
  const folder = useChatCode((s) => s.folder)
  const checkpoint = useTurnChanges(work ? folder : null, messageId)
  const [restoring, setRestoring] = useState(false)
  // Files changed since the reply, waiting for "Undo anyway"; or why it couldn't.
  const [blocked, setBlocked] = useState<{ conflicts?: string[]; error?: string } | null>(null)
  const files = useMemo(() => {
    const byFile = new Map<string, FileChange[]>()
    for (const change of changes) {
      const path = relativePath(folder ?? root, change.file)
      byFile.set(path, [...(byFile.get(path) ?? []), change])
    }
    // A file's changes count once: written twice, it's one change from how it was to how it ended.
    return [...byFile].map(([path, list]): EditedFile => ({
      path,
      changes: foldChanges(list),
      ...changeCounts(list),
      created: list[0].write === true && list[0].created === true
    }))
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
  const canUndo = Boolean(folder && checkpoint?.available)
  const restore = async (force = false): Promise<void> => {
    if (!folder || restoring) return
    setRestoring(true)
    const result = await restoreReply(folder, messageId, undone ? 'redo' : 'undo', force)
    setRestoring(false)
    setBlocked(result.ok ? null : { conflicts: result.conflicts, error: result.error })
  }

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
    <div className="cfiles" data-undone={undone || undefined}>
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
          {canReview && !undone && (
            <button type="button" className="cfiles__tool cfiles__tool--label" onClick={() => review()} title="Open the full diff">
              <FileDiffIcon size={13} strokeWidth={1.9} />
              <span>Open diff</span>
            </button>
          )}
          {canUndo && (
            <button
              type="button"
              className="cfiles__tool cfiles__tool--label"
              disabled={restoring}
              onClick={() => void restore()}
              title={undone ? 'Put this reply’s changes back' : 'Put these files back as they were before this reply'}
            >
              {undone ? <Redo2 size={13} strokeWidth={1.9} /> : <Undo2 size={13} strokeWidth={1.9} />}
              <span>{undone ? 'Redo' : 'Undo'}</span>
            </button>
          )}
        </span>
      </div>
      {blocked && (
        <div className="cfiles__blocked" role="alert">
          <TriangleAlert size={13} strokeWidth={2} className="cfiles__blocked-icon" />
          {blocked.conflicts?.length ? (
            <>
              <span className="cfiles__blocked-text">
                {blocked.conflicts.length === 1 ? (
                  <>
                    <code>{blocked.conflicts[0]}</code> changed since this reply. {undone ? 'Redo' : 'Undo'} replaces that change too.
                  </>
                ) : (
                  <>
                    {blocked.conflicts.length} files changed since this reply ({blocked.conflicts.slice(0, 3).join(', ')}
                    {blocked.conflicts.length > 3 ? '…' : ''}). {undone ? 'Redo' : 'Undo'} replaces those changes too.
                  </>
                )}
              </span>
              <button type="button" className="cfiles__blocked-btn cfiles__blocked-btn--go" disabled={restoring} onClick={() => void restore(true)}>
                {undone ? 'Redo anyway' : 'Undo anyway'}
              </button>
            </>
          ) : (
            <span className="cfiles__blocked-text">{blocked.error ?? 'That didn’t work.'}</span>
          )}
          <button type="button" className="cfiles__blocked-btn" onClick={() => setBlocked(null)}>
            {blocked.conflicts?.length ? 'Cancel' : 'Dismiss'}
          </button>
        </div>
      )}
      {undone && (
        <div className="cfiles__undone" role="status">
          <Undo2 size={12} strokeWidth={2} />
          <span>Changes undone. The files are back as they were before this reply.</span>
        </div>
      )}
      <div className="cfiles__body">{rows}</div>
    </div>
  )
})
