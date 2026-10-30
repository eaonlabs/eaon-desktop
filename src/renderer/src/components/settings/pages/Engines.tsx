import { useCallback, useEffect, useState, type JSX } from 'react'
import { Check, Copy, ExternalLink, Loader2, LogIn, RefreshCw, X } from 'lucide-react'
import { ENGINE_LABEL, type CliEngineId, type EngineModel, type EngineModels, type EngineStatus } from '@shared/engines'
import { EFFORT_LABEL } from '@shared/effort'
import { useApp } from '../../../state/store'
import { Card, Row, Section } from '../../ui'
import codexLogo from '../../../assets/providers/codex.svg'
import copilotLogo from '../../../assets/providers/githubcopilot.svg'
import geminiCliLogo from '../../../assets/providers/geminicli.svg'
import anthropicLogo from '../../../assets/providers/anthropic.png'
import '../../../styles/engines.css'

/**
 * Settings → Agent engines: what runs Eaon's agents besides Eaon's own loop.
 * Codex — the Codex the user installed (on its own, or inside the ChatGPT
 * app) — and GitHub Copilot CLI and Gemini CLI, each with its own sign-in
 * and model list. Main does the work (src/main/engines); this page shows
 * what it found and offers the next step for each state: install, update,
 * sign in, reconnect, refresh.
 */

const CODEX_APP_PAGE = 'https://chatgpt.com/codex?app-landing-page=true'
const NPM_INSTALL = 'npm i -g @openai/codex'

/** "Error invoking remote method 'engines:login': EngineError: Sign-in cancelled." → "Sign-in cancelled." */
function plainError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^\w*Error:\s*/, '')
}

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

const isCommand = (hint: string | null | undefined): hint is string => Boolean(hint && /^(npm|brew|curl|winget|pnpm|yarn) /.test(hint))

type Tone = 'on' | 'waiting' | 'error' | 'off'

function stateOf(status: EngineStatus | null): { tone: Tone; label: string } {
  if (!status) return { tone: 'off', label: 'Checking…' }
  if (!status.installed) return { tone: 'off', label: 'Not installed' }
  if (!status.version) return { tone: 'error', label: 'Won’t start' }
  if (status.outdated) return { tone: 'error', label: 'Update needed' }
  if (status.blockedReason) return { tone: 'error', label: 'Can’t be used here' }
  if (status.auth.state === 'expired') return { tone: 'waiting', label: 'Session expired' }
  // Grey, not the pulsing "working on it" accent: nothing is happening until they sign in.
  if (status.auth.state === 'signed-out') return { tone: 'off', label: 'Not signed in' }
  if (status.error || status.auth.state === 'unknown') return { tone: 'error', label: 'Couldn’t check' }
  return { tone: 'on', label: 'Ready' }
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="btn btn--ghost btn--sm"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.9} />}
      {copied ? 'Copied' : label}
    </button>
  )
}

/** A command the user runs themselves, with a copy button. */
function CommandHint({ command }: { command: string }): JSX.Element {
  return (
    <div className="eng-command">
      <code>{command}</code>
      <CopyButton text={command} />
    </div>
  )
}

function effortRange(model: EngineModel): string | null {
  if (model.efforts.length === 0) return null
  const first = EFFORT_LABEL[model.efforts[0]]
  const last = EFFORT_LABEL[model.efforts[model.efforts.length - 1]]
  return first === last ? first : `${first}–${last}`
}

export function EnginesPage(): JSX.Element {
  const setSettingsPage = useApp((s) => s.setSettingsPage)
  const [statuses, setStatuses] = useState<EngineStatus[] | null>(null)
  const [models, setModels] = useState<EngineModels | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [refreshNote, setRefreshNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const [signInNote, setSignInNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async (): Promise<void> => {
    try {
      const [next, list] = await Promise.all([window.api.engines.status(), window.api.engines.models('codex')])
      setStatuses(next)
      setModels(list)
      setLoadError(null)
    } catch (error) {
      setLoadError(plainError(error))
    }
  }, [])

  /** Asks the engines again; `force` skips caches (the Refresh button). */
  const check = useCallback(async (force: boolean): Promise<EngineModels | null> => {
    setChecking(true)
    try {
      const next = await window.api.engines.refresh('codex', force)
      const list = await window.api.engines.models('codex')
      setStatuses((prev) => [...(prev ?? []).filter((s) => !next.some((n) => n.id === s.id)), ...next])
      setModels(list)
      setLoadError(null)
      return list
    } catch (error) {
      setLoadError(plainError(error))
      return null
    } finally {
      setChecking(false)
      setNow(Date.now())
    }
  }, [])

  useEffect(() => {
    void (async () => {
      await load()
      // Nothing checked yet (the first check runs a few seconds after launch): check now.
      const current = await window.api.engines.status().catch(() => [])
      if (!current.some((s) => s.id === 'codex')) void check(false)
    })()
    const off = window.api.engines.onChanged(() => void load())
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      off()
      clearInterval(tick)
    }
  }, [load, check])

  const codex = statuses?.find((s) => s.id === 'codex') ?? null
  const state = stateOf(codex)

  const refresh = async (): Promise<void> => {
    setRefreshNote(null)
    const list = await check(true)
    if (!list) return
    setRefreshNote(
      list.staleBecause
        ? { ok: false, text: list.staleBecause }
        : { ok: true, text: `Updated just now · ${list.models.length} ${list.models.length === 1 ? 'model' : 'models'}` }
    )
  }

  const signIn = async (): Promise<void> => {
    setSigningIn(true)
    setSignInNote(null)
    try {
      const next = await window.api.engines.login('codex')
      setStatuses(next)
      const after = next.find((s) => s.id === 'codex')
      setSignInNote(
        after?.auth.state === 'signed-in'
          ? { ok: true, text: `Signed in${after.auth.plan ? ` · ${after.auth.plan} plan` : ''}.` }
          : { ok: false, text: 'Codex says the sign-in finished, but it still isn’t signed in. Try again, or run "codex login" in a terminal.' }
      )
      setModels(await window.api.engines.models('codex'))
    } catch (error) {
      setSignInNote({ ok: false, text: plainError(error) })
    } finally {
      setSigningIn(false)
    }
  }

  return (
    <>
      <h1 className="settings__h1">Agent engines</h1>
      <p className="settings__lede">
        An engine runs a whole agent: its own tools, sandbox, sign-in and models. Eaon&rsquo;s own engine runs on the
        providers in Model providers. Codex, GitHub Copilot and Gemini CLI run on the copy you have installed, each
        signed in with your own account, so Chat and workers use your own plan with them. Eaon never sees those
        sign-ins.
      </p>

      {loadError && (
        <div className="eng-notice" data-tone="error" role="alert">
          <span>Eaon couldn&rsquo;t read the engines&rsquo; status: {loadError}</span>
          <button className="btn btn--sm" onClick={() => void check(false)} disabled={checking}>
            Try again
          </button>
        </div>
      )}

      <Section label="Codex">
        <Card>
          <div className="eng-head">
            <span className="ca-logo" style={{ width: 36, height: 36 }} aria-hidden="true">
              <img src={codexLogo} alt="" draggable={false} />
            </span>
            <div className="eng-head__text">
              <div className="eng-head__name">Codex</div>
              <div className="eng-head__blurb">OpenAI&rsquo;s coding agent, run by Eaon through the Codex you installed.</div>
            </div>
            <span className="bx-status" data-state={state.tone === 'off' ? undefined : state.tone}>
              <span className="bx-status__dot" />
              {state.label}
            </span>
          </div>

          <InstallRow status={codex} checking={checking} onCheck={() => void check(true)} />

          {codex?.installed && codex.version && !codex.outdated && (
            <Row
              title="Account"
              description={
                signingIn ? (
                  'Finish signing in in your browser. Eaon opened the ChatGPT sign-in page; this updates when you’re done.'
                ) : (
                  <AccountText status={codex} />
                )
              }
            >
              {signingIn ? (
                <>
                  <Loader2 size={15} strokeWidth={1.9} className="spinner eng-wait" aria-hidden="true" />
                  <button className="btn btn--ghost" onClick={() => void window.api.engines.cancelLogin('codex')}>
                    <X size={14} strokeWidth={1.9} />
                    Cancel
                  </button>
                </>
              ) : codex.auth.state === 'signed-out' || codex.auth.state === 'expired' ? (
                <button className="btn btn--primary" onClick={() => void signIn()} disabled={checking}>
                  <LogIn size={14} strokeWidth={1.9} />
                  {codex.auth.state === 'expired' ? 'Reconnect' : 'Sign in'}
                </button>
              ) : null}
            </Row>
          )}
        </Card>

        {signInNote && (
          <p className="eng-note" data-ok={signInNote.ok || undefined} role="status">
            {signInNote.text}
          </p>
        )}

        {codex?.blockedReason && (
          <div className="eng-notice" data-tone="error">
            <span>{codex.blockedReason}</span>
            <button className="btn btn--sm" onClick={() => setSettingsPage('connect-apps')}>
              Open Connect apps
            </button>
          </div>
        )}

        {codex?.error && codex.version && (
          <div className="eng-notice" data-tone="error">
            <span>{codex.error}</span>
            <button className="btn btn--sm" onClick={() => void refresh()} disabled={checking}>
              Check again
            </button>
          </div>
        )}
      </Section>

      {codex?.installed && codex.version && !codex.outdated && !codex.blockedReason && (
        <Section label="Codex models">
          <Card>
            <Row
              title={models ? `${models.models.length} ${models.models.length === 1 ? 'model' : 'models'}` : 'Models'}
              description={<Freshness models={models} now={now} checking={checking} />}
            >
              <button className="btn" onClick={() => void refresh()} disabled={checking} aria-label="Refresh Codex models">
                <RefreshCw size={14} strokeWidth={1.9} className={checking ? 'spinner' : undefined} />
                {checking ? 'Checking…' : 'Refresh'}
              </button>
            </Row>
            {models?.models.map((model) => (
              <div className="eng-model" key={model.id}>
                <div className="eng-model__name">
                  {model.label}
                  {model.isDefault && <span className="eng-badge">Default</span>}
                  {model.vision === true && <span className="eng-badge">Images</span>}
                </div>
                <div className="eng-model__meta">
                  {model.id !== model.label && <code>{model.id}</code>}
                  {effortRange(model) && <span>Effort {effortRange(model)}</span>}
                  {model.upgrade && <span>Newer: {model.upgrade}</span>}
                </div>
                {model.description && <div className="eng-model__desc">{model.description}</div>}
              </div>
            ))}
          </Card>
          {refreshNote && (
            <p className="eng-note" data-ok={refreshNote.ok || undefined} role="status">
              {refreshNote.text}
            </p>
          )}
          <p className="settings__lede eng-fine">
            {/* Only a list Codex gave is "what your Codex offers": the fallback is Eaon's own. */}
            {models?.staleBecause && !models.retrievedAt
              ? 'Until Codex answers, these are the models Eaon knows Codex for. Yours may differ: with a ChatGPT sign-in, it offers the ones your plan includes; set up with another provider, that provider’s.'
              : models?.staleBecause
                ? 'These are the models your Codex offered when Eaon last asked. With a ChatGPT sign-in, they’re the ones your plan includes; if you set Codex up with another provider, that provider’s.'
                : 'These are the models your Codex offers right now. With a ChatGPT sign-in, they’re the ones your plan includes; if you set Codex up with another provider, that provider’s.'}{' '}
            They&rsquo;re separate from the ChatGPT providers in Model providers, which run Eaon&rsquo;s own agent on ChatGPT&rsquo;s models instead.
          </p>
        </Section>
      )}

      <AcpEngineSection id="claude" status={statuses?.find((s) => s.id === 'claude') ?? null} now={now} />
      <AcpEngineSection id="copilot" status={statuses?.find((s) => s.id === 'copilot') ?? null} now={now} />
      <AcpEngineSection id="gemini" status={statuses?.find((s) => s.id === 'gemini') ?? null} now={now} />

      <Section label="Eaon">
        <Card>
          <Row
            title="Eaon"
            description="Built in. Runs on whichever provider and model you pick; no sign-in of its own."
          >
            <button className="btn btn--ghost" onClick={() => setSettingsPage('providers')}>
              Model providers
            </button>
          </Row>
        </Card>
      </Section>
    </>
  )
}

function InstallRow({ status, checking, onCheck }: { status: EngineStatus | null; checking: boolean; onCheck: () => void }): JSX.Element {
  /** After installing or updating outside Eaon, the user comes back and asks again. */
  const recheck = (label: string): JSX.Element => (
    <button className="btn btn--ghost" onClick={onCheck} disabled={checking}>
      <RefreshCw size={14} strokeWidth={1.9} className={checking ? 'spinner' : undefined} />
      {checking ? 'Checking\u2026' : label}
    </button>
  )
  if (!status) {
    return <Row title="Installation" description={checking ? 'Looking for Codex on this computer…' : 'Checking…'} />
  }
  if (!status.installed) {
    return (
      <div className="row row--stack">
        <div className="row__body">
          <div className="row__title">Not installed</div>
          <div className="row__desc">
            Codex comes with the ChatGPT desktop app. You can also install it on its own with npm; Eaon finds either one.
          </div>
        </div>
        <div className="eng-actions">
          <button className="btn" onClick={() => void window.api.app.openExternal(CODEX_APP_PAGE)}>
            <ExternalLink size={14} strokeWidth={1.9} />
            Get the ChatGPT app
          </button>
          <CommandHint command={NPM_INSTALL} />
          {recheck('I\u2019ve installed it')}
        </div>
      </div>
    )
  }
  const where = status.foundIn ? ` · found in ${status.foundIn}` : ''
  const others = status.others?.length ? (
    <span className="eng-fine-line">
      Also installed: {status.others.map((o) => `${o.foundIn}${o.version ? ` ${o.version}` : ''}`).join(', ')}. Eaon uses the newest.
    </span>
  ) : null
  if (!status.version) {
    return (
      <Row
        title="Installed, but it won’t start"
        description={
          <>
            <span className="eng-danger">{status.error ?? `Found at ${status.path}, but it didn’t start.`}</span> {others}
          </>
        }
      >
        {recheck('Check again')}
      </Row>
    )
  }
  if (status.outdated) {
    return (
      <div className="row row--stack">
        <div className="row__body">
          <div className="row__title">Codex {status.version}{where}</div>
          <div className="row__desc eng-danger">
            Too old for Eaon: it needs Codex {status.minVersion} or newer. Update it, then check again.
          </div>
        </div>
        <div className="eng-actions">
          {status.updateHint && (isCommand(status.updateHint) ? <CommandHint command={status.updateHint} /> : <p className="eng-hint">{status.updateHint}</p>)}
          {recheck('Check again')}
        </div>
      </div>
    )
  }
  if (status.updateAvailable && status.latestVersion) {
    return (
      <div className="row row--stack">
        <div className="row__body">
          <div className="row__title">
            Codex {status.version}
            {where}
          </div>
          <div className="row__desc">
            Update available: {status.latestVersion}. Codex keeps working meanwhile. {others}
          </div>
        </div>
        <div className="eng-actions">
          {status.updateHint && (isCommand(status.updateHint) ? <CommandHint command={status.updateHint} /> : <p className="eng-hint">{status.updateHint}</p>)}
          {recheck('Check again')}
        </div>
      </div>
    )
  }
  return (
    <Row
      title={`Codex ${status.version}${where}`}
      description={
        <>
          <span title={status.path ?? undefined}>{status.latestVersion ? 'Up to date.' : 'Installed.'}</span> {others}
        </>
      }
    />
  )
}

function AccountText({ status }: { status: EngineStatus }): JSX.Element {
  const { state, method, plan } = status.auth
  switch (state) {
    case 'signed-in':
      return <>{method === 'ChatGPT' ? `Signed in with ChatGPT${plan ? ` · ${plan} plan` : ''}` : `Signed in with ${method === 'API key' ? 'an API key' : (method ?? 'an account')}`}</>
    case 'not-required':
      return <>No sign-in needed: Codex is set up with its own model provider.</>
    case 'signed-out':
      return <>Not signed in. Sign in with your ChatGPT account to use Codex here.</>
    case 'expired':
      return <>Your ChatGPT session in Codex has expired. Reconnect to keep using it; nothing needs reinstalling.</>
    default:
      return <>Eaon couldn&rsquo;t tell whether Codex is signed in.</>
  }
}

function Freshness({ models, now, checking }: { models: EngineModels | null; now: number; checking: boolean }): JSX.Element {
  if (!models) return <>{checking ? 'Asking Codex for its models…' : 'Not checked yet.'}</>
  if (models.staleBecause && models.retrievedAt) {
    return (
      <span title={models.staleBecause}>
        Couldn&rsquo;t refresh Codex&rsquo;s models &mdash; showing the list from{' '}
        {now - models.retrievedAt < 60_000 ? 'a moment ago' : ago(models.retrievedAt, now)}.
      </span>
    )
  }
  if (models.staleBecause) {
    return <span title={models.staleBecause}>Couldn&rsquo;t ask Codex for its models &mdash; showing the list built into Eaon, which may be out of date.</span>
  }
  return <>Updated {models.retrievedAt ? ago(models.retrievedAt, now) : 'just now'} &middot; from Codex itself</>
}

type SignInEngine = Extract<CliEngineId, 'claude' | 'copilot' | 'gemini'>

/** What sets each of these engines apart on this page: the rest is the same for all three. */
const ACP_ENGINE: Record<SignInEngine, { logo: string; app: string; blurb: string; plan: string; signingIn: string; how: string; docs: string }> = {
  claude: {
    logo: anthropicLogo,
    // What Eaon finds and runs: its version is Claude Code's.
    app: 'Claude Code',
    blurb: 'Anthropic’s agent, run by Eaon through the Claude Code you installed, with Anthropic’s Agent SDK.',
    plan: 'your Claude plan',
    signingIn: 'Finish signing in in the Terminal window Eaon opened (claude auth login). This updates when you’re done.',
    how: 'Eaon runs your own Claude Code through Anthropic’s Agent SDK, and Claude Code makes every request itself with your sign-in, against your own plan or key. Eaon doesn’t read your account or tokens, or change Claude Code’s instructions.',
    docs: 'https://code.claude.com/docs/en/agent-sdk/overview'
  },
  copilot: {
    logo: copilotLogo,
    app: 'GitHub Copilot',
    blurb: 'GitHub’s coding agent, run by Eaon through the Copilot CLI you installed.',
    plan: 'your GitHub Copilot plan',
    signingIn: 'Finish signing in in the Terminal window Eaon opened (copilot login). This updates when you’re done.',
    how: 'Eaon runs GitHub Copilot the way code editors do, through the mode it offers for them, and GitHub Copilot makes every request itself with your sign-in. Eaon doesn’t read your account or tokens, or change what GitHub Copilot is told.',
    docs: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server'
  },
  gemini: {
    logo: geminiCliLogo,
    app: 'Gemini CLI',
    blurb: 'Google’s coding agent, run by Eaon through the Gemini CLI you installed.',
    plan: 'your Google account',
    signingIn: 'Finish signing in in your browser: Gemini CLI opened Google’s sign-in page. This updates when you’re done.',
    how: 'Eaon runs Gemini CLI the way code editors do, through the mode it offers for them, and Gemini CLI makes every request itself with your sign-in. Eaon doesn’t read your account or tokens, or change what Gemini CLI is told.',
    docs: 'https://github.com/google-gemini/gemini-cli'
  }
}

/**
 * Claude, GitHub Copilot CLI or Gemini CLI: found on this computer or not,
 * signed in or not, and its models. Eaon drives Claude Code through the
 * Agent SDK (main/engines/claude) and the other two through their own ACP
 * mode (main/engines/acp); each signs in and makes every request itself.
 */
function AcpEngineSection({ id, status, now }: { id: SignInEngine; status: EngineStatus | null; now: number }): JSX.Element {
  const meta = ACP_ENGINE[id]
  const name = status?.name ?? ENGINE_LABEL[id]
  const state = stateOf(status)
  const [models, setModels] = useState<EngineModels | null>(null)
  const [checking, setChecking] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    const load = (): void => void window.api.engines.models(id).then((list) => alive && setModels(list), () => {})
    load()
    const off = window.api.engines.onChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [id])

  const check = async (): Promise<void> => {
    setChecking(true)
    setNote(null)
    try {
      await window.api.engines.refresh(id, true)
      setModels(await window.api.engines.models(id))
    } catch (error) {
      setNote({ ok: false, text: plainError(error) })
    } finally {
      setChecking(false)
    }
  }
  const signIn = async (): Promise<void> => {
    setSigningIn(true)
    setNote(null)
    try {
      const next = await window.api.engines.login(id)
      const after = next.find((s) => s.id === id)
      setNote(after?.auth.state === 'signed-in' ? { ok: true, text: 'Signed in.' } : { ok: false, text: `${name} still isn’t signed in. Try again.` })
      setModels(await window.api.engines.models(id))
    } catch (error) {
      setNote({ ok: false, text: plainError(error) })
    } finally {
      setSigningIn(false)
    }
  }

  // The CLI's own default is a row in the pickers, not a model to count; nor is one the plan doesn't include.
  const listed = models?.models.filter((m) => m.id && !m.unavailable) ?? []
  const refused = models?.models.filter((m) => m.unavailable) ?? []
  return (
    <Section label={name}>
      <Card>
        <div className="eng-head">
          <span className="ca-logo" style={{ width: 36, height: 36 }} aria-hidden="true">
            <img src={meta.logo} alt="" draggable={false} />
          </span>
          <div className="eng-head__text">
            <div className="eng-head__name">{name}</div>
            <div className="eng-head__blurb">{meta.blurb}</div>
          </div>
          <span className="bx-status" data-state={state.tone === 'off' ? undefined : state.tone}>
            <span className="bx-status__dot" />
            {state.label}
          </span>
        </div>

        {!status ? (
          <Row title="Installation" description="Checking…" />
        ) : !status.installed ? (
          <div className="row row--stack">
            <div className="row__body">
              <div className="row__title">Not installed</div>
              <div className="row__desc">Install it, sign in once in its own way, and Eaon finds it.</div>
            </div>
            <div className="eng-actions">
              {status.updateHint && <CommandHint command={status.updateHint} />}
              <button className="btn btn--ghost" onClick={() => void check()} disabled={checking}>
                <RefreshCw size={14} strokeWidth={1.9} className={checking ? 'spinner' : undefined} />
                {checking ? 'Checking…' : 'I’ve installed it'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <Row
              title={status.version ? `${meta.app} ${status.version}` : `${meta.app} won’t start`}
              description={status.version ? <span title={status.path ?? undefined}>Found on this computer.</span> : <span className="eng-danger">{status.error ?? `Found at ${status.path}, but it didn’t start.`}</span>}
            />
            {status.version && (
              <Row
                title="Account"
                description={
                  signingIn
                    ? meta.signingIn
                    : status.auth.state === 'signed-in'
                      ? `Signed in${status.auth.plan ? ` (${status.auth.plan})` : ''}. Turns use ${meta.plan}.`
                      : status.auth.state === 'signed-out'
                        ? `Not signed in. Sign in to use ${name} with ${meta.plan}.`
                        : (status.error ?? `Eaon couldn’t tell whether ${name} is signed in.`)
                }
              >
                {signingIn ? (
                  <>
                    <Loader2 size={15} strokeWidth={1.9} className="spinner eng-wait" aria-hidden="true" />
                    <button className="btn btn--ghost" onClick={() => void window.api.engines.cancelLogin(id)}>
                      <X size={14} strokeWidth={1.9} />
                      Cancel
                    </button>
                  </>
                ) : status.auth.state === 'signed-out' || status.auth.state === 'expired' ? (
                  <button className="btn btn--primary" onClick={() => void signIn()} disabled={checking}>
                    <LogIn size={14} strokeWidth={1.9} />
                    Sign in
                  </button>
                ) : (
                  <button className="btn btn--ghost" onClick={() => void check()} disabled={checking} aria-label={`Check ${name} again`}>
                    <RefreshCw size={14} strokeWidth={1.9} className={checking ? 'spinner' : undefined} />
                    {checking ? 'Checking…' : 'Check again'}
                  </button>
                )}
              </Row>
            )}
            {status.version && status.auth.state === 'signed-in' && (
              <Row
                title={listed.length ? `${listed.length} ${listed.length === 1 ? 'model' : 'models'}` : 'Models'}
                description={
                  models?.note
                    ? models.note
                    : listed.length
                      ? `${listed.map((m) => m.label).join(', ')}.${refused.length ? ` Not on your plan: ${refused.map((m) => m.label).join(', ')}.` : ''} Updated ${models?.retrievedAt ? ago(models.retrievedAt, now) : 'just now'}, from ${meta.app} itself.`
                      : `${name} picks its model itself; choose it in its own settings.`
                }
              />
            )}
          </>
        )}
      </Card>
      {note && (
        <p className="eng-note" data-ok={note.ok || undefined} role="status">
          {note.text}
        </p>
      )}
      {status?.installed && (
        <p className="settings__lede eng-fine">
          {meta.how}{' '}
          <button className="link-btn" onClick={() => void window.api.app.openExternal(meta.docs)}>
            About it
          </button>
        </p>
      )}
    </Section>
  )
}
