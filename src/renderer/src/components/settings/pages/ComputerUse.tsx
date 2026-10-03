import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Camera, Check, ExternalLink, OctagonX, RotateCw } from 'lucide-react'
import type { ComputerTestResult, ComputerUseStatus, PermissionKind, PermissionState } from '@shared/computerUse'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Segmented, Switch } from '../../ui'

/**
 * Settings → Computer use. Everything here is real: the switches are
 * `settings.computerUse` (read live by the `computer` tool), the setup steps
 * and status rows come from the main process, and Test takes a screenshot
 * through the same code path the agent uses.
 *
 * On a Mac missing either permission, the page opens with a setup checklist:
 * one row per permission, each with the one button that does the work (asks
 * macOS, which puts Eaon in the list, then opens that exact pane). Once both
 * are allowed it folds into a single "Ready" line under Status.
 */

const allowed = (state: PermissionState): boolean => state === 'granted' || state === 'not-needed'

function SetupStep({
  n,
  title,
  description,
  state,
  attention,
  children
}: {
  n: number
  title: string
  description: ReactNode
  state: PermissionState
  /** Plays a one-off highlight: the step to do next, right after computer use was switched on. */
  attention: boolean
  children: ReactNode
}): JSX.Element {
  const done = allowed(state)
  return (
    <li className="row computer__step" data-done={done} data-attention={attention || undefined}>
      <span className="computer__step-mark" aria-hidden="true">
        {done ? <Check size={12} strokeWidth={2.4} /> : n}
      </span>
      <div className="row__body">
        <div className="row__title">{title}</div>
        <div className="row__desc">{description}</div>
      </div>
      <div className="row__trail">
        {done ? (
          <span className="badge badge--ok">Allowed</span>
        ) : state === 'restricted' ? (
          <span className="badge badge--warn">Blocked by policy</span>
        ) : (
          children
        )}
      </div>
    </li>
  )
}

/** The last status seen, so coming back to the page doesn't redraw the setup a beat late. */
let lastStatus: ComputerUseStatus | null = null

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function ComputerUsePage(): JSX.Element {
  const settings = useApp((s) => s.settings)
  const patchSettings = useApp((s) => s.patchSettings)
  const [status, setStatus] = useState<ComputerUseStatus | null>(lastStatus)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ComputerTestResult | null>(null)
  const [opening, setOpening] = useState<PermissionKind | null>(null)
  const [relaunching, setRelaunching] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  /** Bumped when computer use is switched on with setup unfinished; replays the next step's highlight. */
  const [attention, setAttention] = useState(0)
  const setupRef = useRef<HTMLElement>(null)

  const refresh = useCallback(() => {
    void window.api.computerUse.status().then((next) => {
      lastStatus = next
      setStatus(next)
    })
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

  // macOS lists the app that started Eaon, not Eaon, when it runs from a terminal.
  const owner = status?.owner
  const who = !owner || owner.self ? 'Eaon' : (owner.name ?? 'that app')
  const axDone = !!status && allowed(status.accessibility)
  const screenDone = !!status && allowed(status.screen)
  const setupNeeded = !!status && mac && !(axDone && screenDone)
  const next: PermissionKind | null = !setupNeeded
    ? null
    : !axDone && status.accessibility !== 'restricted'
      ? 'accessibility'
      : !screenDone && status.screen !== 'restricted'
        ? 'screen'
        : null

  const setEnabled = (on: boolean): void => {
    void patchSettings({ computerUse: { enabled: on } })
    if (!on || !setupNeeded) return
    // Switched on but it can't see or click yet: point at what's left to do.
    setAttention((n) => n + 1)
    const reduced = document.body.dataset.reduceMotion === 'on'
    setupRef.current?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
  }

  const openPermission = async (kind: PermissionKind): Promise<void> => {
    setOpening(kind)
    try {
      await window.api.computerUse.openPermission(kind)
    } finally {
      setOpening(null)
      refresh()
    }
  }

  const relaunch = async (): Promise<void> => {
    setRelaunching(true)
    if (!(await window.api.computerUse.relaunch().catch(() => false))) setRelaunching(false)
  }

  // A switch that is on while Eaon is still refused was made for an older,
  // differently signed Eaon; clearing it lets this copy ask again.
  const resetAccessibility = async (): Promise<void> => {
    setResetting(true)
    setResetError(null)
    try {
      const result = await window.api.computerUse.resetAccessibility()
      if (!result.ok) setResetError(result.error ?? 'macOS would not reset the entry.')
    } finally {
      setResetting(false)
      refresh()
    }
  }

  const runTest = async (): Promise<void> => {
    setTesting(true)
    try {
      setResult(await window.api.computerUse.test())
    } finally {
      setTesting(false)
      refresh()
    }
  }

  const openButton = (kind: PermissionKind, primary: boolean): JSX.Element => (
    <button
      className={`btn${primary ? ' btn--primary' : ''}`}
      disabled={opening !== null || relaunching}
      onClick={() => void openPermission(kind)}
    >
      {opening === kind ? 'Opening…' : 'Open settings'}
      <ExternalLink size={13} strokeWidth={1.9} />
    </button>
  )

  // Screen Recording, once asked for, only applies after a restart, and
  // Eaon can't see the switch until then — so from that point the step
  // offers the restart alongside the pane.
  const screenWaiting = !!status?.screenRequested && !screenDone
  const screenDescription = screenDone
    ? 'Lets Eaon see your screen.'
    : !screenWaiting
      ? `Lets Eaon see your screen. Switch on ${who} in the list that opens.`
      : status.canRelaunch
        ? `Switch on ${who} in the list, then quit and reopen Eaon so macOS applies it.`
        : `Switch on ${who} in the list, then restart Eaon so macOS applies it. If it still can't see the screen, restart ${who} too.`

  const inputDescription = !status
    ? 'Checking…'
    : status.input.available
      ? `${status.input.backend}${status.input.detail ? ` — ${status.input.detail}` : ''}`
      : (status.input.detail ?? 'Unavailable on this computer.')

  return (
    <>
      <h1 className="settings__h1">Computer use</h1>
      <p className="settings__lede">
        Let Eaon see your screen and use the mouse and keyboard from Chat and Workers, for apps it can't reach any other way.
      </p>

      {setupNeeded && (
        <section className="settings__section" ref={setupRef}>
          <div className="settings__section-label">Setup</div>
          <Card>
            {owner && !owner.self && (
              <Row
                title={`Started from ${owner.name ?? 'a terminal'}`}
                description={`macOS gives these permissions to the app that started Eaon, so switch on ${owner.name ?? 'that app (usually your terminal)'} below, not Eaon or Electron.`}
              />
            )}
            <ol className="computer__steps">
              <SetupStep
                key={`accessibility-${next === 'accessibility' ? attention : 0}`}
                n={1}
                title="Allow Accessibility"
                description={
                  axDone ? (
                    'Lets Eaon move the pointer, click and type.'
                  ) : (
                    <>
                      Lets Eaon move the pointer, click and type. Switch on {who} in the list that opens.
                      {owner?.self && (
                        <span className="computer__stale">
                          {' '}
                          Already on? macOS keeps one switch for every copy of Eaon, tied to whichever copy asked first.
                          {status.otherCopies?.length
                            ? ` This Mac has ${status.otherCopies.length === 1 ? 'another copy' : `${status.otherCopies.length} other copies`} signed differently, such as ${status.otherCopies[0].path}${status.otherCopies[0].version ? ` (${status.otherCopies[0].version})` : ''}.`
                            : ''}{' '}
                          Reset the switch, then turn Eaon on again.
                        </span>
                      )}
                      {resetError && <span className="computer__stale computer__stale--error"> {resetError}</span>}
                    </>
                  )
                }
                state={status.accessibility}
                attention={next === 'accessibility' && attention > 0}
              >
                {openButton('accessibility', next === 'accessibility')}
                {!axDone && owner?.self && (
                  <button className="btn" disabled={resetting || opening !== null} onClick={() => void resetAccessibility()}>
                    <RotateCw size={13} strokeWidth={1.9} />
                    {resetting ? 'Resetting…' : 'Reset and ask again'}
                  </button>
                )}
              </SetupStep>
              <SetupStep
                key={`screen-${next === 'screen' ? attention : 0}`}
                n={2}
                title="Allow Screen Recording"
                description={screenDescription}
                state={status.screen}
                attention={next === 'screen' && attention > 0}
              >
                {screenWaiting && status.canRelaunch ? (
                  <>
                    {openButton('screen', false)}
                    <button
                      className={`btn${next === 'screen' ? ' btn--primary' : ''}`}
                      disabled={relaunching}
                      onClick={() => void relaunch()}
                    >
                      <RotateCw size={13} strokeWidth={1.9} />
                      {relaunching ? 'Reopening…' : 'Quit & reopen Eaon'}
                    </button>
                  </>
                ) : (
                  openButton('screen', next === 'screen')
                )}
              </SetupStep>
            </ol>
          </Card>
        </section>
      )}

      <Section label="Access">
        <Card>
          <Row
            title="Enable computer use"
            description={
              cu.enabled && setupNeeded ? 'Offers the agent a computer tool. Finish the setup above first.' : 'Offers the agent a computer tool'
            }
          >
            <Switch label="Enable computer use" checked={cu.enabled} onChange={setEnabled} />
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

      <Section label="Status">
        <Card>
          {mac && !setupNeeded && (
            <Row
              title="Permissions"
              description={`Accessibility and Screen Recording are allowed${owner && !owner.self ? ` for ${who}` : ''}`}
            >
              <span className="badge badge--ok">Ready</span>
            </Row>
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
