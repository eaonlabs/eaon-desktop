import { memo, useLayoutEffect, useMemo, useRef, type JSX, type KeyboardEvent } from 'react'
import type { Token } from '../agent/highlight'
import { lineTokens } from '../chatCode/diff/tokens'

/**
 * A plain editor: the file's lines, coloured, under a transparent textarea
 * that takes the typing. The textarea is sized to the text, so the panel
 * scrolls one box and the colours never drift from the caret. Colouring is
 * the diffs' own, by the file's language, as one text so a comment or a
 * string across lines is coloured on each; past a few thousand lines it stops
 * colouring and stays fast. Wrapped (`wrap`), each line's number sits in the
 * line itself, so a line that wraps keeps its number beside its first row.
 */

const COLOURED_LINES = 4000
const INDENT = '  '

const sameTokens = (a: Token[] | undefined, b: Token[] | undefined): boolean =>
  a === b || (!!a && !!b && a.length === b.length && a.every((t, i) => t.text === b[i].text && t.kind === b[i].kind))

/** One line, redrawn only when its own colours change: the file is coloured afresh on each keystroke. */
const Line = memo(
  function Line({ text, tokens, num }: { text: string; tokens: Token[] | undefined; num?: number }): JSX.Element {
    return (
      <div className="ide-editor__line">
        {num !== undefined && (
          <span className="ide-editor__num" data-line={num}>
            {num}
          </span>
        )}
        {tokens
          ? tokens.map((token, index) =>
              token.kind ? (
                <span key={index} className={`tok-${token.kind}`}>
                  {token.text}
                </span>
              ) : (
                token.text
              )
            )
          : text}
        {'\n'}
      </div>
    )
  },
  (a, b) => a.text === b.text && a.num === b.num && sameTokens(a.tokens, b.tokens)
)

/** 1-based line and column of an offset. */
function caretAt(text: string, offset: number): { line: number; col: number } {
  let line = 1
  let start = 0
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) {
    line++
    start = i + 1
  }
  return { line, col: offset - start + 1 }
}

export function CodeEditor({
  text,
  onChange,
  onSave,
  onCaret,
  reveal,
  lang = '',
  wrap = false,
  onLineAction,
  lineActionLabel
}: {
  text: string
  onChange: (text: string) => void
  onSave: () => void
  onCaret: (caret: { line: number; col: number }) => void
  /** A line to select and scroll to; a new `nonce` asks again. */
  reveal?: { line: number; nonce: number } | null
  /** The file's language, for colouring ("ts", "py"…). */
  lang?: string
  /** Long lines wrap at the panel's edge instead of scrolling. */
  wrap?: boolean
  /** A line's number, clicked: a + shows on it under the pointer. */
  onLineAction?: (line: number) => void
  /** What the + does, for its tooltip. */
  lineActionLabel?: string
}): JSX.Element {
  const area = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const lines = useMemo(() => text.split('\n'), [text])
  const coloured = lines.length <= COLOURED_LINES
  const widest = useMemo(() => lines.reduce((max, line) => Math.max(max, line.length), 0), [lines])
  const tokens = useMemo(() => (coloured ? lineTokens(lines, lang) : null), [coloured, lines, lang])

  // A new file starts at the top with the caret in it.
  useLayoutEffect(() => {
    area.current?.focus({ preventScroll: true })
  }, [])

  // Asked for a line (a search result, a path in a reply): selected, and placed a third of the way down.
  useLayoutEffect(() => {
    const el = area.current
    const box = scroller.current
    if (!reveal || !el || !box) return
    const index = Math.min(Math.max(1, reveal.line), lines.length) - 1
    let start = 0
    for (let i = 0; i < index; i++) start += lines[i].length + 1
    el.focus({ preventScroll: true })
    el.setSelectionRange(start, start + lines[index].length)
    // The line itself where lines are drawn one by one (wrapped lines are taller), else its number in the gutter.
    const row = box.querySelectorAll<HTMLElement>('.ide-editor__line')[index] ?? box.querySelectorAll<HTMLElement>('.ide-editor__gutter > div')[index]
    const top = row ? row.offsetTop : index * 20
    box.scrollTop = Math.max(0, top - box.clientHeight / 3)
    onCaret({ line: index + 1, col: 1 })
    // Only when asked: typing changes `lines`, and must not jump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce])

  const report = (): void => {
    const el = area.current
    if (el) onCaret(caretAt(el.value, el.selectionStart))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const el = event.currentTarget
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      onSave()
      return
    }
    if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      const { selectionStart: start, selectionEnd: end, value } = el
      if (event.shiftKey) {
        // Outdent the caret's line.
        const lineStart = value.lastIndexOf('\n', start - 1) + 1
        if (value.startsWith(INDENT, lineStart)) {
          el.setRangeText('', lineStart, lineStart + INDENT.length, 'preserve')
          el.setSelectionRange(Math.max(lineStart, start - INDENT.length), Math.max(lineStart, end - INDENT.length))
        }
      } else {
        el.setRangeText(INDENT, start, end, 'end')
      }
      onChange(el.value)
      report()
      return
    }
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
      // Carry the line's indent onto the next.
      event.preventDefault()
      const { selectionStart: start, selectionEnd: end, value } = el
      const lineStart = value.lastIndexOf('\n', start - 1) + 1
      const indent = /^[ \t]*/.exec(value.slice(lineStart, start))?.[0] ?? ''
      el.setRangeText(`\n${indent}`, start, end, 'end')
      onChange(el.value)
      report()
    }
  }

  return (
    <div
      ref={scroller}
      className="ide-editor scroll"
      data-wrap={wrap || undefined}
      data-line-action={onLineAction ? true : undefined}
      onClick={(event) => {
        const num = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-line]') : null
        if (num && onLineAction) onLineAction(Number(num.dataset.line))
      }}
      onMouseOver={(event) => {
        const num = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-line]') : null
        if (num && lineActionLabel) num.title = `${lineActionLabel} (line ${num.dataset.line})`
      }}
      style={{ '--ide-cols': widest + 4, '--ide-digits': String(lines.length).length } as React.CSSProperties}
    >
      {!wrap && (
        <div className="ide-editor__gutter" aria-hidden>
          {lines.map((_, index) => (
            <div key={index} className="ide-editor__num" data-line={index + 1}>
              {index + 1}
            </div>
          ))}
        </div>
      )}
      <div className="ide-editor__code">
        <pre className="ide-editor__view" aria-hidden>
          {coloured || wrap ? lines.map((line, index) => <Line key={index} text={line} tokens={tokens?.[index]} num={wrap ? index + 1 : undefined} />) : text + '\n'}
        </pre>
        <textarea
          ref={area}
          className="ide-editor__input"
          value={text}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          wrap={wrap ? 'soft' : 'off'}
          aria-label="File contents"
          onChange={(event) => {
            onChange(event.target.value)
            report()
          }}
          onKeyDown={onKeyDown}
          onSelect={report}
          onClick={report}
        />
      </div>
    </div>
  )
}
