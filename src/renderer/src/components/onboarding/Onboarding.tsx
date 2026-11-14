import { useEffect, useRef, useState, type CSSProperties, type JSX, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowUpRight, Check, ChevronRight, CircleAlert, CircleUserRound, CornerDownLeft, FolderInput, KeyRound, Laptop, Loader2, Moon, Palette, Sparkles, Sun } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { LINK_TARGETS, type LinkMethod } from '@shared/linkAccounts'
import { isProviderUsable, providerReadiness } from '@shared/modelSelection'
import type { Provider, ThemeMode } from '@shared/types'
import type { ToknAccount } from '@shared/usage'
import { WHATS_NEW_RELEASE } from '@shared/whatsNew'
import { useApp } from '../../state/store'
import { ToknMark, useToknAccount } from '../account/ToknAccount'
import { LinkAccounts } from '../LinkAccounts'
import { ImportList, useImportServers } from '../ImportServers'
import { Switch } from '../ui'
import { useOnboarding } from './onboardingStore'
import { RedeemCode } from '../RedeemCode'
import '../../styles/onboarding.css'

/**
 * The first-run setup: a few short steps over the whole window on a fresh
 * install (main/features/onboarding.ts decides which installs are fresh).
 * Welcome, a model, light or dark, tools from other apps (only when there are
 * some), the Tokn account that tracks usage, then an offer of the tour. Every
 * step can be skipped, and so can the whole setup; nothing in it is needed to
 * use Eaon, and all of it is in Settings afterwards.
 *
 * One quiet column in the middle of the window: a mark or an icon, a title,
 * a line under it, the step's few choices, and full-width buttons. Enter
 * presses the white one. The dots at the foot say how far along it is and go
 * back to any step already seen.
 *
 * The step reached is kept in memory only: quitting halfway starts the setup
 * again next time, from the top, until it is finished or skipped.
 *
 * An install updated from before 2026.7 gets the same steps (it never had
 * them), with a welcome that says what's new and, at the end, the tour of
 * what's new instead of the tour of the app it already knows.
 */

const STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'models', label: 'Models' },
  { id: 'look', label: 'Appearance' },
  { id: 'import', label: 'Import' },
  { id: 'tokn', label: 'Tokn profile' },
  { id: 'ready', label: 'Finish' }
] as const
type Step = (typeof STEPS)[number]['id']

/** The window's motion curve (--ease in tokens.css), for animations started from script. */
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'

const reduceMotion = (): boolean => document.body.dataset.reduceMotion === 'on'

export function Onboarding(): JSX.Element | null {
  const status = useApp((s) => s.settings?.onboarding.setup)
  return status === 'pending' ? <Setup /> : null
}

function Setup(): JSX.Element {
  const patchSettings = useApp((s) => s.patchSettings)
  const startTour = useOnboarding((s) => s.startTour)
  const { providers, refreshProviders } = useApp(useShallow((s) => ({ providers: s.providers, refreshProviders: s.refreshProviders })))
  // Read once: finishing changes `whatsNew`, and the last step shouldn't change its mind on the way out.
  const [updated] = useState(() => useApp.getState().settings?.onboarding.whatsNew === null)
  const [step, setStep] = useState<Step>('welcome')
  // The furthest step seen: the dots go back to any of them.
  const [reached, setReached] = useState(0)
  const [direction, setDirection] = useState<1 | -1>(1)
  const [leaving, setLeaving] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  // The import step is there only if another app has servers to bring over; the scan is quick, so it
  // settles before that step comes up, and until then the step is counted in.
  const [anyToImport, setAnyToImport] = useState<boolean | null>(null)
  useEffect(() => {
    void window.api.importApps
      .scan()
      .then((apps) => setAnyToImport(apps.some((app) => app.servers.some((server) => !server.duplicate))))
      .catch(() => setAnyToImport(false))
  }, [])
  const steps = anyToImport === false ? STEPS.filter((s) => s.id !== 'import') : STEPS

  const index = steps.findIndex((s) => s.id === step)
  const go = (to: Step): void => {
    const target = steps.findIndex((s) => s.id === to)
    setDirection(target >= index ? 1 : -1)
    setReached((r) => Math.max(r, target))
    setStep(to)
  }
  const next = (): void => go(steps[Math.min(index + 1, steps.length - 1)].id)
  const back = (): void => go(steps[Math.max(index - 1, 0)].id)

  useEffect(() => {
    void refreshProviders()
  }, [refreshProviders])
  const ready = providers.filter((p) => providerReadiness(p).state === 'ready')
  // Eaon Lite on a network that has used up its day: still shown, with why, rather than gone or "Ready".
  const eaonWaiting = providers.find((p) => wayOf(p) === 'eaon' && isProviderUsable(p) && providerReadiness(p).state === 'attention') ?? null

  // Enter presses the step's white button, as its ↵ says, unless something
  // else has the key: a field being typed in, a focused button (Enter
  // presses that one), or a dialog open over the setup (a model sign-in).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('input, textarea, select, button, a, [contenteditable="true"], [role="switch"]')) return
      const overlay = root.current
      if (!overlay || [...document.querySelectorAll('[role="dialog"]')].some((dialog) => dialog !== overlay)) return
      const primary = overlay.querySelector<HTMLButtonElement>('.onboarding__step [data-primary]:not(:disabled)')
      if (!primary) return
      event.preventDefault()
      primary.click()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /**
   * Closes the setup, then hands over to the tour or the app: the column
   * steps back and the setup fades off the real app under it. An updated
   * install's tour is the one of what's new; without it, what's new counts as
   * seen, so it doesn't come up on its own afterwards.
   */
  const finish = async (how: 'done' | 'skipped', tour: boolean): Promise<void> => {
    if (leaving) return
    setLeaving(true)
    await new Promise((done) => window.setTimeout(done, reduceMotion() ? 0 : how === 'done' ? 380 : 240))
    try {
      await patchSettings({
        onboarding: updated
          ? { setup: how, finishedAt: Date.now(), whatsNew: tour ? null : WHATS_NEW_RELEASE }
          : { setup: how, finishedAt: Date.now(), tour: tour ? 'pending' : 'skipped' }
      })
    } catch {
      // Not saved: the setup comes back as it was rather than frozen mid-exit
      // with every button refusing (`leaving` would stay set).
      setLeaving(false)
      return
    }
    if (tour) startTour(updated ? 'whatsNew' : 'app')
  }

  const name = updated ? `Set up Eaon ${WHATS_NEW_RELEASE}` : 'Set up Eaon'
  // On <body>, like the app's dialogs: nothing in the app around it can move or clip it.
  return createPortal(
    <div ref={root} className="onboarding" data-leaving={leaving || undefined} role="dialog" aria-modal="true" aria-label={name}>
      <header className="onboarding__bar">
        {index > 0 && step !== 'ready' ? (
          <button type="button" className="onboarding__quiet onboarding__back" onClick={back} disabled={leaving}>
            <ArrowLeft size={14} strokeWidth={2} />
            Back
          </button>
        ) : (
          <span />
        )}
        {step !== 'ready' && (
          <button type="button" className="onboarding__quiet onboarding__skip" onClick={() => void finish('skipped', false)} disabled={leaving}>
            Skip setup
          </button>
        )}
      </header>

      <main className="onboarding__scroll">
        <div className="onboarding__column">
          <section key={step} className="onboarding__step" data-direction={direction} aria-label={steps[index]?.label}>
            {step === 'welcome' && <Welcome updated={updated} onNext={next} />}
            {step === 'models' && <ModelsStep ready={ready} eaonWaiting={eaonWaiting} refresh={() => void refreshProviders()} onNext={next} />}
            {step === 'look' && <LookStep onNext={next} />}
            {step === 'import' && <ImportStep onNext={next} />}
            {step === 'tokn' && <ToknStep onNext={next} />}
            {step === 'ready' && <Ready updated={updated} onTour={() => void finish('done', true)} onStart={() => void finish('done', false)} />}
          </section>
        </div>
      </main>

      <footer className="onboarding__foot">
        <nav className="onboarding__dots" aria-label="Setup steps">
          {steps.map((s, i) => {
            const state = i === index ? 'current' : i <= reached ? 'done' : 'todo'
            return (
              <button
                key={s.id}
                type="button"
                className="onboarding__dot"
                data-state={state}
                aria-label={`${s.label}${i === index ? ', this step' : ''}`}
                aria-current={i === index ? 'step' : undefined}
                disabled={i > reached || i === index || leaving}
                onClick={() => go(s.id)}
              >
                <span />
              </button>
            )
          })}
        </nav>
        <p className="onboarding__made">
          <EaonSymbol size={12} />
          Free and open source
        </p>
      </footer>
    </div>,
    document.body
  )
}

/** Eaon's mark. */
function EaonSymbol({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg className="onboarding__symbol" width={size} height={size} viewBox="0 0 200 200" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M186.6 50A100 100 0 1 0 186.6 150H103A15 15 0 0 1 103 120H197.98A100 100 0 0 0 197.98 80H103A15 15 0 0 1 103 50Z"
      />
    </svg>
  )
}

/** Children appear one after another, a beat apart. */
const stagger = (i: number): CSSProperties => ({ '--i': i }) as CSSProperties

/** A step's top: its picture (the mark, or an icon on a tile), the title and a line under it. */
function Header({ hero, title, children }: { hero: ReactNode; title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="onboarding__header">
      <div className="onboarding__hero" style={stagger(0)}>
        {hero}
      </div>
      <h1 className="onboarding__title" style={stagger(1)}>
        {title}
      </h1>
      <p className="onboarding__lede" style={stagger(2)}>
        {children}
      </p>
    </div>
  )
}

/** An icon on a raised tile: the picture at the top of every step but the welcome. */
function Tile({ children }: { children: ReactNode }): JSX.Element {
  return <span className="onboarding__tile">{children}</span>
}

/** The step's buttons, full width and stacked: the white one first. */
function Actions({ at = 4, children }: { at?: number; children: ReactNode }): JSX.Element {
  return (
    <div className="onboarding__actions" style={stagger(at)}>
      {children}
    </div>
  )
}

/** The white button. Enter presses it (Setup), and its ↵ says so. */
function Primary({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }): JSX.Element {
  return (
    <button type="button" className="onboarding__btn onboarding__btn--primary" data-primary onClick={onClick} disabled={disabled}>
      {children}
      <CornerDownLeft className="onboarding__enter" size={13} strokeWidth={2.2} aria-hidden="true" />
    </button>
  )
}

function Secondary({ onClick, title, children }: { onClick: () => void; title?: string; children: ReactNode }): JSX.Element {
  return (
    <button type="button" className="onboarding__btn onboarding__btn--secondary" onClick={onClick} title={title}>
      {children}
    </button>
  )
}

function Welcome({ updated, onNext }: { updated: boolean; onNext: () => void }): JSX.Element {
  return (
    <>
      <Header
        hero={
          <span className="onboarding__mark">
            <span className="onboarding__glow" aria-hidden="true" />
            <EaonSymbol size={56} />
          </span>
        }
        title={updated ? `Eaon ${WHATS_NEW_RELEASE} is here` : 'Welcome to Eaon'}
      >
        {updated
          ? 'A lot has changed since 2026.6. Check your models and pick a look, then see what’s new.'
          : 'Every model you use, agents that keep working on their own, and your coding agents, in one app.'}
      </Header>
      <ul className="onboarding__places" style={stagger(3)} aria-label="What’s in Eaon">
        <li>Chat</li>
        <li>Workers</li>
        <li>ADE</li>
      </ul>
      <Actions>
        <Primary onClick={onNext}>Get started</Primary>
      </Actions>
      <p className="onboarding__fine" style={stagger(5)}>
        About 30 seconds. All of it is in Settings later.
      </p>
    </>
  )
}

/** The ways to connect a model, each opening Link accounts on just the providers that link that way. */
const WAYS: { method: LinkMethod; title: string; text: string; icon: JSX.Element }[] = [
  // Its text is the accounts that can sign in now (useSigninNames); this is for when none can.
  { method: 'signin', title: 'Sign in with an account', text: 'Accounts are set up in Settings → Model providers', icon: <CircleUserRound size={16} strokeWidth={1.9} /> },
  { method: 'key', title: 'Paste an API key', text: 'Anthropic, OpenAI, Gemini, Grok and more', icon: <KeyRound size={16} strokeWidth={1.9} /> },
  { method: 'local', title: 'Run models on this computer', text: 'Ollama or LM Studio, no account needed', icon: <Laptop size={16} strokeWidth={1.9} /> }
]

/** Which of the ways a ready provider came in by; Eaon's own (Eaon Lite, Eaon Event) need none. */
const wayOf = (provider: Provider): LinkMethod | 'eaon' =>
  provider.category === 'eaon' ? 'eaon' : provider.local ? 'local' : provider.auth === 'oauth' ? 'signin' : 'key'

/** "A, B or C". */
const orList = (names: string[]): string => (names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`)

/**
 * The accounts the setup can sign in to now. One whose sign-in needs a
 * client of the user's own first (Hugging Face, Poe until Eaon's are
 * registered) is set up in Settings, not offered here.
 */
function useSigninNames(): string | null {
  const providers = useApp((s) => s.providers)
  const [needsSetup, setNeedsSetup] = useState<Set<string> | null>(null)
  useEffect(() => {
    void window.api.providerAuth
      .status()
      .then((list) => setNeedsSetup(new Set(list.filter((s) => s.needsClientId).map((s) => s.providerId))))
      .catch(() => setNeedsSetup(new Set()))
  }, [])
  if (!needsSetup) return null
  const names = LINK_TARGETS.filter((t) => t.method === 'signin' && !needsSetup.has(t.providerId))
    .map((t) => providers.find((p) => p.id === t.providerId)?.name)
    .filter((name): name is string => Boolean(name))
  return orList(names)
}

function ModelsStep({ ready, eaonWaiting, refresh, onNext }: { ready: Provider[]; eaonWaiting: Provider | null; refresh: () => void; onNext: () => void }): JSX.Element {
  const [linking, setLinking] = useState(false)
  const signinNames = useSigninNames()
  // Kept while the dialog closes, so its list doesn't change on the way out.
  const [method, setMethod] = useState<LinkMethod>('signin')
  const [codeOpen, setCodeOpen] = useState(false)
  const names = (way: LinkMethod | 'eaon'): string => ready.filter((p) => wayOf(p) === way).map((p) => p.name).join(', ')
  const eaon = names('eaon')
  const waiting = !eaon && eaonWaiting ? providerReadiness(eaonWaiting) : null
  return (
    <>
      <Header
        hero={
          <Tile>
            <Sparkles size={20} strokeWidth={1.8} />
          </Tile>
        }
        title="Connect a model"
      >
        {eaon ? 'Free models from Eaon are on already, so you can start now. Add your own for more.' : 'Eaon works with whatever you have. Connect as many as you like.'}
      </Header>
      <div className="onboarding__list" style={stagger(3)}>
        {(eaon || waiting) && (
          <div className="onboarding__row" data-static data-waiting={waiting ? true : undefined}>
            <span className="onboarding__row-icon onboarding__row-icon--eaon">
              <EaonSymbol size={15} />
            </span>
            <span className="onboarding__row-body">
              <span className="onboarding__row-title">{eaon || eaonWaiting?.name}</span>
              <span className="onboarding__row-text">{waiting?.reason ?? 'Free models from Eaon, on already'}</span>
            </span>
            <span className="onboarding__row-state">
              {waiting ? <CircleAlert size={14} strokeWidth={2.2} /> : <Check size={14} strokeWidth={2.4} />}
              {waiting ? waiting.label : 'Ready'}
            </span>
          </div>
        )}
        {WAYS.map((way) => {
          const linked = names(way.method)
          return (
            <button
              key={way.method}
              type="button"
              className="onboarding__row"
              onClick={() => {
                setMethod(way.method)
                setLinking(true)
              }}
            >
              <span className="onboarding__row-icon">{way.icon}</span>
              <span className="onboarding__row-body">
                <span className="onboarding__row-title">{way.title}</span>
                <span className="onboarding__row-text">{way.method === 'signin' ? (signinNames ?? ' ') || way.text : way.text}</span>
              </span>
              {linked ? (
                <span className="onboarding__row-state" title={linked}>
                  <Check size={14} strokeWidth={2.4} />
                  <span className="onboarding__row-names">{linked}</span>
                </span>
              ) : (
                <ChevronRight className="onboarding__row-chevron" size={16} strokeWidth={1.9} aria-hidden="true" />
              )}
            </button>
          )
        })}
      </div>
      <Actions>
        {ready.length > 0 ? <Primary onClick={onNext}>Continue</Primary> : <Secondary onClick={onNext}>Not now</Secondary>}
      </Actions>
      {/* At an event, its code is the way in: no account or key, and each
          computer gets its own allowance instead of sharing the venue's IP. */}
      <div className="onboarding__code" style={stagger(5)}>
        {codeOpen ? (
          <RedeemCode
            compact
            onRedeemed={() => {
              setCodeOpen(false)
              refresh()
            }}
          />
        ) : (
          <button type="button" className="onboarding__quiet" onClick={() => setCodeOpen(true)}>
            Have an event code?
          </button>
        )}
      </div>
      <LinkAccounts
        inSetup
        only={method}
        open={linking}
        onClose={() => {
          setLinking(false)
          refresh()
        }}
      />
    </>
  )
}

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => Promise<void>) => { ready: Promise<void>; finished: Promise<void> } }

function LookStep({ onNext }: { onNext: () => void }): JSX.Element {
  const mode = useApp((s) => s.settings?.appearance.mode ?? 'system')
  const patchSettings = useApp((s) => s.patchSettings)
  const options: { value: ThemeMode; label: string; icon: JSX.Element }[] = [
    { value: 'system', label: 'System', icon: <Laptop size={14} strokeWidth={2} /> },
    { value: 'light', label: 'Light', icon: <Sun size={14} strokeWidth={2} /> },
    { value: 'dark', label: 'Dark', icon: <Moon size={14} strokeWidth={2} /> }
  ]

  /**
   * The new look spreads out from the click, over the old one. A view
   * transition snapshots the window before and after, so the whole screen
   * changes together in one sweep.
   */
  const choose = (value: ThemeMode, event: MouseEvent<HTMLButtonElement>): void => {
    if (value === mode) return
    const apply = (): Promise<void> => patchSettings({ appearance: { mode: value } }).then(() => undefined)
    const doc = document as ViewTransitionDocument
    const before = document.documentElement.dataset.theme
    if (!doc.startViewTransition || reduceMotion()) {
      void apply()
      return
    }
    // A keyboard press has no pointer position: spread from the button's middle.
    const box = event.currentTarget.getBoundingClientRect()
    const x = event.detail === 0 ? box.left + box.width / 2 : event.clientX
    const y = event.detail === 0 ? box.top + box.height / 2 : event.clientY
    const root = document.documentElement
    root.dataset.themeReveal = ''
    const transition = doc.startViewTransition(async () => {
      await apply()
      // useTheme writes the palette in an effect after the settings land; wait for it.
      for (let i = 0; i < 6 && root.dataset.theme === before; i++) await new Promise((done) => requestAnimationFrame(() => done(undefined)))
    })
    void transition.ready.then(() => {
      const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))
      root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] }, { duration: 620, easing: EASE, pseudoElement: '::view-transition-new(root)' })
    })
    void transition.finished.finally(() => delete root.dataset.themeReveal)
  }

  return (
    <>
      <Header
        hero={
          <Tile>
            <Palette size={20} strokeWidth={1.8} />
          </Tile>
        }
        title="Light or dark?"
      >
        Themes, accent colours and text size are in Settings → Appearance.
      </Header>
      <div className="onboarding__themes" role="radiogroup" aria-label="Appearance" style={stagger(3)}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={mode === option.value}
            className="onboarding__theme"
            data-on={mode === option.value || undefined}
            onClick={(event) => choose(option.value, event)}
          >
            <span className="onboarding__swatch" data-look={option.value}>
              <span className="onboarding__swatch-side" />
              <span className="onboarding__swatch-main">
                <span />
                <span />
              </span>
            </span>
            <span className="onboarding__theme-label">
              {option.icon}
              {option.label}
            </span>
          </button>
        ))}
      </div>
      <Actions>
        <Primary onClick={onNext}>Continue</Primary>
      </Actions>
    </>
  )
}

/**
 * Import from another app: the MCP servers set up in Claude, Cursor, Windsurf,
 * VS Code or Gemini CLI, ticked to come over. Only their server lists are
 * read; never an account, a chat or a sign-in.
 */
function ImportStep({ onNext }: { onNext: () => void }): JSX.Element {
  const state = useImportServers()
  const { count, working, error } = state
  const bring = async (): Promise<void> => {
    if (await state.run()) onNext()
  }
  return (
    <>
      <Header
        hero={
          <Tile>
            <FolderInput size={20} strokeWidth={1.8} />
          </Tile>
        }
        title="Bring your tools over"
      >
        Eaon can use the MCP servers you already set up in other apps. Pick the ones to add.
      </Header>
      <div className="onboarding__import" style={stagger(3)}>
        <ImportList state={state} />
        {error && <p className="onboarding__note onboarding__note--error">{error}</p>}
      </div>
      <Actions>
        {count > 0 ? (
          <>
            <Primary onClick={() => void bring()} disabled={working}>
              {working ? <Loader2 size={15} strokeWidth={2} className="spinner" /> : null}
              Import {count} {count === 1 ? 'server' : 'servers'}
            </Primary>
            <Secondary onClick={onNext}>Skip</Secondary>
          </>
        ) : (
          <Secondary onClick={onNext}>Skip</Secondary>
        )}
      </Actions>
    </>
  )
}

function ToknStep({ onNext }: { onNext: () => void }): JSX.Element {
  const state = useToknAccount()
  const patchSettings = useApp((s) => s.patchSettings)
  // Offered on: it's the point of the step. It takes effect only with a Tokn account, on Continue.
  const [trackCli, setTrackCli] = useState(true)
  const account = state?.account ?? null
  const pending = state?.signIn.state === 'pending'
  const failed = state?.signIn.state === 'error'
  // Signed in while the step shows: the account opens into the list rather than being there from the start.
  const [arrives] = useState(() => state !== null && !state.account)

  const proceed = (): void => {
    // The switch is the person's choice; it takes effect once there's a Tokn account to publish to.
    void patchSettings({ toknCli: { sync: trackCli } }).then(() => window.api.toknCli.apply())
    onNext()
  }

  return (
    <>
      <Header
        hero={
          <Tile>
            <ToknMark size={22} />
          </Tile>
        }
        title="Track your usage with Tokn"
      >
        See what your AI use costs and keep a streak going on toknhq.com. Eaon sends daily totals only, never your prompts or code.
      </Header>
      <div className="onboarding__list" style={stagger(3)}>
        {account && <AccountRow account={account} arrives={arrives} />}
        <label className="onboarding__row onboarding__option">
          <span className="onboarding__row-body">
            <span className="onboarding__row-title">Also track Claude Code, Codex and other CLIs</span>
            <span className="onboarding__row-text onboarding__row-text--wrap">Published to the same profile, also while Eaon is closed.</span>
          </span>
          <Switch checked={trackCli} onChange={setTrackCli} label="Also track the coding CLIs" />
        </label>
      </div>
      <Actions>
        {account ? (
          <Primary onClick={proceed}>Continue</Primary>
        ) : (
          <>
            {pending ? (
              <button type="button" className="onboarding__btn onboarding__btn--secondary" onClick={() => void window.api.usage.cancelSignIn()} title="Cancel">
                <Loader2 size={15} className="spinner" />
                Waiting for your browser…
              </button>
            ) : (
              <Primary onClick={() => void window.api.usage.signIn()}>{failed ? 'Try again' : 'Sign in with Tokn'}</Primary>
            )}
            <Secondary onClick={proceed}>Not now</Secondary>
          </>
        )}
      </Actions>
      {failed && state?.signIn.error && <p className="onboarding__note onboarding__note--error">{state.signIn.error}</p>}
      {pending && <p className="onboarding__note">Approve Eaon on toknhq.com. No account yet? You can make one there.</p>}
    </>
  )
}

/** The Tokn account signed in to, as the list's first row: who it is, and their profile on toknhq.com. */
function AccountRow({ account, arrives }: { account: ToknAccount; arrives: boolean }): JSX.Element {
  const name = account.name?.trim()
  return (
    <div className="onboarding__account" data-arrives={arrives || undefined}>
      <div className="onboarding__row onboarding__account-row">
        <span className="onboarding__avatar" aria-hidden="true">
          {(name || account.handle).charAt(0).toUpperCase()}
          <span className="onboarding__avatar-mark">
            <ToknMark size={14} />
          </span>
        </span>
        <span className="onboarding__row-body">
          <span className="onboarding__row-title">{name || `@${account.handle}`}</span>
          <span className="onboarding__row-text onboarding__account-status">{name ? `@${account.handle} · Signed in with Tokn` : 'Signed in with Tokn'}</span>
        </span>
        <button
          type="button"
          className="onboarding__quiet onboarding__profile"
          title={account.profileUrl.replace(/^https?:\/\//, '')}
          onClick={() => void window.api.app.openExternal(account.profileUrl)}
        >
          Profile
          <ArrowUpRight size={13} strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}

function Ready({ updated, onTour, onStart }: { updated: boolean; onTour: () => void; onStart: () => void }): JSX.Element {
  const mod = window.api.platform === 'darwin' ? '⌘' : 'Ctrl'
  const keys = [
    { keys: [mod, '1'], text: 'Chat' },
    { keys: [mod, '2'], text: 'Workers' },
    { keys: [mod, '3'], text: 'ADE' },
    { keys: [mod, ','], text: 'Settings' }
  ]
  return (
    <>
      <Header
        hero={
          <span className="onboarding__done">
            <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
              <path d="M7 13.4 11.2 17.5 19.2 9" pathLength={1} />
            </svg>
          </span>
        }
        title="You’re all set"
      >
        {updated ? `Take a one-minute tour of what’s new in ${WHATS_NEW_RELEASE}, or start right away.` : 'Take a one-minute tour of where everything is, or start right away.'}
      </Header>
      <div className="onboarding__keys" style={stagger(3)}>
        {keys.map((key) => (
          <div key={key.text} className="onboarding__key">
            <span>{key.text}</span>
            <span className="onboarding__kbd">
              {key.keys.map((k) => (
                <kbd key={k}>{k}</kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
      <Actions>
        <Primary onClick={onTour}>{updated ? 'See what’s new' : 'Show me around'}</Primary>
        <Secondary onClick={onStart}>Start using Eaon</Secondary>
      </Actions>
      <p className="onboarding__fine" style={stagger(5)}>
        The tour is in Settings → General whenever you want it.
      </p>
    </>
  )
}
