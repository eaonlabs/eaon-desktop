import { type JSX } from 'react'
import { MessagesSquare, SquareTerminal } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../state/store'
import { useWorkers } from './workers/workersStore'
import type { Workspace } from '@shared/types'
import { formatShortcut, isMacPlatform } from '../lib/keys'

/**
 * Chat ⇄ Workers ⇄ ADE, centred in the top bar of every screen.
 *
 * A segmented control rather than a dropdown: all three destinations are
 * always visible and switching is one click. Each is a workspace, so Chat and
 * the ADE keep their own lists.
 *
 * - Chat is the assistant, and an agent underneath: files, shell, browser and
 *   plugins, with the extra controls tucked behind the composer's + button.
 * - Workers are the always-on agents, each with its own face and thread.
 * - ADE is the agentic development environment — an Eaon Code session in a
 *   project folder.
 */
// ⌘1–⌘3 on a Mac, Ctrl+1–3 elsewhere (lib/keys.ts).
const key = (n: string): string => formatShortcut({ modifiers: ['mod'], key: n }, isMacPlatform())
const TABS: { kind: Workspace['kind']; label: string; icon: JSX.Element; hint: string }[] = [
  { kind: 'chat', label: 'Chat', icon: <MessagesSquare size={15} strokeWidth={2} />, hint: `Chat — ask anything, or hand Eaon a task (${key('1')})` },
  { kind: 'workers', label: 'Workers', icon: <WorkersGlyph size={15} strokeWidth={2} />, hint: `Workers — agents that keep working in the background (${key('2')})` },
  { kind: 'code', label: 'ADE', icon: <SquareTerminal size={15} strokeWidth={2} />, hint: `ADE — agentic development environment (${key('3')})` }
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
  // A worker waiting on the user is worth a dot on its tab from anywhere in the app.
  const workersAttention = useWorkers((s) => s.workers.some((w) => w.unread > 0 || w.status === 'failed'))

  const tabs = TABS.map((tab) => ({ ...tab, workspace: workspaces.find((w) => w.kind === tab.kind) })).filter(
    (tab): tab is typeof tab & { workspace: Workspace } => Boolean(tab.workspace)
  )
  // Mid-migration an install can briefly hold fewer; half a switch reads as
  // broken, so show none.
  if (tabs.length < 2) return null

  return (
    <div className="mode-switch" role="tablist" aria-label="Mode">
      {tabs.map(({ workspace, label, icon, hint, kind }) => {
        const active = workspace.id === activeId
        return (
          <button
            key={workspace.id}
            role="tab"
            className="mode-switch__option"
            aria-selected={active}
            data-active={active || undefined}
            title={hint}
            onClick={() => {
              if (!active) setWorkspace(workspace.id)
              // Switching mode from a full-page view (Plugins, Models) lands on
              // that mode's home rather than leaving the page up.
              if (view !== 'chat') setView('chat')
            }}
          >
            {icon}
            <span className="mode-switch__label">{label}</span>
            {kind === 'workers' && workersAttention && !active && <span className="mode-switch__dot" role="img" aria-label="Needs attention" />}
          </button>
        )
      })}
    </div>
  )
}

/** A worker's face as a line icon: the round body and two soft eyes. */
export function WorkersGlyph({ size, strokeWidth }: { size: number; strokeWidth: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" />
      <rect x="8.1" y="8.2" width="2.3" height="5" rx="1.15" fill="currentColor" stroke="none" />
      <rect x="13.6" y="8.2" width="2.3" height="5" rx="1.15" fill="currentColor" stroke="none" />
    </svg>
  )
}
