import { useCallback, useEffect, useState } from 'react'
import { Check, ExternalLink, ScanSearch, Trash2 } from 'lucide-react'
import type { AppControlStatus, AppControlTraceEntry, AppInfo } from '@shared/appControl'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Switch } from '../../ui'

/**
 * Settings → App control. The switches are `settings.appControl`, read live
 * by the `app_control` tool and the control API; status comes from the
 * engine itself; the try-it panel runs the same `snapshot` an agent would
 * (read-only: the main process refuses anything that acts); the activity
 * list is what agents actually did.
 */

let lastStatus: AppControlStatus | null = null

const SOURCE_LABEL: Record<string, string> = { chat: 'Chat', worker: 'Worker', scheduled: 'Task', terminal: 'Terminal', settings: 'Settings' }

function time(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

function TryIt({ ready }: { ready: boolean }): JSX.Element {
  const [apps, setApps] = useState<(AppInfo & { protected?: boolean })[]>([])
  const [app, setApp] = useState('')
  const [interactive, setInteractive] = useState(true)
  const [busy, setBusy] = useState(false)
  const [output, setOutput] = useState<{ text: string; meta: string } | { error: string } | null>(null)

  useEffect(() => {
    if (!ready) return
    void window.api.appControl.try('list-apps', {}).then((envelope) => {
      if (!envelope.ok) return
      const list = ((envelope.data as { apps: (AppInfo & { protected?: boolean })[] }).apps ?? []).filter((a) => !a.protected)
      list.sort((a, b) => a.name.localeCompare(b.name))
      setApps(list)
      setApp((current) => current || String(list.find((a) => a.active)?.pid ?? list[0]?.pid ?? ''))
    })
  }, [ready])

  const read = async (): Promise<void> => {
    setBusy(true)
    try {
      const envelope = await window.api.appControl.try('snapshot', { app, interactive, compact: true, limit: 300 })
      if (!envelope.ok) setOutput({ error: `${envelope.error.message}${envelope.error.hint ? ` ${envelope.error.hint}` : ''}` })
      else {
        const data = envelope.data as { text: string; nodes: number; truncated?: boolean }
        setOutput({ text: data.text, meta: `${data.nodes} elements${data.truncated ? ', some left out' : ''}` })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Row title="Read an app" description="Shows an app's window the way an agent reads it. This only looks; it never clicks or types.">
        <div className="appctl__try">
          <select className="select appctl__select" value={app} disabled={!ready || apps.length === 0} onChange={(e) => setApp(e.target.value)} aria-label="App to read">
            {apps.map((a) => (
              <option key={a.pid} value={String(a.pid)}>
                {a.name}
              </option>
            ))}
          </select>
          <button className="btn" disabled={!ready || !app || busy} onClick={() => void read()}>
            <ScanSearch size={13} strokeWidth={1.9} />
            {busy ? 'Reading…' : 'Read'}
          </button>
        </div>
      </Row>
      <Row title="Only what can be operated" description="Buttons, fields, menus and the like, with the containers around them">
        <Switch label="Only what can be operated" checked={interactive} onChange={setInteractive} />
      </Row>
      {output && (
        <div className="appctl__output" role="status">
          {'error' in output ? (
            <div className="computer__error">{output.error}</div>
          ) : (
            <>
              <pre className="appctl__tree">{output.text}</pre>
              <div className="computer__meta">{output.meta}</div>
            </>
          )}
        </div>
      )}
    </>
  )
}

export function AppControlPage(): JSX.Element {
  const settings = useApp((s) => s.settings)
  const patchSettings = useApp((s) => s.patchSettings)
  const [status, setStatus] = useState<AppControlStatus | null>(lastStatus)
  const [activity, setActivity] = useState<AppControlTraceEntry[]>([])
  const [opening, setOpening] = useState(false)

  const refresh = useCallback(() => {
    void window.api.appControl.status().then((next) => {
      lastStatus = next
      setStatus(next)
    })
  }, [])

  // The Accessibility switch lives in System Settings: poll while the page is open, and check on return.
  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 3000)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])

  useEffect(() => {
    void window.api.appControl.activity(60).then(setActivity)
    return window.api.appControl.onActivity((entry) => setActivity((list) => [entry, ...list].slice(0, 60)))
  }, [])

  if (!settings) return <></>
  const ac = settings.appControl
  const mac = status?.platform === 'darwin'
  const needsPermission = mac && status?.permission === 'denied'
  const ready = Boolean(ac.enabled && status?.engine.available && !needsPermission)

  const openPermission = async (): Promise<void> => {
    setOpening(true)
    try {
      await window.api.appControl.openPermission()
    } finally {
      setOpening(false)
      refresh()
    }
  }

  return (
    <>
      <h1 className="settings__h1">App control</h1>
      <p className="settings__lede">
        Let agents read and operate the apps on your computer through their accessibility tree, the structure screen readers use. They press buttons, fill in fields
        and choose menu items by name, with no screenshots and without taking over your mouse, so you can keep working while they do.
      </p>

      {needsPermission && (
        <Section label="Setup">
          <Card>
            <ol className="computer__steps">
              <li className="row computer__step" data-done={false}>
                <span className="computer__step-mark" aria-hidden="true">
                  1
                </span>
                <div className="row__body">
                  <div className="row__title">Allow Accessibility</div>
                  <div className="row__desc">macOS lets an app read and operate other apps only with this. Switch on Eaon in the list that opens.</div>
                </div>
                <div className="row__trail">
                  <button className="btn btn--primary" disabled={opening} onClick={() => void openPermission()}>
                    {opening ? 'Opening…' : 'Open settings'}
                    <ExternalLink size={13} strokeWidth={1.9} />
                  </button>
                </div>
              </li>
            </ol>
          </Card>
        </Section>
      )}

      <Section label="Access">
        <Card>
          <Row title="Enable app control" description="Gives Eaon's agents in Work mode, workers and scheduled tasks the app_control tool. Anything that clicks or types asks first, as your approval setting says.">
            <Switch label="Enable app control" checked={ac.enabled} onChange={(on) => void patchSettings({ appControl: { enabled: on } })} />
          </Row>
          <Row
            title="Coding agents in the ADE"
            description="Claude Code, Codex and the other agents in ADE terminals can run eaon-apps, and Claude Code gets it through Eaon's MCP server. Their own permission prompts apply. Uses the Local API Server on this computer only; new terminals pick it up."
          >
            <Switch
              label="Coding agents in the ADE"
              checked={ac.terminalAgents}
              dimmed={!ac.enabled}
              onChange={(on) => void patchSettings({ appControl: { terminalAgents: on } })}
            />
          </Row>
          <Row title="Show what agents act on" description="Outline each button or field for a moment as an agent uses it">
            <Switch label="Show what agents act on" checked={ac.showActions} dimmed={!ac.enabled} onChange={(on) => void patchSettings({ appControl: { showActions: on } })} />
          </Row>
        </Card>
      </Section>

      <Section label="Status">
        <Card>
          <Row
            title="Engine"
            description={
              !status
                ? 'Checking…'
                : status.engine.available
                  ? `${status.engine.name}${status.engine.version ? ` ${status.engine.version}` : ''}`
                  : `${status.engine.name}: ${status.engine.detail ?? 'unavailable on this computer.'}`
            }
          >
            {status && <span className={`badge ${status.engine.available ? 'badge--ok' : 'badge--warn'}`}>{status.engine.available ? 'Ready' : 'Unavailable'}</span>}
          </Row>
          {mac && status && (
            <Row title="Accessibility" description={status.permission === 'granted' ? 'Eaon may read and operate other apps' : 'Not allowed yet: see Setup above'}>
              {status.permission === 'granted' ? (
                <span className="badge badge--ok">
                  <Check size={11} strokeWidth={2.4} /> Allowed
                </span>
              ) : (
                <span className="badge badge--warn">Not allowed</span>
              )}
            </Row>
          )}
          <Row title="Off limits" description={`${status?.protectedApps.join(', ') ?? 'Eaon, password managers, sign-in prompts'}, and every password field. Agents are told to ask you instead.`} />
        </Card>
      </Section>

      <Section label="Try it">
        <Card>
          {!ac.enabled ? <Row title="Turn on app control to try it" description="Nothing reads another app until you do." /> : <TryIt ready={ready} />}
        </Card>
      </Section>

      <Section label="For coding agents">
        <Card>
          <Row title="eaon-apps" description="In an ADE terminal, with coding agents allowed above. Every command prints one JSON result.">
            <code className="appctl__cmd">{status?.cli.command ?? 'eaon-apps'} guide</code>
          </Row>
          <pre className="appctl__tree appctl__tree--sample">{`eaon-apps snapshot Calculator -i
eaon-apps click @s4k2p9xq:e12
eaon-apps type @s4k2p9xq:e7 "Quarterly notes"
eaon-apps menu --app TextEdit "File > Save As…"
eaon-apps wait --app Calculator --text 42`}</pre>
        </Card>
      </Section>

      <Section
        label={
          <span className="appctl__label">
            Activity
            {activity.length > 0 && (
              <button
                className="btn btn--ghost appctl__clear"
                onClick={() => void window.api.appControl.clearActivity().then(() => setActivity([]))}
                aria-label="Clear activity"
              >
                <Trash2 size={12} strokeWidth={1.9} />
                Clear
              </button>
            )}
          </span>
        }
      >
        <Card>
          {activity.length === 0 ? (
            <Row title="Nothing yet" description="Every app an agent reads or operates shows here, without what was typed." />
          ) : (
            <ul className="appctl__activity">
              {activity.map((entry) => (
                <li key={entry.id} className="appctl__entry" data-ok={entry.ok}>
                  <span className="appctl__when">{time(entry.at)}</span>
                  <span className="appctl__who" title={entry.source.name}>
                    {entry.source.kind === 'settings' || entry.source.name === SOURCE_LABEL[entry.source.kind] ? SOURCE_LABEL[entry.source.kind] : `${SOURCE_LABEL[entry.source.kind] ?? entry.source.kind} · ${entry.source.name}`}
                  </span>
                  <span className="appctl__what">
                    <strong>{entry.command}</strong>
                    {entry.target ? ` ${entry.target}` : ''}
                    {!entry.ok && <span className="appctl__error"> {entry.code}: {entry.message}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </Section>
    </>
  )
}
