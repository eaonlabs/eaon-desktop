import { useEffect, useRef, useState, type JSX } from 'react'
import { GitCommitHorizontal, History, Loader2 } from 'lucide-react'
import type { ChatCommit } from '@shared/chatCode'
import { blameLabel, type LineBlame } from '@shared/fileHistory'
import { ago } from '@shared/modelSelection'
import { MenuItem, Popover, useDisclosure } from '../../ui'
import { useDockPlace } from '../dockPlace'

/**
 * The open file's git history in the editor: a History button listing the
 * commits that touched it (each opens in the Diff, on this file), and, in the
 * status bar, who last changed the line the caret is on. Both are read only,
 * and neither shows outside a git repository.
 */

/** Opens the Diff on one commit, scrolled to the file. */
function showCommit(store: ReturnType<typeof useDockPlace>['store'], sha: string, short: string, subject: string, rel: string): void {
  store.getState().reviewChanges({ kind: 'commit', sha, short, subject }, rel)
}

export function FileHistoryButton({ path, rel }: { path: string; rel: string }): JSX.Element | null {
  const place = useDockPlace()
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const [commits, setCommits] = useState<ChatCommit[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const folder = place.folder
  const repo = Boolean(place.status?.repo)

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

/** Who last changed the caret's line, asked once the caret rests; nothing while the file has edits not saved (git blames the file on disk). */
export function BlameItem({ path, rel, line, ready, version }: { path: string; rel: string; line: number; ready: boolean; version: unknown }): JSX.Element | null {
  const place = useDockPlace()
  const [blame, setBlame] = useState<LineBlame | null>(null)
  const folder = place.folder
  const repo = Boolean(place.status?.repo)
  // A commit moves what a line was last changed by: asked again when git's status changes.
  const moved = `${place.status?.changes?.files ?? ''}:${place.status?.ahead ?? ''}`

  useEffect(() => {
    if (!repo || !folder || !ready) return setBlame(null)
    let live = true
    const timer = window.setTimeout(() => {
      window.api.gitHistory
        .blame(folder, path, line)
        .then((res) => live && setBlame(res.ok ? res.blame : null))
        .catch(() => live && setBlame(null))
    }, 250)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [repo, folder, path, line, ready, version, moved])

  if (!blame) return null
  const label = blameLabel(blame)
  if (!blame.committed) return <span className="file-status__item">{label}</span>
  return (
    <button type="button" className="file-status__item file-status__blame" title={`${blame.short}: ${blame.subject}. Show what this commit changed in the file`} onClick={() => showCommit(place.store, blame.sha, blame.short, blame.subject, rel)}>
      {label}
    </button>
  )
}
