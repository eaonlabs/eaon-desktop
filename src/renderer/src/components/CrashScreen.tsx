import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

/**
 * Catches a render error anywhere in the app. Without it React unmounts the
 * whole tree and the window goes blank; with it the user sees what happened
 * and can reload. Every error is recorded in crashes.log (main/crashGuard.ts),
 * as are errors outside React (see `reportRendererErrors`).
 */
export class CrashScreen extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    report({ message: error.message, stack: `${error.stack ?? ''}\nComponent stack:${info.componentStack ?? ''}`, source: 'render' })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash-screen" role="alert">
        <div className="crash-screen__drag" />
        <div className="empty-state">
          <AlertTriangle className="empty-state__icon" size={28} strokeWidth={1.6} aria-hidden />
          <div className="empty-state__title">Something went wrong</div>
          <div className="empty-state__body">Eaon hit an error showing this screen. Your chats are saved; reloading brings the window back.</div>
          <pre className="crash-screen__error">{error.message}</pre>
          <button className="btn btn--primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    )
  }
}

const reported = new Set<string>()

function report(entry: { message: string; stack?: string; source: string }): void {
  // The same error repeating (a render loop, an interval) is one entry, and a runaway page cannot flood the log.
  if (reported.has(entry.message) || reported.size >= 20) return
  reported.add(entry.message)
  try {
    window.api.app.reportError(entry)
  } catch {
    // The preload bridge itself is what broke; nothing to report to.
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
