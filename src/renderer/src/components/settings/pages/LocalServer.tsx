import { useEffect, useState } from 'react'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Switch } from '../../ui'
import { notify } from '../../Notice'
import { CLIPBOARD_FAILED, copyText } from '../../../lib/clipboard'
import { ModelSelect, type ModelRef } from '../../composer/ModelSelect'
import type { ModelOption } from '@shared/modelSelection'
import type { LocalServerStatus } from '@shared/types'
import type { GatewayInfo } from '@shared/gateway'
import { portProblem } from '../../../lib/port'

export function LocalServerPage(): JSX.Element {
  const { settings, patchSettings } = useApp()
  const [status, setStatus] = useState<LocalServerStatus>({ running: false, port: 1337, url: null })
  const [busy, setBusy] = useState(false)
  const [gateway, setGateway] = useState<GatewayInfo | null>(null)
  const [copied, setCopied] = useState(false)
  /** Why the port typed last wasn't kept; cleared by the next one that is. */
  const [portError, setPortError] = useState<string | null>(null)

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
              {busy ? '…' : status.running ? 'Stop server' : 'Start server'}
            </button>
          </Row>
          <Row title="Auto start" description="Automatically start the Local API Server when the application launches.">
            <Switch
              label="Auto start"
              checked={local.autoStart}
              onChange={(on) => void patchSettings({ localServer: { autoStart: on } })}
            />
          </Row>
          <Row
            title="Port"
            description={
              portError ? (
                <span className="field-error" role="alert">
                  {portError}
                </span>
              ) : (
                'The loopback port the server listens on, from 1024 to 65535. Restart the server to apply.'
              )
            }
          >
            <PortField value={local.port} onChange={(port) => void patchSettings({ localServer: { port } })} onError={setPortError} />
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
          <Row
            title="Require key"
            description="Refuse every request that doesn't send the key. Browser pages and extensions always need it; with this on, so do apps on this computer."
          >
            <Switch
              label="Require key"
              checked={local.requireKey}
              onChange={(on) => void patchSettings({ localServer: { requireKey: on } })}
            />
          </Row>
          <Row
            title="Key"
            description={
              local.requireKey
                ? 'Apps connected to Eaon send this. It lets them use your models, not control Eaon.'
                : 'Apps connected to Eaon send this. Apps on this computer that send no key still work; a wrong key is refused.'
            }
          >
            <code className="key-chip">{gateway ? `${gateway.token.slice(0, 10)}…` : '…'}</code>
            <button
              className="btn"
              disabled={!gateway}
              onClick={() => {
                if (!gateway) return
                // "Copied" only once it really is: the clipboard refuses while another app has focus.
                void copyText(gateway.token).then((ok) => {
                  setCopied(ok)
                  if (ok) setTimeout(() => setCopied(false), 1500)
                  else notify(CLIPBOARD_FAILED, 'error')
                })
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
            title="Server status"
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

/**
 * Saved on Enter or leaving the field: a whole number from 1024 to 65535.
 * Saving each keystroke put 1337 back the moment the field was cleared to
 * type a new port, and saved "8" and "80" on the way to 8080. Anything else
 * puts the saved port back and says why (lib/port.ts): it used to snap back
 * with nothing said, and 4242.6 was quietly saved as 4243.
 */
function PortField({ value, onChange, onError }: { value: number; onChange: (port: number) => void; onError: (message: string | null) => void }): JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const problem = portProblem(draft)
    if (problem) {
      onError(`${problem} Kept ${value}.`)
      setDraft(String(value))
      return
    }
    onError(null)
    const port = Number(draft.trim())
    if (port !== value) onChange(port)
    setDraft(String(port))
  }
  return (
    <input
      className="input"
      style={{ width: 110 }}
      type="number"
      min={1024}
      max={65535}
      aria-label="Port"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  )
}
