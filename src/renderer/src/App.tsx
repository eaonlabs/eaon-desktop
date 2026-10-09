import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { isAgentKind, useApp, useIsWork, useWorkspaceKind } from './state/store'
import { Sidebar } from './components/Sidebar'
import { ARCHIVE_REQUEST, ChatView } from './components/ChatView'
import { BrowserPanel } from './components/BrowserPanel'
import { PluginsPage } from './components/plugins/PluginsPage'
import { IntegrationsPage } from './components/plugins/IntegrationsPage'
import { ScheduledPage } from './components/ScheduledPage'
import { PullRequestsPage } from './components/PullRequestsPage'
import { LinearPage } from './components/LinearPage'
import { ModelsPage } from './components/ModelsPage'
import { SettingsShell } from './components/settings/SettingsShell'
import { UpdateToast } from './components/UpdateToast'
import { StoreNotice } from './components/StoreNotice'
import { ComputerLeaseIndicator } from './components/computer/ComputerLeaseIndicator'
import { Notice } from './components/Notice'
import { CodeView } from './components/code/CodeView'
import { LibraryPage } from './components/LibraryPage'
import { WorkersView } from './components/workers/WorkersView'
import { WorkerBrowserPanel } from './components/workers/WorkerAutonomy'
import { WorkerActivityPanel } from './components/workers/WorkerThreads'
import { useWorkers } from './components/workers/workersStore'
import { DiscordPresence } from './components/discord/DiscordPresence'
import { BrowserAsk } from './components/browser/BrowserAsk'
import { AgentBrowserPanel } from './components/agentBrowser/AgentBrowserPanel'
import { TradingDesk } from './components/trading/TradingDesk'
import { useAgentBrowser } from './components/agentBrowser/agentBrowserStore'
import { ErrorBoundary } from './components/ErrorBoundary'
import { CrashPage, PaneError, PanelError, SidebarError } from './components/CrashScreen'
import { THEMES } from './lib/themes'
import { useRoomForSidePanel } from './state/sidePanel'
import { Starting } from './components/Starting'
import { modKey } from './lib/platform'
import { installControl } from './lib/control'
import { StarPrompt } from './components/StarPrompt'

export default function App(): JSX.Element {
  const { ready, initError, view, settingsPage, activeChatId, browserOpen, init, setView, setSettingsPage } = useApp(
    useShallow((s) => ({
      ready: s.ready,
      initError: s.initError,
      view: s.view,
      settingsPage: s.settingsPage,
      activeChatId: s.activeChatId,
      browserOpen: s.browserOpen,
      init: s.init,
      setView: s.setView,
      setSettingsPage: s.setSettingsPage
    }))
  )

  useEffect(() => {
    void init()
    void useWorkers.getState().init()
    useAgentBrowser.getState().init(() => useApp.getState().activeChatId)
  }, [init])

  // What Eaon CLI asks of the window (tabs, ADE folders and terminals, settings).
  useEffect(() => installControl(), [])


  const isWork = useIsWork()
  const kind = useWorkspaceKind()
  const agentBrowserOpen = useAgentBrowser((s) => s.open)
  // A worker's browser beside its page, while that page is the one open.
  const browserWorker = useWorkers((s) => (s.browserFor && s.selectedId === s.browserFor && !s.selectedRoomId ? s.workers.find((w) => w.id === s.browserFor) ?? null : null))
  // A worker's run history beside its page.
  const activityWorker = useWorkers((s) => (s.activityOpen && s.selectedId && !s.selectedRoomId ? s.workers.find((w) => w.id === s.selectedId) ?? null : null))
  // The same conditions that render the side panels below.
  useRoomForSidePanel(
    (isWork && browserOpen) ||
      (isWork && view === 'chat' && kind === 'chat' && agentBrowserOpen) ||
      (view === 'chat' && kind === 'workers' && (Boolean(browserWorker) || Boolean(activityWorker)))
  )

  useTheme()



  // Once the saved data is in: a command that arrives sooner (New Chat with
  // every window closed opens this one) is held by the preload until then,
  // where loading the data would have undone it.
  useEffect(() => {
    if (!ready) return
    return window.api.app.onMenu((command) => {
      const app = useApp.getState()
      switch (command) {
        case 'settings':
          app.setSettingsPage('general')
          break
        case 'new-chat':
          app.newChat()
          break
        case 'archive-chat':
          // The open conversation archives itself, so a chat that is still
          // replying asks first, as its own menu does (ChatView).
          window.dispatchEvent(new Event(ARCHIVE_REQUEST))
          break
        case 'toggle-sidebar':
          app.toggleSidebar()
          break
        case 'toggle-panel':
          // The browser panel exists beside Chat only; elsewhere this flipped
          // a hidden switch and the panel popped up later, unasked.
          if (isAgentKind(app.workspaces.find((w) => w.id === app.settings?.activeWorkspaceId)?.kind)) app.toggleBrowser()
          break
      }
    })
  }, [ready])

  if (!ready) {
    if (!initError) return <Starting />
    return (
      <CrashPage
        title="Eaon couldn’t start"
        body="This window couldn’t load your settings and chats. Nothing has been lost; reloading tries again."
        message={initError}
      />
    )
  }

  // The page on screen: a tab (Chat, Workers, ADE) or one of the sidebar's pages.
  const page = view === 'chat' ? `${kind} tab` : `${view} page`

  return (
    <>
      {view === 'settings' ? (
        // Settings pages render inside SettingsShell, so one failing takes the
        // shell with it; this keeps it to Settings rather than the window.
        <ErrorBoundary
          resetKey={settingsPage}
          area={`settings: ${settingsPage}`}
          fallback={(error) => (
            <CrashPage
              title="Settings hit an error"
              body="Your settings are saved. Close Settings to get back to Eaon, or reload the window."
              message={error.message}
              actions={[{ label: 'Close Settings', run: () => setView('chat') }, { label: 'Reload', run: () => window.location.reload() }]}
            />
          )}
        >
          <SettingsShell />
        </ErrorBoundary>
      ) : (
        <div className="app">
          <ErrorBoundary area="sidebar" fallback={(_, retry) => <SidebarError retry={retry} />}>
            <Sidebar />
          </ErrorBoundary>
          <div className="main">
            {/* Keyed on the page, so switching to another starts it fresh. The
                open tab is saved and reopens at launch, so one that keeps
                failing must leave the top bar's switch there to leave it by.
                A different chat from the sidebar tries again too. */}
            <ErrorBoundary key={page} area={page} resetKey={activeChatId} fallback={(error, retry) => <PaneError error={error} retry={retry} />}>
              {view === 'chat' && (kind === 'code' ? <CodeView /> : kind === 'workers' ? <WorkersView /> : <ChatView />)}
              {view === 'library' && <LibraryPage />}
              {view === 'plugins' && <PluginsPage />}
              {view === 'integrations' && <IntegrationsPage />}
              {view === 'scheduled' && <ScheduledPage />}
              {view === 'pull-requests' && <PullRequestsPage />}
              {view === 'linear' && <LinearPage />}
              {view === 'trading' && <TradingDesk />}
              {view === 'models' && <ModelsPage />}
            </ErrorBoundary>
          </div>
          {isWork && browserOpen && (
            <ErrorBoundary area="browser panel" fallback={() => <PanelError onClose={() => useApp.getState().toggleBrowser(false)} />}>
              <BrowserPanel />
            </ErrorBoundary>
          )}
          {isWork && view === 'chat' && kind === 'chat' && agentBrowserOpen && !browserOpen && (
            <ErrorBoundary area="agent browser" fallback={() => <PanelError onClose={() => useAgentBrowser.getState().setOpen(false, useApp.getState().activeChatId)} />}>
              <AgentBrowserPanel />
            </ErrorBoundary>
          )}
          {view === 'chat' && kind === 'workers' && browserWorker && (
            <ErrorBoundary
              key={browserWorker.id}
              area="worker browser"
              fallback={() => <PanelError onClose={() => useWorkers.getState().setBrowser(null, browserWorker.id)} />}
            >
              <WorkerBrowserPanel worker={browserWorker} />
            </ErrorBoundary>
          )}
          {view === 'chat' && kind === 'workers' && activityWorker && (
            <ErrorBoundary key={activityWorker.id} area="worker activity" fallback={() => <PanelError onClose={() => useWorkers.getState().setActivityOpen(false)} />}>
              <WorkerActivityPanel worker={activityWorker} />
            </ErrorBoundary>
          )}
        </div>
      )}
      {/* Outside the view switch, so ⌘1–3 and ⇧⌘P work from Settings too. */}
      <GlobalKeys onSettings={() => setSettingsPage('general')} onPlugins={() => setView('plugins')} />
      <UpdateToast />
      <StoreNotice />
      <ComputerLeaseIndicator />
      <Notice />
      <StarPrompt />
      <DiscordPresence />
      <BrowserAsk />
    </>
  )
}

function GlobalKeys({ onSettings, onPlugins }: { onSettings: () => void; onPlugins: () => void }): null {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // ⌘ on macOS, Ctrl on Windows and Linux (but never AltGr; see modKey).
      // A held key repeats; toggling the sidebar ten times a second helps nobody.
      if (!modKey(event) || event.repeat) return
      if (event.key === ',') {
        event.preventDefault()
        onSettings()
      }
      if (event.key === 'b') {
        event.preventDefault()
        useApp.getState().toggleSidebar()
      }
      if (event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        onPlugins()
      }
      // ⌘1 / ⌘2 / ⌘3 (Ctrl elsewhere): Chat, Workers, ADE — the top bar's switch, from the keyboard.
      const kind = ({ '1': 'chat', '2': 'workers', '3': 'code' } as const)[event.key as '1' | '2' | '3']
      if (kind && !event.shiftKey && !event.altKey) {
        const app = useApp.getState()
        const target = app.workspaces.find((w) => w.kind === kind)
        if (!target) return
        event.preventDefault()
        if (target.id !== app.settings?.activeWorkspaceId) app.setWorkspace(target.id)
        if (app.view !== 'chat') app.setView('chat')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSettings, onPlugins])
  return null
}

/** Push the active palette into CSS custom properties. */
function useTheme(): void {
  const settings = useApp((s) => s.settings)
  // The ADE's theme picker previews its themes on the whole app before one is kept.
  const preview = useApp((s) => s.appearancePreview)

  useEffect(() => {
    if (!settings) return
    const appearance = preview ? { ...settings.appearance, ...preview } : settings.appearance
    const media = window.matchMedia('(prefers-color-scheme: dark)')

    const apply = (): void => {
      const resolved =
        appearance.mode === 'system' ? (media.matches ? 'dark' : 'light') : appearance.mode
      const palette = resolved === 'dark' ? appearance.dark : appearance.light
      const root = document.documentElement

      root.dataset.theme = resolved
      root.style.setProperty('--bg', palette.background)
      root.style.setProperty('--fg', palette.foreground)
      root.style.setProperty('--accent', palette.accent)
      root.style.setProperty('--contrast', String(palette.contrast))
      // Belongs to the theme rather than the stored palette — see ThemeTone.
      const tone = THEMES.find((theme) => theme.name === palette.preset)?.[resolved]
      root.style.setProperty('--text-fade', String(tone?.textFade ?? 1))
      root.style.setProperty('--fs-base', `${appearance.fontSize}px`)
      // No --font-ui override: the typeface is always the system stack in
      // tokens.css. `palette.fontFamily` is still stored by older installs
      // (Inter, SF Mono, Georgia) and deliberately ignored.
      root.style.setProperty(
        '--font-weight-ui',
        palette.fontWeight === 'Light' ? '300' : palette.fontWeight === 'Medium' ? '500' : '400'
      )
      document.body.style.fontWeight = root.style.getPropertyValue('--font-weight-ui')

      // Drives the single window background in app.css. Computed here because
      // this is where the palette is already resolved — reading it per-component
      // got 'system' mode wrong by always falling through to the dark palette.
      // Drives the window-control reservations in tokens.css: macOS keeps its
      // traffic lights top-left, Windows paints its caption buttons top-right.
      document.body.dataset.platform = window.api.platform
      document.body.dataset.translucent = palette.translucentSidebar ? 'on' : 'off'
      document.body.dataset.pointer = appearance.pointerCursors ? 'on' : 'off'
      document.body.dataset.fontSmoothing = appearance.fontSmoothing ? 'on' : 'off'
      document.body.dataset.reduceMotion =
        appearance.reduceMotion === 'system'
          ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'on'
            : 'off'
          : appearance.reduceMotion
    }

    apply()
    // The system's light/dark and reduce-motion settings can change while Eaon is open.
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    media.addEventListener('change', apply)
    motion.addEventListener('change', apply)
    return () => {
      media.removeEventListener('change', apply)
      motion.removeEventListener('change', apply)
    }
  }, [settings, preview])
}
