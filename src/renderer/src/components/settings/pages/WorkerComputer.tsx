import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Loader2, TriangleAlert } from 'lucide-react'
import { Card, Modal, Row, Section, Segmented, Switch } from '../../ui'
import type { HostInstallProgress, HostPairing, WorkerHostState } from '@shared/workerHost'

const errorText = (error: unknown): string => (error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error))

const bytes = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`)

const PLATFORM: Record<string, string> = { linux: 'Linux', darwin: 'macOS' }

function connectionText(state: WorkerHostState): { label: string; tone: 'ok' | 'wait' | 'off' } {
  switch (state.connection) {
    case 'connected':
      return { label: 'Online', tone: 'ok' }
    case 'connecting':
      return { label: 'Connecting…', tone: 'wait' }
    case 'updating':
      return { label: 'Updating the host app…', tone: 'wait' }
    default:
      return { label: 'Offline', tone: 'off' }
  }
}

/** Install and move progress, newest last. */
function ProgressLog({ lines }: { lines: HostInstallProgress[] }): JSX.Element | null {
  const end = useRef<HTMLLIElement | null>(null)
  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [lines.length])
  if (lines.length === 0) return null
  return (
    <ol className="wh-log" aria-live="polite">
      {lines.map((line, i) => (
        <li key={i} ref={i === lines.length - 1 ? end : undefined} data-error={line.error ? 'true' : undefined} data-done={line.done ? 'true' : undefined}>
          {line.line}
        </li>
      ))}
    </ol>
  )
}

function LinkComputer({ onLinked }: { onLinked: (state: WorkerHostState) => void }): JSX.Element {
  const [how, setHow] = useState<'ssh' | 'command'>('ssh')
  const [host, setHost] = useState('')
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [sshPort, setSshPort] = useState('')
  const [keyFile, setKeyFile] = useState('')
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<HostInstallProgress[]>([])
  const [pairing, setPairing] = useState<HostPairing | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => window.api.workerHost.onProgress((line) => setLog((lines) => [...lines.slice(-60), line])), [])
  // A served install command ends with the page.
  useEffect(() => () => void window.api.workerHost.pairCancel(), [])

  const install = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setLog([])
    try {
      const state = await window.api.workerHost.installSsh({
        host: host.trim(),
        user: user.trim(),
        password: password || undefined,
        name: name.trim() || undefined,
        port: sshPort ? Number(sshPort) : undefined,
        keyFile: keyFile.trim() || undefined
      })
      setPassword('')
      onLinked(state)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const getCommand = async (): Promise<void> => {
    setError(null)
    setLog([])
    try {
      setPairing(await window.api.workerHost.pairStart())
    } catch (e) {
      setError(errorText(e))
    }
  }

  const copy = (): void => {
    if (!pairing) return
    void navigator.clipboard.writeText(pairing.command)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Section label="Link a computer">
      <Card>
        <div className="row row--stack">
          <Segmented
            value={how}
            onChange={(value) => {
              setHow(value)
              setError(null)
            }}
            options={[
              { value: 'ssh', label: 'Over SSH' },
              { value: 'command', label: 'With a command' }
            ]}
          />
        </div>
        {how === 'ssh' ? (
          <>
            <div className="row row--stack">
              <p className="wh-hint">Eaon signs in to the other computer, sends it the host app and sets it up to start with the computer. SSH has to be on there.</p>
              <div className="wh-form">
                <label>
                  <span>Address</span>
                  <input className="input" value={host} placeholder="raspberrypi.local or 192.168.1.20" onChange={(e) => setHost(e.target.value)} disabled={busy} spellCheck={false} />
                </label>
                <label>
                  <span>User name</span>
                  <input className="input" value={user} placeholder="pi" onChange={(e) => setUser(e.target.value)} disabled={busy} spellCheck={false} autoCapitalize="off" />
                </label>
                <label>
                  <span>Password</span>
                  <input
                    className="input"
                    type="password"
                    value={password}
                    placeholder="Leave empty to use your SSH key"
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={busy}
                  />
                </label>
                {more && (
                  <>
                    <label>
                      <span>Name</span>
                      <input className="input" value={name} placeholder="Shown in Eaon, like “Garage Pi”" onChange={(e) => setName(e.target.value)} disabled={busy} />
                    </label>
                    <label>
                      <span>SSH port</span>
                      <input className="input" type="number" value={sshPort} placeholder="22" onChange={(e) => setSshPort(e.target.value)} disabled={busy} />
                    </label>
                    <label>
                      <span>Key file</span>
                      <input className="input" value={keyFile} placeholder="~/.ssh/id_ed25519" onChange={(e) => setKeyFile(e.target.value)} disabled={busy} spellCheck={false} />
                    </label>
                  </>
                )}
              </div>
              <div className="wh-actions">
                <button className="btn btn--primary" disabled={busy || !host.trim() || !user.trim()} onClick={() => void install()}>
                  {busy ? (
                    <>
                      <Loader2 size={14} className="spinner" /> Installing…
                    </>
                  ) : (
                    'Install and link'
                  )}
                </button>
                {!more && (
                  <button className="btn btn--ghost" disabled={busy} onClick={() => setMore(true)}>
                    More options
                  </button>
                )}
              </div>
              <p className="wh-hint">The password is used for this install only, and is never saved.</p>
            </div>
          </>
        ) : (
          <div className="row row--stack">
            <p className="wh-hint">Run one command on the other computer, in its terminal or over SSH. It downloads the host app from this computer, so both need to be on the same network.</p>
            {pairing ? (
              <>
                <div className="wh-command">
                  <code>{pairing.command}</code>
                  <button className="btn btn--ghost" onClick={copy} aria-label="Copy the command">
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <p className="wh-hint">
                  Eaon links to it as soon as it finishes. The command holds the link’s key, so don’t share it; it stops working after it’s used, or in
                  30 minutes.
                </p>
              </>
            ) : (
              <div className="wh-actions">
                <button className="btn btn--primary" onClick={() => void getCommand()}>
                  Get the command
                </button>
              </div>
            )}
          </div>
        )}
        {(log.length > 0 || error) && (
          <div className="row row--stack">
            <ProgressLog lines={log} />
            {error && <p className="ch-error">{error}</p>}
          </div>
        )}
      </Card>
      <p className="wh-footnote">
        Works with Linux (Raspberry Pi OS, Debian, Ubuntu) and macOS. A 64-bit Raspberry Pi 4 or 5 with 4 GB is plenty; each worker’s browser needs about 300
        MB of memory. The first install downloads Electron (about 100 MB) on that computer.
      </p>
    </Section>
  )
}

export function WorkerComputerPage(): JSX.Element {
  const [state, setState] = useState<WorkerHostState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<HostInstallProgress[]>([])
  const [confirm, setConfirm] = useState<'unlink' | 'restore' | null>(null)
  const [removeApp, setRemoveApp] = useState(true)
  const [address, setAddress] = useState('')
  const [reinstallPassword, setReinstallPassword] = useState('')

  useEffect(() => {
    void window.api.workerHost.state().then(setState)
    const offState = window.api.workerHost.onState(setState)
    const offProgress = window.api.workerHost.onProgress((line) => setLog((lines) => [...lines.slice(-40), line]))
    return () => {
      offState()
      offProgress()
    }
  }, [])
  useEffect(() => {
    if (state?.host) setAddress(state.host.address)
  }, [state?.host?.address]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (job: () => Promise<WorkerHostState>): Promise<void> => {
    setBusy(true)
    setError(null)
    setLog([])
    try {
      setState(await job())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const host = state?.host ?? null
  const hello = state?.hello ?? null
  const online = state?.connection === 'connected'
  const status = state ? connectionText(state) : null
  const name = host?.name ?? 'the worker computer'

  const toggle = (on: boolean): void => {
    if (!on && !online) {
      setConfirm('restore')
      return
    }
    void run(() => window.api.workerHost.setEnabled(on))
  }

  return (
    <>
      <h1 className="settings__h1">Worker computer</h1>
      <p className="wh-intro">
        Keep your workers on another computer you leave on, like a Raspberry Pi, a spare Mac or a home server, so they keep working while this one is closed.
        Their folders and their own browsers live there too. You still see them, talk to them and watch their browsers from here.
      </p>

      {state && !host && <LinkComputer onLinked={setState} />}

      {state && host && (
        <>
          <Section>
            <Card>
              <Row
                title={
                  <span className="wh-title">
                    {host.name}
                    {status && (
                      <span className="wh-status" data-tone={status.tone}>
                        <span className="wh-dot" aria-hidden="true" />
                        {status.label}
                      </span>
                    )}
                  </span>
                }
                description={[`${host.address}:${host.port}`, PLATFORM[host.platform] ?? host.platform, host.arch].filter(Boolean).join(' · ')}
              >
                {!online && state.connection !== 'updating' && (
                  <button className="btn btn--ghost" disabled={busy} onClick={() => void run(() => window.api.workerHost.reconnect())}>
                    Try again
                  </button>
                )}
              </Row>
              <Row
                title={`Run workers on ${host.name}`}
                description={
                  state.enabled
                    ? `Your workers, their folders and their browsers are on ${host.name}. They keep working while this computer is off.`
                    : 'Your workers run on this computer. Turning this on moves them, with their threads and folders.'
                }
              >
                <Switch label={`Run workers on ${host.name}`} checked={state.enabled} disabled={busy || Boolean(state.moving) || (!state.enabled && !online)} onChange={toggle} />
              </Row>
              {state.moving && (
                <div className="row row--stack">
                  <p className="wh-moving">
                    <Loader2 size={14} className="spinner" /> {state.moving.step}…
                  </p>
                </div>
              )}
              {(log.length > 0 || error || state.error) && !state.moving && (
                <div className="row row--stack">
                  <ProgressLog lines={log} />
                  {(error || (state.error && !online)) && <p className="ch-error">{error ?? state.error}</p>}
                </div>
              )}
            </Card>
          </Section>

          {hello && (
            <Section label="On that computer">
              <Card>
                <Row
                  title="Workers"
                  description={`${hello.workers} worker${hello.workers === 1 ? '' : 's'}${hello.running ? `, ${hello.running} working now` : ''} · ${bytes(hello.memory.free)} of ${bytes(hello.memory.total)} memory free · load ${hello.load.toFixed(2)}`}
                />
                <Row
                  title="Browsers"
                  description={
                    hello.runtime === 'electron'
                      ? 'Each worker has its own browser there. Watch it live, or take control to sign it in, from the worker’s page.'
                      : (hello.browserNote ?? 'Workers there work without a browser.')
                  }
                />
                <Row
                  title="Keys and settings"
                  description="Your API keys, providers, MCP servers and skills go to it over the encrypted link whenever it connects, so workers think with the same models and tools."
                >
                  <button className="btn btn--ghost" disabled={busy || !online} onClick={() => void run(() => window.api.workerHost.sync())}>
                    Send again
                  </button>
                </Row>
                <Row title="Host app" description={`Version ${hello.appVersion}. Eaon keeps it up to date by itself.`} />
              </Card>
            </Section>
          )}

          <Section label="Connection">
            <Card>
              <Row title="Address" description="Where Eaon finds it. Change this if its address on your network changed.">
                <input className="input" style={{ width: 200 }} value={address} disabled={busy} onChange={(e) => setAddress(e.target.value)} spellCheck={false} />
                <button
                  className="btn btn--ghost"
                  disabled={busy || !address.trim() || address.trim() === host.address}
                  onClick={() => void run(() => window.api.workerHost.setAddress(address.trim()))}
                >
                  Save
                </button>
              </Row>
              {host.ssh && (
                <Row
                  title="Reinstall the host app"
                  description={`Signs in to ${host.ssh.user}@${host.address} again and installs it afresh, keeping the link and the workers there. For when it stopped answering.`}
                >
                  <input
                    className="input"
                    style={{ width: 150 }}
                    type="password"
                    placeholder="Password, if needed"
                    value={reinstallPassword}
                    disabled={busy}
                    onChange={(e) => setReinstallPassword(e.target.value)}
                  />
                  <button
                    className="btn btn--ghost"
                    disabled={busy || Boolean(state.moving)}
                    onClick={() =>
                      void run(async () => {
                        const next = await window.api.workerHost.reinstall(reinstallPassword || undefined)
                        setReinstallPassword('')
                        return next
                      })
                    }
                  >
                    {busy ? <Loader2 size={14} className="spinner" /> : 'Reinstall'}
                  </button>
                </Row>
              )}
              <div className="row row--stack">
                <div className="ch-warn" role="note">
                  <TriangleAlert size={15} strokeWidth={2} aria-hidden="true" />
                  <span>
                    The link is encrypted end to end with a key only this computer and {host.name} hold. To reach it away from home, put both on a private
                    network such as Tailscale and use its Tailscale address.
                  </span>
                </div>
              </div>
            </Card>
          </Section>

          <Section>
            <Card>
              <Row
                title="Unlink"
                description={state.enabled ? `Brings your workers back to this computer first, then forgets ${host.name}.` : `Forgets ${host.name}.`}
              >
                <button className="btn btn--danger" disabled={busy || Boolean(state.moving)} onClick={() => setConfirm('unlink')}>
                  Unlink…
                </button>
              </Row>
            </Card>
          </Section>
        </>
      )}

      <Modal
        open={confirm === 'unlink'}
        onClose={() => setConfirm(null)}
        title={`Unlink ${name}?`}
        actions={
          <>
            <button className="btn btn--ghost" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              className="btn btn--danger"
              autoFocus
              onClick={() => {
                setConfirm(null)
                void run(() => window.api.workerHost.unlink({ removeApp: removeApp && online, fromBackup: Boolean(state?.enabled && !online) }))
              }}
            >
              Unlink
            </button>
          </>
        }
      >
        {state?.enabled && !online ? (
          <p>
            {name} can’t be reached, so your workers come back as they were when they moved there
            {state.backupAt ? ` (${new Date(state.backupAt).toLocaleString()})` : ''}. Whatever they did on {name} since stays there, and it keeps
            running them until you remove the host app there with <code>sh ~/.eaon-host/app/install.sh --uninstall</code>.
          </p>
        ) : state?.enabled ? (
          <p>Your workers, their threads and their folders come back to this computer first.</p>
        ) : null}
        {online && (
          <label className="wh-check">
            <input type="checkbox" checked={removeApp} onChange={(e) => setRemoveApp(e.target.checked)} />
            Also remove the host app from {name}
          </label>
        )}
      </Modal>

      <Modal
        open={confirm === 'restore'}
        onClose={() => setConfirm(null)}
        title={`${name} can’t be reached`}
        actions={
          <>
            <button className="btn btn--ghost" onClick={() => setConfirm(null)}>
              Wait for it
            </button>
            <button
              className="btn btn--danger"
              onClick={() => {
                setConfirm(null)
                void run(() => window.api.workerHost.setEnabled(false, { fromBackup: true }))
              }}
            >
              Use the copy here
            </button>
          </>
        }
      >
        <p>
          Bringing your workers back needs {name}. You can instead restore them from the copy this computer kept when they moved
          {state?.backupAt ? ` (${new Date(state.backupAt).toLocaleString()})` : ''}. Anything they did on {name} since then is left there, and when it’s back
          online Eaon stops them there, so they only run here.
        </p>
      </Modal>
    </>
  )
}
