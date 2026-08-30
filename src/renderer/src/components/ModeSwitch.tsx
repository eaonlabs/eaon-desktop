import { type JSX } from 'react'
import { Hammer, MessagesSquare } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../state/store'

/**
 * Chat ⇄ Work, in the top bar.
 *
 * Two modes rather than a list, so this is a segmented control and not the
 * dropdown the old free-form workspaces needed: both destinations are always
 * visible, and switching is one click instead of two.
 *
 * Work mode is what turns the agent's tools on — `cwd` is only non-null there,
 * and `localToolsFor(null)` hands back an empty tool list everywhere else.
 */
export function ModeSwitch(): JSX.Element | null {
  const { workspaces, activeId, setWorkspace } = useApp(
    useShallow((s) => ({
      workspaces: s.workspaces,
      activeId: s.settings?.activeWorkspaceId,
      setWorkspace: s.setWorkspace
    }))
  )

  const chat = workspaces.find((w) => w.kind !== 'work')
  const work = workspaces.find((w) => w.kind === 'work')
  // Mid-migration an install can briefly hold only one; half a switch reads as
  // broken, so show none.
  if (!chat || !work) return null

  return (
    <div className="mode-switch" role="tablist" aria-label="Mode">
      {[
        { workspace: chat, label: 'Chat', Icon: MessagesSquare },
        { workspace: work, label: 'Work', Icon: Hammer }
      ].map(({ workspace, label, Icon }) => (
        <button
          key={workspace.id}
          role="tab"
          className="mode-switch__option"
          aria-selected={workspace.id === activeId}
          data-active={workspace.id === activeId || undefined}
          onClick={() => setWorkspace(workspace.id)}
        >
          <Icon size={15} strokeWidth={2} />
          {label}
        </button>
      ))}
    </div>
  )
}
