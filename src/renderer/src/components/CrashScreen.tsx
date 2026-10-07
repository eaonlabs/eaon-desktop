import type { ReactNode } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { useApp } from '../state/store'
import { ErrorBoundary, reportError as report } from './ErrorBoundary'
import { TopBar } from './TopBar'

/**
 * The last error boundary, around the whole app: what is left when an error
 * gets past the ones around each tab, panel and message (see ErrorBoundary).
 * Without it React unmounts the whole tree and the window goes blank; with it
 * the user sees what happened and can reload. Errors outside React are
 * recorded in crashes.log too (see `reportRendererErrors`).
 */
export function CrashScreen({ children }: { children: ReactNode }): JSX.Element {
  return <ErrorBoundary fallback={(error) => <CrashPage message={error.message} />}>{children}</ErrorBoundary>
}

interface Action {
  label: string
  run: () => void
}

const reload: Action = { label: 'Reload', run: () => window.location.reload() }

/** The whole-window error screen; App also shows it for Settings, and when the window can't start. */
export function CrashPage({
  title = 'Something went wrong',
  body = 'Eaon hit an error showing this screen. Your chats are saved; reloading brings the window back.',
  message,
  actions = [reload]
}: {
  title?: string
  body?: string
  message: string
  actions?: Action[]
}): JSX.Element {
  return (
    <div className="crash-screen" role="alert">
      <div className="crash-screen__drag" />
      <ErrorNotice title={title} body={body} message={message} actions={actions} />
    </div>
  )
}

/**
 * In place of a tab or page that hit a render error. The top bar stays, so
 * the Chat / Workers / ADE switch still works: the open tab is saved and comes
 * back on every launch, so a broken one must never be the only way out.
 */
export function PaneError({ error, retry }: { error: Error; retry: () => void }): JSX.Element {
  return (
    <>
      <ErrorBoundary fallback={() => null}>
        <TopBar />
      </ErrorBoundary>
      <div className="crash-screen crash-screen--pane" role="alert">
        <ErrorNotice
          title="This page hit an error"
          body="Your chats are saved and the rest of Eaon still works. Switch tabs above, try this page again, or reload the window."
          message={error.message}
          actions={[{ label: 'Try again', run: retry }, reload]}
        />
      </div>
    </>
  )
}

/** In place of the sidebar, at its width, so the page beside it keeps its place. */
export function SidebarError({ retry }: { retry: () => void }): JSX.Element {
  const open = useApp((s) => s.sidebarOpen)
  return (
    <aside className="sidebar" data-open={open} role="alert">
      <div className="sidebar__content">
        <div className="sidebar__panel crash-panel">
          <AlertTriangle className="empty-state__icon" size={22} strokeWidth={1.6} aria-hidden />
          <div className="empty-state__body">The sidebar hit an error.</div>
          <button className="btn btn--sm" onClick={retry}>
            Try again
          </button>
        </div>
      </div>
    </aside>
  )
}

/** In place of a browser panel beside the page. Closing it and opening it again starts it fresh. */
export function PanelError({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <aside className="browser" role="alert">
      <div className="browser__tabs">
        <span className="crash-panel__spacer" />
        <button className="icon-btn" onClick={onClose} aria-label="Close panel" title="Close">
          <X size={15} strokeWidth={2} />
        </button>
      </div>
      <div className="crash-panel">
        <AlertTriangle className="empty-state__icon" size={22} strokeWidth={1.6} aria-hidden />
        <div className="empty-state__body">This panel hit an error. Close it and open it again to start it fresh.</div>
        <button className="btn btn--sm" onClick={showCrashLog}>
          Show crash log
        </button>
      </div>
    </aside>
  )
}

function ErrorNotice({ title, body, message, actions }: { title: string; body: string; message: string; actions: Action[] }): JSX.Element {
  return (
    <div className="empty-state">
      <AlertTriangle className="empty-state__icon" size={28} strokeWidth={1.6} aria-hidden />
      <div className="empty-state__title">{title}</div>
      <div className="empty-state__body">{body}</div>
      <pre className="crash-screen__error">{message}</pre>
      <div className="crash-screen__actions">
        {actions.map((action, i) => (
          <button key={action.label} className={i === 0 ? 'btn btn--primary' : 'btn'} onClick={action.run}>
            {action.label}
          </button>
        ))}
        <button className="btn" onClick={showCrashLog}>
          Show crash log
        </button>
      </div>
    </div>
  )
}

/**
 * Where main keeps crashes.log (`crashLogPath` in main/crashGuard.ts): the
 * logs folder in Electron's default userData folder for Eaon. The preload has
 * no call that returns that path, so it is spelled out per platform here;
 * `app:show-item` expands the leading ~.
 */
const CRASH_LOG: Record<string, string> = {
  darwin: '~/Library/Application Support/Eaon/logs/crashes.log',
  win32: '~/AppData/Roaming/Eaon/logs/crashes.log',
  linux: '~/.config/Eaon/logs/crashes.log'
}

function showCrashLog(): void {
  try {
    void window.api.app.showItem(CRASH_LOG[window.api.platform] ?? CRASH_LOG.linux).catch(() => undefined)
  } catch {
    // The preload bridge is what broke. Help › Show Crash Log in the menu bar does the same from main.
  }
}

/** Errors and rejected promises nothing caught, outside React's render. */
export function reportRendererErrors(): void {
  window.addEventListener('error', (event) => {
    // Chromium reports a benign layout notice as an error event.
    if (/ResizeObserver loop/.test(event.message)) return
    const error = event.error instanceof Error ? event.error : null
    report({ message: error?.message ?? event.message, stack: error?.stack ?? `${event.filename}:${event.lineno}:${event.colno}`, source: 'window error' })
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason
    const error = reason instanceof Error ? reason : null
    report({ message: error?.message ?? String(reason), stack: error?.stack, source: 'unhandled rejection' })
  })
}
