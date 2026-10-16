import { memo, useLayoutEffect, useMemo, useRef, type JSX, type KeyboardEvent } from 'react'
import { tokenize } from '../agent/FileDiff'

/**
 * A plain editor: the file's lines, coloured, under a transparent textarea
 * that takes the typing. The textarea is sized to the text, so the panel
 * scrolls one box and the colours never drift from the caret. Colouring is
 * the same light tokenizer the diffs use, not a grammar; past a few thousand
 * lines it stops colouring and stays fast.
 */

const COLOURED_LINES = 4000
const INDENT = '  '

const Line = memo(function Line({ text }: { text: string }): JSX.Element {
  const tokens = useMemo(() => tokenize(text), [text])
  return (
    <div className="ide-editor__line">
      {tokens.map((token, index) =>
        token.t === 'txt' ? (
          token.v
        ) : (
          <span key={index} className={`tk-${token.t}`}>
            {token.v}
          </span>
        )
      )}
      {'\n'}
    </div>
  )
})

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
  onCaret
}: {
  text: string
  onChange: (text: string) => void
  onSave: () => void
  onCaret: (caret: { line: number; col: number }) => void
}): JSX.Element {
  const area = useRef<HTMLTextAreaElement>(null)
  const lines = useMemo(() => text.split('\n'), [text])
  const coloured = lines.length <= COLOURED_LINES
  const widest = useMemo(() => lines.reduce((max, line) => Math.max(max, line.length), 0), [lines])

  // A new file starts at the top with the caret in it.
  useLayoutEffect(() => {
    area.current?.focus({ preventScroll: true })
  }, [])

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
    <div className="ide-editor scroll" style={{ '--ide-cols': widest + 4 } as React.CSSProperties}>
      <div className="ide-editor__gutter" aria-hidden>
        {lines.map((_, index) => (
          <div key={index}>{index + 1}</div>
        ))}
      </div>
      <div className="ide-editor__code">
        <pre className="ide-editor__view" aria-hidden>
          {coloured ? lines.map((line, index) => <Line key={index} text={line} />) : text + '\n'}
        </pre>
        <textarea
          ref={area}
          className="ide-editor__input"
          value={text}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          wrap="off"
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
