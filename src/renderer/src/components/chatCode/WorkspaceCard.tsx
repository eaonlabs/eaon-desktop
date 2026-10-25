import { useEffect, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { FileDiff as FileDiffIcon, SquareMenu } from 'lucide-react'
import { ProjectPicker } from '../composer/ComposerBits'
import { useChatChanges } from '../ide/changes'
import { useIde } from '../ide/ideStore'
import { BranchPicker } from './BranchPicker'
import { useChatCode } from './chatCodeStore'
import { OpenInButton, ScriptsButton } from './CodeTools'
import { DiffStat } from './diff/DiffCard'
import { GitActions } from './GitActions'

/**
 * The workspace card beside a conversation: where the agent works and what
 * to do with it, out of the top bar and off the message box. Its first part
 * is the folder, Open in an editor and the project's scripts; its second the
 * branch, the next Git step and the changes. Where the window has room it
 * sits to the right of the conversation, which moves over for it; where it
 * hasn't, the top bar's toggle opens it over the conversation until a click
 * elsewhere.
 */

/** The main area's width from which the card sits beside the conversation rather than over it. */
const ROOM = 920

/** Whether the main area has room for the card beside the conversation. */
export function useCardRoom(): boolean {
  const [wide, setWide] = useState(() => (document.querySelector<HTMLElement>('.main')?.clientWidth ?? window.innerWidth) >= ROOM)
  useEffect(() => {
    const main = document.querySelector<HTMLElement>('.main')
    if (!main) return
    const observer = new ResizeObserver(() => setWide(main.clientWidth >= ROOM))
    observer.observe(main)
    return () => observer.disconnect()
  }, [])
  return wide
}

/** The card is beside the conversation now: the conversation leaves it room. */
export function useCardInline(): boolean {
  const wide = useCardRoom()
  const open = useChatCode((s) => s.cardOpen)
  return wide && open
}

/** `over`: only ever over the page, as on the start page, which keeps no room beside it. */
export function WorkspaceCard({ over = false }: { over?: boolean } = {}): JSX.Element | null {
  const { cardOpen, cardPeek, setCardPeek, folder, repo } = useChatCode(
    useShallow((s) => ({ cardOpen: s.cardOpen, cardPeek: s.cardPeek, setCardPeek: s.setCardPeek, folder: s.folder, repo: Boolean(s.status?.repo) }))
  )
  const wide = useCardRoom() && !over
  const showing = wide ? cardOpen : cardPeek

  // Over the conversation, a click elsewhere or Escape puts it away; its own menus and dialogs don't.
  useEffect(() => {
    if (wide || !cardPeek) return
    const onDown = (e: PointerEvent): void => {
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('.ws-card, .menu, .popover, [role="dialog"], .ws-toggle')) return
      setCardPeek(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !document.querySelector('.menu, [role="dialog"]')) setCardPeek(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [wide, cardPeek, setCardPeek])

  if (!showing) return null
  return (
    <aside className="ws-card" data-mode={wide ? 'beside' : 'over'} aria-label="Workspace">
      <div className="ws-card__part">
        <ProjectPicker row />
        {folder && <OpenInButton row />}
        {folder && <ScriptsButton place="card" />}
      </div>
      {folder && <VersionPart repo={repo} />}
    </aside>
  )
}

function VersionPart({ repo }: { repo: boolean }): JSX.Element | null {
  const changes = useChatChanges()
  const git = useChatCode((s) => s.status?.changes ?? null)
  const counts = changes.files > 0 ? { added: changes.added, removed: changes.removed } : git && git.files > 0 ? { added: git.added, removed: git.removed } : null
  if (!repo && !counts) return null
  return (
    <div className="ws-card__part">
      {repo && <BranchPicker row />}
      {repo && <GitActions row />}
      {counts && (
        <button
          type="button"
          className="ws-row"
          title="Review the changes"
          onClick={() => useIde.getState().reviewChanges(changes.files > 0 ? { kind: 'chat' } : { kind: 'git' })}
        >
          <span className="ws-row__icon">
            <FileDiffIcon size={15} strokeWidth={1.8} />
          </span>
          <span className="ws-row__label">Changes</span>
          <DiffStat added={counts.added} removed={counts.removed} className="ws-row__meta" />
        </button>
      )}
    </div>
  )
}

/** The top bar's button for the card: beside the conversation it shows and hides it; without the room, it opens it over. */
export function WorkspaceToggle({ over = false }: { over?: boolean } = {}): JSX.Element {
  const wide = useCardRoom() && !over
  const { cardOpen, cardPeek, toggleCard } = useChatCode(useShallow((s) => ({ cardOpen: s.cardOpen, cardPeek: s.cardPeek, toggleCard: s.toggleCard })))
  const showing = wide ? cardOpen : cardPeek
  return (
    <button
      type="button"
      className="dock-tool ws-toggle"
      data-active={showing || undefined}
      aria-pressed={showing}
      aria-label="Workspace"
      title={showing ? 'Hide the workspace card' : 'Show the workspace card: folder, editor, scripts, branch and Git'}
      onClick={() => toggleCard(wide)}
    >
      <SquareMenu size={15} strokeWidth={1.8} />
    </button>
  )
}
