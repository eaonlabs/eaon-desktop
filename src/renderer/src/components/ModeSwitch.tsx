import { type JSX } from 'react'
import { Code2, MessagesSquare, SquareTerminal } from 'lucide-react'
import { useApp, useTabs } from '../state/store'
import { useWorkers } from './workers/workersStore'
import { effectiveBinding, formatBinding } from '@shared/keybindings'
import { TAB_HINT, TAB_LABEL, type AppTab } from '@shared/tabs'
import { isMac } from '../lib/platform'

/**
 * The tabs, centred in the top bar of every screen: the ones picked in
 * Settings → General → Tabs, in that order.
 *
 * A segmented control rather than a dropdown: every destination is always
 * visible and switching is one click.
 *
 * - Chat is the assistant, and an agent underneath: files, shell, browser and
 *   plugins, with the extra controls tucked behind the composer's + button.
 * - The IDE is coding in a project: a chat working in its folder, the code
 *   panel beside it.
 * - Workers are the always-on agents, each with its own face and thread.
 * - ADE is the agentic development environment: coding agents in terminals.
 */
export const TAB_ICON: Record<AppTab, (size: number) => JSX.Element> = {
  chat: (size) => <MessagesSquare size={size} strokeWidth={2} />,
  ide: (size) => <Code2 size={size} strokeWidth={2} />,
  workers: (size) => <WorkersGlyph size={size} strokeWidth={2} />,
  ade: (size) => <SquareTerminal size={size} strokeWidth={2} />
}

export function ModeSwitch(): JSX.Element | null {
  const { tabs, active } = useTabs()
  const setTab = useApp((s) => s.setTab)
  const setView = useApp((s) => s.setView)
  const view = useApp((s) => s.view)
  const shortcuts = useApp((s) => s.settings?.shortcuts)
  // A worker waiting on the user is worth a dot on its tab from anywhere in the app.
  const workersAttention = useWorkers((s) => s.workers.some((w) => w.unread > 0 || w.status === 'failed'))

  // One tab is nowhere to switch to.
  if (tabs.length < 2) return null

  return (
    <div className="mode-switch" role="tablist" aria-label="Mode">
      {tabs.map((tab, place) => {
        const on = tab === active
        // ⌘1–⌘4 by place (lib/keys.ts), unless changed in Settings → Keyboard shortcuts.
        const keys = formatBinding(effectiveBinding(`tab-${place + 1}`, shortcuts, isMac), isMac)
        return (
          <button
            key={tab}
            role="tab"
            className="mode-switch__option"
            aria-selected={on}
            data-active={on || undefined}
            data-tab={tab}
            title={`${TAB_LABEL[tab]}: ${TAB_HINT[tab]}${keys ? ` (${keys})` : ''}`}
            onClick={() => {
              if (!on) setTab(tab)
              // Switching mode from a full-page view (Plugins, Models) lands on
              // that mode's home rather than leaving the page up.
              if (view !== 'chat') setView('chat')
            }}
          >
            {TAB_ICON[tab](15)}
            <span className="mode-switch__label">{TAB_LABEL[tab]}</span>
            {tab === 'workers' && workersAttention && !on && <span className="mode-switch__dot" role="img" aria-label="Needs attention" />}
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
