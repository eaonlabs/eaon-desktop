import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Globe,
  History,
  LoaderCircle,
  Lock,
  Maximize2,
  Minimize2,
  MoreVertical,
  PanelRight,
  Plus,
  RefreshCw,
  Server,
  SquareCode,
  SquareDashedMousePointer,
  TriangleAlert,
  X
} from 'lucide-react'
import { ANNOTATE_SHORTCUT, browserKey, matchesBinding, type BrowserKeyAction, type DesignNote, type PickedElement } from '@shared/browser'
import { useApp } from '../../state/store'
import { BrandIcon } from '../../icons/brand'
import { isMac, shortcutLabel } from '../../lib/platform'
import { MenuItem, MenuSeparator, Popover, useDisclosure } from '../ui'
import { useCode } from '../code/codeStore'
import { terminals } from '../code/terminal/registry'
import { useTerminals } from '../code/terminal/terminalStore'
import { MIN_WIDTH, hostOf, toUrl, useBrowser, useBrowserScope, type BrowserTab } from './browserStore'
import { armPicker, disarmPicker, highlightOnPage, pickAt } from './picker'
import { DesignTray } from './DesignTray'

/**
 * The in-app browser beside Chat and the ADE: tabs that keep their pages
 * while you switch between them, and Design Mode — point at an element on the
 * page and it goes to your coding agent with its markup, styles, source
 * location and a screenshot.
 *
 * In the ADE each project folder has its own tabs, and a local dev server a
 * terminal prints (Vite's "Local: http://localhost:5173/") is one click away.
 */

/** Every page on screen, by tab id, for the toolbar and Design Mode to drive. */
const views = new Map<string, Electron.WebviewTag>()
/** A page's webContents id → its tab, to route what main reports about a page. */
const pages = new Map<number, { key: string; tabId: string }>()

/**
 * Calls a `<webview>` method that throws until the page is attached and has
 * had its dom-ready (and again once it is closed): a button pressed while a
 * page is still starting does nothing rather than throwing.
 */
function onPage<T>(page: Electron.WebviewTag | null | undefined, use: (page: Electron.WebviewTag) => T): T | undefined {
  if (!page) return undefined
  try {
    return use(page)
  } catch {
    return undefined
  }
}

const accent = (): string => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3b82f6'

const annotateBinding = (): string | null => {
  const bound = useApp.getState().settings?.shortcuts['annotate-page-element']
  return bound === undefined ? ANNOTATE_SHORTCUT : bound
}

/**
 * `embedded`: inside Chat's dock, which shows the pages as its own tabs and
 * holds the panel's controls; only the toolbar and the pages are drawn here.
 */
export function BrowserPanel({ embedded = false }: { embedded?: boolean } = {}): JSX.Element {
  const key = useBrowserScope()
  const scope = useBrowser((s) => s.scopes[key])
  const { width, expanded, designMode } = useBrowser(useShallow((s) => ({ width: s.width, expanded: s.expanded, designMode: s.designMode })))
  const toggleBrowser = useApp((s) => s.toggleBrowser)
  const panel = useRef<HTMLElement>(null)
  const address = useRef<HTMLInputElement>(null)
  const [findOpen, setFindOpen] = useState(false)
  /** Bumped when the active page has a new document, so Design Mode arms itself in it again. */
  const [readyTick, setReadyTick] = useState(0)
  const [toast, setToast] = useState<string | null>(null)

  useLayoutEffect(() => {
    useBrowser.getState().ensure(key)
  }, [key])

  const tabs = scope?.tabs ?? []
  const active = tabs.find((t) => t.id === scope?.activeId) ?? tabs[0]
  const activeId = active?.id ?? null
  const view = (): Electron.WebviewTag | null => (activeId ? (views.get(activeId) ?? null) : null)

  const flash = useCallback((text: string) => setToast(text), [])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(timer)
  }, [toast])

  // Closing the panel leaves Design Mode, and it opens beside the page next time.
  useEffect(
    () => () => {
      useBrowser.getState().setDesignMode(false)
      useBrowser.getState().setExpanded(false)
    },
    []
  )

  const onDomReady = useCallback((tabId: string) => {
    if (tabId === useBrowser.getState().scopes[key]?.activeId) setReadyTick((n) => n + 1)
  }, [key])

  /** Reads a picked element into a note: its crop is taken while the page still shows it. */
  const addPick = useCallback(
    async (tabId: string, element: PickedElement) => {
      const webContentsId = onPage(views.get(tabId), (page) => page.getWebContentsId())
      let shot: { path: string; thumbnail: string } | null = null
      if (webContentsId !== undefined) {
        shot = await window.api.inAppBrowser.capture({ webContentsId, rect: element.rect, viewport: element.viewport }).catch(() => null)
      }
      useBrowser.getState().addNote(key, {
        id: Math.random().toString(36).slice(2, 10),
        element,
        screenshot: shot?.path ?? null,
        thumbnail: shot?.thumbnail ?? null,
        note: '',
        createdAt: Date.now()
      })
    },
    [key]
  )

  // Design Mode: arm the picker on the active page, take each pick, arm again.
  useEffect(() => {
    if (!designMode || !activeId || !active?.url) return
    const page = views.get(activeId)
    if (!page) return
    let live = true
    void (async () => {
      while (live) {
        const result = await armPicker(page, accent()).catch(() => null)
        if (!live || !result) break
        if ('cancelled' in result) {
          useBrowser.getState().setDesignMode(false)
          break
        }
        await addPick(activeId, result.element)
      }
    })()
    return () => {
      live = false
      disarmPicker(page)
    }
  }, [designMode, activeId, active?.url, readyTick, addPick])

  const toggleDesign = useCallback(() => {
    const state = useBrowser.getState()
    const next = !state.designMode
    state.setDesignMode(next)
    // The page takes the keyboard, so ↑, Enter and Escape reach the picker.
    if (next) requestAnimationFrame(() => view()?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  const run = useCallback(
    (action: BrowserKeyAction) => {
      const browser = useBrowser.getState()
      const page = view()
      switch (action) {
        case 'annotate':
          toggleDesign()
          break
        case 'focus-address':
          address.current?.focus()
          address.current?.select()
          break
        case 'reload':
          onPage(page, (p) => p.reload())
          break
        case 'new-tab':
          browser.newTab(key)
          requestAnimationFrame(() => address.current?.focus())
          break
        case 'close-tab':
          if (activeId) browser.closeTab(key, activeId)
          break
        case 'back':
          onPage(page, (p) => p.canGoBack() && p.goBack())
          break
        case 'forward':
          onPage(page, (p) => p.canGoForward() && p.goForward())
          break
        case 'devtools': {
          const id = onPage(page, (p) => p.getWebContentsId())
          if (id !== undefined) void window.api.inAppBrowser.toggleDevTools(id)
          break
        }
        case 'find':
          if (active?.url) setFindOpen(true)
          break
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, activeId, active?.url, toggleDesign]
  )

  // What main reports about a page: its popups, keys pressed in it, "Annotate Element".
  useEffect(() => {
    const api = window.api.inAppBrowser
    const offOpen = api.onOpen(({ webContentsId, url, background }) => {
      const page = pages.get(webContentsId)
      useBrowser.getState().open(page?.key ?? key, url, { background })
    })
    const offKey = api.onKey(({ webContentsId, action }) => {
      if (pages.get(webContentsId)?.tabId === activeId) run(action)
    })
    const offAnnotate = api.onAnnotateAt(({ webContentsId, x, y }) => {
      const page = pages.get(webContentsId)
      const node = page && views.get(page.tabId)
      if (!page || !node) return
      void pickAt(node, x, y)
        .then((result) => {
          if (result && 'element' in result) return addPick(page.tabId, result.element)
        })
        .catch(() => undefined)
    })
    return () => {
      offOpen()
      offKey()
      offAnnotate()
    }
  }, [key, activeId, run, addPick])

  // The same keys while the panel itself (its toolbar, its tabs) has focus —
  // all but ⌘R, ⌘W and ⌥⌘I, which out here are the app menu's (reload Eaon,
  // close the window, Eaon's DevTools). Inside a page main takes them first.
  const onPanelKey = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape' && useBrowser.getState().designMode) {
      event.preventDefault()
      useBrowser.getState().setDesignMode(false)
      return
    }
    const action = browserKey({ key: event.key, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey }, isMac)
    if (!action || action === 'reload' || action === 'close-tab' || action === 'devtools') return
    event.preventDefault()
    event.stopPropagation()
    run(action)
  }

  // ⌘L (Settings → Shortcuts) from anywhere while the panel is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const bound = useApp.getState().settings?.shortcuts['focus-browser-address-bar']
      if (!matchesBinding(bound, { key: event.key, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey }, isMac)) return
      if (!isMac && document.activeElement?.closest('.term-pane')) return
      event.preventDefault()
      run('focus-address')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [run])

  const hover = useCallback(
    (note: DesignNote | null) => {
      const page = view()
      if (!page || useBrowser.getState().designMode) return
      if (note && note.element.url !== active?.url) return
      highlightOnPage(page, note?.element.selector ?? null, accent())
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeId, active?.url]
  )

  return (
    <aside
      ref={panel}
      className={`browser browser--web${embedded ? ' browser--embedded' : ''}`}
      data-expanded={(!embedded && expanded) || undefined}
      style={expanded || embedded ? undefined : { width }}
      aria-label="Browser"
      onKeyDown={onPanelKey}
    >
      {!expanded && !embedded && <ResizeHandle panel={panel} />}
      {!embedded && (
        <div className="browser__tabs" role="tablist">
          <div className="browser__tab-strip">
            {tabs.map((tab) => (
              <TabButton key={tab.id} tab={tab} active={tab.id === activeId} scopeKey={key} />
            ))}
            <button className="icon-btn browser__new-tab" aria-label="New tab" title={`New tab (${shortcutLabel('⌘T')})`} onClick={() => run('new-tab')}>
              <Plus size={15} strokeWidth={2} />
            </button>
          </div>
          <button
            className="icon-btn"
            aria-label={expanded ? 'Restore panel' : 'Expand browser'}
            title={expanded ? 'Back to the side' : 'Fill the window'}
            onClick={() => useBrowser.getState().setExpanded(!expanded)}
          >
            {expanded ? <Minimize2 size={14} strokeWidth={1.9} /> : <Maximize2 size={14} strokeWidth={1.9} />}
          </button>
          <button className="icon-btn" data-active onClick={() => toggleBrowser(false)} aria-label="Close browser" title="Close browser">
            <PanelRight size={16} strokeWidth={1.9} />
          </button>
        </div>
      )}

      {active && (
        <Toolbar
          scopeKey={key}
          tab={active}
          address={address}
          designMode={designMode}
          onDesign={toggleDesign}
          onRun={run}
        />
      )}

      {designMode && (
        <div className="browser__design-hint" role="status">
          <SquareDashedMousePointer size={14} strokeWidth={2} />
          <span>
            {active?.url ? (
              <>
                Click an element to annotate it. <kbd>↑</kbd> picks its parent, <kbd>Esc</kbd> stops.
              </>
            ) : (
              'Open a page to point at its elements.'
            )}
          </span>
          <button className="browser__design-done" onClick={() => useBrowser.getState().setDesignMode(false)}>
            Done
          </button>
        </div>
      )}

      {findOpen && active?.url && <FindBar view={view} onClose={() => setFindOpen(false)} />}

      <div className="browser__view" data-design={designMode || undefined}>
        {tabs.map((tab) =>
          tab.url ? <BrowserPage key={tab.id} scopeKey={key} tab={tab} active={tab.id === activeId} onDomReady={onDomReady} /> : null
        )}
        {active && !active.url && <StartPage scopeKey={key} tabId={active.id} />}
        {active?.url && active.error && <PageError tab={active} onRetry={() => onPage(view(), (p) => p.reload())} />}
        {toast && (
          <div className="browser__toast" role="status">
            {toast}
          </div>
        )}
      </div>

      <DesignTray scopeKey={key} onHover={hover} onSent={flash} />
    </aside>
  )
}

/** One page. Kept mounted, hidden, while another tab is in front, so it keeps its state. */
const BrowserPage = memo(function BrowserPage({
  scopeKey,
  tab,
  active,
  onDomReady
}: {
  scopeKey: string
  tab: BrowserTab
  active: boolean
  onDomReady: (tabId: string) => void
}): JSX.Element {
  const node = useRef<Electron.WebviewTag | null>(null)
  const [initialUrl] = useState(tab.url)
  const loaded = useRef(tab.load)
  const ready = useRef(false)

  useEffect(() => {
    const page = node.current
    if (!page) return
    const id = tab.id
    views.set(id, page)
    const patch = (change: Partial<BrowserTab>): void => useBrowser.getState().patchTab(scopeKey, id, change)
    const history = (): Partial<BrowserTab> =>
      (ready.current ? onPage(page, (p) => ({ canGoBack: p.canGoBack(), canGoForward: p.canGoForward() })) : undefined) ?? {}

    const onStart = (): void => patch({ loading: true, error: null })
    const onStop = (): void => patch({ loading: false, ...history() })
    const onNavigate = (event: Electron.DidNavigateEvent): void => {
      patch({ url: event.url, ...history() })
      useBrowser.getState().visit(event.url, onPage(page, (p) => p.getTitle()) ?? '')
    }
    const onInPage = (event: Electron.DidNavigateInPageEvent): void => {
      if (event.isMainFrame) patch({ url: event.url, ...history() })
    }
    const onTitle = (event: Electron.PageTitleUpdatedEvent): void => {
      patch({ title: event.title })
      useBrowser.getState().visit(onPage(page, (p) => p.getURL()) ?? '', event.title)
    }
    const onFavicon = (event: Electron.PageFaviconUpdatedEvent): void => patch({ favicon: event.favicons[0] ?? null })
    const onFail = (event: Electron.DidFailLoadEvent): void => {
      // -3 is a load that was stopped or replaced, not a failure.
      if (!event.isMainFrame || event.errorCode === -3) return
      patch({ loading: false, error: describeError(event.errorCode, event.errorDescription, event.validatedURL) })
    }
    const onReady = (): void => {
      ready.current = true
      const contentsId = onPage(page, (p) => p.getWebContentsId())
      if (contentsId !== undefined) pages.set(contentsId, { key: scopeKey, tabId: id })
      patch(history())
      onDomReady(id)
    }
    const onGone = (): void => patch({ loading: false, error: 'This page crashed. Reload to try again.' })

    page.addEventListener('did-start-loading', onStart)
    page.addEventListener('did-stop-loading', onStop)
    page.addEventListener('did-navigate', onNavigate)
    page.addEventListener('did-navigate-in-page', onInPage)
    page.addEventListener('page-title-updated', onTitle)
    page.addEventListener('page-favicon-updated', onFavicon)
    page.addEventListener('did-fail-load', onFail)
    page.addEventListener('dom-ready', onReady)
    page.addEventListener('render-process-gone', onGone)
    return () => {
      page.removeEventListener('did-start-loading', onStart)
      page.removeEventListener('did-stop-loading', onStop)
      page.removeEventListener('did-navigate', onNavigate)
      page.removeEventListener('did-navigate-in-page', onInPage)
      page.removeEventListener('page-title-updated', onTitle)
      page.removeEventListener('page-favicon-updated', onFavicon)
      page.removeEventListener('did-fail-load', onFail)
      page.removeEventListener('dom-ready', onReady)
      page.removeEventListener('render-process-gone', onGone)
      if (views.get(id) === page) views.delete(id)
      for (const [contentsId, owner] of pages) if (owner.tabId === id) pages.delete(contentsId)
    }
  }, [scopeKey, tab.id, onDomReady])

  // The address bar (or a terminal link) asked this tab for a page.
  useEffect(() => {
    if (tab.load === loaded.current) return
    loaded.current = tab.load
    const page = node.current
    if (!page) return
    if (ready.current) void onPage(page, (p) => p.loadURL(tab.url))?.catch(() => undefined)
    else page.src = tab.url
  }, [tab.load, tab.url])

  return (
    <webview
      ref={(element) => {
        node.current = element as Electron.WebviewTag | null
      }}
      className="browser__page"
      data-active={active || undefined}
      src={initialUrl}
      // Its own session: sites get their own cookies and storage, apart from
      // Eaon's page and its eaon-file: scheme.
      partition="persist:in-app-browser"
      // eslint-disable-next-line react/no-unknown-property
      allowpopups={'true' as unknown as boolean}
    />
  )
})

function TabButton({ tab, active, scopeKey }: { tab: BrowserTab; active: boolean; scopeKey: string }): JSX.Element {
  const browser = useBrowser.getState
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      className="browser__tab"
      data-active={active}
      title={tab.url ? `${tab.title}\n${tab.url}` : 'New tab'}
      onClick={() => browser().activate(scopeKey, tab.id)}
      onKeyDown={(event) => event.key === 'Enter' && browser().activate(scopeKey, tab.id)}
      onAuxClick={(event) => event.button === 1 && browser().closeTab(scopeKey, tab.id)}
    >
      {tab.loading ? (
        <LoaderCircle size={13} strokeWidth={2} className="browser__spin" />
      ) : tab.favicon ? (
        <img className="browser__favicon" src={tab.favicon} alt="" width={13} height={13} onError={() => browser().patchTab(scopeKey, tab.id, { favicon: null })} />
      ) : (
        <Globe size={13} strokeWidth={1.9} />
      )}
      <span className="browser__tab-label">{tab.url ? tab.title || hostOf(tab.url) : 'New tab'}</span>
      <button
        className="browser__tab-close"
        tabIndex={-1}
        aria-label={`Close ${tab.title || 'tab'}`}
        onClick={(event) => {
          event.stopPropagation()
          browser().closeTab(scopeKey, tab.id)
        }}
      >
        <X size={12} strokeWidth={2.2} />
      </button>
    </div>
  )
}

function Toolbar({
  scopeKey,
  tab,
  address,
  designMode,
  onDesign,
  onRun
}: {
  scopeKey: string
  tab: BrowserTab
  address: React.RefObject<HTMLInputElement>
  designMode: boolean
  onDesign: () => void
  onRun: (action: BrowserKeyAction) => void
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const menuAnchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const annotate = useApp((s) => {
    const bound = s.settings?.shortcuts['annotate-page-element']
    return bound === undefined ? ANNOTATE_SHORTCUT : bound
  })

  // Another tab, or the page went somewhere: the field shows where it is now.
  useEffect(() => setDraft(null), [tab.id, tab.url])

  const go = (): void => {
    const url = toUrl(draft ?? '')
    if (!url) return
    useBrowser.getState().navigate(scopeKey, tab.id, url)
    setDraft(null)
    address.current?.blur()
  }

  const secure = tab.url.startsWith('https://')
  const page = (): Electron.WebviewTag | null => views.get(tab.id) ?? null

  return (
    <div className="browser__toolbar">
      <button className="icon-btn" disabled={!tab.canGoBack} onClick={() => onRun('back')} aria-label="Back" title="Back">
        <ArrowLeft size={16} strokeWidth={1.9} />
      </button>
      <button className="icon-btn" disabled={!tab.canGoForward} onClick={() => onRun('forward')} aria-label="Forward" title="Forward">
        <ArrowRight size={16} strokeWidth={1.9} />
      </button>
      {tab.loading ? (
        <button className="icon-btn" onClick={() => onPage(page(), (p) => p.stop())} aria-label="Stop" title="Stop">
          <X size={16} strokeWidth={1.9} />
        </button>
      ) : (
        <button className="icon-btn" disabled={!tab.url} onClick={() => onRun('reload')} aria-label="Reload" title="Reload">
          <RefreshCw size={15} strokeWidth={1.9} />
        </button>
      )}
      <form
        className="browser__url"
        data-focused={draft !== null || undefined}
        onSubmit={(event) => {
          event.preventDefault()
          go()
        }}
      >
        {tab.url && (secure ? <Lock size={12} strokeWidth={2.2} className="browser__url-icon" /> : <Globe size={12} strokeWidth={2} className="browser__url-icon" />)}
        <input
          ref={address}
          value={draft ?? tab.url}
          placeholder="Search or enter an address — or a port, like 5173"
          spellCheck={false}
          aria-label="Address"
          onFocus={(event) => {
            setDraft(tab.url)
            event.currentTarget.select()
          }}
          onBlur={() => setDraft(null)}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              setDraft(null)
              event.currentTarget.blur()
            }
          }}
        />
      </form>
      <button
        className="header-btn browser__design"
        data-active={designMode || undefined}
        aria-pressed={designMode}
        onClick={onDesign}
        title={`Design Mode: point at elements to send to your agent${annotate ? ` (${shortcutLabel(annotate)})` : ''}`}
      >
        <SquareDashedMousePointer size={14} strokeWidth={1.9} />
        <span>Design</span>
      </button>
      <button ref={menuAnchor} className="icon-btn" onClick={menu.toggle} aria-label="Browser menu" title="More">
        <MoreVertical size={16} strokeWidth={1.9} />
      </button>
      <Popover anchor={menuAnchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={230}>
        <MenuItem
          icon={<ExternalLink size={15} strokeWidth={1.8} />}
          title="Open in default browser"
          disabled={!tab.url}
          onClick={() => {
            menu.close()
            void window.api.app.openExternal(tab.url)
          }}
        />
        <MenuItem
          icon={<Copy size={15} strokeWidth={1.8} />}
          title="Copy address"
          disabled={!tab.url}
          onClick={() => {
            menu.close()
            void navigator.clipboard.writeText(tab.url)
          }}
        />
        <MenuSeparator />
        <MenuItem
          title="Find in page"
          hint={shortcutLabel('⌘F')}
          disabled={!tab.url}
          onClick={() => {
            menu.close()
            onRun('find')
          }}
        />
        <MenuItem
          icon={<SquareCode size={15} strokeWidth={1.8} />}
          title="Developer tools"
          hint={shortcutLabel('⌥⌘I')}
          disabled={!tab.url}
          onClick={() => {
            menu.close()
            onRun('devtools')
          }}
        />
        <MenuSeparator />
        <MenuItem
          title="Clear browsing history"
          onClick={() => {
            menu.close()
            useBrowser.getState().clearHistory()
          }}
        />
      </Popover>
    </div>
  )
}

function FindBar({ view, onClose }: { view: () => Electron.WebviewTag | null; onClose: () => void }): JSX.Element {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ active: number; matches: number } | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    const page = view()
    if (!page) return
    const onFound = (event: Electron.FoundInPageEvent): void => setResult({ active: event.result.activeMatchOrdinal, matches: event.result.matches })
    page.addEventListener('found-in-page', onFound)
    return () => {
      page.removeEventListener('found-in-page', onFound)
      onPage(page, (p) => p.stopFindInPage('clearSelection'))
    }
  }, [view])

  const find = (text: string, options?: { forward?: boolean; findNext?: boolean }): void => {
    const page = view()
    if (!page) return
    if (!text) {
      onPage(page, (p) => p.stopFindInPage('clearSelection'))
      setResult(null)
      return
    }
    onPage(page, (p) => p.findInPage(text, options))
  }

  return (
    <div className="browser__find">
      <input aria-label="Find in page"
        ref={input}
        value={query}
        placeholder="Find in page"
        spellCheck={false}
        onChange={(event) => {
          setQuery(event.target.value)
          find(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
          if (event.key === 'Enter') find(query, { forward: !event.shiftKey, findNext: true })
        }}
      />
      <span className="browser__find-count">{result && query ? `${result.matches ? result.active : 0}/${result.matches}` : ''}</span>
      <button className="icon-btn" aria-label="Previous match" onClick={() => find(query, { forward: false, findNext: true })}>
        <ChevronUp size={15} strokeWidth={1.9} />
      </button>
      <button className="icon-btn" aria-label="Next match" onClick={() => find(query, { forward: true, findNext: true })}>
        <ChevronDown size={15} strokeWidth={1.9} />
      </button>
      <button className="icon-btn" aria-label="Close find" onClick={onClose}>
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  )
}

/** A new tab: the dev servers the ADE's terminals printed, and pages visited lately. */
function StartPage({ scopeKey, tabId }: { scopeKey: string; tabId: string }): JSX.Element {
  const cwd = useCode((s) => s.cwd)
  const paneIds = useTerminals(useShallow((s) => (scopeKey.startsWith('code:') && cwd ? (s.layout[cwd] ?? []).map((p) => p.id) : [])))
  // In the ADE, the servers this folder's terminals printed; in Chat, any.
  const servers = useSyncExternalStore(
    useCallback((listener: () => void) => terminals.onServers(listener), []),
    () => (scopeKey.startsWith('code:') ? terminals.devServers(paneIds) : terminals.devServers()).join('\n')
  )
  const localServers = servers ? servers.split('\n') : []
  const history = useBrowser((s) => s.history)
  const recent = history.slice(0, 6)
  const { settings, patchSettings } = useApp(useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings })))
  const annotate = annotateBinding()
  const go = (url: string): void => useBrowser.getState().navigate(scopeKey, tabId, url)

  return (
    <div className="browser-start scroll">
      <div className="browser-start__inner">
        <span className="browser-start__icon">
          <Globe size={26} strokeWidth={1.6} />
        </span>
        <h2 className="browser-start__title">Start browsing</h2>
        <p className="browser-start__lede">
          Type an address above, or just a port for a local dev server.
          {annotate && (
            <>
              {' '}
              Press <kbd>{shortcutLabel(annotate)}</kbd> on any page to point at an element and send it to your agent.
            </>
          )}
        </p>

        {localServers.length > 0 && (
          <section className="browser-start__section">
            <div className="browser-start__label">Running in your terminals</div>
            {localServers.map((url) => (
              <button key={url} className="browser-start__row" onClick={() => go(url)}>
                <Server size={15} strokeWidth={1.8} />
                <span className="browser-start__row-title">{hostOf(url)}</span>
                <span className="browser-start__row-url">{url}</span>
              </button>
            ))}
          </section>
        )}

        {recent.length > 0 && (
          <section className="browser-start__section">
            <div className="browser-start__label">Recent</div>
            {recent.map((visit) => (
              <button key={visit.url} className="browser-start__row" onClick={() => go(visit.url)}>
                <History size={15} strokeWidth={1.8} />
                <span className="browser-start__row-title">{visit.title || hostOf(visit.url)}</span>
                <span className="browser-start__row-url">{visit.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}</span>
              </button>
            ))}
          </section>
        )}
      </div>
    </div>
  )
}

function PageError({ tab, onRetry }: { tab: BrowserTab; onRetry: () => void }): JSX.Element {
  return (
    <div className="browser-error">
      <TriangleAlert size={26} strokeWidth={1.6} />
      <div className="browser-error__title">This page didn’t load</div>
      <div className="browser-error__body">{tab.error}</div>
      <div className="browser-error__url">{tab.url}</div>
      <button className="btn btn--sm" onClick={onRetry}>
        Try again
      </button>
    </div>
  )
}

function describeError(code: number, description: string, url: string): string {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(url)
  if (code === -102 || description === 'ERR_CONNECTION_REFUSED') {
    return local ? 'Nothing is answering at this address. Is the dev server running?' : 'The site refused to connect.'
  }
  if (code === -105 || description === 'ERR_NAME_NOT_RESOLVED') return 'The address couldn’t be found. Check it for typos.'
  if (code === -106 || description === 'ERR_INTERNET_DISCONNECTED') return 'You’re offline.'
  if (code <= -200 && code > -300) return 'The site’s security certificate isn’t trusted.'
  return description ? description.replace(/^ERR_/, '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) : 'Something went wrong.'
}

/** Drag the panel's left edge to give the page more or less room. */
function ResizeHandle({ panel }: { panel: React.RefObject<HTMLElement> }): JSX.Element {
  return (
    <div
      className="browser__resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize browser"
      onPointerDown={(event) => {
        const node = panel.current
        if (!node || event.button !== 0) return
        event.preventDefault()
        const handle = event.currentTarget
        handle.setPointerCapture(event.pointerId)
        const right = node.getBoundingClientRect().right
        // Pages would take the pointer as it crosses them.
        document.body.dataset.resizing = 'browser'
        const move = (e: PointerEvent): void => {
          const width = Math.min(right - e.clientX, window.innerWidth - 380)
          node.style.width = `${Math.max(MIN_WIDTH, width)}px`
        }
        const up = (e: PointerEvent): void => {
          handle.removeEventListener('pointermove', move)
          handle.removeEventListener('pointerup', up)
          handle.removeEventListener('pointercancel', up)
          delete document.body.dataset.resizing
          useBrowser.getState().setWidth(Math.min(right - e.clientX, window.innerWidth - 380))
        }
        handle.addEventListener('pointermove', move)
        handle.addEventListener('pointerup', up)
        handle.addEventListener('pointercancel', up)
      }}
      onDoubleClick={() => useBrowser.getState().setWidth(520)}
    />
  )
}

/**
 * The Design Mode shortcut wherever focus is (a page in the browser reports
 * its own through main): opens the browser when it is closed, then toggles
 * the picker. Mounted while Chat or the ADE is on screen.
 */
export function BrowserKeys(): null {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!matchesBinding(annotateBinding(), { key: event.key, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey }, isMac)) return
      // Ctrl+Shift+C copies in a terminal off the Mac.
      if (!isMac && document.activeElement?.closest('.term-pane')) return
      event.preventDefault()
      event.stopPropagation()
      const app = useApp.getState()
      const browser = useBrowser.getState()
      if (!app.browserOpen) {
        app.toggleBrowser(true)
        browser.setDesignMode(true)
        return
      }
      browser.setDesignMode(!browser.designMode)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return null
}
