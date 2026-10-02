import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Select, Switch } from '../../ui'
import type { LocalServerStatus } from '@shared/types'

export function LocalServerPage(): JSX.Element {
  const { settings, patchSettings } = useApp()
  const models = useApp(useShallow((s) => s.availableModels()))
  const [status, setStatus] = useState<LocalServerStatus>({ running: false, port: 1337, url: null })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.localServer.status().then(setStatus)
    return window.api.localServer.onStatus(setStatus)
  }, [])

  if (!settings) return <></>
  const local = settings.localServer

  const toggle = async (): Promise<void> => {
    setBusy(true)
    try {
      setStatus(status.running ? await window.api.localServer.stop() : await window.api.localServer.start())
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h1 className="settings__h1">Local API Server</h1>

      <Section>
        <Card>
          <Row title="Local API Server" description="Run an OpenAI-compatible server locally.">
            <button className="btn btn--provider" disabled={busy} onClick={() => void toggle()}>
              {busy ? '…' : status.running ? 'Stop Server' : 'Start Server'}
            </button>
          </Row>
          <Row title="Auto start" description="Automatically start the Local API Server when the application launches.">
            <Switch
              label="Auto start"
              checked={local.autoStart}
              onChange={(on) => void patchSettings({ localServer: { autoStart: on } })}
            />
          </Row>
          <Row title="Port" description="The loopback port the server listens on. Restart the server to apply.">
            <input
              className="input"
              style={{ width: 110 }}
              type="number"
              value={local.port}
              onChange={(e) =>
                void patchSettings({ localServer: { port: Number(e.target.value) || 1337 } })
              }
            />
          </Row>
          <Row
            title="Default Model Local API Server"
            description="Model used when a request doesn't name one."
          >
            <Select
              width={200}
              value={local.defaultModelId ?? ''}
              onChange={(value) => void patchSettings({ localServer: { defaultModelId: value || null } })}
              options={
                models.length > 0
                  ? models.map((m) => ({ value: m.id, label: m.label }))
                  : [{ value: '', label: 'Select a local ...' }]
              }
            />
          </Row>
        </Card>
      </Section>

      <Section>
        <Card>
          <Row
            title="Server Status"
            description={
              status.error
                ? `Failed to start: ${status.error}`
                : status.running
                  ? `Running at ${status.url}`
                  : 'The server is stopped.'
            }
          />
          <Row title="API Documentation" description="View interactive API documentation (Swagger UI).">
            <button
              className="btn"
              disabled={!status.running}
              onClick={() => status.url && void window.api.app.openExternal(`${status.url}/docs`)}
            >
              Open Docs
            </button>
          </Row>
        </Card>
        {status.running && (
          <p className="settings__lede" style={{ marginTop: 12 }}>
            Point any OpenAI-compatible client at <code>{status.url}/v1</code>. Requests use whichever provider key
            you have configured. The server is bound to loopback only.
          </p>
        )}
      </Section>
    </>
  )
}
