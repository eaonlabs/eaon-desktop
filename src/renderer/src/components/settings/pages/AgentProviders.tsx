import { useEffect, useRef, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronDown, ChevronRight, Download, ExternalLink, GripVertical, RefreshCw, RotateCcw } from 'lucide-react'
import { AGENT_USAGE_ID, type AgentTool, type AgentToolsState } from '@shared/agentProviders'
import {
  AGENT_PERMISSIONS,
  effectivePermission,
  PERMISSION_TEXT,
  permissionArgs,
  permissionChoice,
  permissionDescription,
  permissionsFor,
  type AgentPermission,
  type AgentPermissionChoice
} from '@shared/agentPermissions'
import type { Settings } from '@shared/types'
import { useApp } from '../../../state/store'
import { arrangeAgents } from '../../../lib/agentPrefs'
import { ensureLimits, signedIn, useLimitsSources } from '../../../state/limits'
import { AgentMark } from '../../code/terminal/TerminalWorkspace'
import { Card, MenuItem, MenuSeparator, Popover, Row, Section, Switch, useDisclosure } from '../../ui'
import '../../../styles/agentProviders.css'

/**
 * Settings → Agent providers: the coding CLIs the ADE runs. Which are on
 * this computer and signed in, which the ADE's pickers offer and in what
 * order, what each may do without asking, how hard they may work the
 * computer, and keeping them up to date.
 */

type Prefs = Settings['agentProviders']
const DEFAULTS: Prefs = { hidden: [], order: [], lowPriority: false, updateChecks: true, permissions: 'own', agentPermissions: { claude: 'full' } }

/**
 * The patch Restore defaults sends. Settings merge into what is saved, key by
 * key, so DEFAULTS alone would leave every agent's own choice but Claude
 * Code's in place: each one saved goes back to "Same as all agents".
 */
function restoredDefaults(prefs: Prefs): Prefs {
  const cleared = Object.fromEntries(Object.keys(prefs.agentPermissions ?? {}).map((id) => [id, 'all' as const]))
  return { ...DEFAULTS, agentPermissions: { ...cleared, ...DEFAULTS.agentPermissions } }
}

function useAgentTools(): [AgentToolsState | null, (force?: boolean) => void] {
  const [state, setState] = useState<AgentToolsState | null>(null)
  useEffect(() => {
    let live = true
    void window.api.agentProviders.state().then((s) => live && setState(s))
    const off = window.api.agentProviders.onChanged((s) => live && setState(s))
    return () => {
      live = false
      off()
    }
  }, [])
  return [state, (force = true) => void (force ? window.api.agentProviders.refresh() : window.api.agentProviders.state()).then(setState)]
}

/** Connected (signed in), installed, or not on this computer, in a few words. */
function statusOf(tool: AgentTool, connected: Set<string>): { label: string; tone: 'on' | 'idle' | 'off'; note: string | null } {
  if (!tool.installed) return { label: 'Unavailable', tone: 'off', note: tool.bin ? `${tool.label} (\`${tool.bin}\`) is not installed or not on PATH.` : null }
  const usage = AGENT_USAGE_ID[tool.id]
  if (usage && connected.has(usage)) return { label: 'Connected', tone: 'on', note: null }
  if (tool.id === 'eaon-code' || tool.id === 'eaon-cli') return { label: 'Ready', tone: 'on', note: null }
  return { label: usage ? 'Installed · not signed in' : `Installed · authentication managed by ${tool.label}`, tone: 'idle', note: null }
}

export function AgentProvidersPage(): JSX.Element {
  const { settings, patchSettings } = useApp(useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings })))
  const prefs: Prefs = { ...DEFAULTS, ...settings?.agentProviders }
  const set = (patch: Partial<Prefs>): void => void patchSettings({ agentProviders: { ...prefs, ...patch } })
  const [state, refresh] = useAgentTools()
  const { cli, provider } = useLimitsSources()
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => ensureLimits(), [])

  const connected = new Set(
    signedIn(cli, provider, Date.now())
      .filter((v) => v.status === 'ok' || v.status === 'unsupported' || v.status === 'loading')
      .map((v) => v.id as string)
  )
  const tools = state?.tools ?? []
  // Before the first look finishes there's nothing to count: "0 of 0 enabled" read as no CLIs at all.
  const looking = !state || (tools.length === 0 && (state.checking || state.at === 0))
  // Every CLI the ADE offers by default, and any other that's on this computer.
  const listed = tools.filter((t) => t.installed || !t.other)
  const arranged = arrangeAgents(listed, { ...prefs, hidden: [] })
  const installed = tools.filter((t) => t.installed)
  const updates = tools.filter((t) => t.updatable)
  const enabledCount = listed.filter((t) => !prefs.hidden.includes(t.id)).length

  const choose = (id: string, choice: AgentPermissionChoice): void => set({ agentPermissions: { ...prefs.agentPermissions, [id]: choice } })
  const toggle = (id: string, on: boolean): void => set({ hidden: on ? prefs.hidden.filter((h) => h !== id) : [...prefs.hidden, id] })
  const move = (from: string, to: string): void => {
    const ids = arranged.map((t) => t.id)
    const next = ids.filter((id) => id !== from)
    next.splice(next.indexOf(to), 0, from)
    set({ order: next })
  }

  return (
    <>
      <div className="settings__title-row">
        <h1 className="settings__h1">Agent providers</h1>
        <button className="btn btn--ghost btn--sm limits-restore" onClick={() => void patchSettings({ agentProviders: restoredDefaults(prefs) })}>
          <RotateCcw size={13} strokeWidth={2} />
          Restore defaults
        </button>
      </div>
      <p className="settings__lede">Choose the coding agents the ADE offers and manage their installed CLI tools.</p>

      <Section label="Provider activity">
        <Card>
          <div className="agentp-head">
            <div>
              <div className="agentp-head__title">Enabled providers</div>
              <div className="agentp-head__desc">
                Hidden providers are left out of the ADE’s “New terminal” picker; their terminals already open keep running. Enabling doesn’t install a CLI or
                sign it in.
              </div>
              {!looking && (
                <div className="agentp-head__count">
                  {enabledCount} of {listed.length} enabled
                </div>
              )}
            </div>
            <button className="btn btn--sm" disabled={state?.checking} onClick={() => refresh()}>
              <RefreshCw size={13} strokeWidth={2} className={state?.checking ? 'limits-spin' : undefined} />
              Refresh status
            </button>
          </div>
          {looking && <div className="agentp-empty">Looking for coding CLIs…</div>}
          <div className="agentp-list" role="list">
            {arranged.map((tool) => (
              <ProviderRow
                key={tool.id}
                tool={tool}
                status={statusOf(tool, connected)}
                enabled={!prefs.hidden.includes(tool.id)}
                onToggle={(on) => toggle(tool.id, on)}
                permission={<AgentPermissionPicker tool={tool} prefs={prefs} onChoose={(choice) => choose(tool.id, choice)} />}
                onMove={move}
              />
            ))}
          </div>
          <div className="agentp-foot">Drag a row to change the picker’s order.</div>
        </Card>
      </Section>

      <Section label="Permissions">
        <Card>
          <Row
            title="All agents"
            description="What the ADE’s coding agents may do without asking, in terminals opened from now on. An agent set on its own above keeps its choice, and one with no switch for this uses its own settings."
          >
            <PermissionButton
              current={prefs.permissions}
              label={prefs.permissions === 'own' ? 'Each agent’s own settings' : PERMISSION_TEXT[prefs.permissions].title}
              title="What every agent on “Same as all agents” may do without asking"
            >
              {(close) =>
                AGENT_PERMISSIONS.map((p) => (
                  <PermissionOption
                    key={p}
                    permission={p}
                    title={p === 'own' ? 'Each agent’s own settings' : PERMISSION_TEXT[p].title}
                    description={p === 'own' ? 'Starts each one as it is: it follows its own permission settings' : PERMISSION_TEXT[p].description}
                    checked={prefs.permissions === p}
                    onClick={() => {
                      set({ permissions: p })
                      close()
                    }}
                  />
                ))
              }
            </PermissionButton>
          </Row>
        </Card>
      </Section>

      <Section label="Performance">
        <Card>
          <Row
            title="Keep Eaon responsive"
            description="Give agent terminals and the commands they run a lower CPU priority, so the computer stays quick while they work. Applies to terminals opened from now on."
          >
            <Switch label="Keep Eaon responsive" checked={prefs.lowPriority} onChange={(lowPriority) => set({ lowPriority })} />
          </Row>
        </Card>
      </Section>

      <Section label="Updates">
        <Card>
          <Row title="Automatic CLI update checks" description="Check Claude Code, Codex and the other npm-installed CLIs for newer versions in the background.">
            <Switch
              label="Automatic CLI update checks"
              checked={prefs.updateChecks}
              onChange={(updateChecks) => {
                set({ updateChecks })
                if (updateChecks) setTimeout(() => refresh(), 200)
              }}
            />
          </Row>
          <div className="agentp-updates">
            <div className="agentp-head__title">Provider updates</div>
            <div className="agentp-head__desc">Installed tools Eaon can update the way they were installed, with npm.</div>
            {!looking && (
              <div className="agentp-head__count">
                {updates.length === 0 ? (prefs.updateChecks ? 'Everything is up to date' : 'Update checks are off') : `${updates.length} update${updates.length === 1 ? '' : 's'} available`}
              </div>
            )}
            {updates.map((tool) => (
              <UpdateRow key={tool.id} tool={tool} busy={state?.updating === tool.id} />
            ))}
            {state?.error && <div className="agentp-error">{state.error}</div>}
          </div>
        </Card>
      </Section>

      <Section label="Provider tools">
        <Card>
          <div className="agentp-head">
            <div>
              <div className="agentp-head__title">Installed CLIs</div>
              <div className="agentp-head__desc">Versions and where each one is. Open a row for its path and how to reinstall it.</div>
              {!looking && (
                <div className="agentp-head__count">
                  {installed.length} installed{updates.length > 0 ? ` · ${updates.length} update${updates.length === 1 ? '' : 's'} available` : ''}
                </div>
              )}
            </div>
          </div>
          <div className="agentp-tools">
            {installed.map((tool) => (
              <div key={tool.id} className="agentp-tool" data-open={open === tool.id || undefined}>
                <button className="agentp-tool__row" onClick={() => setOpen(open === tool.id ? null : tool.id)} aria-expanded={open === tool.id}>
                  <span className="agentp-tool__name">{tool.label}</span>
                  <span className="agentp-tool__version">
                    {tool.updatable && tool.latest ? `v${tool.version} → v${tool.latest}` : tool.version ? `Current v${tool.version}` : ''}
                  </span>
                  <ChevronRight size={15} strokeWidth={2} className="agentp-tool__chevron" />
                </button>
                {tool.updatable && <UpdateButton tool={tool} busy={state?.updating === tool.id} />}
                {open === tool.id && (
                  <div className="agentp-tool__more">
                    <div>
                      <span>Path</span>
                      <code>{tool.path ?? '—'}</code>
                    </div>
                    {tool.installHint && (
                      <div>
                        <span>Install</span>
                        <code>{tool.installHint}</code>
                      </div>
                    )}
                    {tool.path && (
                      <button className="btn btn--ghost btn--sm" onClick={() => void window.api.app.showItem(tool.path!)}>
                        Show in folder
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
            {state && installed.length === 0 && <div className="agentp-empty">No coding CLIs found on this computer.</div>}
          </div>
        </Card>
      </Section>
    </>
  )
}

function ProviderRow({
  tool,
  status,
  enabled,
  onToggle,
  onMove,
  permission
}: {
  tool: AgentTool
  status: ReturnType<typeof statusOf>
  enabled: boolean
  onToggle: (on: boolean) => void
  onMove: (from: string, to: string) => void
  permission: JSX.Element | null
}): JSX.Element {
  const row = useRef<HTMLDivElement>(null)
  const [over, setOver] = useState(false)
  return (
    <div
      ref={row}
      className="agentp-row"
      role="listitem"
      data-over={over || undefined}
      data-off={!enabled || undefined}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/x-eaon-agent', tool.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('text/x-eaon-agent')) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        const from = e.dataTransfer.getData('text/x-eaon-agent')
        if (from && from !== tool.id) onMove(from, tool.id)
      }}
    >
      <GripVertical size={15} strokeWidth={2} className="agentp-row__grip" aria-hidden="true" />
      <span className="agentp-row__mark">
        <AgentMark agent={tool.id as never} size={20} />
      </span>
      <span className="agentp-row__text">
        <span className="agentp-row__name">{tool.label}</span>
        <span className="agentp-row__status" data-tone={status.tone}>
          {status.label}
        </span>
        {status.note && <span className="agentp-row__note">{status.note}</span>}
      </span>
      {tool.guide && (
        <button className="btn btn--sm agentp-row__guide" onClick={() => window.api.app.openExternal(tool.guide!)}>
          Setup guide
          <ExternalLink size={12} strokeWidth={2} />
        </button>
      )}
      {permission}
      <Switch label={`Offer ${tool.label} in the ADE`} checked={enabled} onChange={onToggle} />
    </div>
  )
}

/**
 * A row's permissions: "Same as all agents" (and what that comes to for this
 * agent), or a choice of its own among those its CLI has a switch for. None
 * for a CLI with no switches, which always follows its own settings.
 */
function AgentPermissionPicker({ tool, prefs, onChoose }: { tool: AgentTool; prefs: Prefs; onChoose: (choice: AgentPermissionChoice) => void }): JSX.Element | null {
  const options = permissionsFor(tool.id)
  if (options.length < 2) return null
  const choice = permissionChoice(tool.id, prefs)
  const effective = effectivePermission(tool.id, prefs)
  const own = `${tool.label}’s own settings`
  const titleOf = (p: AgentPermission): string => (p === 'own' ? own : PERMISSION_TEXT[p].title)
  const flags = permissionArgs(tool.id, effective)
  // What "Same as all agents" comes to for this agent.
  const sameAsAll = effectivePermission(tool.id, { ...prefs, agentPermissions: {} })
  return (
    <PermissionButton
      current={effective}
      label={choice === 'all' ? 'Same as all agents' : titleOf(choice)}
      title={flags ? `${tool.label} starts with ${flags}` : `${tool.label} starts on its own settings`}
    >
      {(close) => (
        <>
          <div className="perm-menu__option" data-tone={sameAsAll === 'full' ? 'warn' : undefined}>
            <MenuItem
              title={`Same as all agents · ${sameAsAll === 'own' ? 'its own settings' : PERMISSION_TEXT[sameAsAll].title}`}
              description="Follows the choice under Permissions below"
              checked={choice === 'all'}
              onClick={() => {
                onChoose('all')
                close()
              }}
            />
          </div>
          <MenuSeparator />
          {options.map((p) => (
            <PermissionOption
              key={p}
              permission={p}
              title={p === 'own' ? `Use ${own}` : titleOf(p)}
              description={permissionDescription(tool.id, p)}
              hint={permissionArgs(tool.id, p) ?? undefined}
              checked={choice === p}
              onClick={() => {
                onChoose(p)
                close()
              }}
            />
          ))}
        </>
      )}
    </PermissionButton>
  )
}

/** The picker's button and menu; full access is set in orange, as in Chat's permission menu. */
function PermissionButton({
  current,
  label,
  title,
  children
}: {
  current: AgentPermission
  label: string
  title: string
  children: (close: () => void) => JSX.Element | JSX.Element[]
}): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  return (
    <>
      <button
        ref={anchor}
        className="btn btn--sm agentp-perm"
        data-tone={current === 'full' ? 'warn' : undefined}
        data-open={menu.open || undefined}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        title={title}
        onClick={menu.toggle}
        // A row can be dragged; a press on its picker isn't the start of one.
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
      >
        <span className="agentp-perm__label">{label}</span>
        <ChevronDown size={13} strokeWidth={2} />
      </button>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={340} className="perm-menu agentp-perm-menu">
        {children(menu.close)}
      </Popover>
    </>
  )
}

function PermissionOption({
  permission,
  title,
  description,
  hint,
  checked,
  onClick
}: {
  permission: AgentPermission
  title: string
  description: string
  hint?: string
  checked: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <div className="perm-menu__option" data-tone={permission === 'full' ? 'warn' : undefined}>
      <MenuItem
        title={title}
        description={
          hint ? (
            <>
              {description}
              <code className="agentp-perm__flags">{hint}</code>
            </>
          ) : (
            description
          )
        }
        checked={checked}
        onClick={onClick}
      />
    </div>
  )
}

function UpdateButton({ tool, busy }: { tool: AgentTool; busy: boolean }): JSX.Element {
  return (
    <button className="btn btn--sm agentp-update" disabled={busy} onClick={() => void window.api.agentProviders.update(tool.id)}>
      <Download size={13} strokeWidth={2} />
      {busy ? 'Updating…' : 'Update'}
    </button>
  )
}

function UpdateRow({ tool, busy }: { tool: AgentTool; busy: boolean }): JSX.Element {
  return (
    <div className="agentp-update-row">
      <div>
        <div className="agentp-row__name">{tool.label}</div>
        <div className="agentp-row__status">
          v{tool.version} → v{tool.latest}
        </div>
      </div>
      <UpdateButton tool={tool} busy={busy} />
    </div>
  )
}
