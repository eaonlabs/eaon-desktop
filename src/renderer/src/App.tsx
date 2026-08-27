import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useApp, useIsWork } from './state/store'
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

export default function App(): JSX.Element {
  const { ready, view, sidebarOpen, browserOpen, init, setView, setSettingsPage } = useApp(useShallow((s) => ({ ready: s.ready, view: s.view, sidebarOpen: s.sidebarOpen, browserOpen: s.browserOpen, init: s.init, setView: s.setView, setSettingsPage: s.setSettingsPage })))

  useEffect(() => {
    void init()
  }, [init])


  const isWork = useIsWork()

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
            {view === 'chat' && <ChatView />}
            {view === 'plugins' && <PluginsPage />}
            {view === 'integrations' && <IntegrationsPage />}
            {view === 'scheduled' && <ScheduledPage />}
            {view === 'pull-requests' && <PullRequestsPage />}
            {view === 'models' && <ModelsPage />}
          </div>
          {isWork && browserOpen && <BrowserPanel />}
          <GlobalKeys onSettings={() => setSettingsPage('general')} onPlugins={() => setView('plugins')} />
        </div>
      )}
      <UpdateToast />
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
      root.style.setProperty('--fs-base', `${appearance.fontSize}px`)
      root.style.setProperty(
        '--font-ui',
        palette.fontFamily === 'System default'
          ? "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif"
          : `'${palette.fontFamily}', -apple-system, system-ui, sans-serif`
      )
      root.style.setProperty(
        '--font-weight-ui',
        palette.fontWeight === 'Light' ? '300' : palette.fontWeight === 'Medium' ? '500' : '400'
      )
      document.body.style.fontWeight = root.style.getPropertyValue('--font-weight-ui')

      // Drives the single window background in app.css. Computed here because
      // this is where the palette is already resolved — reading it per-component
      // got 'system' mode wrong by always falling through to the dark palette.
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
