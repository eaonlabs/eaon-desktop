import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { CreditCard, HardDrive, Mail, MessagesSquare, type LucideIcon } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../../../state/store'
import { ErrorBoundary } from '../../ErrorBoundary'
import { SettingsPageError } from '../../CrashScreen'
import { PaymentsPage } from './Payments'
import { ChatAppsPage } from './ChatApps'
import { EmailPage } from './Email'
import { WorkerComputerPage } from './WorkerComputer'

/**
 * Settings → Workers: what workers use beyond Eaon, on one page with a tab
 * each. A tab keeps the page id it had as a page of its own, so a link to it
 * (the purchase dialog, the Workers sidebar, the control API) still opens it;
 * `workers` alone opens the tab looked at last.
 */

export interface WorkerTab {
  id: string
  label: string
  icon: LucideIcon
  page: () => JSX.Element
}

export const WORKER_TABS: WorkerTab[] = [
  { id: 'payments', label: 'Payments', icon: CreditCard, page: PaymentsPage },
  { id: 'chat-apps', label: 'Chat apps', icon: MessagesSquare, page: ChatAppsPage },
  { id: 'email', label: 'Email', icon: Mail, page: EmailPage },
  { id: 'worker-computer', label: 'Worker computer', icon: HardDrive, page: WorkerComputerPage }
]

const TAB_KEY = 'eaon.settings.workersTab'

function rememberedTab(): string | null {
  try {
    return localStorage.getItem(TAB_KEY)
  } catch {
    return null
  }
}

/** `blocked`: tabs an organization's policy turned off, which aren't shown. */
export function WorkersPage({ blocked }: { blocked?: ReadonlySet<string> }): JSX.Element {
  const { settingsPage, setSettingsPage } = useApp(useShallow((s) => ({ settingsPage: s.settingsPage, setSettingsPage: s.setSettingsPage })))
  const tabs = WORKER_TABS.filter((t) => !blocked?.has(t.id))
  const tab = tabs.find((t) => t.id === settingsPage) ?? tabs.find((t) => t.id === rememberedTab()) ?? tabs[0]

  useEffect(() => {
    try {
      if (tab) localStorage.setItem(TAB_KEY, tab.id)
    } catch {
      // Not remembered; Workers opens on its first tab next time.
    }
  }, [tab])

  return (
    <>
      <h1 className="settings__h1">Workers</h1>
      {tab && (
        <>
          <Tabs tabs={tabs} active={tab.id} onPick={setSettingsPage} />
          <div key={tab.id} role="tabpanel" id="workers-panel" aria-labelledby={`workers-tab-${tab.id}`} className="settings-tabpanel">
            <ErrorBoundary resetKey={tab.id} area={`settings: ${tab.id}`} fallback={(error, retry) => <SettingsPageError error={error} retry={retry} />}>
              <tab.page />
            </ErrorBoundary>
          </div>
        </>
      )}
    </>
  )
}

/** The tab row, with a bar under the open tab that slides to the next one. */
function Tabs({ tabs, active, onPick }: { tabs: WorkerTab[]; active: string; onPick: (id: string) => void }): JSX.Element {
  const list = useRef<HTMLDivElement>(null)
  const [bar, setBar] = useState<{ x: number; width: number } | null>(null)

  useLayoutEffect(() => {
    const row = list.current
    if (!row) return
    const place = (): void => {
      const button = row.querySelector<HTMLElement>(`[data-tab="${active}"]`)
      if (button) setBar({ x: button.offsetLeft, width: button.offsetWidth })
    }
    place()
    // A font that loads late, or a larger text size, changes the tabs' widths.
    const observer = new ResizeObserver(place)
    for (const child of row.children) observer.observe(child)
    return () => observer.disconnect()
  }, [active, tabs.length])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const at = tabs.findIndex((t) => t.id === active)
    const next =
      event.key === 'ArrowRight' ? (at + 1) % tabs.length : event.key === 'ArrowLeft' ? (at - 1 + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
    if (next === -1) return
    event.preventDefault()
    onPick(tabs[next].id)
    list.current?.querySelector<HTMLElement>(`[data-tab="${tabs[next].id}"]`)?.focus()
  }

  return (
    <div ref={list} className="settings-tabs" role="tablist" aria-label="Workers settings" onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`workers-tab-${t.id}`}
          data-tab={t.id}
          aria-selected={t.id === active}
          aria-controls="workers-panel"
          tabIndex={t.id === active ? 0 : -1}
          className="settings-tabs__tab"
          onClick={() => onPick(t.id)}
        >
          <t.icon size={14} strokeWidth={1.9} aria-hidden />
          {t.label}
        </button>
      ))}
      {bar && <span className="settings-tabs__bar" style={{ transform: `translateX(${bar.x}px)`, width: bar.width }} aria-hidden />}
    </div>
  )
}
