import { memo, useMemo, useState, type JSX } from 'react'
import { Atom, Braces, CodeXml, File, FileText, Hash, Image } from 'lucide-react'
import { FileDiff, diffStats } from './FileDiff'

/**
 * What a turn changed on disk, once, at the end of the reply: one row per
 * file with its line counts, each opening its diff. The edits themselves are
 * folded into the turn's activity line, so this is where a reader reviews
 * them — the way a pull request lists its files rather than its keystrokes.
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

const TEXT_BADGE: Record<string, string> = { ts: 'TS', mts: 'TS', cts: 'TS', js: 'JS', mjs: 'JS', cjs: 'JS', py: 'PY', go: 'GO', rs: 'RS', rb: 'RB' }

/** A small mark for the file's type, like an editor's tab icon. */
function FileGlyph({ file }: { file: string }): JSX.Element {
  const ext = file.split('.').pop()?.toLowerCase() ?? ''
  const badge = TEXT_BADGE[ext]
  if (badge) return <span className="files-changed__badge" data-ext={badge}>{badge}</span>
  const props = { size: 15, strokeWidth: 1.8, className: 'files-changed__glyph' }
  if (ext === 'tsx' || ext === 'jsx') return <Atom {...props} data-ext="react" />
  if (ext === 'css' || ext === 'scss' || ext === 'less') return <Hash {...props} data-ext="css" />
  if (ext === 'json' || ext === 'yml' || ext === 'yaml' || ext === 'toml') return <Braces {...props} data-ext="data" />
  if (ext === 'html' || ext === 'xml' || ext === 'svg' || ext === 'vue') return <CodeXml {...props} data-ext="markup" />
  if (ext === 'md' || ext === 'mdx' || ext === 'txt') return <FileText {...props} />
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return <Image {...props} />
  return <File {...props} />
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

  return (
    <div className="files-changed">
      <div className="files-changed__head">
        <span>{files.length === 1 ? '1 file changed' : `${files.length} files changed`}</span>
        <button className="files-changed__review" onClick={() => setOpen(allOpen ? new Set() : new Set(files.map((f) => f.file)))}>
          {allOpen ? 'Hide' : 'Review'}
        </button>
      </div>
      {files.map((entry) => {
        const slash = Math.max(entry.file.lastIndexOf('/'), entry.file.lastIndexOf('\\'))
        const name = entry.file.slice(slash + 1)
        const folder = slash > 0 ? entry.file.slice(0, slash) : ''
        const isOpen = open.has(entry.file)
        return (
          <div key={entry.file} className="files-changed__file" data-open={isOpen || undefined}>
            <button className="files-changed__row" onClick={() => toggle(entry.file)} title={entry.file} aria-expanded={isOpen}>
              <span className="files-changed__icon">
                <FileGlyph file={name} />
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
                  <FileDiff key={index} file={change.file} before={change.before} after={change.after} />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
})
