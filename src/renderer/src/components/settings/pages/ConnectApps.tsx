import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Check, ChevronDown, ChevronRight, Copy, FolderOpen, RotateCw, SquareTerminal } from 'lucide-react'
import type { ConnectAppId, ConnectAppStatus, ConnectChoice, ConnectWritten } from '@shared/connectApps'
import type { GatewayInfo, GatewayModel } from '@shared/gateway'
import { useApp } from '../../../state/store'
import { CLIPBOARD_FAILED, copyText } from '../../../lib/clipboard'
import { Card, MenuItem, MenuSearch, Modal, Popover, Row, Section, Switch } from '../../ui'
import claudeCodeLogo from '../../../assets/providers/claudecode.svg'
import chatgptLogo from '../../../assets/providers/openai.png'
import codexLogo from '../../../assets/providers/codex.svg'
import opencodeLogo from '../../../assets/providers/opencode.svg'
import copilotLogo from '../../../assets/providers/githubcopilot.svg'
import deepseekLogo from '../../../assets/providers/deepseek.svg'
import qwenLogo from '../../../assets/providers/qwen.svg'
import openclawLogo from '../../../assets/apps/openclaw.svg'
import hermesLogo from '../../../assets/apps/hermes.png'
import droidLogo from '../../../assets/apps/droid.svg'
import piLogo from '../../../assets/apps/pi.svg'
import clineLogo from '../../../assets/apps/cline.png'
import ohMyPiLogo from '../../../assets/apps/ohmypi.svg'
import poolsideLogo from '../../../assets/apps/poolside.png'

/**
 * Settings → Connect apps: use the models set up in Eaon from Claude Code,
 * ChatGPT's Codex, OpenCode and the rest, through Eaon's gateway (the Local
 * API Server). Main does the work (features/connectApps): it writes each
 * app's own settings, merging only Eaon's keys, and takes them back out on
 * disconnect. This page lists the apps and opens a sheet per app.
 */

const RECOMMENDED: ConnectAppId[] = ['claude-code', 'chatgpt']

/** `mark`: a logo drawn on a transparent or white ground, shown on a white tile with some padding. */
const LOGOS: Partial<Record<ConnectAppId, { src: string; mark?: boolean }>> = {
  'claude-code': { src: claudeCodeLogo },
  chatgpt: { src: chatgptLogo, mark: true },
  'codex-cli': { src: codexLogo },
  openclaw: { src: openclawLogo, mark: true },
  opencode: { src: opencodeLogo },
  hermes: { src: hermesLogo },
  'hermes-desktop': { src: hermesLogo },
  droid: { src: droidLogo },
  pi: { src: piLogo },
  cline: { src: clineLogo, mark: true },
  'copilot-cli': { src: copilotLogo },
  'oh-my-pi': { src: ohMyPiLogo },
  'deepseek-harness': { src: deepseekLogo },
  poolside: { src: poolsideLogo },
  'qwen-code': { src: qwenLogo }
}

function AppLogo({ id, size }: { id: ConnectAppId; size: number }): JSX.Element {
  const logo = LOGOS[id]
  if (!logo) {
    return (
      <span className="ca-logo ca-logo--icon" style={{ width: size, height: size }} aria-hidden="true">
        <SquareTerminal size={Math.round(size * 0.55)} strokeWidth={1.8} />
      </span>
    )
  }
  return (
    <span className="ca-logo" data-mark={logo.mark || undefined} style={{ width: size, height: size }} aria-hidden="true">
      <img src={logo.src} alt="" draggable={false} />
    </span>
  )
}

type Tone = 'on' | 'waiting' | 'error' | 'off'

function stateOf(app: ConnectAppStatus): { tone: Tone; label: string } {
  if (app.error) return { tone: 'error', label: 'Can\'t read its settings' }
  if (app.connected && app.stale) return { tone: 'waiting', label: 'Needs reconnecting' }
  if (app.connected) return { tone: 'on', label: app.kind === 'launch' ? 'Ready' : 'Connected' }
  if (!app.installed) return { tone: 'off', label: 'Not installed' }
  return { tone: 'off', label: app.kind === 'manual' ? 'Set up by hand' : 'Not connected' }
}

export function ConnectAppsPage(): JSX.Element {
  const setSettingsPage = useApp((s) => s.setSettingsPage)
  const [apps, setApps] = useState<ConnectAppStatus[] | null>(null)
  const [gateway, setGateway] = useState<GatewayInfo | null>(null)
  const [open, setOpen] = useState<ConnectAppId | null>(null)
  const [background, setBackground] = useState<{ supported: boolean; enabled: boolean } | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const [list, info] = await Promise.all([window.api.connectApps.list(), window.api.gateway.info()])
    setApps(list)
    setGateway(info)
  }, [])

  useEffect(() => {
    void refresh()
    void window.api.app.background().then(setBackground)
    // Another app (or the user) may change these files while the page is open.
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const byId = useMemo(() => new Map((apps ?? []).map((a) => [a.id, a])), [apps])
  const current = open ? (byId.get(open) ?? null) : null

  return (
    <>
      <h1 className="settings__h1">Connect apps</h1>
      <p className="settings__lede">
        Use the models you&apos;ve added to Eaon in your other AI apps. Eaon sets each app up to talk to it, with your keys staying
        here.
      </p>

      <Section label="Recommended">
        <div className="ca-featured">
          {RECOMMENDED.map((id) => {
            const app = byId.get(id)
            return (
              <div key={id} className="ca-feature" data-connected={app?.connected || undefined}>
                <button className="ca-feature__main" onClick={() => setOpen(id)} disabled={!app}>
                  <AppLogo id={id} size={40} />
                  <span className="ca-feature__text">
                    <span className="ca-feature__name">
                      {app?.name ?? (id === 'chatgpt' ? 'ChatGPT' : 'Claude Code')}
                      {app && <StatusDot app={app} />}
                    </span>
                    <span className="ca-feature__blurb">{app?.blurb ?? ''}</span>
                  </span>
                </button>
                <button className="ca-pill" data-on={app?.connected || undefined} disabled={!app} onClick={() => setOpen(id)}>
                  {app?.connected ? 'Manage' : 'Connect'}
                </button>
              </div>
            )
          })}
        </div>
      </Section>

      <Section label="Other apps">
        <div className="ca-grid">
          {(apps ?? [])
            .filter((a) => !RECOMMENDED.includes(a.id))
            .map((app) => (
              <button key={app.id} className="ca-app" onClick={() => setOpen(app.id)}>
                <AppLogo id={app.id} size={30} />
                <span className="ca-app__name">{app.name}</span>
                <StatusDot app={app} />
                <ChevronRight className="ca-app__chevron" size={15} strokeWidth={2} aria-hidden="true" />
              </button>
            ))}
        </div>
      </Section>

      <Section label="Eaon's gateway">
        <Card>
          <GatewayRow gateway={gateway} onChange={setGateway} onSettings={() => setSettingsPage('local-server')} />
          {background?.supported && (
            <Row
              title="Keep Eaon running in the background"
              description="Connected apps reach your models through Eaon, so it has to be open. With this on, it starts at login without a window and keeps running when you close it."
            >
              <Switch
                label="Keep Eaon running in the background"
                checked={background.enabled}
                onChange={(on) => void window.api.app.setBackground(on).then(setBackground)}
              />
            </Row>
          )}
        </Card>
      </Section>

      {current && gateway && (
        <AppSheet
          key={current.id}
          app={current}
          gateway={gateway}
          background={background}
          onClose={() => setOpen(null)}
          onChanged={(status, info) => {
            setApps((list) => (list ?? []).map((a) => (a.id === status.id || (isHermes(a.id) && isHermes(status.id)) ? { ...a, ...pick(status, a) } : a)))
            if (info) setGateway(info)
          }}
          onAddModels={() => setSettingsPage('providers')}
        />
      )}
    </>
  )
}

const isHermes = (id: ConnectAppId): boolean => id === 'hermes' || id === 'hermes-desktop'

/** An install hint that's a command to run (shown as code, with a copy button) rather than a pointer to a website. */
const isCommand = (hint: string): boolean => /^(npm|npx|curl|code|brew|pip|pipx|uv)\s/.test(hint)

/** `env.A, env.B` → `env: A, B`, so a long list of keys under one block reads at a glance. */
function compactKeys(keys: string[]): string {
  const head = keys[0]?.split('.')[0]
  if (keys.length > 1 && keys.every((k) => k.startsWith(`${head}.`))) return `${head}: ${keys.map((k) => k.slice(head.length + 1)).join(', ')}`
  return keys.join(', ')
}

/** The connection fields of `status`, onto `app` (Hermes Agent and Desktop share theirs). */
function pick(status: ConnectAppStatus, app: ConnectAppStatus): Partial<ConnectAppStatus> {
  return status.id === app.id
    ? status
    : { connected: status.connected, stale: status.stale, model: status.model, models: status.models, smallModel: status.smallModel, error: status.error }
}

function StatusDot({ app }: { app: ConnectAppStatus }): JSX.Element | null {
  const { tone, label } = stateOf(app)
  if (tone === 'off') return null
  return <span className="ca-dot" data-tone={tone} title={label} aria-label={label} />
}

function GatewayRow({
  gateway,
  onChange,
  onSettings
}: {
  gateway: GatewayInfo | null
  onChange: (info: GatewayInfo) => void
  onSettings: () => void
}): JSX.Element {
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const start = async (): Promise<void> => {
    setStarting(true)
    setError(null)
    try {
      onChange(await window.api.gateway.start())
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    } finally {
      setStarting(false)
    }
  }
  return (
    <Row
      title={
        <span className="ca-gateway__title">
          <span className="ca-dot" data-tone={gateway?.running ? 'on' : 'off'} aria-hidden="true" />
          {gateway?.running ? `Running on 127.0.0.1:${gateway.port}` : 'Not running'}
        </span>
      }
      description={
        error ??
        (gateway?.running
          ? `${gateway.models.length} ${gateway.models.length === 1 ? 'model' : 'models'} shared. Connecting an app starts it, and it starts with Eaon from then on.`
          : 'It starts when you connect an app, and with Eaon from then on.')
      }
    >
      {!gateway?.running && (
        <button className="btn" disabled={starting || !gateway} onClick={() => void start()}>
          {starting ? 'Starting…' : 'Start'}
        </button>
      )}
      <button className="btn btn--ghost" onClick={onSettings}>
        Settings
      </button>
    </Row>
  )
}

/* ---------------------------------------------------------------- the sheet */

function AppSheet({
  app,
  gateway,
  background,
  onClose,
  onChanged,
  onAddModels
}: {
  app: ConnectAppStatus
  gateway: GatewayInfo
  background: { supported: boolean; enabled: boolean } | null
  onClose: () => void
  onChanged: (status: ConnectAppStatus, info?: GatewayInfo) => void
  onAddModels: () => void
}): JSX.Element {
  const models = gateway.models
  const known = (id: string | null | undefined): string | null => (id && models.some((m) => m.id === id) ? id : null)
  const initial = known(app.model) ?? known(gateway.defaultModel) ?? models[0]?.id ?? null
  const [model, setModel] = useState<string | null>(initial)
  // Every model the app lists, the default among them; one slot for apps that keep no list.
  const [picked, setPicked] = useState<string[]>(() => {
    const saved = app.models.filter((id) => known(id))
    return saved.length ? saved : initial ? [initial] : []
  })
  const [smallModel, setSmallModel] = useState<string | null>(known(app.smallModel) ?? known(gateway.smallModel))
  const [busy, setBusy] = useState<'connect' | 'disconnect' | 'launch' | 'restart' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [written, setWritten] = useState<ConnectWritten[] | null>(null)
  const [copied, setCopied] = useState<'settings' | 'key' | 'install' | null>(null)
  const [opened, setOpened] = useState(false)
  // A desktop app (ChatGPT) reads Eaon's settings when it starts: after a change, offer to restart it.
  const [reload, setReload] = useState<{ running: boolean; done?: 'reopened' | 'opened'; off?: boolean } | null>(null)

  const choice: Partial<ConnectChoice> | undefined = model
    ? { model, ...(app.multiModel ? { models: picked } : {}), ...(app.hasSmallModel ? { smallModel } : {}) }
    : undefined
  const state = stateOf(app)
  const sameModels = picked.length === app.models.length && picked.every((id) => app.models.includes(id))
  // Picked something other than what the app has: Connect writes the new choice.
  const changed =
    app.connected &&
    (model !== app.model || (app.multiModel && !sameModels) || (app.hasSmallModel && (smallModel ?? null) !== (app.smallModel ?? null)))

  /** Ticks or unticks a model; the default moves to the first one left when it's unticked. */
  const togglePicked = (id: string): void => {
    const next = picked.includes(id) ? picked.filter((m) => m !== id) : [...picked, id]
    setPicked(next)
    if (!model || !next.includes(model)) setModel(next[0] ?? null)
  }
  const afterChange = async (off: boolean): Promise<void> => {
    if (app.restartable) setReload({ running: await window.api.connectApps.running(app.id), off })
  }
  const restart = async (): Promise<void> => {
    setBusy('restart')
    setError(null)
    try {
      const result = await window.api.connectApps.restart(app.id)
      if (!result.ok) return setError(result.error)
      setReload((r) => ({ running: true, off: r?.off, done: result.action }))
    } finally {
      setBusy(null)
    }
  }

  const flash = (what: 'settings' | 'key' | 'install'): void => {
    setCopied(what)
    setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500)
  }

  const connect = async (): Promise<void> => {
    setBusy('connect')
    setError(null)
    try {
      const result = await window.api.connectApps.connect(app.id, choice)
      if (!result.ok) return setError(result.error)
      setWritten(result.written)
      onChanged(result.status, await window.api.gateway.info())
      await afterChange(false)
    } finally {
      setBusy(null)
    }
  }
  const disconnect = async (): Promise<void> => {
    setBusy('disconnect')
    setError(null)
    try {
      const result = await window.api.connectApps.disconnect(app.id)
      if (!result.ok) return setError(result.error)
      setWritten(null)
      onChanged(result.status)
      await afterChange(true)
    } finally {
      setBusy(null)
    }
  }
  const launch = async (): Promise<void> => {
    setBusy('launch')
    setError(null)
    try {
      const result = await window.api.connectApps.launch(app.id, choice)
      if (!result.ok) return setError(result.error)
      setOpened(true)
      const [list, info] = await Promise.all([window.api.connectApps.list(), window.api.gateway.info()])
      const status = list.find((a) => a.id === app.id)
      if (status) onChanged(status, info)
    } finally {
      setBusy(null)
    }
  }
  const copySettings = async (): Promise<void> => {
    setError(null)
    const result = await window.api.connectApps.manual(app.id, choice)
    if (!result.ok) return setError(result.error)
    if (await copyText(result.text)) flash('settings')
    else setError(CLIPBOARD_FAILED)
  }

  const actions = (
    <div className="ca-sheet__actions">
      {app.kind !== 'manual' && (
        <button className="btn btn--ghost" disabled={!model} onClick={() => void copySettings()}>
          {copied === 'settings' ? <Check size={14} strokeWidth={2.2} /> : <Copy size={14} strokeWidth={2} />}
          {copied === 'settings' ? 'Copied' : 'Copy settings'}
        </button>
      )}
      <span className="ca-sheet__spacer" />
      {app.kind === 'config' && app.connected && (
        <button className="btn btn--danger" disabled={busy !== null} onClick={() => void disconnect()}>
          {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
        </button>
      )}
      {app.kind === 'launch' && app.connected && (
        <button className="btn btn--ghost" disabled={busy !== null} onClick={() => void disconnect()}>
          Forget
        </button>
      )}
      {app.canOpen && app.installed && (app.kind === 'launch' || app.connected) && (
        <button className={`btn ${app.kind === 'launch' ? 'btn--primary' : ''}`} disabled={busy !== null || !model} onClick={() => void launch()}>
          <SquareTerminal size={14} strokeWidth={2} />
          {busy === 'launch' ? 'Opening…' : 'Open in Terminal'}
        </button>
      )}
      {app.kind === 'config' && (!app.connected || app.stale || changed) && (
        <button className="btn btn--primary" disabled={busy !== null || !model || picked.length === 0 || Boolean(app.error)} onClick={() => void connect()}>
          {busy === 'connect' ? 'Connecting…' : app.connected ? (changed ? 'Save' : 'Reconnect') : 'Connect'}
        </button>
      )}
      {app.kind === 'manual' && (
        <button className="btn btn--primary" disabled={!model} onClick={() => void copySettings()}>
          {copied === 'settings' ? <Check size={14} strokeWidth={2.2} /> : <Copy size={14} strokeWidth={2} />}
          {copied === 'settings' ? 'Copied' : 'Copy settings'}
        </button>
      )}
    </div>
  )

  return (
    <Modal open onClose={onClose} title={app.name} width={480} actions={actions}>
      <div className="ca-sheet">
        <div className="ca-sheet__head">
          <AppLogo id={app.id} size={44} />
          <div className="ca-sheet__headtext">
            <div className="ca-sheet__blurb">{app.blurb}</div>
            <span className="bx-status ca-sheet__status" data-state={state.tone === 'off' ? undefined : state.tone}>
              <span className="bx-status__dot" aria-hidden="true" />
              {state.label}
            </span>
          </div>
        </div>

        {!app.installed && (
          <div className="ca-sheet__notice">
            <span>
              {app.name} doesn&apos;t look installed{app.installHint ? (isCommand(app.installHint) ? ':' : '.') : '.'}
              {app.installHint && (isCommand(app.installHint) ? <code className="ca-code">{app.installHint}</code> : <span className="ca-sheet__fine">{app.installHint}</span>)}
            </span>
            {app.installHint && isCommand(app.installHint) && (
              <button
                className="icon-btn"
                title="Copy"
                aria-label="Copy the install command"
                onClick={() => {
                  void copyText(app.installHint ?? '').then((ok) => (ok ? flash('install') : setError(CLIPBOARD_FAILED)))
                }}
              >
                {copied === 'install' ? <Check size={14} strokeWidth={2.2} /> : <Copy size={14} strokeWidth={2} />}
              </button>
            )}
          </div>
        )}
        {app.error && <p className="ca-sheet__error">{app.error}</p>}

        {models.length === 0 ? (
          <div className="ca-sheet__notice">
            <span>Add a model provider first; its models are what {app.name} will use.</span>
            <button className="btn btn--sm" onClick={onAddModels}>
              Add models
            </button>
          </div>
        ) : (
          <div className="ca-sheet__fields">
            {app.multiModel ? (
              <>
                <div className="ca-field">
                  <span className="ca-field__label">Models</span>
                  <ModelsPicker models={models} value={picked} onToggle={togglePicked} />
                </div>
                {picked.length > 1 && (
                  <div className="ca-field">
                    <span className="ca-field__label">Default</span>
                    <ModelPicker models={models.filter((m) => picked.includes(m.id))} value={model} onChange={setModel} />
                  </div>
                )}
              </>
            ) : (
              <div className="ca-field">
                <span className="ca-field__label">Model</span>
                <ModelPicker models={models} value={model} onChange={setModel} />
              </div>
            )}
            {app.hasSmallModel && (
              <div className="ca-field">
                <span className="ca-field__label">Fast model</span>
                <ModelPicker models={models} value={smallModel} onChange={setSmallModel} sameAs="Same as model" />
              </div>
            )}
          </div>
        )}

        {app.note && <p className="ca-sheet__note">{app.note}</p>}
        {opened && <p className="ca-sheet__note">Opened {app.name} in a new terminal window.</p>}
        {reload && (
          <div className="ca-sheet__notice">
            {reload.done ? (
              <span>
                {reload.done === 'reopened' ? `Restarted ${app.name}.` : `Opened ${app.name}.`}{' '}
                {reload.off ? `It's back on its own models.` : 'Your models are in its model picker, in Codex mode.'}
              </span>
            ) : (
              <>
                <span>
                  {reload.running
                    ? `${app.name} is open, so it needs a restart to ${reload.off ? 'go back to its own models' : 'show your models'}.`
                    : `${app.name} picks this up the next time it opens.`}
                </span>
                <button className="btn btn--sm" disabled={busy !== null} onClick={() => void restart()}>
                  {reload.running && <RotateCw size={13} strokeWidth={2} />}
                  {busy === 'restart' ? (reload.running ? 'Restarting…' : 'Opening…') : reload.running ? `Restart ${app.name}` : `Open ${app.name}`}
                </button>
              </>
            )}
          </div>
        )}

        {app.files.length > 0 && (
          <div className="ca-sheet__files">
            <div className="ca-field__label">{written ? 'Eaon wrote' : app.connected ? 'Eaon\'s settings are in' : 'Connecting writes to'}</div>
            {(written ?? app.files.map((path) => ({ path, keys: [] }))).map((w) => (
              <div key={w.path} className="ca-file">
                <FolderOpen size={13} strokeWidth={2} aria-hidden="true" />
                <span className="ca-file__path">{w.path}</span>
                {w.keys.length > 0 && <span className="ca-file__keys">{compactKeys(w.keys)}</span>}
              </div>
            ))}
            {app.kind === 'config' && (
              <div className="ca-sheet__fine">
                Only Eaon&apos;s own entries change, and the first time a file changes Eaon keeps a copy next to it (.eaon-backup).
                Disconnect puts back what was there.
              </div>
            )}
          </div>
        )}

        <div className="ca-sheet__gateway">
          <span className="ca-dot" data-tone={gateway.running ? 'on' : 'off'} aria-hidden="true" />
          <span className="ca-sheet__gateway-text">
            {gateway.running ? `Gateway running on 127.0.0.1:${gateway.port}` : 'Gateway off; connecting starts it'}
            <span className="ca-sheet__fine">
              {app.name} reaches your models through Eaon, so Eaon has to be open
              {background?.supported && !background.enabled ? ' (or turn on Keep running in the background)' : ''}.
            </span>
          </span>
          <button
            className="btn btn--ghost btn--sm"
            title="Copy the gateway key"
            onClick={() => {
              void copyText(gateway.token).then((ok) => (ok ? flash('key') : setError(CLIPBOARD_FAILED)))
            }}
          >
            {copied === 'key' ? 'Copied' : `Key ${gateway.token.slice(0, 8)}…`}
          </button>
        </div>

        {error && <p className="ca-sheet__error">{error}</p>}
      </div>
    </Modal>
  )
}

/* ---------------------------------------------------------- model picker */

/** Picks any number of models: each click ticks or unticks one, and the menu stays open. */
function ModelsPicker({
  models,
  value,
  onToggle
}: {
  models: GatewayModel[]
  value: string[]
  onToggle: (id: string) => void
}): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const chosen = value.flatMap((id) => models.find((m) => m.id === id) ?? [])
  const q = query.trim().toLowerCase()
  const shown = q ? models.filter((m) => `${m.label} ${m.id} ${m.providerName}`.toLowerCase().includes(q)) : models
  const label =
    chosen.length === 0 ? 'Choose models' : chosen.length === 1 ? chosen[0].label : `${chosen[0].label} and ${chosen.length - 1} more`
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="select ca-picker"
        data-open={open || undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ca-picker__label">{label}</span>
        {chosen.length === 1 && <span className="ca-picker__provider">{chosen[0].providerName}</span>}
        {chosen.length > 1 && <span className="ca-picker__provider">{chosen.length} models</span>}
        <span className="select__chevron">
          <ChevronDown size={14} strokeWidth={2} />
        </span>
      </button>
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => {
          setOpen(false)
          setQuery('')
        }}
        placement="bottom-start"
        width={320}
      >
        {models.length > 8 && <MenuSearch value={query} onChange={setQuery} placeholder="Search models" />}
        {shown.length === 0 ? (
          <div className="menu__empty">No models match “{query.trim()}”</div>
        ) : (
          shown.map((m) => (
            <MenuItem key={m.id} title={m.label} hint={m.providerName} checked={value.includes(m.id)} onClick={() => onToggle(m.id)} />
          ))
        )}
      </Popover>
    </>
  )
}

function ModelPicker({
  models,
  value,
  onChange,
  sameAs
}: {
  models: GatewayModel[]
  value: string | null
  onChange: (id: string | null) => void
  /** Offers "same as the main model" (null) when set. */
  sameAs?: string
}): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const current = models.find((m) => m.id === value) ?? null
  const q = query.trim().toLowerCase()
  const shown = q ? models.filter((m) => `${m.label} ${m.id} ${m.providerName}`.toLowerCase().includes(q)) : models
  const choose = (id: string | null): void => {
    onChange(id)
    setOpen(false)
    setQuery('')
  }
  return (
    <>
      <button ref={anchor} type="button" className="select ca-picker" data-open={open || undefined} onClick={() => setOpen((v) => !v)}>
        <span className="ca-picker__label">{current ? current.label : (sameAs ?? 'Choose a model')}</span>
        {current && <span className="ca-picker__provider">{current.providerName}</span>}
        <span className="select__chevron">
          <ChevronDown size={14} strokeWidth={2} />
        </span>
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-start" width={320}>
        {models.length > 8 && <MenuSearch value={query} onChange={setQuery} placeholder="Search models" />}
        {sameAs && !q && <MenuItem title={sameAs} checked={value === null} onClick={() => choose(null)} />}
        {shown.length === 0 ? (
          <div className="menu__empty">No models match “{query.trim()}”</div>
        ) : (
          shown.map((m) => <MenuItem key={m.id} title={m.label} hint={m.providerName} checked={m.id === value} onClick={() => choose(m.id)} />)
        )}
      </Popover>
    </>
  )
}
