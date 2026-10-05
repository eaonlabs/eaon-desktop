import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useApp, useIsWork, useWorkspaceKind } from './state/store'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { BrowserPanel } from './components/BrowserPanel'
import { PluginsPage } from './components/plugins/PluginsPage'
import { IntegrationsPage } from './components/plugins/IntegrationsPage'
import { ScheduledPage } from './components/ScheduledPage'
import { PullRequestsPage } from './components/PullRequestsPage'
import { ModelsPage } from './components/ModelsPage'
import { SettingsShell } from './components/settings/SettingsShell'
import { UpdateToast } from './components/UpdateToast'
import { StoreNotice } from './components/StoreNotice'
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
import { THEMES } from './lib/themes'

export default function App(): JSX.Element {
  const { ready, view, sidebarOpen, browserOpen, init, setView, setSettingsPage } = useApp(useShallow((s) => ({ ready: s.ready, view: s.view, sidebarOpen: s.sidebarOpen, browserOpen: s.browserOpen, init: s.init, setView: s.setView, setSettingsPage: s.setSettingsPage })))

  useEffect(() => {
    void init()
    void useWorkers.getState().init()
    useAgentBrowser.getState().init(() => useApp.getState().activeChatId)
  }, [init])


  const isWork = useIsWork()
  const kind = useWorkspaceKind()
  const agentBrowserOpen = useAgentBrowser((s) => s.open)
  // A worker's browser beside its page, while that page is the one open.
  const browserWorker = useWorkers((s) => (s.browserFor && s.selectedId === s.browserFor && !s.selectedRoomId ? s.workers.find((w) => w.id === s.browserFor) ?? null : null))
  // A worker's run history beside its page.
  const activityWorker = useWorkers((s) => (s.activityOpen && s.selectedId && !s.selectedRoomId ? s.workers.find((w) => w.id === s.selectedId) ?? null : null))

  useTheme()



  useEffect(() => {
    return window.api.app.onMenu((command) => {
      const app = useApp.getState()
      switch (command) {
        case 'settings':
          app.setSettingsPage('general')
          break
        case 'new-chat':
        case 'new-temp-chat':
          app.newChat()
          break
        case 'archive-chat':
          if (app.activeChatId) app.archiveChat(app.activeChatId)
          break
        case 'toggle-sidebar':
          app.toggleSidebar()
          break
        case 'toggle-panel':
          app.toggleBrowser()
          break
      }
    })
  }, [])

  if (!ready) return <div className="app" />

  return (
    <>
      {view === 'settings' ? (
        <SettingsShell />
      ) : (
        <div className="app">
          <Sidebar />
          <div className="main">
            {view === 'chat' && (kind === 'code' ? <CodeView /> : kind === 'workers' ? <WorkersView /> : <ChatView />)}
            {view === 'library' && <LibraryPage />}
            {view === 'plugins' && <PluginsPage />}
            {view === 'integrations' && <IntegrationsPage />}
            {view === 'scheduled' && <ScheduledPage />}
            {view === 'pull-requests' && <PullRequestsPage />}
            {view === 'trading' && <TradingDesk />}
            {view === 'models' && <ModelsPage />}
          </div>
          {isWork && browserOpen && <BrowserPanel />}
          {isWork && view === 'chat' && kind === 'chat' && agentBrowserOpen && !browserOpen && <AgentBrowserPanel />}
          {view === 'chat' && kind === 'workers' && browserWorker && <WorkerBrowserPanel key={browserWorker.id} worker={browserWorker} />}
          {view === 'chat' && kind === 'workers' && activityWorker && <WorkerActivityPanel key={activityWorker.id} worker={activityWorker} />}
          <GlobalKeys onSettings={() => setSettingsPage('general')} onPlugins={() => setView('plugins')} />
        </div>
      )}
      <UpdateToast />
      <StoreNotice />
      <DiscordPresence />
      <BrowserAsk />
    </>
  )
}

function GlobalKeys({ onSettings, onPlugins }: { onSettings: () => void; onPlugins: () => void }): null {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.metaKey) return
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
      // ⌘1 / ⌘2 / ⌘3: Chat, Workers, ADE — the top bar's switch, from the keyboard.
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

  useEffect(() => {
    if (!settings) return
    const { appearance } = settings
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
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [settings])
}
