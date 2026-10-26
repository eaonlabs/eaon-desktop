import { useEffect, useState, type JSX } from 'react'
import { ArrowDownToLine, Check, ChevronDown, Loader2, Search, TriangleAlert, X } from 'lucide-react'
import { speechIdFor, type LocalSpeechState, type SpeechHubFile, type SpeechHubResult } from '@shared/speech'
import { SearchField } from '../../ui'
import { downloadHubModel, downloadedOf, megabytes } from '../../../lib/localSpeech'

/** Files a repo shows before "Show more". */
const SHOWN = 4

const count = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n))

/**
 * Settings → Model providers → Speech to text → Find more on Hugging Face:
 * every whisper.cpp model there, searchable by language or name, each a
 * click from downloaded and in use. Only models whisper.cpp can run are
 * listed (speechHub.ts in main), so whatever is picked here works.
 */
export function SpeechHub({
  state,
  selected,
  onSelect
}: {
  state: LocalSpeechState | null
  /** The local model dictation uses, if any. */
  selected: string | null
  onSelect: (id: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SpeechHubResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    setSearching(true)
    setError(null)
    // A pause after typing, so each letter isn't a search.
    const timer = window.setTimeout(
      () => {
        window.api.voice.hubSearch(query).then(
          (found) => {
            if (!live) return
            setResults(found)
            setSearching(false)
          },
          (e: Error) => {
            if (!live) return
            setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
            setSearching(false)
          }
        )
      },
      query ? 400 : 0
    )
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [open, query])

  if (!open) {
    return (
      <button type="button" className="speech-hub__open" onClick={() => setOpen(true)}>
        <Search size={14} strokeWidth={2} />
        <span>Find more on Hugging Face</span>
        <span className="speech-hub__open-hint">Other sizes, English-only, and models for other languages</span>
      </button>
    )
  }

  const download = (file: SpeechHubFile): void => {
    setFailed(null)
    downloadHubModel(file.repoId, file.filename).then(
      (id) => id && onSelect(id),
      (e: Error) => setFailed({ id: speechIdFor(file.repoId, file.filename), message: e.message })
    )
  }

  return (
    <div className="speech-hub">
      <div className="speech-hub__head">
        <span className="speech-hub__title">Hugging Face</span>
        <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close Hugging Face" title="Close">
          <X size={14} strokeWidth={2} />
        </button>
      </div>
      <SearchField value={query} onChange={setQuery} placeholder="Search a language or a model: japanese, german, turbo…" autoFocus />
      <p className="speech-hub__note">Only whisper.cpp models are listed: they’re the ones that run on this computer. Each is checked before it’s used.</p>

      {error ? (
        <div className="provider-status" data-tone="error">
          <TriangleAlert size={14} strokeWidth={2} />
          <span>{error}</span>
        </div>
      ) : searching && !results ? (
        <div className="speech-hub__empty">
          <Loader2 size={14} strokeWidth={2} className="spinner" />
          Searching Hugging Face…
        </div>
      ) : results && results.length === 0 ? (
        <div className="speech-hub__empty">
          No whisper.cpp models match “{query.trim()}”. Speech models in other formats, like GGUF, can’t run here.
        </div>
      ) : (
        <div className="speech-hub__results" data-busy={searching || undefined}>
          {results?.map((repo) => (
            <HubRepo key={repo.repoId} repo={repo} state={state} selected={selected} failed={failed} onDownload={download} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  )
}

function HubRepo({
  repo,
  state,
  selected,
  failed,
  onDownload,
  onSelect
}: {
  repo: SpeechHubResult
  state: LocalSpeechState | null
  selected: string | null
  failed: { id: string; message: string } | null
  onDownload: (file: SpeechHubFile) => void
  onSelect: (id: string) => void
}): JSX.Element {
  const [all, setAll] = useState(false)
  const files = all ? repo.files : repo.files.slice(0, SHOWN)
  return (
    <section className="speech-hub__repo" aria-label={repo.name}>
      <div className="speech-hub__repo-head">
        <a className="speech-hub__repo-name" href={`https://huggingface.co/${repo.repoId}`} target="_blank" rel="noreferrer">
          {repo.official ? 'whisper.cpp' : repo.name}
        </a>
        {repo.official && <span className="speech-hub__tag">Official</span>}
        <span className="speech-hub__repo-meta">
          {repo.author}
          {repo.downloads > 0 && ` · ${count(repo.downloads)} downloads`}
        </span>
      </div>
      {repo.note && <p className="speech-hub__repo-note">{repo.note}</p>}
      <div className="speech-hub__files">
        {files.map((file) => {
          const id = speechIdFor(file.repoId, file.filename)
          const have = Boolean(state?.downloaded.includes(id))
          const progress = state?.downloading?.id === id ? state.downloading.progress : null
          const error = failed?.id === id ? failed.message : null
          return (
            <div key={file.filename} className="speech-hub__file">
              <div className="speech-hub__file-text">
                <span className="speech-hub__file-name">{file.label}</span>
                <span className="speech-hub__file-meta" data-tone={error ? 'error' : undefined}>
                  {error ?? (progress !== null ? `Downloading… ${downloadedOf(progress, file.bytes)}` : `${megabytes(file.bytes)} · ${file.filename}`)}
                </span>
              </div>
              {progress !== null ? (
                <span className="local-speech__progress">
                  <span className="local-speech__bar" role="progressbar" aria-label={`Downloading ${file.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
                    <span style={{ width: `${Math.round(progress * 100)}%` }} />
                  </span>
                  <span className="local-speech__pct">{Math.round(progress * 100)}%</span>
                  <button type="button" className="icon-btn" onClick={() => void window.api.voice.localCancel()} aria-label="Stop downloading" title="Stop downloading">
                    <X size={14} strokeWidth={2} />
                  </button>
                </span>
              ) : have ? (
                selected === id ? (
                  <span className="speech-hub__in-use">
                    <Check size={13} strokeWidth={2.4} />
                    In use
                  </span>
                ) : (
                  <button type="button" className="btn btn--sm" onClick={() => onSelect(id)}>
                    Use
                  </button>
                )
              ) : (
                <button type="button" className="btn btn--sm local-speech__get" disabled={Boolean(state?.downloading) || !state?.available} onClick={() => onDownload(file)}>
                  <ArrowDownToLine size={13} strokeWidth={2} />
                  Download
                </button>
              )}
            </div>
          )
        })}
      </div>
      {repo.files.length > SHOWN && (
        <button type="button" className="speech-hub__more" onClick={() => setAll((on) => !on)} aria-expanded={all}>
          {all ? 'Show fewer' : `Show ${repo.files.length - SHOWN} more`}
          <ChevronDown size={13} strokeWidth={2} style={{ rotate: all ? '180deg' : undefined }} />
        </button>
      )}
    </section>
  )
}
