import { useEffect, useRef, useState, type JSX } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, Cloud, GitBranch, GitBranchPlus, Loader2 } from 'lucide-react'
import type { ChatBranch, ChatGitResult } from '@shared/chatCode'
import { MenuItem, MenuSearch, MenuSeparator, Popover, useDisclosure } from '../ui'
import { notify } from '../Notice'
import { useApp } from '../../state/store'
import { useChatCode } from './chatCodeStore'

/** "3 days ago", short. */
function ago(at: number): string {
  const s = Math.max(0, (Date.now() - at) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`
  return `${Math.floor(s / (86400 * 365))}y`
}

/** Git's rules for a branch name, near enough to say so before git does. */
const validName = (name: string): boolean =>
  /^[\w.][\w./-]{0,250}$/.test(name) && !name.includes('..') && !name.endsWith('/') && !name.endsWith('.lock') && !name.includes('//')

/**
 * The branch pill beside the folder above the message box: the branch the
 * folder is on, how far it is from its upstream, and a menu to switch to
 * another branch, make one, push or pull. Hidden outside git.
 */
export function BranchPicker({ row = false }: { row?: boolean } = {}): JSX.Element | null {
  const folder = useChatCode((s) => s.folder)
  const status = useChatCode((s) => s.status)
  const streaming = useApp((s) => s.streamingMessageId !== null)
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const [query, setQuery] = useState('')
  const [list, setList] = useState<ChatBranch[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (!menu.open || !folder) return
    setQuery('')
    setList(null)
    window.api.chatCode
      .branches(folder)
      .then((res) => setList(res.branches))
      .catch(() => setList([]))
  }, [menu.open, folder])

  if (!folder || !status?.repo) return null

  const act = async (label: string, run: () => Promise<ChatGitResult>): Promise<void> => {
    setBusy(label)
    try {
      const res = await run()
      if (res.ok) notify(res.message ?? 'Done.')
      else notify(res.error, 'error')
    } catch (e) {
      notify(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e), 'error')
    } finally {
      setBusy(null)
      menu.close()
      void useChatCode.getState().refresh()
    }
  }

  const name = status.branch ?? (status.detached ? `at ${status.detached}` : 'no branch')
  const q = query.trim()
  const shown = (list ?? []).filter((b) => !q || b.name.toLowerCase().includes(q.toLowerCase())).slice(0, 80)
  const canCreate = q && validName(q) && !(list ?? []).some((b) => b.name === q)

  const sync = (
    <>
      {status.ahead > 0 && (
        <span className="branch-sync" title={`${status.ahead} to push`}>
          <ArrowUp size={11} strokeWidth={2.4} />
          {status.ahead}
        </span>
      )}
      {status.behind > 0 && (
        <span className="branch-sync" title={`${status.behind} to pull`}>
          <ArrowDown size={11} strokeWidth={2.4} />
          {status.behind}
        </span>
      )}
    </>
  )

  return (
    <>
      {row ? (
        <button ref={anchor} className="ws-row" data-open={menu.open || undefined} onClick={menu.toggle} title={status.upstream ? `${name}, tracking ${status.upstream}` : name}>
          <span className="ws-row__icon">
            <GitBranch size={15} strokeWidth={1.8} />
          </span>
          <span className="ws-row__label">{name}</span>
          <span className="ws-row__meta">{sync}</span>
          <ChevronDown size={14} strokeWidth={2} className="ws-row__chev" />
        </button>
      ) : (
      <button
        ref={anchor}
        className="composer-pill composer-pill--branch"
        data-open={menu.open || undefined}
        onClick={menu.toggle}
        title={status.upstream ? `${name}, tracking ${status.upstream}` : name}
      >
        <GitBranch size={14} strokeWidth={1.9} />
        <span className="composer-pill__label">{name}</span>
        {status.ahead > 0 && (
          <span className="branch-sync" title={`${status.ahead} to push`}>
            <ArrowUp size={11} strokeWidth={2.4} />
            {status.ahead}
          </span>
        )}
        {status.behind > 0 && (
          <span className="branch-sync" title={`${status.behind} to pull`}>
            <ArrowDown size={11} strokeWidth={2.4} />
            {status.behind}
          </span>
        )}
      </button>
      )}
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement={row ? 'bottom-end' : 'top-start'} width={320} className="branch-menu">
        <MenuSearch value={query} onChange={setQuery} placeholder="Find or make a branch" />
        {streaming && <div className="menu__note">Eaon is working in this folder. Switching branches now changes the files under it.</div>}
        {(status.ahead > 0 || status.behind > 0 || (status.remote && !status.upstream && status.branch)) && (
          <>
            {status.behind > 0 && (
              <MenuItem
                icon={busy === 'pull' ? <Loader2 size={15} className="spinner" /> : <ArrowDown size={15} strokeWidth={1.9} />}
                title={`Pull ${status.behind} ${status.behind === 1 ? 'commit' : 'commits'}`}
                description={status.upstream ?? undefined}
                disabled={busy !== null}
                onClick={() => void act('pull', () => window.api.chatCode.pull(folder))}
              />
            )}
            {(status.ahead > 0 || !status.upstream) && status.remote && (
              <MenuItem
                icon={busy === 'push' ? <Loader2 size={15} className="spinner" /> : <ArrowUp size={15} strokeWidth={1.9} />}
                title={status.upstream ? `Push ${status.ahead} ${status.ahead === 1 ? 'commit' : 'commits'}` : 'Publish branch'}
                description={status.upstream ?? `to origin/${status.branch}`}
                disabled={busy !== null}
                onClick={() => void act('push', () => window.api.ade.push(folder))}
              />
            )}
            <MenuSeparator />
          </>
        )}
        {canCreate && (
          <MenuItem
            icon={busy === 'create' ? <Loader2 size={15} className="spinner" /> : <GitBranchPlus size={15} strokeWidth={1.9} />}
            title={`Make branch “${q}”`}
            description={`From ${name}, keeping your changes`}
            disabled={busy !== null}
            onClick={() => void act('create', () => window.api.chatCode.switchBranch(folder, q, true))}
          />
        )}
        <div className="menu__label">Branches</div>
        {list === null ? (
          <div className="menu__empty">
            <Loader2 size={14} className="spinner" /> Reading branches…
          </div>
        ) : shown.length === 0 ? (
          <div className="menu__empty">{q ? 'No branch by that name' : 'No branches yet'}</div>
        ) : (
          <div className="branch-menu__list">
            {shown.map((b) => (
              <MenuItem
                key={`${b.name}${b.remoteOnly ? ':remote' : ''}`}
                icon={b.remoteOnly ? <Cloud size={15} strokeWidth={1.8} /> : <GitBranch size={15} strokeWidth={1.8} />}
                title={b.name}
                hint={b.at ? ago(b.at) : undefined}
                description={b.remoteOnly ? 'On origin only' : undefined}
                checked={b.name === status.branch}
                disabled={busy !== null}
                onClick={() => {
                  if (b.name === status.branch) return menu.close()
                  void act(`switch:${b.name}`, () => window.api.chatCode.switchBranch(folder, b.name))
                }}
              />
            ))}
          </div>
        )}
      </Popover>
    </>
  )
}
