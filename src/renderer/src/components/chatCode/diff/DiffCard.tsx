import { Fragment, memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, MessageSquarePlus, UnfoldVertical } from 'lucide-react'
import { FileIcon } from '../../agent/FileIcon'
import type { Token } from '../../agent/highlight'
import { splitPairs, wordMarks, type DiffBlock, type DiffFileModel, type DiffRow, type Span } from './model'
import { languageOf, lineTokens, pieces } from './tokens'

export type { DiffFileModel }

export type DiffLayout = 'unified' | 'split'

/** Lines a fold opens by, from either end. */
const STEP = 20
/** Past this many rows a diff waits to be asked for: drawing it all at once would stall the panel. */
const LARGE = 2500

export interface LineComments {
  /** The line's gutter was clicked: open a comment on it. */
  onPick: (row: DiffRow) => void
  /** What goes under a line: its comment, or the box writing one. */
  render: (row: DiffRow) => ReactNode
}

/** "src/app/" and "page.tsx" from "src/app/page.tsx". */
export function splitFilePath(path: string): { dir: string; name: string } {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? { dir: '', name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) }
}

/** "+12 −3", each count in its colour; nothing when both are zero. */
export function DiffStat({ added, removed, className }: { added: number; removed: number; className?: string }): JSX.Element | null {
  if (added === 0 && removed === 0) return null
  return (
    <span className={`dstat${className ? ` ${className}` : ''}`}>
      <span className="dstat__add">+{added}</span>
      <span className="dstat__del">−{removed}</span>
    </span>
  )
}

/**
 * A file's diff as a card: a header that stays at the top of the panel while
 * its file scrolls past (the file, how much changed, its actions, a fold), and
 * the changed lines with a few lines of context around each, the unchanged
 * runs between them folded to a line that opens in place. A changed line is
 * tinted and barred in the gutter, and inside a line that was edited rather
 * than replaced, the words that changed are marked.
 */
export const DiffCard = memo(function DiffCard({
  file,
  layout,
  wrap,
  collapsed,
  onToggle,
  actions,
  comments,
  cardRef,
  bare = false
}: {
  file: DiffFileModel
  layout: DiffLayout
  wrap: boolean
  collapsed: boolean
  onToggle: () => void
  actions?: ReactNode
  comments?: LineComments
  cardRef?: (el: HTMLDivElement | null) => void
  /** Only the lines: the file is already named around it. */
  bare?: boolean
}): JSX.Element {
  if (bare) {
    return (
      <div className="dv" data-bare ref={cardRef} data-path={file.path}>
        <DiffBody file={file} layout={layout} wrap={wrap} comments={comments} />
      </div>
    )
  }
  const { dir, name } = splitFilePath(file.path)
  const renamedFrom = file.oldPath && file.oldPath !== file.path ? splitFilePath(file.oldPath).name : null
  return (
    <div className="dv" ref={cardRef} data-collapsed={collapsed || undefined} data-path={file.path}>
      <div
        className="dv__head"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        title={file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
      >
        <span className="dv__icon">
          <FileIcon file={name} size={14} />
        </span>
        <span className="dv__title">
          {renamedFrom && (
            <>
              <span className="dv__was">{renamedFrom}</span>
              <span className="dv__arrow" aria-hidden>
                →
              </span>
            </>
          )}
          <span className="dv__name" data-status={file.status}>
            {name}
          </span>
          {dir && <span className="dv__dir">{dir}</span>}
        </span>
        {file.status === 'added' && <span className="dv__tag">New</span>}
        {file.status === 'deleted' && <span className="dv__tag" data-tone="del">Deleted</span>}
        <DiffStat added={file.added} removed={file.removed} className="dv__stat" />
        {actions && (
          <span className="dv__actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            {actions}
          </span>
        )}
        <ChevronDown size={14} strokeWidth={2} className="dv__chev" aria-hidden />
      </div>
      {!collapsed && <DiffBody file={file} layout={layout} wrap={wrap} comments={comments} />}
    </div>
  )
})

function DiffBody({ file, layout, wrap, comments }: { file: DiffFileModel; layout: DiffLayout; wrap: boolean; comments?: LineComments }): JSX.Element {
  const total = useMemo(() => file.blocks.reduce((n, b) => n + (b.type === 'rows' ? b.rows.length : 0), 0), [file.blocks])
  const [forced, setForced] = useState(false)
  if (file.binary) return <div className="dv__note">A binary file: nothing to show line by line.</div>
  if (file.blocks.length === 0) return <div className="dv__note">{file.status === 'added' ? 'An empty file.' : 'No changes to show.'}</div>
  if (total > LARGE && !forced) {
    return (
      <div className="dv__note">
        A large diff: {total.toLocaleString()} lines.
        <button type="button" className="dv__load" onClick={() => setForced(true)}>
          Show it
        </button>
      </div>
    )
  }
  return <DiffLines file={file} layout={layout} wrap={wrap} comments={comments} />
}

interface Reveal {
  /** Lines opened at the top of the fold, under the change above it. */
  head: number
  /** Lines opened at its bottom, over the change below it. */
  tail: number
}

/** A gap's rows as drawn now: the opened ends, and what is still folded between them. */
function opened(block: Extract<DiffBlock, { type: 'gap' }>, reveal: Reveal | undefined): { head: DiffRow[]; hidden: number; tail: DiffRow[] } {
  if (!block.rows) return { head: [], hidden: block.count, tail: [] }
  const head = Math.min(block.count, reveal?.head ?? 0)
  const tail = Math.min(block.count - head, reveal?.tail ?? 0)
  return { head: block.rows.slice(0, head), hidden: block.count - head - tail, tail: block.rows.slice(block.count - tail) }
}

function DiffLines({ file, layout, wrap, comments }: { file: DiffFileModel; layout: DiffLayout; wrap: boolean; comments?: LineComments }): JSX.Element {
  const [reveals, setReveals] = useState<Record<number, Reveal>>({})
  const lang = languageOf(file.path)
  const body = useRef<HTMLDivElement>(null)

  // Every row the card can show, for colouring the file as one text and for its widest line number.
  const { tokens, marks, digits } = useMemo(() => {
    const all: DiffRow[] = []
    for (const block of file.blocks) {
      if (block.type === 'rows') all.push(...block.rows)
      else if (block.type === 'gap' && block.rows) all.push(...block.rows)
    }
    const newSide = all.filter((r) => r.kind !== 'del')
    const oldSide = all.filter((r) => r.kind === 'del')
    const map = new Map<DiffRow, Token[]>()
    const newTokens = lineTokens(newSide.map((r) => r.text), lang)
    newSide.forEach((r, i) => map.set(r, newTokens[i]))
    const oldTokens = lineTokens(oldSide.map((r) => r.text), lang)
    oldSide.forEach((r, i) => map.set(r, oldTokens[i]))
    const marks = new Map<DiffRow, Span[]>()
    for (const block of file.blocks) if (block.type === 'rows') for (const [row, spans] of wordMarks(block.rows)) marks.set(row, spans)
    let widest = 1
    for (const r of all) widest = Math.max(widest, r.old ?? 0, r.cur ?? 0)
    for (const block of file.blocks) if (block.type === 'gap') widest = Math.max(widest, block.cur + block.count, block.old + block.count)
    return { tokens: map, marks, digits: String(widest).length }
  }, [file.blocks, lang])

  // Notes under a line span the visible width, not the widest line's.
  useLayoutEffect(() => {
    const el = body.current
    if (!el || layout !== 'unified' || wrap) return
    const set = (): void => el.style.setProperty('--dv-view', `${el.clientWidth}px`)
    set()
    const observer = new ResizeObserver(set)
    observer.observe(el)
    return () => observer.disconnect()
  }, [layout, wrap])

  const open = (index: number, change: (r: Reveal) => Reveal): void =>
    setReveals((now) => ({ ...now, [index]: change(now[index] ?? { head: 0, tail: 0 }) }))

  const line = useCallback((row: DiffRow): JSX.Element => <Code tokens={tokens.get(row)} text={row.text} marks={marks.get(row)} />, [tokens, marks])
  const lastIndex = file.blocks.length - 1

  const content: ReactNode[] = []
  file.blocks.forEach((block, index) => {
    if (block.type === 'break') {
      content.push(<div key={`b${index}`} className="dv__break" aria-hidden />)
      return
    }
    if (block.type === 'rows') {
      content.push(<RowRun key={`r${index}`} rows={block.rows} layout={layout} line={line} comments={comments} />)
      return
    }
    const { head, hidden, tail } = opened(block, reveals[index])
    if (head.length) content.push(<RowRun key={`h${index}`} rows={head} layout={layout} line={line} comments={comments} />)
    if (hidden > 0) {
      const atTop = index === 0
      const atEnd = index === lastIndex
      content.push(
        <Fold
          key={`g${index}`}
          count={hidden}
          canOpen={block.rows !== null}
          up={!atEnd}
          down={!atTop}
          onUp={() => open(index, (r) => ({ ...r, tail: r.tail + STEP }))}
          onDown={() => open(index, (r) => ({ ...r, head: r.head + STEP }))}
          onAll={() => open(index, () => ({ head: block.count, tail: 0 }))}
        />
      )
    }
    if (tail.length) content.push(<RowRun key={`t${index}`} rows={tail} layout={layout} line={line} comments={comments} />)
  })

  return (
    <div
      ref={body}
      className="dv__body"
      data-layout={layout}
      data-wrap={wrap || layout === 'split' || undefined}
      data-comments={comments ? '' : undefined}
      style={{ '--dv-digits': digits } as CSSProperties}
    >
      <div className="dv__lines">{content}</div>
    </div>
  )
}

/** A run of rows, one column or side by side, with any comment under its line. */
const RowRun = memo(function RowRun({
  rows,
  layout,
  line,
  comments
}: {
  rows: DiffRow[]
  layout: DiffLayout
  line: (row: DiffRow) => JSX.Element
  comments?: LineComments
}): JSX.Element {
  if (layout === 'split') {
    return (
      <>
        {splitPairs(rows).map((pair, i) => {
          const notes = [pair.left, pair.right !== pair.left ? pair.right : null].map((r) => (r && comments ? comments.render(r) : null))
          return (
            <Fragment key={i}>
              <div className="dv__pair">
                <Half row={pair.left} side="old" line={line} comments={comments} />
                <Half row={pair.right} side="new" line={line} comments={comments} />
              </div>
              {notes.map((note, k) => note && <div key={k} className="dv__comment">{note}</div>)}
            </Fragment>
          )
        })}
      </>
    )
  }
  return (
    <>
      {rows.map((row, i) => {
        const note = comments?.render(row)
        const startsChange = row.kind !== 'ctx' && (i === 0 || rows[i - 1].kind === 'ctx')
        return (
          <Fragment key={i}>
            <div className="dv__row" data-kind={row.kind} data-change={startsChange || undefined}>
              <Num row={row} n={row.kind === 'del' ? row.old : row.cur} comments={comments} />
              {line(row)}
            </div>
            {note && <div className="dv__comment">{note}</div>}
          </Fragment>
        )
      })}
    </>
  )
})

function Half({ row, side, line, comments }: { row: DiffRow | null; side: 'old' | 'new'; line: (row: DiffRow) => JSX.Element; comments?: LineComments }): JSX.Element {
  if (!row) return <div className="dv__half" data-empty />
  const kind = row.kind === 'ctx' ? 'ctx' : side === 'old' ? 'del' : 'add'
  return (
    <div className="dv__half" data-kind={kind}>
      <Num row={row} n={side === 'old' ? row.old : row.cur} comments={comments} />
      {line(row)}
    </div>
  )
}

function Num({ row, n, comments }: { row: DiffRow; n: number | null; comments?: LineComments }): JSX.Element {
  if (!comments || n === null) return <span className="dv__num">{n ?? ''}</span>
  return (
    <button type="button" className="dv__num" title="Comment on this line" onClick={() => comments.onPick(row)}>
      <span className="dv__n">{n}</span>
      <MessageSquarePlus size={12} strokeWidth={2.1} className="dv__plus" aria-hidden />
    </button>
  )
}

/** One line of code, coloured, with its changed words marked. Memoised: a long diff redraws as a whole when it opens. */
const Code = memo(function Code({ tokens, text, marks }: { tokens: Token[] | undefined; text: string; marks: Span[] | undefined }): JSX.Element {
  const parts = pieces(tokens ?? [{ text, kind: null }], marks)
  return (
    <span className="dv__code">
      {parts.length === 0
        ? '​'
        : parts.map((p, i) =>
            p.kind || p.em ? (
              <span key={i} className={`${p.kind ? `tok-${p.kind}` : ''}${p.em ? ' dv__em' : ''}`}>
                {p.text}
              </span>
            ) : (
              <Fragment key={i}>{p.text}</Fragment>
            )
          )}
    </span>
  )
})

/** Folded unchanged lines: "24 unmodified lines", opening a step at a time from either end, or all at once. */
function Fold({
  count,
  canOpen,
  up,
  down,
  onUp,
  onDown,
  onAll
}: {
  count: number
  canOpen: boolean
  up: boolean
  down: boolean
  onUp: () => void
  onDown: () => void
  onAll: () => void
}): JSX.Element {
  const label = `${count.toLocaleString()} unmodified ${count === 1 ? 'line' : 'lines'}`
  if (!canOpen) {
    return (
      <div className="dv__fold">
        <span className="dv__fold-label">{label}</span>
      </div>
    )
  }
  const small = count <= STEP
  return (
    <div className="dv__fold">
      <span className="dv__fold-btns">
        {small ? (
          <button type="button" className="dv__fold-btn" onClick={onAll} aria-label="Show these lines" title="Show these lines">
            <UnfoldVertical size={13} strokeWidth={2} />
          </button>
        ) : (
          <>
            {down && (
              <button type="button" className="dv__fold-btn" onClick={onDown} aria-label={`Show ${STEP} more lines below`} title={`Show ${STEP} more below`}>
                <ChevronDown size={13} strokeWidth={2} />
              </button>
            )}
            {up && (
              <button type="button" className="dv__fold-btn" onClick={onUp} aria-label={`Show ${STEP} more lines above`} title={`Show ${STEP} more above`}>
                <ChevronUp size={13} strokeWidth={2} />
              </button>
            )}
          </>
        )}
      </span>
      <button type="button" className="dv__fold-label" onClick={onAll} title="Show all of them">
        {label}
      </button>
    </div>
  )
}
