import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { ArrowUp, MessageSquarePlus, Sparkles } from 'lucide-react'
import type { Token } from '../agent/highlight'
import { lineTokens } from '../chatCode/diff/tokens'
import { isMac } from '../../lib/platform'
import type { GutterMark } from './gitGutter'

/**
 * A plain editor: the file's lines, coloured, under a transparent textarea
 * that takes the typing. The textarea is sized to the text, so the panel
 * scrolls one box and the colours never drift from the caret. Colouring is
 * the diffs' own, by the file's language, as one text so a comment or a
 * string across lines is coloured on each; past a few thousand lines it stops
 * colouring and stays fast. Wrapped (`wrap`), each line's number sits in the
 * line itself, so a line that wraps keeps its number beside its first row.
 *
 * The caret's line is lit, and the gutter marks the lines changed since the
 * last commit (`marks`). Selected text can go to the agent: ⌘L adds it to
 * what the user is writing, ⌘K opens a box under it to say what to change.
 */

const COLOURED_LINES = 4000
const INDENT = '  '
/** The code's top padding, where line 1 starts (ide.css .ide-editor__code). */
const PAD_TOP = 8

/** What is selected, for the agent: the text and the lines it spans, 1-based. */
export interface EditorSelection {
  text: string
  fromLine: number
  toLine: number
}

/** Where the caret is, and how much is selected, for the status bar. */
export interface EditorCaret {
  line: number
  col: number
  /** Characters selected, and over how many lines; 0 with nothing selected. */
  selected?: number
  selectedLines?: number
}

const sameTokens = (a: Token[] | undefined, b: Token[] | undefined): boolean =>
  a === b || (!!a && !!b && a.length === b.length && a.every((t, i) => t.text === b[i].text && t.kind === b[i].kind))

/** A line's number, with its gutter mark and whether the caret is on it. */
function Num({ num, mark, active }: { num: number; mark?: GutterMark; active: boolean }): JSX.Element {
  return (
    <span className="ide-editor__num" data-line={num} data-mark={mark} data-active={active || undefined}>
      {num}
    </span>
  )
}

/** One line, redrawn only when its own colours, mark or caret change: the file is coloured afresh on each keystroke. */
const Line = memo(
  function Line({ text, tokens, num, mark, active }: { text: string; tokens: Token[] | undefined; num?: number; mark?: GutterMark; active: boolean }): JSX.Element {
    return (
      <div className="ide-editor__line" data-active={active || undefined}>
        {num !== undefined && <Num num={num} mark={mark} active={active} />}
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
  (a, b) => a.text === b.text && a.num === b.num && a.mark === b.mark && a.active === b.active && sameTokens(a.tokens, b.tokens)
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

const MOD = isMac ? '⌘' : 'Ctrl+'

export function CodeEditor({
  text,
  onChange,
  onSave,
  onCaret,
  reveal,
  lang = '',
  wrap = false,
  marks,
  onLineAction,
  lineActionLabel,
  onAddToChat,
  onAskEdit,
  askLabel = 'the chat'
}: {
  text: string
  onChange: (text: string) => void
  onSave: () => void
  onCaret: (caret: EditorCaret) => void
  /** A line to select and scroll to; a new `nonce` asks again. */
  reveal?: { line: number; nonce: number } | null
  /** The file's language, for colouring ("ts", "py"…). */
  lang?: string
  /** Long lines wrap at the panel's edge instead of scrolling. */
  wrap?: boolean
  /** Lines changed since the last commit, for the gutter. */
  marks?: Map<number, GutterMark>
  /** A line's number, clicked: a + shows on it under the pointer. */
  onLineAction?: (line: number) => void
  /** What the + does, for its tooltip. */
  lineActionLabel?: string
  /** ⌘L: the selection goes into what the user is writing to the agent. */
  onAddToChat?: (selection: EditorSelection) => void
  /** ⌘K: the selection and what to do with it go to the agent. */
  onAskEdit?: (instruction: string, selection: EditorSelection) => void
  /** Where those go, for the buttons' words: "the chat", "the agent". */
  askLabel?: string
}): JSX.Element {
  const area = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const view = useRef<HTMLPreElement>(null)
  const lines = useMemo(() => text.split('\n'), [text])
  const coloured = lines.length <= COLOURED_LINES
  const widest = useMemo(() => lines.reduce((max, line) => Math.max(max, line.length), 0), [lines])
  const tokens = useMemo(() => (coloured ? lineTokens(lines, lang) : null), [coloured, lines, lang])
  // The caret's line, and the selection as offsets; `focused` keeps the selection's buttons to the editor in use.
  const [sel, setSel] = useState({ start: 0, end: 0, line: 1 })
  const [focused, setFocused] = useState(false)
  const [scrollTop, setScrollTop] = useState(0)
  // ⌘K: the box under the selection, and the selection it is about (kept while the box has the focus).
  const [asking, setAsking] = useState<EditorSelection | null>(null)
  const [instruction, setInstruction] = useState('')

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
    box.scrollTop = Math.max(0, lineTop(index) - box.clientHeight / 3)
    report()
    // Only when asked: typing changes `lines`, and must not jump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.nonce])

  /** Where line `index` (0-based) starts, from the top of the code: drawn lines are measured, else counted. */
  function lineTop(index: number): number {
    const row = view.current?.children[index] as HTMLElement | undefined
    if (row && row.classList.contains('ide-editor__line')) return row.offsetTop
    return PAD_TOP + index * lineHeight()
  }
  function lineBottom(index: number): number {
    const row = view.current?.children[index] as HTMLElement | undefined
    if (row && row.classList.contains('ide-editor__line')) return row.offsetTop + row.offsetHeight
    return lineTop(index) + lineHeight()
  }
  function lineHeight(): number {
    const box = scroller.current
    return box ? parseFloat(getComputedStyle(box).lineHeight) || 20 : 20
  }

  const report = (): void => {
    const el = area.current
    if (!el) return
    const { selectionStart: start, selectionEnd: end, value } = el
    const at = caretAt(value, start)
    const selected = end - start
    const endLine = selected > 0 ? caretAt(value, end).line : at.line
    setSel((now) => (now.start === start && now.end === end && now.line === at.line ? now : { start, end, line: at.line }))
    onCaret({ ...at, selected, selectedLines: selected > 0 ? endLine - at.line + 1 : 0 })
  }

  /** The selection as the agent gets it; the caret's line when nothing is selected. */
  const selection = (): EditorSelection | null => {
    const el = area.current
    if (!el) return null
    const { selectionStart: start, selectionEnd: end, value } = el
    if (end > start) {
      const fromLine = caretAt(value, start).line
      // A selection ending at the very start of a line doesn't take that line in.
      const toLine = caretAt(value, value[end - 1] === '\n' ? end - 1 : end).line
      return { text: value.slice(start, end), fromLine, toLine }
    }
    const line = caretAt(value, start).line
    return { text: lines[line - 1] ?? '', fromLine: line, toLine: line }
  }

  const addToChat = (): void => {
    const picked = selection()
    if (picked && onAddToChat) onAddToChat(picked)
  }
  const openAsk = (): void => {
    const picked = selection()
    if (!picked || !onAskEdit) return
    setInstruction('')
    setAsking(picked)
  }
  const closeAsk = (refocus = true): void => {
    setAsking(null)
    setInstruction('')
    if (refocus) requestAnimationFrame(() => area.current?.focus({ preventScroll: true }))
  }
  const sendAsk = (): void => {
    if (!asking || !instruction.trim() || !onAskEdit) return
    onAskEdit(instruction.trim(), asking)
    closeAsk()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const el = event.currentTarget
    const mod = isMac ? event.metaKey : event.ctrlKey
    const key = event.key.toLowerCase()
    if (mod && !event.altKey && key === 's') {
      event.preventDefault()
      onSave()
      return
    }
    if (mod && !event.altKey && !event.shiftKey && key === 'l' && onAddToChat) {
      event.preventDefault()
      event.stopPropagation()
      addToChat()
      return
    }
    if (mod && !event.altKey && !event.shiftKey && key === 'k' && onAskEdit) {
      event.preventDefault()
      event.stopPropagation()
      openAsk()
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

  // Typing elsewhere moved the text under the caret (a reload, an edit from the agent): read it again.
  useEffect(() => {
    if (document.activeElement === area.current) report()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  const activeIndex = Math.min(sel.line, lines.length) - 1
  const hasSelection = sel.end > sel.start
  const band = { top: lineTop(activeIndex), height: lineBottom(activeIndex) - lineTop(activeIndex) }
  // The selection's buttons sit over its first line, or under its last when there is no room above.
  const fromIndex = hasSelection ? caretAt(text, sel.start).line - 1 : activeIndex
  const toIndex = hasSelection ? caretAt(text, text[sel.end - 1] === '\n' ? sel.end - 1 : sel.end).line - 1 : activeIndex
  const above = lineTop(fromIndex) - scrollTop - 34
  const toolsTop = above >= 4 ? above : lineBottom(toIndex) - scrollTop + 6
  const askTop = asking ? lineBottom(Math.min(asking.toLine, lines.length) - 1) - scrollTop + 6 : 0
  // Focus events wait for the window to be in front; what has the keyboard is known before that.
  const inUse = focused || (typeof document !== 'undefined' && document.activeElement === area.current && area.current !== null)
  const showTools = hasSelection && inUse && !asking && Boolean(onAddToChat || onAskEdit)

  return (
    <div className="ide-editor-wrap">
      <div
        ref={scroller}
        className="ide-editor scroll"
        data-wrap={wrap || undefined}
        data-line-action={onLineAction ? true : undefined}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
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
              <div key={index} className="ide-editor__gutter-row">
                <Num num={index + 1} mark={marks?.get(index + 1)} active={index === activeIndex} />
              </div>
            ))}
          </div>
        )}
        <div className="ide-editor__code">
          {!hasSelection && <div className="ide-editor__band" style={band} aria-hidden />}
          <pre ref={view} className="ide-editor__view" aria-hidden>
            {coloured || wrap
              ? lines.map((line, index) => (
                  <Line
                    key={index}
                    text={line}
                    tokens={tokens?.[index]}
                    num={wrap ? index + 1 : undefined}
                    mark={wrap ? marks?.get(index + 1) : undefined}
                    active={index === activeIndex}
                  />
                ))
              : text + '\n'}
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
            onKeyUp={report}
            onFocus={() => setFocused(true)}
            // Moving to the selection's own buttons keeps them up long enough to be pressed.
            onBlur={(event) => setFocused(Boolean(event.relatedTarget instanceof Element && event.relatedTarget.closest('.ide-sel-tools')))}
          />
        </div>
      </div>
      {showTools && (
        <div className="ide-sel-tools" style={{ top: toolsTop }} role="toolbar" aria-label="Selection">
          {onAddToChat && (
            <button type="button" className="ide-sel-tools__btn" onMouseDown={(e) => e.preventDefault()} onClick={addToChat} title={`Add the selection to ${askLabel}`}>
              <MessageSquarePlus size={13} strokeWidth={1.9} />
              <span>Add to chat</span>
              <kbd>{MOD}L</kbd>
            </button>
          )}
          {onAskEdit && (
            <button type="button" className="ide-sel-tools__btn" onMouseDown={(e) => e.preventDefault()} onClick={openAsk} title="Ask the agent to change the selection">
              <Sparkles size={13} strokeWidth={1.9} />
              <span>Edit</span>
              <kbd>{MOD}K</kbd>
            </button>
          )}
        </div>
      )}
      {asking && (
        <form
          className="ide-ask"
          style={{ top: askTop }}
          onSubmit={(event) => {
            event.preventDefault()
            sendAsk()
          }}
        >
          <Sparkles size={14} strokeWidth={1.9} className="ide-ask__icon" aria-hidden />
          <input
            autoFocus
            className="ide-ask__input"
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                closeAsk()
              }
            }}
            placeholder={asking.fromLine === asking.toLine ? `Change line ${asking.fromLine}…` : `Change lines ${asking.fromLine}–${asking.toLine}…`}
            aria-label="What to change"
          />
          <span className="ide-ask__hint">Esc</span>
          <button type="submit" className="ide-ask__send" disabled={!instruction.trim()} aria-label={`Send to ${askLabel}`} title={`Send to ${askLabel}`}>
            <ArrowUp size={14} strokeWidth={2.2} />
          </button>
        </form>
      )}
    </div>
  )
}
