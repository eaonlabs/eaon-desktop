import { useCallback, useEffect, useState } from 'react'
import { Camera, ExternalLink, OctagonX } from 'lucide-react'
import type { ComputerTestResult, ComputerUseStatus, PermissionKind, PermissionState } from '@shared/computerUse'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Segmented, Switch } from '../../ui'

/**
 * Settings → Computer use. Everything here is real: the switches are
 * `settings.computerUse` (read live by the `computer` tool), the permission
 * rows come from the main process, and Test takes a screenshot through the
 * same code path the agent uses.
 */

const PERMISSION_LABEL: Record<PermissionState, string> = {
  granted: 'Allowed',
  denied: 'Not allowed',
  'not-determined': 'Not asked yet',
  restricted: 'Blocked by policy',
  unknown: 'Unknown',
  'not-needed': 'Not needed'
}

function PermissionBadge({ state }: { state: PermissionState }): JSX.Element {
  const ok = state === 'granted' || state === 'not-needed'
  return <span className={`badge ${ok ? 'badge--ok' : 'badge--warn'}`}>{PERMISSION_LABEL[state]}</span>
}

function PermissionRow({
  kind,
  title,
  description,
  state
}: {
  kind: PermissionKind
  title: string
  description: string
  state: PermissionState
}): JSX.Element {
  return (
    <Row title={title} description={description}>
      <div className="computer__trail">
        <PermissionBadge state={state} />
        {state !== 'granted' && (
          <button className="btn" onClick={() => void window.api.computerUse.openPermission(kind)}>
            Open
            <ExternalLink size={13} strokeWidth={1.9} />
          </button>
        )}
      </div>
    </Row>
  )
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function ComputerUsePage(): JSX.Element {
  const settings = useApp((s) => s.settings)
  const patchSettings = useApp((s) => s.patchSettings)
  const [status, setStatus] = useState<ComputerUseStatus | null>(null)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ComputerTestResult | null>(null)

  const refresh = useCallback(() => {
    void window.api.computerUse.status().then(setStatus)
  }, [])

  // Permissions change in System Settings, outside Eaon; poll while the page
  // is open and re-check the moment the user comes back to the window.
  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 3000)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])

  if (!settings) return <></>
  const cu = settings.computerUse
  const mac = status?.platform === 'darwin'

  const runTest = async (): Promise<void> => {
    setTesting(true)
    try {
      setResult(await window.api.computerUse.test())
    } finally {
      setTesting(false)
      refresh()
    }
  }

  const inputDescription = !status
    ? 'Checking…'
    : status.input.available
      ? `${status.input.backend}${status.input.detail ? ` — ${status.input.detail}` : ''}`
      : (status.input.detail ?? 'Unavailable on this computer.')

  return (
    <>
      <h1 className="settings__h1">Computer use</h1>
      <p className="settings__lede">
        Let Eaon see your screen and use the mouse and keyboard in Work mode, for apps it can't reach any other way.
      </p>

      <Section label="Access">
        <Card>
          <Row title="Enable computer use" description="Offers the agent a computer tool in Work mode">
            <Switch
              label="Enable computer use"
              checked={cu.enabled}
              onChange={(on) => void patchSettings({ computerUse: { enabled: on } })}
            />
          </Row>
          <Row
            title="Confirm each action"
            description="Ask before every click, keystroke and app launch, even when approvals are set to Approve for me"
          >
            <Switch
              label="Confirm each action"
              checked={cu.confirmEachAction}
              dimmed={!cu.enabled}
              onChange={(on) => void patchSettings({ computerUse: { confirmEachAction: on } })}
            />
          </Row>
          <Row title="Screenshot quality" description="Sharp keeps small text legible on big displays, at about 1.6× the tokens per step">
            <Segmented
              value={cu.quality}
              onChange={(quality) => void patchSettings({ computerUse: { quality } })}
              options={[
                { value: 'balanced', label: 'Balanced' },
                { value: 'sharp', label: 'Sharp' }
              ]}
            />
          </Row>
        </Card>
      </Section>

      <Section label="Permissions">
        <Card>
          {mac && status && (
            <>
              <PermissionRow
                kind="screen"
                title="Screen Recording"
                description="Lets Eaon take screenshots. After turning it on, quit and reopen Eaon."
                state={status.screen}
              />
              <PermissionRow
                kind="accessibility"
                title="Accessibility"
                description="Lets Eaon move the pointer, click and type"
                state={status.accessibility}
              />
            </>
          )}
          <Row title="Input" description={inputDescription}>
            {status && (
              <span className={`badge ${status.input.available ? 'badge--ok' : 'badge--warn'}`}>
                {status.input.available ? 'Available' : 'Unavailable'}
              </span>
            )}
          </Row>
          {status?.locked && (
            <Row title="Screen is locked" description="Eaon won't click or type until you unlock the computer" />
          )}
        </Card>
      </Section>

      <Section label="Safety">
        <Card>
          <Row
            title="Emergency stop"
            description="Stops the agent at once. A bar at the top of the screen shows whenever Eaon is using your computer."
          >
            <div className="computer__trail">
              <kbd className="computer__kbd">{status?.stopShortcut ?? '⌃⌥⌘.'}</kbd>
              {status?.driving && (
                <button className="btn btn--danger" onClick={() => void window.api.computerUse.stop().then(refresh)}>
                  <OctagonX size={13} strokeWidth={1.9} />
                  Stop now
                </button>
              )}
            </div>
          </Row>
        </Card>
      </Section>

      <Section label="Test">
        <Card>
          <Row
            title="Test screenshot"
            description="Takes a screenshot of your main display exactly as the agent would get it, with Eaon's own windows hidden"
          >
            <button className="btn" disabled={testing} onClick={() => void runTest()}>
              <Camera size={13} strokeWidth={1.9} />
              {testing ? 'Taking…' : 'Test'}
            </button>
          </Row>
          {result && (
            <div className="computer__test" role="status">
              {result.ok && result.dataUrl ? (
                <>
                  <img className="computer__shot" src={result.dataUrl} alt="Test screenshot of your main display" />
                  <div className="computer__meta">
                    {result.width}×{result.height} px · {formatBytes(result.bytes ?? 0)} · {result.ms} ms
                  </div>
                  {result.error && <div className="computer__error">{result.error}</div>}
                </>
              ) : (
                <div className="computer__error">{result.error ?? 'The screenshot failed.'}</div>
              )}
            </div>
          )}
        </Card>
      </Section>
    </>
  )
}
