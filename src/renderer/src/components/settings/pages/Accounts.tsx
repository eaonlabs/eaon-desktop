import { useEffect, useState, type JSX } from 'react'
import { Check, ExternalLink, Loader2, Plus, RefreshCw } from 'lucide-react'
import {
  CLI_TOOLS,
  CLI_TOOL_NAME,
  DEFAULT_ACCOUNT_ID,
  accountName,
  usageKey,
  type AccountUsage,
  type CliAccount,
  type CliAccountsState,
  type CliTool
} from '@shared/cliAccounts'
import { useApp } from '../../../state/store'
import { agoText, useCliAccounts } from '../../../state/cliAccounts'
import { Card, Row, Section, Segmented, Switch } from '../../ui'

/**
 * Settings → Accounts: which Claude Code and Codex account Eaon's terminals
 * run as, signing in to more, and the ADE's usage meter. Each account is a
 * folder the CLI keeps its own login in; signing in is the CLI's own sign-in.
 */

const INSTALL: Record<CliTool, string> = { claude: 'npm install -g @anthropic-ai/claude-code', codex: 'npm install -g @openai/codex' }

export function AccountsPage(): JSX.Element {
  const { state, ensure, refresh } = useCliAccounts()
  const settings = useApp((s) => s.settings)
  const patchSettings = useApp((s) => s.patchSettings)

  useEffect(() => {
    ensure()
    void refresh({ all: true })
  }, [ensure, refresh])

  const meter = settings?.cliUsage ?? { meter: true, view: 'detailed' as const }

  return (
    <>
      <h1 className="settings__h1">Accounts</h1>
      <p className="settings__lede">
        The Claude Code and Codex accounts Eaon’s terminals use, and how much of each plan is left. Each CLI signs in and reads its own
        usage; Eaon never sees your login.
      </p>

      {state ? CLI_TOOLS.map((tool) => <ToolAccounts key={tool} tool={tool} state={state} />) : <p className="settings__lede">Loading…</p>}

      <Section label="Usage meter">
        <Card>
          <Row title="Show in the ADE’s header" description="Your session and week at a glance, with every limit and when it resets one click away.">
            <Switch label="Show the usage meter" checked={meter.meter} onChange={(on) => void patchSettings({ cliUsage: { ...meter, meter: on } })} />
          </Row>
          <Row title="Panel layout" description="Detailed shows one CLI with each limit spelled out; compact lists both, a line per limit.">
            <Segmented
              value={meter.view}
              options={[
                { value: 'detailed', label: 'Detailed' },
                { value: 'compact', label: 'Compact' }
              ]}
              onChange={(view) => void patchSettings({ cliUsage: { ...meter, view } })}
            />
          </Row>
        </Card>
        <p className="accounts__fine">
          Figures come from Claude Code and Codex themselves — the same numbers their <code>/usage</code> shows — read every few minutes while the
          meter is on screen. Nothing is sent to a model to read them.
        </p>
      </Section>
    </>
  )
}

function ToolAccounts({ tool, state }: { tool: CliTool; state: CliAccountsState }): JSX.Element {
  const refresh = useCliAccounts((s) => s.refresh)
  const entry = state.tools[tool]
  const login = state.login
  const signingIn = login.state !== 'idle' && login.tool === tool
  const busy = entry.accounts.some((a) => state.loading.includes(usageKey(tool, a.id)))
  const [error, setError] = useState<string | null>(null)

  const act = async (run: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await run()
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    }
  }

  return (
    <Section
      label={
        <span className="accounts__label">
          {CLI_TOOL_NAME[tool]}
          {entry.installed && (
            <button className="accounts__refresh" aria-label={`Read ${CLI_TOOL_NAME[tool]} usage again`} title="Read usage again" data-spinning={busy || undefined} onClick={() => void refresh({ tool, all: true, force: true })}>
              <RefreshCw size={12} strokeWidth={2} />
            </button>
          )}
        </span>
      }
    >
      <Card>
        {!entry.installed ? (
          <Row title={`${CLI_TOOL_NAME[tool]} isn’t installed`} description={<code>{INSTALL[tool]}</code>} />
        ) : (
          <>
            {entry.accounts.map((account) => (
              <AccountRow
                key={account.id}
                tool={tool}
                account={account}
                active={account.id === entry.active}
                usage={state.usage[usageKey(tool, account.id)]}
                loading={state.loading.includes(usageKey(tool, account.id))}
                pending={signingIn && login.state === 'running' && login.accountId === account.id}
                act={act}
              />
            ))}
            {signingIn ? (
              <LoginCard state={state} />
            ) : (
              <div className="accounts__add">
                <button className="btn btn--ghost" disabled={login.state === 'running'} onClick={() => void act(() => window.api.cliAccounts.add(tool))}>
                  <Plus size={14} strokeWidth={2} /> Add a {CLI_TOOL_NAME[tool]} account
                </button>
              </div>
            )}
          </>
        )}
      </Card>
      {error && <p className="accounts__error">{error}</p>}
      {entry.installed && entry.accounts.length > 1 && (
        <p className="accounts__fine">Switching applies to panes opened from now on; panes already running keep the account they started with until they restart.</p>
      )}
    </Section>
  )
}

function AccountRow({
  tool,
  account,
  active,
  usage,
  loading,
  pending,
  act
}: {
  tool: CliTool
  account: CliAccount
  active: boolean
  usage: AccountUsage | undefined
  loading: boolean
  pending: boolean
  act: (run: () => Promise<unknown>) => Promise<void>
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(account.label)
  const isDefault = account.id === DEFAULT_ACCOUNT_ID
  const now = Date.now()

  return (
    <div className="account-row" data-active={active || undefined}>
      <button
        className="account-row__pick"
        role="radio"
        aria-checked={active}
        aria-label={`Use ${accountName(account)}`}
        disabled={pending || active}
        onClick={() => void act(() => window.api.cliAccounts.use(tool, account.id))}
      >
        {active && <Check size={12} strokeWidth={3} />}
      </button>
      <div className="account-row__body">
        {editing ? (
          <input
            className="input account-row__name-input"
            autoFocus
            value={label}
            placeholder={account.email ?? 'Name'}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => {
              setEditing(false)
              if (label !== account.label) void act(() => window.api.cliAccounts.rename(tool, account.id, label))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') {
                setLabel(account.label)
                setEditing(false)
              }
            }}
          />
        ) : (
          <div className="account-row__name">
            {pending ? 'Signing in…' : accountName(account)}
            {account.plan && <span className="account-row__plan">{account.plan}</span>}
            {isDefault && <span className="account-row__tag">default</span>}
          </div>
        )}
        <div className="account-row__usage">
          {loading && !usage ? (
            <>
              <Loader2 size={11} className="spin" /> reading…
            </>
          ) : (
            usageLine(tool, isDefault, usage, now)
          )}
        </div>
      </div>
      {!pending && (
        <div className="account-row__actions">
          <button className="btn btn--ghost btn--sm" onClick={() => setEditing(true)}>
            Rename
          </button>
          {!isDefault && usage && !usage.ok && usage.reason === 'signed-out' && (
            <button className="btn btn--ghost btn--sm" onClick={() => void act(() => window.api.cliAccounts.signIn(tool, account.id))}>
              Sign in
            </button>
          )}
          {!isDefault && (
            <button className="btn btn--ghost btn--sm" onClick={() => void act(() => window.api.cliAccounts.remove(tool, account.id))}>
              {usage && !usage.ok && usage.reason === 'signed-out' ? 'Remove' : 'Sign out'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function usageLine(tool: CliTool, isDefault: boolean, usage: AccountUsage | undefined, now: number): string {
  if (!usage) return 'Not read yet'
  if (!usage.ok) {
    if (usage.reason !== 'signed-out') return usage.message
    return isDefault ? `Not signed in — run ${tool === 'claude' ? 'claude' : 'codex login'} in a pane` : 'Not signed in'
  }
  const parts = usage.windows.map((w) => `${w.label.toLowerCase()} ${w.percent}%`)
  return `${parts.join(' · ') || 'no limits reported'} · ${agoText(usage.at, now)}`
}

function LoginCard({ state }: { state: CliAccountsState }): JSX.Element | null {
  const login = state.login
  const [code, setCode] = useState('')
  if (login.state === 'idle') return null
  const name = CLI_TOOL_NAME[login.tool]
  return (
    <div className="account-login" data-state={login.state}>
      <div className="account-login__head">
        {login.state === 'running' && <Loader2 size={14} className="spin" />}
        <span>
          {login.state === 'running'
            ? `Signing in with ${name}: finish in your browser`
            : login.state === 'done'
              ? (login.message ?? 'Signed in')
              : `Not added: ${login.message ?? 'the sign-in stopped'}`}
        </span>
      </div>
      {login.state === 'running' && (
        <>
          <div className="account-login__actions">
            <button className="btn btn--primary btn--sm" disabled={!login.url} onClick={() => void window.api.cliAccounts.openLoginUrl()}>
              <ExternalLink size={13} strokeWidth={2} /> {login.url ? 'Open the sign-in page' : 'Waiting for the sign-in page…'}
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => void window.api.cliAccounts.cancelLogin()}>
              Cancel
            </button>
          </div>
          <form
            className="account-login__code"
            onSubmit={(e) => {
              e.preventDefault()
              if (!code.trim()) return
              void window.api.cliAccounts.loginInput(code.trim())
              setCode('')
            }}
          >
            <input className="input" value={code} placeholder="If the page gives you a code, paste it here" onChange={(e) => setCode(e.target.value)} />
            <button className="btn btn--ghost btn--sm" type="submit" disabled={!code.trim()}>
              Send
            </button>
          </form>
          {login.output && <pre className="account-login__output">{login.output}</pre>}
        </>
      )}
      {login.state !== 'running' && (
        <div className="account-login__actions">
          <button className="btn btn--ghost btn--sm" onClick={() => void window.api.cliAccounts.dismissLogin()}>
            {login.state === 'done' ? 'Done' : 'OK'}
          </button>
        </div>
      )}
    </div>
  )
}
