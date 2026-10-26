import { memo, useMemo, type JSX } from 'react'
import { DiffCard } from './DiffCard'
import { countChanges, diffLines, splitLines, toBlocks, type DiffBlock, type DiffFileModel } from './model'

/**
 * Edits drawn without their file: an edit's old and new text, each edit after
 * the last with a break between. Where an edit landed in the file isn't
 * known, so its lines carry no numbers; a written file's are its own.
 */
export const SnippetDiff = memo(function SnippetDiff({ path, changes }: { path: string; changes: { before: string; after: string; write?: boolean }[] }): JSX.Element {
  const model = useMemo<DiffFileModel>(() => {
    const blocks: DiffBlock[] = []
    let added = 0
    let removed = 0
    changes.forEach((change, i) => {
      if (i > 0) blocks.push({ type: 'break' })
      const rows = diffLines(splitLines(change.before), splitLines(change.after))
      // A write's texts are the whole file, so its numbers are the file's own.
      const numbered = change.before === '' || change.write ? rows : rows.map((r) => ({ ...r, old: null, cur: null }))
      // Every line of a snippet is drawn: it is already only what changed and a little around it.
      blocks.push(...toBlocks(numbered).map((b): DiffBlock => (b.type === 'gap' ? { type: 'rows', rows: b.rows ?? [] } : b)))
      const stats = countChanges(change.before, change.after)
      added += stats.added
      removed += stats.removed
    })
    return { key: path, path, status: changes.length === 1 && changes[0].before === '' ? 'added' : 'modified', added, removed, blocks }
  }, [path, changes])
  return <DiffCard file={model} layout="unified" wrap={false} collapsed={false} onToggle={noop} bare />
})

const noop = (): void => undefined
