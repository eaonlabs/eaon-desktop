import { useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Maximize2,
  MoreVertical,
  PanelRight,
  Plus,
  RefreshCw,
  X
} from 'lucide-react'
import { useApp } from '../state/store'
import { BrandIcon } from '../icons/brand'
import { MenuItem, Popover, useDisclosure } from './ui'

interface Tab {
  id: string
  title: string
  url: string
}

const newTab = (): Tab => ({ id: Math.random().toString(36).slice(2), title: 'New tab', url: '' })

/** The in-app browser shown beside the conversation. */
export function BrowserPanel(): JSX.Element {
  const { settings, patchSettings, toggleBrowser } = useApp(useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings, toggleBrowser: s.toggleBrowser })))
  const [tabs, setTabs] = useState<Tab[]>([newTab()])
  const [activeId, setActiveId] = useState(tabs[0].id)
  const [draft, setDraft] = useState('')
  const menuAnchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const view = useRef<Electron.WebviewTag | null>(null)

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]
  const showBanner = !settings?.browser.dismissedImportBanner

  const commit = (value: string): void => {
    const trimmed = value.trim()
    if (!trimmed) return
    const url = /^[a-z]+:\/\//i.test(trimmed)
      ? trimmed
      : /^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(trimmed)
        ? `https://${trimmed}`
        : `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`
    setTabs((all) => all.map((t) => (t.id === active.id ? { ...t, url, title: hostOf(url) } : t)))
  }

  return (
    <div className="browser">
      <div className="browser__tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className="browser__tab"
            data-active={tab.id === activeId}
            onClick={() => {
              setActiveId(tab.id)
              setDraft(tab.url)
            }}
          >
            <Globe size={13} strokeWidth={1.9} />
            <span className="browser__tab-label">{tab.title}</span>
            <span
              className="browser__tab-close"
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation()
                setTabs((all) => {
                  const next = all.filter((t) => t.id !== tab.id)
                  const result = next.length ? next : [newTab()]
                  if (tab.id === activeId) setActiveId(result[0].id)
                  return result
                })
              }}
            >
              <X size={12} strokeWidth={2.2} />
            </span>
          </button>
        ))}
        <button
          className="icon-btn"
          aria-label="New tab"
          onClick={() => {
            const tab = newTab()
            setTabs((all) => [...all, tab])
            setActiveId(tab.id)
            setDraft('')
          }}
        >
          <Plus size={15} strokeWidth={2} />
        </button>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" aria-label="Expand">
          <Maximize2 size={14} strokeWidth={1.9} />
        </button>
        <button className="icon-btn" data-active onClick={() => toggleBrowser(false)} aria-label="Close panel">
          <PanelRight size={16} strokeWidth={1.9} />
        </button>
      </div>

      <div className="browser__toolbar">
        <button className="icon-btn" onClick={() => view.current?.goBack()} aria-label="Back">
          <ArrowLeft size={16} strokeWidth={1.9} />
        </button>
        <button className="icon-btn" onClick={() => view.current?.goForward()} aria-label="Forward">
          <ArrowRight size={16} strokeWidth={1.9} />
        </button>
        <button className="icon-btn" onClick={() => view.current?.reload()} aria-label="Reload">
          <RefreshCw size={15} strokeWidth={1.9} />
        </button>
        <div className="browser__url">
          <input
            value={draft}
            placeholder="Enter a URL"
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && commit(draft)}
          />
          <button
            className="icon-btn"
            aria-label="Open externally"
            onClick={() => active.url && void window.api.app.openExternal(active.url)}
          >
            <ExternalLink size={14} strokeWidth={1.9} />
          </button>
        </div>
        <button ref={menuAnchor} className="icon-btn" onClick={menu.toggle} aria-label="Browser menu">
          <MoreVertical size={16} strokeWidth={1.9} />
        </button>
        <Popover anchor={menuAnchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={210}>
          <MenuItem
            title="Open in default browser"
            onClick={() => {
              if (active.url) void window.api.app.openExternal(active.url)
              menu.close()
            }}
          />
          <MenuItem
            title="Clear this tab"
            onClick={() => {
              setTabs((all) => all.map((t) => (t.id === active.id ? { ...t, url: '', title: 'New tab' } : t)))
              setDraft('')
              menu.close()
            }}
          />
        </Popover>
      </div>

      {showBanner && (
        <div className="browser__banner">
          <BrandIcon id="chrome" size={30} />
          <div className="browser__banner-body">
            <div className="browser__banner-title">Import data from Chrome</div>
            <div className="browser__banner-desc">Bring over your passwords and cookies to the built-in browser</div>
          </div>
          <button
            className="btn btn--sm"
            onClick={() => void patchSettings({ browser: { importedFromChrome: true, dismissedImportBanner: true } })}
          >
            Import
          </button>
          <button
            className="icon-btn"
            aria-label="Dismiss"
            onClick={() => void patchSettings({ browser: { dismissedImportBanner: true } })}
          >
            <X size={15} strokeWidth={2} />
          </button>
        </div>
      )}

      <div className="browser__view">
        {active.url ? (
          <webview
            ref={(node) => (view.current = node as Electron.WebviewTag | null)}
            src={active.url}
            style={{ flex: 1 }}
            // eslint-disable-next-line react/no-unknown-property
            allowpopups={'true' as unknown as boolean}
          />
        ) : (
          <div className="empty-state">
            <span className="empty-state__icon">
              <Globe size={30} strokeWidth={1.6} />
            </span>
            <span className="empty-state__title">Start browsing</span>
            <span className="empty-state__body">Enter a URL to open a page</span>
          </div>
        )}
      </div>
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'New tab'
  }
}
