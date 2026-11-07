import { Fragment, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { FileSearch } from 'lucide-react'
import { FileIcon, splitPath } from '../agent/FileIcon'
import { fuzzyFind, type FuzzyHit } from '../ide/fuzzy'
import { openInCode } from '../ide/ideStore'
import { joinPath } from '../ide/paths'
import { isMac } from '../../lib/platform'
import { useChatCode } from './chatCodeStore'

/**
 * Quick Open (⌘P): a file in the chat's project by a few letters of its
 * name, opened in the editor beside the conversation. ↑ ↓ move, Enter
 * opens, Esc closes. With nothing typed it lists the files open in the
 * editor and the ones the agent changed in this chat first.
 */
export function QuickOpen(): JSX.Element | null {
  const open = useChatCode((s) => s.quickOpen)
  if (!open) return null
  return createPortal(<QuickOpenDialog />, document.body)
}

/** The letters that matched, in bold. */
function Marked({ text, at, offset }: { text: string; at: number[]; offset: number }): JSX.Element {
  const hits = new Set(at.map((i) => i - offset).filter((i) => i >= 0 && i < text.length))
  if (hits.size === 0) return <>{text}</>
  return (
    <>
      {[...text].map((ch, i) => (hits.has(i) ? <b key={i}>{ch}</b> : <Fragment key={i}>{ch}</Fragment>))}
    </>
  )
}

function QuickOpenDialog(): JSX.Element {
  const { folder, files, loadFiles } = useChatCode(useShallow((s) => ({ folder: s.folder, files: s.files, loadFiles: s.loadFiles })))
  const close = (): void => useChatCode.getState().setQuickOpen(false)
  const [query, setQuery] = useState('')
  const [current, setCurrent] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadFiles()
    requestAnimationFrame(() => input.current?.focus())
  }, [loadFiles])

  const hits: FuzzyHit[] = useMemo(() => (files ? fuzzyFind(query, files, 60) : []), [files, query])
  useEffect(() => setCurrent(0), [query])
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const choose = (rel: string): void => {
    if (!folder) return
    close()
    void openInCode(joinPath(folder, rel))
  }

  return (
    <div className="code-search__scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className="code-search quick-open"
        role="dialog"
        aria-modal="true"
        aria-label="Open a file"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            close()
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            setCurrent((i) => Math.min(i + 1, hits.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setCurrent((i) => Math.max(i - 1, 0))
          } else if (e.key === 'Enter' && hits[current]) {
            e.preventDefault()
            choose(hits[current].path)
          }
        }}
      >
        <div className="code-search__bar">
          <FileSearch size={15} strokeWidth={2} className="code-search__glyph" />
          <input
            ref={input}
            className="code-search__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Open a file by name"
            spellCheck={false}
            aria-label="File name"
          />
          <kbd className="quick-open__key">{isMac ? '⌘P' : 'Ctrl+P'}</kbd>
        </div>
        <div ref={list} className="code-search__results quick-open__results scroll" role="listbox" aria-label="Files">
          {files === null ? (
            <div className="quick-open__empty">Reading the project…</div>
          ) : hits.length === 0 ? (
            <div className="quick-open__empty">{query ? `No file matches “${query}”.` : 'This project has no files yet.'}</div>
          ) : (
            hits.map((hit, index) => {
              const { name, folder: dir } = splitPath(hit.path)
              const nameAt = hit.path.length - name.length
              return (
                <button
                  key={hit.path}
                  type="button"
                  role="option"
                  aria-selected={index === current}
                  data-index={index}
                  className="quick-open__row"
                  data-current={index === current || undefined}
                  onMouseMove={() => setCurrent(index)}
                  onClick={() => choose(hit.path)}
                  title={hit.path}
                >
                  <span className="quick-open__icon">
                    <FileIcon file={name} size={16} />
                  </span>
                  <span className="quick-open__name">
                    <Marked text={name} at={hit.at} offset={nameAt} />
                  </span>
                  {dir && (
                    <span className="quick-open__dir">
                      <Marked text={dir} at={hit.at} offset={0} />
                    </span>
                  )}
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
