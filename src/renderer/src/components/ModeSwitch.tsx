import { type JSX } from 'react'
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
  chat: (size) => <ChatGlyph size={size} strokeWidth={2} />,
  ide: (size) => <IdeGlyph size={size} strokeWidth={2} />,
  workers: (size) => <WorkersGlyph size={size} strokeWidth={2} />,
  ade: (size) => <AdeGlyph size={size} strokeWidth={2} />
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

/*
 * The tabs' marks, one family on lucide's 24-unit grid: a line outline and,
 * in all but the IDE's, a small filled mark inside it, as the worker's eyes.
 */
type GlyphProps = { size: number; strokeWidth: number }
const GLYPH = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

/** Chat: a speech bubble with someone typing in it. */
export function ChatGlyph({ size, strokeWidth }: GlyphProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth={strokeWidth} {...GLYPH}>
      <path d="M9.5 17H16a5 5 0 0 0 5-5V9a5 5 0 0 0-5-5H8a5 5 0 0 0-5 5v3a5 5 0 0 0 2.5 4.33V20.2Z" />
      <circle cx="8.2" cy="10.5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="10.5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15.8" cy="10.5" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** The IDE: code in a window. */
export function IdeGlyph({ size, strokeWidth }: GlyphProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth={strokeWidth} {...GLYPH}>
      <rect x="3" y="4" width="18" height="16" rx="4" />
      <path d="m10 9.5-2.5 2.5 2.5 2.5" />
      <path d="m14 9.5 2.5 2.5-2.5 2.5" />
    </svg>
  )
}

/** The ADE: terminals stacked, an agent's prompt and cursor in the front one. */
export function AdeGlyph({ size, strokeWidth }: GlyphProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth={strokeWidth} {...GLYPH}>
      <path d="M7 7V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
      <rect x="3" y="7" width="14" height="13" rx="3" />
      <path d="m6.5 11.5 2.2 2-2.2 2" />
      <rect x="10.6" y="14.3" width="3.6" height="2.4" rx="1.2" fill="currentColor" stroke="none" />
    </svg>
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
