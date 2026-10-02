import type { ReactNode } from 'react'
import { useApp } from '../state/store'
import { CollapsedNav } from './CollapsedNav'
import { ModeSwitch } from './ModeSwitch'

/**
 * The top row of every screen: whatever the screen puts on the left, the
 * Chat / Workers / ADE switch dead centre, and the screen's actions on the
 * right.
 *
 * A three-column grid (1fr · auto · 1fr) rather than an absolutely centred
 * switch: the side columns are always equal, so the switch stays centred in
 * the window, and when space runs out a long chat title ellipsises instead of
 * sliding underneath it. `variant` keeps each screen's existing row class —
 * `.chat-header` or `.page__bar` — for its padding and drag region.
 */
export function TopBar({
  left,
  right,
  variant = 'chat-header',
  className
}: {
  left?: ReactNode
  right?: ReactNode
  variant?: 'chat-header' | 'page__bar'
  className?: string
}): JSX.Element {
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  return (
    <div className={`${variant} topbar ${className ?? ''}`} data-collapsed={!sidebarOpen || undefined}>
      <div className="topbar__side topbar__side--left">
        {!sidebarOpen && <CollapsedNav />}
        {left}
      </div>
      <ModeSwitch />
      <div className="topbar__side topbar__side--right">{right}</div>
    </div>
  )
}
