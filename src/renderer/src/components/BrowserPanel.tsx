import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ArrowLeft, ArrowRight, ExternalLink, Globe, MoreVertical, PanelRight, Plus, RefreshCw, TriangleAlert, X } from 'lucide-react'
import { useApp } from '../state/store'
import { MenuItem, Popover, useDisclosure } from './ui'
import { isSearchEngine, toBrowserUrl } from '../lib/browserUrl'

interface Tab {
  id: string
  title: string
  /** What the webview was told to load. Kept apart from `url` so following the page doesn't reload it. */
  src: string
  /** Where the page is now, after links and redirects; what the address bar shows. */
  url: string
}

/** A page that didn't load: Chromium's error code and text, for the message and the retry. */
interface LoadError {
  url: string
  code: number
  description: string
}

const blankTab = (src = ''): Tab => ({ id: Math.random().toString(36).slice(2), title: src ? hostOf(src) : 'New tab', src, url: src })

/** The in-app browser shown beside the conversation. */
export function BrowserPanel(): JSX.Element {
  const { settings, toggleBrowser } = useApp(useShallow((s) => ({ settings: s.settings, toggleBrowser: s.toggleBrowser })))
  const engine = isSearchEngine(settings?.browser.searchEngine) ? settings.browser.searchEngine : 'DuckDuckGo'
  // The homepage as typed in Settings, read the way the address bar reads a line.
  const homepage = toBrowserUrl(settings?.browser.homepage ?? '', engine) ?? ''
  const [tabs, setTabs] = useState<Tab[]>(() => [blankTab(homepage)])
  const [activeId, setActiveId] = useState(tabs[0].id)
  const [draft, setDraft] = useState(tabs[0].url)
  const [error, setError] = useState<LoadError | null>(null)
  const menuAnchor = useRef<HTMLButtonElement>(null)
  const address = useRef<HTMLInputElement>(null)
  const menu = useDisclosure()
  const view = useRef<Electron.WebviewTag | null>(null)

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]
  const patchTab = (id: string, patch: Partial<Tab>): void => setTabs((all) => all.map((t) => (t.id === id ? { ...t, ...patch } : t)))

  const commit = (value: string): void => {
    const url = toBrowserUrl(value, engine)
    if (!url) return
    setError(null)
    patchTab(active.id, { src: url, url, title: hostOf(url) })
    setDraft(url)
  }

  const openTab = (tab: Tab): void => {
    setActiveId(tab.id)
    setDraft(tab.url)
    setError(null)
  }

  // Follows the page: links and redirects update the address bar and the tab's
  // title, and a page that fails to load says why instead of staying blank.
  useEffect(() => {
    const node = view.current
    if (!node) return
    const id = active.id
    const navigated = (event: Event): void => {
      const url = (event as Event & { url: string }).url
      if (!url) return
      patchTab(id, { url })
      // Not over what someone is typing.
      if (document.activeElement !== address.current) setDraft(url)
    }
    const titled = (event: Event): void => {
      const title = (event as Event & { title: string }).title
      if (title) patchTab(id, { title })
    }
    const failed = (event: Event): void => {
      const e = event as Event & { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean }
      // -3 is ERR_ABORTED: a navigation replaced by another one (a redirect, a new click), not a failure.
      if (!e.isMainFrame || e.errorCode === -3) return
      setError({ url: e.validatedURL, code: e.errorCode, description: e.errorDescription })
    }
    const started = (): void => setError(null)
    node.addEventListener('did-navigate', navigated)
    node.addEventListener('did-navigate-in-page', navigated)
    node.addEventListener('page-title-updated', titled)
    node.addEventListener('did-fail-load', failed)
    node.addEventListener('did-start-loading', started)
    return () => {
      node.removeEventListener('did-navigate', navigated)
      node.removeEventListener('did-navigate-in-page', navigated)
      node.removeEventListener('page-title-updated', titled)
      node.removeEventListener('did-fail-load', failed)
      node.removeEventListener('did-start-loading', started)
    }
  }, [active.id, active.src])

  return (
    <div className="browser">
      <div className="browser__tabs">
        {tabs.map((tab) => (
          <div key={tab.id} className="browser__tab" data-active={tab.id === activeId}>
            <button type="button" className="browser__tab-select" title={tab.url || tab.title} onClick={() => openTab(tab)}>
              <Globe size={13} strokeWidth={1.9} aria-hidden />
              <span className="browser__tab-label">{tab.title}</span>
            </button>
            <button
              type="button"
              className="browser__tab-close"
              aria-label={`Close ${tab.title}`}
              title="Close tab"
              onClick={() => {
                const next = tabs.filter((t) => t.id !== tab.id)
                const result = next.length ? next : [blankTab(homepage)]
                setTabs(result)
                if (tab.id === activeId) openTab(result[0])
              }}
            >
              <X size={12} strokeWidth={2.2} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="icon-btn"
          aria-label="New tab"
          title="New tab"
          onClick={() => {
            const tab = blankTab(homepage)
            setTabs((all) => [...all, tab])
            openTab(tab)
          }}
        >
          <Plus size={15} strokeWidth={2} />
        </button>
        <div style={{ flex: 1 }} />
        <button type="button" className="icon-btn" data-active onClick={() => toggleBrowser(false)} aria-label="Close panel" title="Close panel">
          <PanelRight size={16} strokeWidth={1.9} />
        </button>
      </div>

      <div className="browser__toolbar">
        <button type="button" className="icon-btn" disabled={!active.src} onClick={() => view.current?.goBack()} aria-label="Back" title="Back">
          <ArrowLeft size={16} strokeWidth={1.9} />
        </button>
        <button type="button" className="icon-btn" disabled={!active.src} onClick={() => view.current?.goForward()} aria-label="Forward" title="Forward">
          <ArrowRight size={16} strokeWidth={1.9} />
        </button>
        <button type="button" className="icon-btn" disabled={!active.src} onClick={() => view.current?.reload()} aria-label="Reload" title="Reload">
          <RefreshCw size={15} strokeWidth={1.9} />
        </button>
        <div className="browser__url">
          <input
            ref={address}
            value={draft}
            placeholder={`Search ${engine} or enter a URL`}
            aria-label="Address"
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && commit(draft)}
          />
          <button
            type="button"
            className="icon-btn"
            aria-label="Open in your browser"
            title="Open in your browser"
            disabled={!active.url}
            onClick={() => void window.api.app.openExternal(active.url)}
          >
            <ExternalLink size={14} strokeWidth={1.9} />
          </button>
        </div>
        <button ref={menuAnchor} type="button" className="icon-btn" onClick={menu.toggle} aria-label="Browser menu" title="More">
          <MoreVertical size={16} strokeWidth={1.9} />
        </button>
        <Popover anchor={menuAnchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={210}>
          <MenuItem
            title="Open in default browser"
            disabled={!active.url}
            onClick={() => {
              void window.api.app.openExternal(active.url)
              menu.close()
            }}
          />
          <MenuItem
            title="Clear this tab"
            onClick={() => {
              patchTab(active.id, { src: '', url: '', title: 'New tab' })
              setDraft('')
              setError(null)
              menu.close()
            }}
          />
        </Popover>
      </div>

      <div className="browser__view">
        {active.src && (
          <webview
            ref={(node) => (view.current = node as Electron.WebviewTag | null)}
            src={active.src}
            style={{ flex: 1, display: error ? 'none' : undefined }}
            // eslint-disable-next-line react/no-unknown-property
            allowpopups={'true' as unknown as boolean}
          />
        )}
        {error ? (
          <div className="empty-state" role="alert">
            <span className="empty-state__icon">
              <TriangleAlert size={30} strokeWidth={1.6} />
            </span>
            <span className="empty-state__title">This page didn’t open</span>
            <span className="empty-state__body">{loadErrorText(error)}</span>
            <code className="browser__error-code">{error.description || `Error ${error.code}`}</code>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                setError(null)
                view.current?.reload()
              }}
            >
              Try again
            </button>
          </div>
        ) : (
          !active.src && (
            <div className="empty-state">
              <span className="empty-state__icon">
                <Globe size={30} strokeWidth={1.6} />
              </span>
              <span className="empty-state__title">Start browsing</span>
              <span className="empty-state__body">Type a web address or a search above</span>
            </div>
          )
        )}
      </div>
    </div>
  )
}

/** Chromium's common load failures (net_error_list.h), in words. */
function loadErrorText(error: LoadError): string {
  const host = hostOf(error.url)
  switch (error.description) {
    case 'ERR_NAME_NOT_RESOLVED':
      return `Couldn't find ${host}. Check the address for typos.`
    case 'ERR_INTERNET_DISCONNECTED':
      return 'This computer is offline. Reconnect and try again.'
    case 'ERR_CONNECTION_REFUSED':
      return `${host} refused the connection. If it's a local server, check that it's running.`
    case 'ERR_CONNECTION_TIMED_OUT':
    case 'ERR_TIMED_OUT':
      return `${host} took too long to respond.`
    case 'ERR_CERT_AUTHORITY_INVALID':
    case 'ERR_CERT_COMMON_NAME_INVALID':
    case 'ERR_CERT_DATE_INVALID':
      return `${host} has a security certificate the browser doesn't trust, so it wasn't opened.`
    default:
      return `${host} couldn't be loaded.`
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url
  } catch {
    return 'New tab'
  }
}
