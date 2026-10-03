import { memo, useMemo, useState, type JSX } from 'react'
import { ChevronRight } from 'lucide-react'
import { FileDiff, diffStats } from './FileDiff'
import { FileIcon, splitPath } from './FileIcon'

/**
 * What a turn changed on disk, once, at the end of the reply: one row per
 * file with its line counts, each opening its diff. Each edit also has a card
 * where it happened in the turn; this is the review of all of them together,
 * per file — the way a pull request lists its files rather than its keystrokes.
 */

export interface FileChange {
  file: string
  before: string
  after: string
}

interface ChangedFile {
  file: string
  changes: FileChange[]
  added: number
  removed: number
}

/** Memoised: the line counts run a diff per change, and a finished turn's changes never move. */
export const FilesChanged = memo(function FilesChanged({ changes }: { changes: FileChange[] }): JSX.Element | null {
  const files = useMemo(() => {
    const byFile = new Map<string, ChangedFile>()
    for (const change of changes) {
      let entry = byFile.get(change.file)
      if (!entry) {
        entry = { file: change.file, changes: [], added: 0, removed: 0 }
        byFile.set(change.file, entry)
      }
      const stats = diffStats(change.before, change.after)
      entry.changes.push(change)
      entry.added += stats.added
      entry.removed += stats.removed
    }
    return [...byFile.values()]
  }, [changes])
  const [open, setOpen] = useState<Set<string>>(() => new Set())

  if (files.length === 0) return null
  const allOpen = files.every((f) => open.has(f.file))
  const toggle = (file: string): void =>
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })

  const added = files.reduce((sum, f) => sum + f.added, 0)
  const removed = files.reduce((sum, f) => sum + f.removed, 0)

  return (
    <div className="files-changed">
      <div className="files-changed__head">
        <span className="files-changed__title">{files.length === 1 ? '1 file changed' : `${files.length} files changed`}</span>
        <span className="files-changed__stat">
          {added > 0 && <span className="diff__stat-add">+{added}</span>}
          {removed > 0 && <span className="diff__stat-del">−{removed}</span>}
        </span>
        <button className="files-changed__review" onClick={() => setOpen(allOpen ? new Set() : new Set(files.map((f) => f.file)))}>
          {allOpen ? 'Hide' : 'Review'}
        </button>
      </div>
      {files.map((entry) => {
        const { name, folder } = splitPath(entry.file)
        const isOpen = open.has(entry.file)
        return (
          <div key={entry.file} className="files-changed__file" data-open={isOpen || undefined}>
            <button className="files-changed__row" onClick={() => toggle(entry.file)} title={entry.file} aria-expanded={isOpen}>
              <ChevronRight size={13} strokeWidth={2.2} className="files-changed__chevron" />
              <span className="files-changed__icon">
                <FileIcon file={name} />
              </span>
              <span className="files-changed__name">{name}</span>
              {folder && <span className="files-changed__folder">{folder}</span>}
              <span className="files-changed__stat">
                {entry.added > 0 && <span className="diff__stat-add">+{entry.added}</span>}
                {entry.removed > 0 && <span className="diff__stat-del">−{entry.removed}</span>}
              </span>
            </button>
            {isOpen && (
              <div className="files-changed__diffs">
                {entry.changes.map((change, index) => (
                  <FileDiff key={index} file={change.file} before={change.before} after={change.after} bare />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
})
