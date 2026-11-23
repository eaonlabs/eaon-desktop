import type { JSX } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useApp } from '../../state/store'
import { APP_TABS, shownTabs, TAB_HINT, TAB_LABEL, type AppTab } from '@shared/tabs'
import { effectiveBinding, formatBinding } from '@shared/keybindings'
import { isMac } from '../../lib/platform'
import { TAB_ICON } from '../ModeSwitch'
import { Switch } from '../ui'
import '../../styles/tabsPicker.css'

/**
 * Which tabs the top bar has, and in what order: the ones shown first, in
 * their order, each with arrows to move it; the hidden ones after, dimmed.
 * One stays shown. Settings → General → Tabs and the first-run setup.
 */
export function TabsPicker(): JSX.Element {
  const setting = useApp((s) => s.settings?.general.tabs)
  const patchSettings = useApp((s) => s.patchSettings)
  const shortcuts = useApp((s) => s.settings?.shortcuts)
  const shown = shownTabs(setting)
  const hidden = APP_TABS.filter((tab) => !shown.includes(tab))
  const save = (tabs: AppTab[]): void => void patchSettings({ general: { tabs } })
  const move = (tab: AppTab, by: -1 | 1): void => {
    const next = [...shown]
    const at = next.indexOf(tab)
    next.splice(at, 1)
    next.splice(at + by, 0, tab)
    save(next)
  }

  return (
    <ol className="tabs-pick" aria-label="Tabs">
      {[...shown, ...hidden].map((tab) => {
        const on = shown.includes(tab)
        const place = shown.indexOf(tab)
        // Its key goes with its place: ⌘1 is whichever tab is first.
        const keys = on ? formatBinding(effectiveBinding(`tab-${place + 1}`, shortcuts, isMac), isMac) : ''
        return (
          <li key={tab} className="tabs-pick__row" data-off={on ? undefined : true}>
            <span className="tabs-pick__icon" aria-hidden>
              {TAB_ICON[tab](16)}
            </span>
            <span className="tabs-pick__body">
              <span className="tabs-pick__name">
                {TAB_LABEL[tab]}
                {keys && <kbd className="tabs-pick__key">{keys}</kbd>}
              </span>
              <span className="tabs-pick__hint">{TAB_HINT[tab]}</span>
            </span>
            {on && (
              <span className="tabs-pick__moves">
                <button type="button" className="icon-btn tabs-pick__move" aria-label={`Move ${TAB_LABEL[tab]} up`} title="Move up" disabled={place === 0} onClick={() => move(tab, -1)}>
                  <ArrowUp size={14} strokeWidth={2} />
                </button>
                <button
                  type="button"
                  className="icon-btn tabs-pick__move"
                  aria-label={`Move ${TAB_LABEL[tab]} down`}
                  title="Move down"
                  disabled={place === shown.length - 1}
                  onClick={() => move(tab, 1)}
                >
                  <ArrowDown size={14} strokeWidth={2} />
                </button>
              </span>
            )}
            <span title={on && shown.length === 1 ? 'One tab stays' : undefined}>
              <Switch
                label={`Show ${TAB_LABEL[tab]}`}
                checked={on}
                disabled={on && shown.length === 1}
                onChange={(next) => save(next ? [...shown, tab] : shown.filter((t) => t !== tab))}
              />
            </span>
          </li>
        )
      })}
    </ol>
  )
}
