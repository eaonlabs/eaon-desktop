import { useEffect, useRef, useState, type JSX } from 'react'
import { Check, CircleAlert, Download, ExternalLink, FolderSearch, RefreshCw, SquareTerminal, X } from 'lucide-react'
import { useApp } from '../../state/store'
import { useCode } from './codeStore'
import { EAON_CODE_PACKAGE, EAON_CODE_REPO, type EaonCodeStatus } from '@shared/eaonCode'

/**
 * Shown in place of the Code tab when Eaon Code cannot run: not installed, or
 * installed but failing (usually a Node that is too old). Every check is real
 * — the Node version comes from running `node --version` on the same PATH the
 * session will use — and install is Eaon Code's own npm command.
 */
export function Onboarding({ status }: { status: EaonCodeStatus }): JSX.Element {
  const refreshStatus = useCode((s) => s.refreshStatus)
  const checking = useCode((s) => s.checking)
  const [installing, setInstalling] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => window.api.eaonCode.onInstallLog((line) => setLog((lines) => [...lines.slice(-300), line])), [])
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  const install = async (): Promise<void> => {
    setInstalling(true)
    setError(null)
    setLog([])
    const result = await window.api.eaonCode.install()
    setInstalling(false)
    if (!result.ok) {
      setError(result.error)
      await refreshStatus(true)
      return
    }
    useCode.setState({ status: result.data })
    // Straight into the folder picker or the last folder.
    useCode.setState({ initialised: false })
    void useCode.getState().init()
  }

  const applyBinary = async (binaryPath: string | null): Promise<void> => {
    const settings = useApp.getState().settings
    if (!settings) return
    await useApp.getState().patchSettings({ eaonCode: { ...settings.eaonCode, binaryPath } })
    const next = await refreshStatus(true)
    if (next.state === 'ready') {
      useCode.setState({ initialised: false })
      void useCode.getState().init()
    }
  }
  const locate = async (): Promise<void> => {
    const path = await window.api.eaonCode.pickBinary()
    if (path) await applyBinary(path)
  }
  const autoDetect = (): Promise<void> => applyBinary(null)

  const broken = status.state === 'broken'
  const nodeOk = status.node.ok

  return (
    <div className="code-onboarding scroll">
      <div className="code-onboarding__card">
        <div className="code-onboarding__icon">
          <SquareTerminal size={26} strokeWidth={1.6} />
        </div>
        <h1 className="code-onboarding__title">{broken ? 'Eaon Code needs attention' : 'Set up Eaon Code'}</h1>
        <p className="code-onboarding__lede">
          The Code tab is a window onto Eaon Code, the coding agent that works directly in your project folder — reading,
          editing and running your code.{' '}
          {!broken
            ? 'It runs on Node and installs with npm.'
            : status.source === 'setting'
              ? 'The path set for it in Settings does not work.'
              : 'It is installed, but it would not start.'}
        </p>

        <ul className="code-checks">
          <li className="code-check" data-ok={nodeOk || undefined}>
            <span className="code-check__mark">{nodeOk ? <Check size={14} strokeWidth={2.4} /> : <X size={14} strokeWidth={2.4} />}</span>
            <span className="code-check__body">
              <span className="code-check__title">Node.js {status.nodeRequirement.replace('>=', '')} or newer</span>
              <span className="code-check__detail">
                {status.node.version
                  ? `Found Node ${status.node.version}${status.node.path ? ` at ${status.node.path}` : ''}${nodeOk ? '' : ' — too old'}`
                  : 'No node on your PATH'}
              </span>
            </span>
          </li>
          <li className="code-check" data-ok={status.state === 'ready' || undefined}>
            <span className="code-check__mark">
              {status.state === 'ready' ? <Check size={14} strokeWidth={2.4} /> : <X size={14} strokeWidth={2.4} />}
            </span>
            <span className="code-check__body">
              <span className="code-check__title">Eaon Code</span>
              <span className="code-check__detail">
                {broken
                  ? (status.error ?? 'Found, but it would not run.')
                  : status.binaryPath
                    ? `${status.version ?? ''} at ${status.binaryPath}`
                    : `Not installed — no eaon-code on your PATH`}
              </span>
            </span>
          </li>
        </ul>

        {!nodeOk && (
          <p className="code-onboarding__hint">
            Install a current Node from{' '}
            <a href="https://nodejs.org" onClick={(e) => (e.preventDefault(), void window.api.app.openExternal('https://nodejs.org'))}>
              nodejs.org
            </a>{' '}
            or with a version manager (<code>nvm install 22</code>), then check again.
          </p>
        )}

        <div className="code-onboarding__actions">
          <button className="btn btn--accent" disabled={!nodeOk || installing} onClick={() => void install()}>
            {installing ? <RefreshCw size={14} strokeWidth={2} className="spinner" /> : <Download size={14} strokeWidth={2} />}
            {installing ? 'Installing…' : broken ? 'Reinstall Eaon Code' : 'Install Eaon Code'}
          </button>
          <button className="btn" disabled={checking || installing} onClick={() => void refreshStatus(true)}>
            <RefreshCw size={14} strokeWidth={2} className={checking ? 'spinner' : undefined} />
            Check again
          </button>
          <button className="btn btn--ghost" disabled={installing} onClick={() => void locate()}>
            <FolderSearch size={14} strokeWidth={2} />
            Locate…
          </button>
          {status.source === 'setting' && (
            <button className="btn btn--ghost" disabled={installing} onClick={() => void autoDetect()}>
              Find on PATH instead
            </button>
          )}
        </div>
        <p className="code-onboarding__command">
          <code>npm install -g --ignore-scripts {EAON_CODE_PACKAGE}</code>
        </p>

        {(installing || log.length > 0) && (
          <pre ref={logRef} className="code-onboarding__log scroll">
            {log.join('\n') || 'Starting npm…'}
          </pre>
        )}
        {error && (
          <div className="msg__error code-onboarding__error">
            <CircleAlert size={15} strokeWidth={1.9} style={{ flex: 'none', marginTop: 1 }} />
            <span>{error}</span>
          </div>
        )}

        <button className="code-onboarding__link" onClick={() => void window.api.app.openExternal(EAON_CODE_REPO)}>
          <ExternalLink size={13} strokeWidth={2} />
          Eaon Code on GitHub
        </button>
      </div>
    </div>
  )
}
