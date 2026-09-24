import { type JSX } from 'react'
import { Hammer, MessagesSquare, SquareTerminal } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../state/store'
import type { Workspace } from '@shared/types'

/**
 * Chat ⇄ Work ⇄ Code, in the top bar.
 *
 * A segmented control rather than a dropdown: all three destinations are
 * always visible and switching is one click. Each is a workspace, so each
 * keeps its own chat list.
 *
 * - Chat is the plain assistant; its only tool is web search.
 * - Work is the agent — files, shell, browser, plugins, computer use.
 * - Code is a front end for an Eaon Code session in a project folder.
 */
const TABS: { kind: Workspace['kind']; label: string; Icon: typeof Hammer }[] = [
  { kind: 'chat', label: 'Chat', Icon: MessagesSquare },
  { kind: 'work', label: 'Work', Icon: Hammer },
  { kind: 'code', label: 'Code', Icon: SquareTerminal }
]

export function ModeSwitch(): JSX.Element | null {
  const { workspaces, activeId, setWorkspace, setView, view } = useApp(
    useShallow((s) => ({
      workspaces: s.workspaces,
      activeId: s.settings?.activeWorkspaceId,
      setWorkspace: s.setWorkspace,
      setView: s.setView,
      view: s.view
    }))
  )

  const tabs = TABS.map((tab) => ({ ...tab, workspace: workspaces.find((w) => w.kind === tab.kind) })).filter(
    (tab): tab is typeof tab & { workspace: Workspace } => Boolean(tab.workspace)
  )
  // Mid-migration an install can briefly hold fewer; half a switch reads as
  // broken, so show none.
  if (tabs.length < 2) return null

  return (
    <div className="mode-switch" role="tablist" aria-label="Mode">
      {tabs.map(({ workspace, label, Icon }) => (
        <button
          key={workspace.id}
          role="tab"
          className="mode-switch__option"
          aria-selected={workspace.id === activeId}
          data-active={workspace.id === activeId || undefined}
          onClick={() => {
            if (workspace.id !== activeId) setWorkspace(workspace.id)
            // Switching mode from a full-page view (Plugins, Models) lands on
            // that mode's home rather than leaving the page up.
            if (view !== 'chat') setView('chat')
          }}
        >
          <Icon size={15} strokeWidth={2} />
          {label}
        </button>
      ))}
    </div>
  )
}
