import { useEffect, useRef, useState, type JSX } from 'react'
import { GitCommitHorizontal, History, Loader2 } from 'lucide-react'
import type { ChatCommit } from '@shared/chatCode'
import { blameLabel, type LineBlame } from '@shared/fileHistory'
import { ago } from '@shared/modelSelection'
import { MenuItem, Popover, useDisclosure } from '../../ui'
import { useDockPlace } from '../dockPlace'

/**
 * The open file's git history in the editor: a History button whose menu
 * says who last changed the line the caret is on, then lists the commits
 * that touched the file (each opens in the Diff, on this file). Read only,
 * and not shown outside a git repository.
 */

/** Opens the Diff on one commit, scrolled to the file. */
function showCommit(store: ReturnType<typeof useDockPlace>['store'], sha: string, short: string, subject: string, rel: string): void {
  store.getState().reviewChanges({ kind: 'commit', sha, short, subject }, rel)
}

/**
 * `line`: the caret's, whose last change heads the menu; `ready` is false while
 * the file has edits not saved (git blames the file on disk).
 */
export function FileHistoryButton({ path, rel, line, ready }: { path: string; rel: string; line: number; ready: boolean }): JSX.Element | null {
  const place = useDockPlace()
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const [commits, setCommits] = useState<ChatCommit[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [blame, setBlame] = useState<LineBlame | null>(null)
  const folder = place.folder
  const repo = Boolean(place.status?.repo)

  // Who last changed the caret's line, asked as the menu opens.
  useEffect(() => {
    if (!menu.open || !folder || !ready) return setBlame(null)
    let live = true
    window.api.gitHistory
      .blame(folder, path, line)
      .then((res) => live && setBlame(res.ok ? res.blame : null))
      .catch(() => live && setBlame(null))
    return () => {
      live = false
    }
  }, [menu.open, folder, path, line, ready])

  // Read each time the menu opens: a commit made since changes the list.
  useEffect(() => {
    if (!menu.open || !folder) return
    let live = true
    setCommits(null)
    setProblem(null)
    window.api.gitHistory
      .file(folder, path)
      .then((res) => {
        if (!live) return
        setCommits(res.ok ? res.commits : [])
        setProblem(res.ok ? null : res.error)
      })
      .catch((e: unknown) => {
        if (!live) return
        setCommits([])
        setProblem(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
      })
    return () => {
      live = false
    }
  }, [menu.open, folder, path])

  if (!repo || !folder) return null
  return (
    <>
      <button ref={anchor} type="button" className="file-surface__tool" data-active={menu.open || undefined} aria-haspopup="menu" aria-label="History of this file" title="History of this file" onClick={menu.toggle}>
        <History size={15} strokeWidth={1.8} />
      </button>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={320}>
        {blame && (
          <>
            <div className="menu__label">Line {line}</div>
            <MenuItem
              icon={<GitCommitHorizontal size={15} strokeWidth={1.8} />}
              title={blameLabel(blame)}
              description={blame.committed ? `${blame.short}: last changed this line` : 'Changed since the last commit'}
              disabled={!blame.committed}
              onClick={() => {
                menu.close()
                showCommit(place.store, blame.sha, blame.short, blame.subject, rel)
              }}
            />
          </>
        )}
        <div className="menu__label">History of {rel.split('/').pop()}</div>
        {commits === null ? (
          <div className="menu__empty">
            <Loader2 size={13} className="spinner" /> Reading the history…
          </div>
        ) : commits.length === 0 ? (
          <div className="menu__empty">{problem ?? 'No commit has touched this file yet.'}</div>
        ) : (
          commits.map((c) => (
            <MenuItem
              key={c.sha}
              icon={<GitCommitHorizontal size={15} strokeWidth={1.8} />}
              title={c.subject || c.short}
              description={`${c.short} · ${c.author} · ${ago(c.at)}${c.local ? ' · not pushed' : ''}`}
              onClick={() => {
                menu.close()
                showCommit(place.store, c.sha, c.short, c.subject, rel)
              }}
            />
          ))
        )}
      </Popover>
    </>
  )
}
