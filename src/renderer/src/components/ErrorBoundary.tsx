import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

/**
 * Keeps a render error to the part of the window it happened in. Without a
 * boundary React unmounts the whole tree and the window goes blank; with one
 * around each tab, panel and message, a bad message or a broken page shows a
 * small error of its own and the rest of Eaon keeps working. CrashScreen is
 * the last one, around everything. Every error caught is recorded in
 * crashes.log (main/crashGuard.ts).
 *
 * `resetKey` lets it try again when what it shows changes — a reply that
 * failed halfway through streaming gets another go with the next token —
 * instead of staying on the fallback until it is unmounted.
 */
export class ErrorBoundary extends Component<
  {
    children: ReactNode
    fallback: (error: Error, retry: () => void) => ReactNode
    resetKey?: unknown
    /** Where it sits, for crashes.log: "workers tab", "sidebar"… */
    area?: string
  },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: unknown): { error: Error } {
    // Anything can be thrown; the fallbacks expect a message to show.
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const caught = error instanceof Error ? error : new Error(String(error))
    reportError({
      message: caught.message,
      stack: `${caught.stack ?? ''}\nComponent stack:${info.componentStack ?? ''}`,
      source: this.props.area ? `render: ${this.props.area}` : 'render'
    })
  }

  componentDidUpdate(previous: { resetKey?: unknown }): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  retry = (): void => this.setState({ error: null })

  render(): ReactNode {
    const { error } = this.state
    return error ? this.props.fallback(error, this.retry) : this.props.children
  }
}

/**
 * One message or post in a thread. If it can't be drawn — data from an older
 * build, a hand-edited file — it says so in its own place and every other
 * message stays readable.
 */
export function RowBoundary({ item, children }: { item: unknown; children: ReactNode }): JSX.Element {
  return (
    <ErrorBoundary resetKey={item} area="message" fallback={() => <RowError />}>
      {children}
    </ErrorBoundary>
  )
}

function RowError(): JSX.Element {
  return (
    <div className="msg-row row-error" role="note">
      <AlertTriangle size={13} strokeWidth={2} aria-hidden />
      <span>This message couldn’t be shown.</span>
    </div>
  )
}

const reported = new Set<string>()

/** Records an error in crashes.log — for the boundaries, and for failures a store catches so the window can carry on. */
export function reportError(entry: { message: string; stack?: string; source: string }): void {
  // The same error repeating (a render loop, an interval) is one entry, and a runaway page cannot flood the log.
  if (reported.has(entry.message) || reported.size >= 20) return
  reported.add(entry.message)
  try {
    window.api.app.reportError(entry)
  } catch {
    // The preload bridge itself is what broke; nothing to report to.
  }
}
