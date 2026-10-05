import { useEffect, useState } from 'react'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Switch } from '../../ui'
import { ModelSelect, type ModelRef } from '../../composer/ModelSelect'
import type { ModelOption } from '@shared/modelSelection'
import type { LocalServerStatus } from '@shared/types'
import type { GatewayInfo } from '@shared/gateway'

export function LocalServerPage(): JSX.Element {
  const { settings, patchSettings } = useApp()
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
  // Only what the gateway can serve (never a provider that points back at this server).
  const servedIds = new Set((gateway?.models ?? []).map((m) => m.id))
  const served = (option: ModelOption): boolean => !gateway || servedIds.has(`${option.providerId}/${option.modelId}`)

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
            <ModelSelect
              width={220}
              label="Default model"
              value={gatewayRef(gateway?.defaultModel)}
              onChange={(ref) => void window.api.gateway.setDefaults({ defaultModel: ref?.providerId ? `${ref.providerId}/${ref.modelId}` : null }).then(setGateway)}
              defaultLabel="The first model Eaon has"
              filter={served}
            />
          </Row>
          <Row title="Fast model" description="Used when an app asks for a small, fast model (a haiku or mini). Defaults to the model above.">
            <ModelSelect
              width={220}
              label="Fast model"
              value={gatewayRef(gateway?.smallModel)}
              onChange={(ref) => void window.api.gateway.setDefaults({ smallModel: ref?.providerId ? `${ref.providerId}/${ref.modelId}` : null }).then(setGateway)}
              defaultLabel="Same as default"
              filter={served}
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

/** The gateway names models `provider/model`; the model id itself may hold more slashes. */
function gatewayRef(id: string | null | undefined): ModelRef | null {
  if (!id) return null
  const slash = id.indexOf('/')
  return slash > 0 ? { providerId: id.slice(0, slash), modelId: id.slice(slash + 1) } : { providerId: null, modelId: id }
}
