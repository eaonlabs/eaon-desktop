import { Fragment, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { CaseSensitive, Loader2, Regex, Search, WholeWord, X } from 'lucide-react'
import type { SearchMatch, SearchOptions, SearchResult } from '@shared/chatCode'
import { FileIcon, splitPath } from '../agent/FileIcon'
import { openInCode } from '../ide/ideStore'
import { joinPath } from '../ide/paths'
import { folderName, preferredTarget, useChatCode } from './chatCodeStore'

const OPTIONS_KEY = 'eaon.chatCode.searchOptions'

const storedOptions = (): SearchOptions => {
  try {
    return JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}') as SearchOptions
  } catch {
    return {}
  }
}

/** Where the query matches in a line, for highlighting; the same rules the search ran with. */
function ranges(text: string, query: string, options: SearchOptions): [number, number][] {
  let pattern: RegExp
  try {
    const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    pattern = new RegExp(options.word ? `\\b(?:${source})\\b` : source, options.caseSensitive ? 'g' : 'gi')
  } catch {
    return []
  }
  const out: [number, number][] = []
  for (const m of text.matchAll(pattern)) {
    if (!m[0]) break
    out.push([m.index ?? 0, (m.index ?? 0) + m[0].length])
    if (out.length > 20) break
  }
  return out
}

function Highlighted({ text, query, options }: { text: string; query: string; options: SearchOptions }): JSX.Element {
  // Leading indent says nothing in a result list and pushes the match out of sight.
  const trimmed = text.replace(/^\s+/, '')
  const found = ranges(trimmed, query, options)
  if (found.length === 0) return <>{trimmed}</>
  const parts: JSX.Element[] = []
  let at = 0
  found.forEach(([from, to], i) => {
    if (from > at) parts.push(<Fragment key={`t${i}`}>{trimmed.slice(at, from)}</Fragment>)
    parts.push(<mark key={`m${i}`}>{trimmed.slice(from, to)}</mark>)
    at = to
  })
  if (at < trimmed.length) parts.push(<Fragment key="end">{trimmed.slice(at)}</Fragment>)
  return <>{parts}</>
}

/**
 * Find in the project (⇧⌘F): text across every file in the chat's folder,
 * the way git sees it (ignored files left out), grouped by file. ↑ ↓ move
 * through the matches, Enter opens one at its line in the code panel, ⌘Enter
 * in the editor the Open button uses.
 */
export function ProjectSearch(): JSX.Element | null {
  const open = useChatCode((s) => s.searchOpen)
  if (!open) return null
  return createPortal(<SearchDialog />, document.body)
}

function SearchDialog(): JSX.Element {
  const folder = useChatCode((s) => s.folder)
  const close = (): void => useChatCode.getState().setSearchOpen(false)
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<SearchOptions>(storedOptions)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [current, setCurrent] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // A word selected in the conversation is what the reader wants to find.
    const picked = window.getSelection()?.toString().trim()
    if (picked && !picked.includes('\n') && picked.length < 120) setQuery(picked)
    requestAnimationFrame(() => input.current?.select())
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(options))
    } catch {
      /* kept for this session */
    }
  }, [options])

  // Asked once typing pauses; an answer to an older question is dropped.
  useEffect(() => {
    const q = query.trim()
    if (!folder || !q) {
      setResult(null)
      setLoading(false)
      return
    }
    let live = true
    setLoading(true)
    const timer = window.setTimeout(() => {
      window.api.chatCode
        .search(folder, q, options)
        .then((res) => live && (setResult(res), setCurrent(0)))
        .catch((e: unknown) => live && setResult({ matches: [], truncated: false, error: e instanceof Error ? e.message : String(e) }))
        .finally(() => live && setLoading(false))
    }, 180)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [folder, query, options])

  const groups = useMemo(() => {
    const byFile = new Map<string, SearchMatch[]>()
    for (const m of result?.matches ?? []) {
      const list = byFile.get(m.path)
      if (list) list.push(m)
      else byFile.set(m.path, [m])
    }
    return [...byFile.entries()]
  }, [result])
  const flat = useMemo(() => groups.flatMap(([, matches]) => matches), [groups])

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const choose = (match: SearchMatch, external: boolean): void => {
    if (!folder) return
    const path = joinPath(folder, match.path)
    close()
    if (external) {
      const code = useChatCode.getState()
      const target = preferredTarget(code.targets, code.preferred)
      if (target) return void window.api.chatCode.openIn(folder, target.id, path, match.line).catch(() => openInCode(path, match.line))
    }
    void openInCode(path, match.line)
  }

  const onKey = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setCurrent((c) => Math.min(flat.length - 1, c + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setCurrent((c) => Math.max(0, c - 1))
    } else if (event.key === 'Enter' && flat[current]) {
      event.preventDefault()
      choose(flat[current], event.metaKey || event.ctrlKey)
    }
  }

  const toggle = (key: keyof SearchOptions): void => setOptions((o) => ({ ...o, [key]: !o[key] }))
  let index = -1
  const count = result?.matches.length ?? 0

  return (
    <div className="code-search__scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="code-search" role="dialog" aria-modal="true" aria-label="Find in project" onKeyDown={onKey}>
        <div className="code-search__bar">
          {loading ? <Loader2 size={15} className="spinner code-search__glyph" /> : <Search size={15} strokeWidth={2} className="code-search__glyph" />}
          <input
            ref={input}
            className="code-search__input"
            value={query}
            placeholder={folder ? `Find in ${folderName(folder)}` : 'Find in the project'}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className="code-search__opt" aria-pressed={!!options.caseSensitive} title="Match case" onClick={() => toggle('caseSensitive')}>
            <CaseSensitive size={16} strokeWidth={1.8} />
          </button>
          <button type="button" className="code-search__opt" aria-pressed={!!options.word} title="Whole words" onClick={() => toggle('word')}>
            <WholeWord size={16} strokeWidth={1.8} />
          </button>
          <button type="button" className="code-search__opt" aria-pressed={!!options.regex} title="Regular expression" onClick={() => toggle('regex')}>
            <Regex size={15} strokeWidth={1.8} />
          </button>
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
            <X size={15} strokeWidth={2} />
          </button>
        </div>
        {query.trim() && result && (
          <div className="code-search__summary">
            {result.error
              ? result.error
              : count === 0
                ? 'No matches'
                : `${count}${result.truncated ? '+' : ''} ${count === 1 ? 'match' : 'matches'} in ${groups.length} ${groups.length === 1 ? 'file' : 'files'}`}
          </div>
        )}
        <div ref={list} className="code-search__results scroll">
          {groups.map(([path, matches]) => {
            const { name, folder: dir } = splitPath(path)
            return (
              <div key={path} className="code-search__file">
                <div className="code-search__file-head" title={path}>
                  <FileIcon file={name} size={14} />
                  <span className="code-search__file-name">{name}</span>
                  {dir && <span className="code-search__file-dir">{dir}</span>}
                  <span className="code-search__file-count">{matches.length}</span>
                </div>
                {matches.map((m) => {
                  index++
                  const i = index
                  return (
                    <button
                      key={`${m.line}:${i}`}
                      type="button"
                      className="code-search__hit"
                      data-index={i}
                      data-current={i === current || undefined}
                      onMouseMove={() => i !== current && setCurrent(i)}
                      onClick={(e) => choose(m, e.metaKey || e.ctrlKey)}
                    >
                      <span className="code-search__ln">{m.line}</span>
                      <span className="code-search__text">
                        <Highlighted text={m.text} query={query.trim()} options={options} />
                      </span>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
        <div className="code-search__foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>↵</kbd> open here
          </span>
          <span>
            <kbd>⌘</kbd>
            <kbd>↵</kbd> open in editor
          </span>
        </div>
      </div>
    </div>
  )
}
