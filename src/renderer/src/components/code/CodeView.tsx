import { useEffect, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Bug,
  CircleAlert,
  Compass,
  Folder,
  FolderOpen,
  GitCompare,
  Loader2,
  RotateCw,
  SquareTerminal,
  TestTubeDiagonal,
  X
} from 'lucide-react'
import { useApp } from '../../state/store'
import { CodeComposer, modelLabel } from './CodeComposer'
import { CodeHeader, folderName } from './CodeHeader'
import { useCode } from './codeStore'
import { ExtensionDialog } from './ExtensionDialog'
import { Onboarding } from './Onboarding'
import { Thread } from './Thread'

/** The Code tab's main area: an Eaon Code session in a project folder. */
export function CodeView(): JSX.Element {
  const { status, cwd, startError, starting, hasItems, process } = useCode(
    useShallow((s) => ({
      status: s.status,
      cwd: s.cwd,
      startError: s.startError,
      starting: s.starting,
      hasItems: s.transcript.items.length > 0,
      process: s.process
    }))
  )

  useEffect(() => {
    void useCode.getState().init()
  }, [])

  // Esc stops a running turn from anywhere in the tab — unless a menu or
  // dialog is open, which gets the key first.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('.layer')) return
      const { transcript, awaiting, abort } = useCode.getState()
      if (transcript.running || awaiting) {
        event.preventDefault()
        void abort()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const crashed = process.state === 'exited' && Boolean(process.crashed) && process.cwd === cwd && !starting && !startError

  let body: JSX.Element
  if (!status) body = <div className="code-fill" />
  else if (status.state !== 'ready') body = <Onboarding status={status} />
  else if (!cwd) body = <NoFolder />
  else if (startError && !starting) body = <StartFailure error={startError} />
  else if (!hasItems) body = <CodeHome crashed={crashed} />
  else
    body = (
      <>
        <Thread />
        <div className="composer-dock code-dock">
          {crashed && <CrashBanner />}
          <CodeComposer variant="dock" />
        </div>
      </>
    )

  return (
    <>
      <CodeHeader />
      {body}
      <ExtensionDialog />
      <Toast />
    </>
  )
}

const SUGGESTIONS = [
  { icon: Compass, color: '#60a5fa', label: 'Explain this\ncodebase', prompt: 'Give me a tour of this codebase: what it does, how it is laid out, and where to start reading.' },
  { icon: Bug, color: '#fb923c', label: 'Find and fix\na bug', prompt: 'Find and fix the bug where ' },
  { icon: TestTubeDiagonal, color: '#34d399', label: 'Write tests\nfor a module', prompt: 'Write tests for ' },
  { icon: GitCompare, color: '#a78bfa', label: 'Review my\nchanges', prompt: 'Review my uncommitted changes (git diff) and point out bugs, risks and missing tests.' }
]

let suggestionNonce = 0

function CodeHome({ crashed }: { crashed: boolean }): JSX.Element {
  const { cwd, starting, session, status } = useCode(
    useShallow((s) => ({ cwd: s.cwd, starting: s.starting, session: s.session, status: s.status }))
  )
  const suggestionsOn = useApp((s) => s.settings?.general.suggestedPrompts !== false)

  return (
    <div className="home code-home">
      <SquareTerminal size={44} strokeWidth={1.3} className="home__icon" />
      <h1 className="home__title">What should we build?</h1>
      {suggestionsOn && (
        <div className="suggestions">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              className="suggestion-card"
              onClick={() => useCode.setState({ draft: { text: s.prompt, nonce: ++suggestionNonce } })}
            >
              <s.icon size={20} strokeWidth={1.8} style={{ color: s.color }} />
              <span className="suggestion-card__label">{s.label}</span>
            </button>
          ))}
        </div>
      )}
      {crashed && (
        <div className="code-home__crash">
          <CrashBanner />
        </div>
      )}
      <div className="code-home__stack">
        <div className="project-bar code-project-bar">
          <button className="project-bar__pick" onClick={() => void useCode.getState().chooseFolder()} title={cwd ?? ''}>
            <Folder size={15} strokeWidth={1.8} />
            <span className="project-bar__label">{cwd ? folderName(cwd) : 'Choose a folder'}</span>
          </button>
          <span className="project-bar__status code-project-bar__status">
            {starting ? (
              <>
                <Loader2 size={13} strokeWidth={2} className="spinner" />
                Starting Eaon Code…
              </>
            ) : session ? (
              <>
                <span className="code-dot" data-state="ready" />
                Eaon Code {status?.version} · {modelLabel(session.model)}
              </>
            ) : null}
          </span>
        </div>
        <CodeComposer variant="home" />
      </div>
    </div>
  )
}

function NoFolder(): JSX.Element {
  const { recents, chooseFolder, openFolder } = useCode(
    useShallow((s) => ({ recents: s.recents, chooseFolder: s.chooseFolder, openFolder: s.openFolder }))
  )
  return (
    <div className="home code-home">
      <FolderOpen size={44} strokeWidth={1.3} className="home__icon" />
      <h1 className="home__title code-home__title--tight">Open a project</h1>
      <p className="code-home__lede">Eaon Code works inside one folder at a time — it reads, edits and runs the code there.</p>
      <button className="btn btn--accent code-home__cta" onClick={() => void chooseFolder()}>
        <Folder size={14} strokeWidth={2} />
        Choose folder…
      </button>
      {recents.length > 0 && (
        <div className="code-recents">
          <div className="code-recents__label">Recent</div>
          {recents.map((path) => (
            <button key={path} className="code-recents__row" onClick={() => void openFolder(path)}>
              <Folder size={15} strokeWidth={1.8} />
              <span className="code-recents__name">{folderName(path)}</span>
              <span className="code-recents__path">{path}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function StartFailure({ error }: { error: string }): JSX.Element {
  const { start, cwd } = useCode(useShallow((s) => ({ start: s.start, cwd: s.cwd })))
  const [first, ...rest] = error.split('\n')
  return (
    <div className="home code-home">
      <div className="code-failure">
        <div className="code-failure__head">
          <CircleAlert size={18} strokeWidth={1.9} />
          <span>Eaon Code could not start</span>
        </div>
        <p className="code-failure__message">{first}</p>
        {rest.length > 0 && <pre className="code-failure__log scroll">{rest.join('\n')}</pre>}
        <div className="code-failure__actions">
          <button className="btn btn--accent" onClick={() => void start()}>
            <RotateCw size={14} strokeWidth={2} />
            Try again
          </button>
          {cwd && (
            <button
              className="btn"
              onClick={async () => {
                const result = await window.api.eaonCode.openTerminal(cwd)
                if (!result.ok) useCode.setState({ toast: result.error })
              }}
            >
              <SquareTerminal size={14} strokeWidth={2} />
              Open in Terminal
            </button>
          )}
          <button className="btn btn--ghost" onClick={() => useApp.getState().setSettingsPage('eaon-code')}>
            Settings
          </button>
        </div>
      </div>
    </div>
  )
}

/** The process died on its own: say so, show why, offer to bring the session back. */
function CrashBanner(): JSX.Element {
  const { process, start, session, stats } = useCode(
    useShallow((s) => ({ process: s.process, start: s.start, session: s.session, stats: s.stats }))
  )
  const tail = process.stderr.trim().split('\n').slice(-4).join('\n')
  return (
    <div className="code-crash">
      <CircleAlert size={15} strokeWidth={1.9} className="code-crash__icon" />
      <div className="code-crash__body">
        <span className="code-crash__title">
          Eaon Code stopped unexpectedly
          {typeof process.exitCode === 'number' ? ` (exit code ${process.exitCode})` : process.signal ? ` (${process.signal})` : ''}
        </span>
        {tail && <pre className="code-crash__log">{tail}</pre>}
      </div>
      <button className="btn btn--sm" onClick={() => void start(stats?.assistantMessages ? session?.sessionFile : undefined)}>
        <RotateCw size={13} strokeWidth={2} />
        Restart
      </button>
    </div>
  )
}

function Toast(): JSX.Element | null {
  const toast = useCode((s) => s.toast)
  const dismiss = useCode((s) => s.dismissToast)
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(dismiss, 6000)
    return () => clearTimeout(timer)
  }, [toast, dismiss])
  if (!toast) return null
  return (
    <div className="code-toast" role="status">
      <span>{toast}</span>
      <button className="icon-btn" onClick={dismiss} aria-label="Dismiss">
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  )
}
