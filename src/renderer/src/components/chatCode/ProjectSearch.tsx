import { Fragment, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { CaseSensitive, Loader2, Regex, Replace, Search, WholeWord, X } from 'lucide-react'
import type { SearchMatch, SearchOptions, SearchResult } from '@shared/chatCode'
import { replaceLine, replacedSummary, searchPattern, type ReplaceResult } from '@shared/searchReplace'
import { FileIcon, splitPath } from '../agent/FileIcon'
import { isDirty, openInCode, useIde } from '../ide/ideStore'
import { notify } from '../Notice'
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

/** The line as it will be once replaced, the replacements marked; leading indent is left off like in the line above it. */
function After({ text, pattern, replacement, regex }: { text: string; pattern: RegExp; replacement: string; regex: boolean }): JSX.Element {
  const { parts } = replaceLine(text, pattern, replacement, regex)
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <ins key={i} data-empty={p.text === '' || undefined}>
            {p.text}
          </ins>
        ) : (
          <Fragment key={i}>{i === 0 ? p.text.replace(/^\s+/, '') : p.text}</Fragment>
        )
      )}
    </>
  )
}

const hitKey = (m: SearchMatch): string => `${m.path}\0${m.line}`

/**
 * Find in the project (⇧⌘F): text across every file in the chat's folder,
 * the way git sees it (ignored files left out), grouped by file. ↑ ↓ move
 * through the matches, Enter opens one at its line in the code panel, ⌘Enter
 * in the editor the Open button uses.
 *
 * Replace turns each match into a before and an after line to look at. Files
 * and lines can be left out, and nothing is written until Replace is pressed
 * a second time; the last replacement can be undone.
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
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [replacement, setReplacement] = useState('')
  /** Matches and files left out of the replacement, by key. */
  const [offHits, setOffHits] = useState<Set<string>>(() => new Set())
  const [offFiles, setOffFiles] = useState<Set<string>>(() => new Set())
  const [armed, setArmed] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const [outcome, setOutcome] = useState<(ReplaceResult & { ok: true }) | null>(null)
  /** Asks the search again after a replacement or an undo. */
  const [again, setAgain] = useState(0)
  const tabs = useIde((s) => s.tabs)
  // Files open in the editor with edits not saved: written over, they would be lost or fight the editor.
  const unsaved = useMemo(() => new Set(tabs.filter(isDirty).map((t) => t.path)), [tabs])

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
        .then((res) => live && (setResult(res), setCurrent(0), setOffHits(new Set()), setOffFiles(new Set()), setArmed(false)))
        .catch((e: unknown) => live && setResult({ matches: [], truncated: false, error: e instanceof Error ? e.message : String(e) }))
        .finally(() => live && setLoading(false))
    }, 180)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [folder, query, options, again])

  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), 4000)
    return () => window.clearTimeout(timer)
  }, [armed])

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
    // Typing the replacement, ticking a box or pressing a button there is not choosing a match.
    if (event.key === 'Enter' && (event.target as HTMLElement).closest('.code-search__replace, .code-search__outcome, input[type=checkbox]')) return
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

  const made = useMemo(() => searchPattern(query.trim(), options), [query, options])
  const pattern = 'pattern' in made ? made.pattern : null
  const absolute = (path: string): string => (folder ? joinPath(folder, path) : path)
  const isUnsaved = (path: string): boolean => unsaved.has(absolute(path))
  const isOff = (m: SearchMatch): boolean => offFiles.has(m.path) || offHits.has(hitKey(m)) || isUnsaved(m.path)
  const chosen = useMemo(
    () => (result?.matches ?? []).filter((m) => !offFiles.has(m.path) && !offHits.has(hitKey(m)) && !unsaved.has(folder ? joinPath(folder, m.path) : m.path)),
    [result, offFiles, offHits, unsaved, folder]
  )
  const chosenFiles = useMemo(() => new Set(chosen.map((m) => m.path)).size, [chosen])
  const flip = (set: Set<string>, key: string): Set<string> => {
    const next = new Set(set)
    if (!next.delete(key)) next.add(key)
    return next
  }

  const doReplace = async (): Promise<void> => {
    if (!folder || !pattern || chosen.length === 0 || replacing) return
    setReplacing(true)
    setArmed(false)
    try {
      const byFile = new Map<string, number[]>()
      for (const m of chosen) byFile.set(m.path, [...(byFile.get(m.path) ?? []), m.line])
      const res = await window.api.searchReplace.replace(folder, query.trim(), options, replacement, [...byFile.entries()].map(([path, lines]) => ({ path, lines })))
      if (res.ok) {
        setOutcome(res)
        // Open files that were clean take what was written.
        void useIde.getState().refresh()
        setAgain((n) => n + 1)
      } else notify(res.error, 'error')
    } catch (e) {
      notify(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e), 'error')
    } finally {
      setReplacing(false)
    }
  }

  const undo = async (): Promise<void> => {
    if (!folder) return
    try {
      const res = await window.api.searchReplace.undo(folder)
      if (!res.ok) return notify(res.error, 'error')
      notify(res.conflicts.length ? `Put back ${res.restored.length} ${res.restored.length === 1 ? 'file' : 'files'}. ${res.conflicts.join(', ')} changed since, so ${res.conflicts.length === 1 ? 'it was' : 'they were'} left alone.` : `Put back ${res.restored.length} ${res.restored.length === 1 ? 'file' : 'files'}.`, 'done')
      setOutcome(null)
      void useIde.getState().refresh()
      setAgain((n) => n + 1)
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error')
    }
  }
  let index = -1
  const count = result?.matches.length ?? 0

  return (
    <div className="code-search__scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="code-search" role="dialog" aria-modal="true" aria-label="Find in project" onKeyDown={onKey}>
        <div className="code-search__bar">
          {loading ? <Loader2 size={15} className="spinner code-search__glyph" /> : <Search size={15} strokeWidth={2} className="code-search__glyph" />}
          <input aria-label="Find in project"
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
          <button type="button" className="code-search__opt" aria-pressed={replaceOpen} title="Replace" onClick={() => setReplaceOpen((v) => !v)}>
            <Replace size={15} strokeWidth={1.8} />
          </button>
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
            <X size={15} strokeWidth={2} />
          </button>
        </div>
        {replaceOpen && (
          <div className="code-search__replace">
            <input
              aria-label="Replace with"
              className="code-search__input code-search__input--replace"
              value={replacement}
              placeholder="Replace with (leave empty to delete the matches)"
              spellCheck={false}
              onChange={(e) => {
                setReplacement(e.target.value)
                setArmed(false)
              }}
            />
            <button
              type="button"
              className={`btn btn--sm ${armed ? 'btn--danger' : ''}`}
              disabled={!pattern || chosen.length === 0 || replacing || !result || Boolean(result.error)}
              title={chosen.length === 0 ? 'Nothing is chosen to replace' : 'Writes the replacement into the matches ticked below. Press again to confirm.'}
              onClick={() => (armed ? void doReplace() : setArmed(true))}
            >
              {replacing
                ? 'Replacing…'
                : armed
                  ? `Replace ${chosen.length} in ${chosenFiles} ${chosenFiles === 1 ? 'file' : 'files'}?`
                  : chosen.length > 0
                    ? `Replace ${chosen.length} in ${chosenFiles} ${chosenFiles === 1 ? 'file' : 'files'}`
                    : 'Replace'}
            </button>
          </div>
        )}
        {replaceOpen && 'error' in made && query.trim() && <div className="code-search__summary">{made.error}</div>}
        {replaceOpen && !('error' in made) && result?.truncated && (
          <div className="code-search__summary">Only the {result.matches.length} matches listed are replaced; search again afterwards for the rest.</div>
        )}
        {outcome && (
          <div className="code-search__outcome">
            <div className="code-search__outcome-head">
              <span>{replacedSummary(outcome.files)}</span>
              {outcome.undoable && outcome.files.length > 0 && (
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => void undo()}>
                  Undo
                </button>
              )}
              <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setOutcome(null)}>
                <X size={13} strokeWidth={2} />
              </button>
            </div>
            {outcome.skipped.length > 0 && (
              <ul>
                {outcome.skipped.slice(0, 6).map((s, i) => (
                  <li key={`${s.path}${i}`}>
                    <span>{s.path}</span> left alone: {s.reason}
                  </li>
                ))}
                {outcome.skipped.length > 6 && <li>and {outcome.skipped.length - 6} more</li>}
              </ul>
            )}
          </div>
        )}
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
                  {replaceOpen && (
                    <input
                      type="checkbox"
                      aria-label={`Replace in ${path}`}
                      checked={!offFiles.has(path) && !isUnsaved(path)}
                      disabled={isUnsaved(path)}
                      onChange={() => setOffFiles((set) => flip(set, path))}
                    />
                  )}
                  <FileIcon file={name} size={14} />
                  <span className="code-search__file-name">{name}</span>
                  {dir && <span className="code-search__file-dir">{dir}</span>}
                  {isUnsaved(path) && <span className="code-search__file-note">unsaved in the editor</span>}
                  <span className="code-search__file-count">{matches.length}</span>
                </div>
                {matches.map((m) => {
                  index++
                  const i = index
                  const hit = (
                    <button
                      key={`${m.line}:${i}`}
                      type="button"
                      className="code-search__hit"
                      data-index={i}
                      data-current={i === current || undefined}
                      data-replace={Boolean(replaceOpen && pattern) || undefined}
                      onMouseMove={() => i !== current && setCurrent(i)}
                      onClick={(e) => choose(m, e.metaKey || e.ctrlKey)}
                    >
                      <span className="code-search__ln">{m.line}</span>
                      <span className="code-search__text">
                        <span className="code-search__before">
                          <Highlighted text={m.text} query={query.trim()} options={options} />
                        </span>
                        {replaceOpen && pattern && (
                          <span className="code-search__after">
                            <After text={m.text} pattern={pattern} replacement={replacement} regex={options.regex === true} />
                          </span>
                        )}
                      </span>
                    </button>
                  )
                  if (!replaceOpen) return hit
                  return (
                    <div key={`${m.line}:${i}`} className="code-search__hit-row" data-off={isOff(m) || undefined}>
                      <input
                        type="checkbox"
                        aria-label={`Replace line ${m.line} of ${path}`}
                        checked={!isOff(m)}
                        disabled={isUnsaved(path)}
                        onChange={() => setOffHits((set) => flip(set, hitKey(m)))}
                      />
                      {hit}
                    </div>
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
