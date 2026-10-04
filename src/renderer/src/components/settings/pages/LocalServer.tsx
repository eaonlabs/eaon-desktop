import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Select, Switch } from '../../ui'
import type { LocalServerStatus } from '@shared/types'
import type { GatewayInfo } from '@shared/gateway'

export function LocalServerPage(): JSX.Element {
  const { settings, patchSettings } = useApp()
  const models = useApp(useShallow((s) => s.availableModels()))
  const [status, setStatus] = useState<LocalServerStatus>({ running: false, port: 1337, url: null })
  const [busy, setBusy] = useState(false)
  const [gateway, setGateway] = useState<GatewayInfo | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void window.api.localServer.status().then(setStatus)
    return window.api.localServer.onStatus(setStatus)
  }, [])
  // The key and the model list; re-read when the server starts or stops.
  useEffect(() => {
    void window.api.gateway.info().then(setGateway)
  }, [status.running])

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
            title="Default model"
            description="Used when an app asks for a model Eaon doesn't have, like Claude Code's or Codex's own model names."
          >
            <Select
              width={220}
              value={gateway?.defaultModel ?? ''}
              onChange={(value) => void window.api.gateway.setDefaults({ defaultModel: value || null }).then(setGateway)}
              options={
                gateway && gateway.models.length > 0
                  ? gateway.models.map((m) => ({ value: m.id, label: `${m.label} · ${m.providerName}` }))
                  : [{ value: '', label: models.length ? 'Loading…' : 'No models yet' }]
              }
            />
          </Row>
          <Row title="Fast model" description="Used when an app asks for a small, fast model (a haiku or mini). Defaults to the model above.">
            <Select
              width={220}
              value={gateway?.smallModel ?? ''}
              onChange={(value) => void window.api.gateway.setDefaults({ smallModel: value || null }).then(setGateway)}
              options={[
                { value: '', label: 'Same as default' },
                ...(gateway?.models ?? []).map((m) => ({ value: m.id, label: `${m.label} · ${m.providerName}` }))
              ]}
            />
          </Row>
          <Row title="Key" description="Apps connected to Eaon send this. Requests with no key still work; a wrong key is refused.">
            <code className="code-settings__path" style={{ fontSize: 12 }}>
              {gateway ? `${gateway.token.slice(0, 10)}…` : '…'}
            </code>
            <button
              className="btn btn--ghost"
              disabled={!gateway}
              onClick={() => {
                if (!gateway) return
                void navigator.clipboard.writeText(gateway.token)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
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
            OpenAI-style apps use <code>{status.url}/v1</code>; Anthropic-style apps (Claude Code) use{' '}
            <code>{status.url}</code>. Tools work in both. Models are named <code>provider/model</code>, and each
            request uses the keys you saved in Eaon. The server only answers this computer.
          </p>
        )}
      </Section>
    </>
  )
}
