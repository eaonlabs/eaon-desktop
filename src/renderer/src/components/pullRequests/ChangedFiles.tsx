import { useEffect, useState, type JSX } from 'react'
import { parseUnifiedDiff, type ReviewFile } from '@shared/adeReview'
import type { PullRequestDetail } from '@shared/types'
import { Code } from '../agent/FileDiff'
import { Octicon } from './octicons'
import { Diffstat, errorText } from './parts'

/** Bigger than this many changed lines and a file starts folded, as GitHub folds large diffs. */
const OPEN_UP_TO = 300

/** The Files changed tab, as GitHub's: a line saying how much changed, then each file in its own box with a sticky header and its diff. */
export function ChangedFiles({ detail }: { detail: PullRequestDetail }): JSX.Element {
  const [files, setFiles] = useState<ReviewFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  useEffect(() => {
    setFiles(null)
    setError(null)
    window.api.github.diff(detail.url).then(
      (text) => setFiles(parseUnifiedDiff(text)),
      (e) => setError(errorText(e))
    )
  }, [detail.url])

  if (error) return <div className="gh-flash" data-tone="danger">{error}</div>
  if (!files) return <Loading>Loading the changes…</Loading>
  if (files.length === 0) {
    return (
      <div className="gh-blank">
        <Octicon name="file-diff" size={24} />
        <h3>No changes</h3>
      </div>
    )
  }
  const isOpen = (file: ReviewFile): boolean => open[file.path] ?? file.added + file.removed <= OPEN_UP_TO
  const allOpen = files.every(isOpen)
  return (
    <div className="gh-files">
      <div className="gh-files__toolbar">
        <span className="gh-muted">
          Showing <strong>{files.length} changed {files.length === 1 ? 'file' : 'files'}</strong> with <strong>{detail.additions.toLocaleString()} additions</strong> and{' '}
          <strong>{detail.deletions.toLocaleString()} deletions</strong>.
        </span>
        <button type="button" className="gh-btn gh-btn--sm" onClick={() => setOpen(Object.fromEntries(files.map((f) => [f.path, !allOpen])))}>
          <Octicon name={allOpen ? 'fold' : 'unfold'} />
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      {files.map((file) => {
        const shown = isOpen(file)
        return (
          <section key={file.path} className="gh-file">
            <button type="button" className="gh-file__head" aria-expanded={shown} onClick={() => setOpen({ ...open, [file.path]: !shown })}>
              <Octicon name={shown ? 'chevron-down' : 'chevron-right'} className="octicon gh-file__chev" />
              <span className="gh-file__path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
                {file.oldPath ? (
                  <>
                    {file.oldPath} <span className="gh-muted">→</span> {file.path}
                  </>
                ) : (
                  file.path
                )}
              </span>
              {file.status !== 'modified' && (
                <span className="gh-file__badge" data-status={file.status}>
                  {file.status === 'added' ? 'Added' : file.status === 'deleted' ? 'Deleted' : 'Renamed'}
                </span>
              )}
              <span className="gh-file__stat">
                <Diffstat additions={file.added} deletions={file.removed} />
              </span>
            </button>
            {shown &&
              (file.binary ? (
                <p className="gh-file__note">Binary file not shown.</p>
              ) : file.hunks.length === 0 ? (
                <p className="gh-file__note">File renamed without changes.</p>
              ) : (
                <div className="gh-diff" role="table" aria-label={`Changes to ${file.path}`}>
                  {file.hunks.map((hunk, h) => (
                    <div key={h} role="rowgroup">
                      <div className="gh-diff__hunk" role="row">
                        <span className="gh-diff__expander" aria-hidden />
                        <span className="gh-diff__hunk-text">{hunk.header}</span>
                      </div>
                      {hunk.lines.map((line, i) => (
                        <div key={i} className="gh-diff__row" data-kind={line.kind} role="row">
                          <span className="gh-diff__num">{line.old ?? ''}</span>
                          <span className="gh-diff__num">{line.cur ?? ''}</span>
                          <span className="gh-diff__code">
                            <span className="gh-diff__sign" aria-hidden>
                              {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                            </span>
                            <Code text={line.text || ' '} />
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
          </section>
        )
      })}
    </div>
  )
}

export function Loading({ children }: { children: string }): JSX.Element {
  return (
    <div className="gh-loading">
      <span className="gh-spinner" aria-hidden />
      {children}
    </div>
  )
}
