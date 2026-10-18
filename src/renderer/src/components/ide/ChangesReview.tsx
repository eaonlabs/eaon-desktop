import { memo, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { ChevronDown, ChevronUp, Code2, Copy, FolderOpen, GitCompareArrows, ChevronsDownUp, ChevronsUpDown, MoreHorizontal, RotateCw, Search, X } from 'lucide-react'
import { FileDiff, diffStats } from '../agent/FileDiff'
import { FileIcon, splitPath } from '../agent/FileIcon'
import type { FileChange } from '../agent/FilesChanged'
import { MenuItem, Popover, useDisclosure } from '../ui'
import { joinPath } from './paths'

/**
 * The code panel's Changes pane: everything this chat changed, a card per
 * file with its diff, the way a review reads. A toolbar over it steps from
 * file to file, finds a name or a line across the diffs, folds or opens them
 * all, and narrows to one turn's edits. Each card's line numbers are the
 * file's own, found by locating the edit in the file as it is on disk.
 */

interface ReviewFile {
  file: string
  changes: FileChange[]
  added: number
  removed: number
}

export function ChangesReview({
  changes,
  root,
  turnFilter,
  onOpen,
  onRefresh
}: {
  changes: FileChange[]
  root: string | null
  /** The turn picker, when there is more than one turn to pick from. */
  turnFilter?: JSX.Element | false
  onOpen: (file: string) => void
  onRefresh: () => void
}): JSX.Element {
  const files = useMemo(() => {
    const byFile = new Map<string, ReviewFile>()
    for (const change of changes) {
      let entry = byFile.get(change.file)
      if (!entry) byFile.set(change.file, (entry = { file: change.file, changes: [], added: 0, removed: 0 }))
      const stats = diffStats(change.before, change.after)
      entry.changes.push(change)
      entry.added += stats.added
      entry.removed += stats.removed
    }
    return [...byFile.values()]
  }, [changes])

  const [folded, setFolded] = useState<Set<string>>(() => new Set())
  const [finding, setFinding] = useState(false)
  const [query, setQuery] = useState('')
  const [current, setCurrent] = useState(0)
  const cards = useRef(new Map<string, HTMLDivElement>())
  const findInput = useRef<HTMLInputElement>(null)

  const q = query.trim().toLowerCase()
  const shown = useMemo(
    () =>
      q
        ? files.filter((f) => f.file.toLowerCase().includes(q) || f.changes.some((c) => c.after.toLowerCase().includes(q) || c.before.toLowerCase().includes(q)))
        : files,
    [files, q]
  )
  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)
  const allFolded = shown.length > 0 && shown.every((f) => folded.has(f.file))

  useEffect(() => {
    if (finding) findInput.current?.focus()
  }, [finding])

  // Step to a file: scroll its card into view and mark it for a moment.
  const go = (step: 1 | -1): void => {
    if (shown.length === 0) return
    const next = (current + step + shown.length) % shown.length
    setCurrent(next)
    const card = cards.current.get(shown[next].file)
    if (!card) return
    card.scrollIntoView({ block: 'start', behavior: document.body.dataset.reduceMotion === 'on' ? 'auto' : 'smooth' })
    card.dataset.flash = ''
    setTimeout(() => delete card.dataset.flash, 900)
  }

  return (
    <div className="review">
      <div className="review__bar">
        <span className="review__summary" title={`${files.length} files changed in this chat`}>
          <GitCompareArrows size={14} strokeWidth={1.9} />
          <span className="review__count">{files.length}</span>
          <span className="review__unit">{files.length === 1 ? 'file' : 'files'}</span>
          {added > 0 && <span className="diff__stat-add">+{added}</span>}
          {removed > 0 && <span className="diff__stat-del">−{removed}</span>}
        </span>
        <div className="review__tools" role="toolbar" aria-label="Review">
          <button className="review__tool" onClick={onRefresh} title="Refresh" aria-label="Refresh">
            <RotateCw size={13} strokeWidth={1.9} />
          </button>
          <button className="review__tool" onClick={() => go(-1)} disabled={shown.length < 2} title="Previous file" aria-label="Previous file">
            <ChevronUp size={15} strokeWidth={1.9} />
          </button>
          <button className="review__tool" onClick={() => go(1)} disabled={shown.length < 2} title="Next file" aria-label="Next file">
            <ChevronDown size={15} strokeWidth={1.9} />
          </button>
          <button className="review__tool" data-active={finding || undefined} onClick={() => setFinding(!finding)} title="Find in changes" aria-label="Find in changes">
            <Search size={13} strokeWidth={1.9} />
          </button>
          <button
            className="review__tool"
            onClick={() => setFolded(allFolded ? new Set() : new Set(files.map((f) => f.file)))}
            title={allFolded ? 'Open all' : 'Fold all'}
            aria-label={allFolded ? 'Open all' : 'Fold all'}
          >
            {allFolded ? <ChevronsUpDown size={14} strokeWidth={1.9} /> : <ChevronsDownUp size={14} strokeWidth={1.9} />}
          </button>
        </div>
        {turnFilter}
      </div>

      {finding && (
        <div className="review__find">
          <Search size={13} strokeWidth={1.9} />
          <input
            ref={findInput}
            value={query}
            placeholder="Find a file or a line"
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value)
              setCurrent(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('')
                setFinding(false)
              } else if (e.key === 'Enter') go(e.shiftKey ? -1 : 1)
            }}
          />
          {q && (
            <span className="review__found">
              {shown.length} of {files.length}
            </span>
          )}
          <button
            className="review__tool"
            onClick={() => {
              setQuery('')
              setFinding(false)
            }}
            aria-label="Close find"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      )}

      <div className="review__list">
        {shown.map((entry) => (
          <ReviewCard
            key={entry.file}
            entry={entry}
            root={root}
            query={q}
            open={!folded.has(entry.file)}
            onToggle={() =>
              setFolded((now) => {
                const next = new Set(now)
                if (next.has(entry.file)) next.delete(entry.file)
                else next.add(entry.file)
                return next
              })
            }
            onOpen={() => onOpen(entry.file)}
            cardRef={(el) => {
              if (el) cards.current.set(entry.file, el)
              else cards.current.delete(entry.file)
            }}
          />
        ))}
        {shown.length === 0 && <div className="review__none">Nothing matches “{query.trim()}”.</div>}
      </div>
    </div>
  )
}

/** Where an edit starts in the file as it is now: the line its new text begins on. */
function startLine(text: string | null, after: string): number | undefined {
  if (!text || !after) return undefined
  const at = text.indexOf(after)
  if (at < 0) return undefined
  let line = 1
  for (let i = text.indexOf('\n'); i !== -1 && i < at; i = text.indexOf('\n', i + 1)) line++
  return line
}

const ReviewCard = memo(function ReviewCard({
  entry,
  root,
  query,
  open,
  onToggle,
  onOpen,
  cardRef
}: {
  entry: ReviewFile
  root: string | null
  query: string
  open: boolean
  onToggle: () => void
  onOpen: () => void
  cardRef: (el: HTMLDivElement | null) => void
}): JSX.Element {
  const { name, folder } = splitPath(entry.file)
  const abs = root ? joinPath(root, entry.file) : entry.file
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  // The file as it is on disk, to number each edit where it now sits.
  const [disk, setDisk] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    window.api.workspaceFiles
      .read(abs)
      .then((file) => live && setDisk(file.kind === 'text' ? file.text : null))
      .catch(() => live && setDisk(null))
    return () => {
      live = false
    }
  }, [abs, entry.changes])
  const hit = query && entry.changes.some((c) => c.after.toLowerCase().includes(query))

  return (
    <div className="review-card" ref={cardRef} data-open={open || undefined} data-hit={hit || undefined}>
      <div className="review-card__head">
        <button className="review-card__toggle" onClick={onToggle} aria-expanded={open} title={entry.file}>
          <span className="review-card__icon">
            <FileIcon file={name} />
          </span>
          <span className="review-card__name">{name}</span>
          {folder && <span className="review-card__folder">{folder}</span>}
          <span className="review-card__stat">
            <span className="diff__stat-add">+{entry.added}</span>
            <span className="diff__stat-del">−{entry.removed}</span>
          </span>
        </button>
        <button ref={anchor} className="review__tool" data-active={menu.open || undefined} onClick={menu.toggle} aria-label={`More for ${name}`} title="More">
          <MoreHorizontal size={14} strokeWidth={1.9} />
        </button>
        <button className="review__tool review-card__chevron" onClick={onToggle} aria-label={open ? 'Fold' : 'Open'}>
          <ChevronDown size={14} strokeWidth={1.9} />
        </button>
        <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={210}>
          <MenuItem
            icon={<Code2 size={15} strokeWidth={1.8} />}
            title="Open in editor"
            onClick={() => {
              menu.close()
              onOpen()
            }}
          />
          <MenuItem
            icon={<Copy size={15} strokeWidth={1.8} />}
            title="Copy path"
            onClick={() => {
              menu.close()
              void navigator.clipboard.writeText(abs)
            }}
          />
          <MenuItem
            icon={<FolderOpen size={15} strokeWidth={1.8} />}
            title="Show in folder"
            onClick={() => {
              menu.close()
              void window.api.app.showItem(abs)
            }}
          />
        </Popover>
      </div>
      {open && (
        <div className="review-card__body">
          {entry.changes.map((change, index) => (
            <FileDiff key={index} file={change.file} before={change.before} after={change.after} newStart={change.before ? startLine(disk, change.after) : undefined} bare />
          ))}
        </div>
      )}
    </div>
  )
})
