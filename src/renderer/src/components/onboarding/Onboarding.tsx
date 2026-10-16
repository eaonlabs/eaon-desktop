import { useEffect, useRef, useState, type CSSProperties, type JSX, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, Check, Laptop, Loader2, MessagesSquare, Moon, SquareTerminal, Sun } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { providerReadiness } from '@shared/modelSelection'
import type { ThemeMode } from '@shared/types'
import { useApp } from '../../state/store'
import { ToknMark, useToknAccount } from '../account/ToknAccount'
import { LinkAccounts } from '../LinkAccounts'
import { WorkersGlyph } from '../ModeSwitch'
import { Switch } from '../ui'
import { ADE_LENGTH, CHAT_LENGTH, MiniApp, WORKERS_LENGTH, reduceMotion, type Scene } from './MiniApp'
import { useOnboarding } from './onboardingStore'
import '../../styles/onboarding.css'

/**
 * The first-run setup: a few steps over the whole window on a fresh install
 * (main/features/onboarding.ts decides which installs are fresh). Welcome,
 * the Tokn account that tracks usage, a model, light or dark, then an offer
 * of the tour. Every step can be skipped, and so can the whole setup; nothing
 * in it is needed to use Eaon, and all of it is in Settings afterwards.
 *
 * It's laid out like the app: the steps in a floating panel where the sidebar
 * goes, and beside each step a small Eaon window (MiniApp) showing what the
 * step is about. Finishing grows that window to fill the screen, over the
 * real app, which is there when it fades.
 *
 * The step reached is kept in memory only: quitting halfway starts the setup
 * again next time, from the top, until it is finished or skipped.
 */

const STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'tokn', label: 'Tokn profile' },
  { id: 'models', label: 'Models' },
  { id: 'look', label: 'Appearance' },
  { id: 'ready', label: 'Finish' }
] as const
type Step = (typeof STEPS)[number]['id']

/** The welcome's three places, each playing in the window in turn. */
const PLACES: { scene: Scene; title: string; text: string; icon: JSX.Element; length: number }[] = [
  { scene: 'chat', title: 'Chat', text: 'Ask anything, or hand Eaon a task.', icon: <MessagesSquare size={16} strokeWidth={1.9} />, length: CHAT_LENGTH },
  { scene: 'workers', title: 'Workers', text: 'Agents that keep working on their own.', icon: <WorkersGlyph size={16} strokeWidth={1.9} />, length: WORKERS_LENGTH },
  { scene: 'ade', title: 'ADE', text: 'Claude Code and Codex in real terminals.', icon: <SquareTerminal size={16} strokeWidth={1.9} />, length: ADE_LENGTH }
]

/** The window's motion curve (--ease in tokens.css), for animations started from script. */
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'

export function Onboarding(): JSX.Element | null {
  const status = useApp((s) => s.settings?.onboarding.setup)
  return status === 'pending' ? <Setup /> : null
}

function Setup(): JSX.Element {
  const patchSettings = useApp((s) => s.patchSettings)
  const startTour = useOnboarding((s) => s.startTour)
  const { providers, refreshProviders } = useApp(useShallow((s) => ({ providers: s.providers, refreshProviders: s.refreshProviders })))
  const tokn = useToknAccount()
  const [step, setStep] = useState<Step>('welcome')
  // The furthest step seen: the panel lets you go back to any of them.
  const [reached, setReached] = useState(0)
  const [direction, setDirection] = useState<1 | -1>(1)
  const [leaving, setLeaving] = useState<'zoom' | 'fade' | null>(null)
  const [place, setPlace] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const mini = useRef<HTMLDivElement>(null)

  const index = STEPS.findIndex((s) => s.id === step)
  const go = (to: Step): void => {
    const target = STEPS.findIndex((s) => s.id === to)
    setDirection(target >= index ? 1 : -1)
    setReached((r) => Math.max(r, target))
    setStep(to)
  }
  const next = (): void => go(STEPS[Math.min(index + 1, STEPS.length - 1)].id)
  const back = (): void => go(STEPS[Math.max(index - 1, 0)].id)

  // The welcome plays its three places in turn; picking one starts it over from there.
  useEffect(() => {
    if (step !== 'welcome') return
    const timer = window.setTimeout(() => setPlace((p) => (p + 1) % PLACES.length), PLACES[place].length)
    return () => window.clearTimeout(timer)
  }, [step, place])

  useEffect(() => {
    void refreshProviders()
  }, [refreshProviders])
  const ready = providers.filter((p) => providerReadiness(p).state === 'ready')

  const scene: Scene = step === 'welcome' ? PLACES[place].scene : step === 'tokn' ? 'tokn' : step === 'models' ? 'models' : 'home'

  /**
   * Closes the setup, then hands over to the tour or the app. Finishing grows
   * the little window over the real one and lets it go; skipping just fades.
   */
  const finish = async (how: 'done' | 'skipped', tour: boolean): Promise<void> => {
    if (leaving) return
    const window_ = mini.current
    const overlay = root.current
    const zoom = how === 'done' && window_ && overlay && window_.getClientRects().length > 0 && !reduceMotion()
    setLeaving(zoom ? 'zoom' : 'fade')
    if (zoom) {
      const rect = window_.getBoundingClientRect()
      const scale = Math.max(window.innerWidth / rect.width, window.innerHeight / rect.height)
      const dx = window.innerWidth / 2 - (rect.left + rect.width / 2)
      const dy = window.innerHeight / 2 - (rect.top + rect.height / 2)
      const grow = window_.animate(
        // It's gone before it's full size: the real window under it is laid out a little differently.
        [
          { transform: 'none', opacity: 1, filter: 'blur(0px)' },
          { opacity: 1, filter: 'blur(0px)', offset: 0.3 },
          { opacity: 0, filter: 'blur(6px)', offset: 0.72 },
          { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0, filter: 'blur(6px)' }
        ],
        { duration: 720, easing: EASE, fill: 'forwards' }
      )
      const canvas = getComputedStyle(overlay).backgroundColor
      overlay.animate([{ backgroundColor: canvas }, { backgroundColor: canvas, offset: 0.35 }, { backgroundColor: 'transparent' }], {
        duration: 720,
        easing: EASE,
        fill: 'forwards'
      })
      await grow.finished.catch(() => undefined)
    } else {
      await new Promise((done) => window.setTimeout(done, 220))
    }
    await patchSettings({ onboarding: { setup: how, finishedAt: Date.now(), tour: tour ? 'pending' : 'skipped' } })
    if (tour) startTour()
  }

  // On <body>, like the app's dialogs: nothing in the app around it can move or clip it.
  return createPortal(
    <div ref={root} className="onboarding" data-leaving={leaving ?? undefined} role="dialog" aria-modal="true" aria-label="Set up Eaon">
      <nav className="onboarding__nav" aria-label="Setup steps">
        <div className="onboarding__panel">
          <div className="onboarding__drag" />
          <div className="onboarding__brand">
            <EaonSymbol size={18} />
            <span className="onboarding__brand-text">
              <span className="onboarding__brand-name">Set up Eaon</span>
              <span className="onboarding__brand-sub">About a minute</span>
            </span>
          </div>
          <ol className="onboarding__steps" style={{ '--at': index } as CSSProperties}>
            <span className="onboarding__indicator" aria-hidden="true" />
            {STEPS.map((s, i) => {
              const state = i === index ? 'current' : i <= reached ? 'done' : 'todo'
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className="onboarding__stepnav"
                    data-state={state}
                    aria-current={i === index ? 'step' : undefined}
                    disabled={i > reached || Boolean(leaving)}
                    onClick={() => go(s.id)}
                  >
                    <StepMark state={state} />
                    {s.label}
                  </button>
                </li>
              )
            })}
          </ol>
          <div className="onboarding__panel-foot">
            <button type="button" className="onboarding__skip" onClick={() => void finish('skipped', false)}>
              Skip setup
            </button>
          </div>
        </div>
      </nav>

      <main className="onboarding__main">
        <div className="onboarding__titlebar" />
        <div className="onboarding__progress" aria-hidden="true">
          Step {index + 1} of {STEPS.length}
        </div>
        <div className="onboarding__layout">
          <section key={step} className="onboarding__step" data-direction={direction}>
            {step === 'welcome' && <Welcome place={place} onPlace={setPlace} onNext={next} />}
            {step === 'tokn' && <ToknStep onBack={back} onNext={next} />}
            {step === 'models' && <ModelsStep ready={ready.map((p) => p.name)} refresh={() => void refreshProviders()} onBack={back} onNext={next} />}
            {step === 'look' && <LookStep onBack={back} onNext={next} />}
            {step === 'ready' && <Ready onBack={back} onTour={() => void finish('done', true)} onStart={() => void finish('done', false)} />}
          </section>
          <div className="onboarding__stage">
            <MiniApp ref={mini} scene={scene} account={tokn?.account ?? null} ready={ready.map((p) => p.name)} />
          </div>
        </div>
      </main>
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

/** A step's mark in the panel: an empty ring, the current one, or a check that draws itself in. */
function StepMark({ state }: { state: 'done' | 'current' | 'todo' }): JSX.Element {
  return (
    <svg className="onboarding__mark" data-state={state} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle className="onboarding__mark-ring" cx="8" cy="8" r="6.25" />
      <circle className="onboarding__mark-fill" cx="8" cy="8" r="7" />
      <path className="onboarding__mark-check" d="M5.2 8.2 7.1 10 10.8 6.2" pathLength={1} />
    </svg>
  )
}

/** Children appear one after another, a beat apart. */
const stagger = (i: number): CSSProperties => ({ '--i': i }) as CSSProperties

function Header({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="onboarding__header">
      <h1 className="onboarding__title" style={stagger(0)}>
        {title}
      </h1>
      <p className="onboarding__lede" style={stagger(1)}>
        {children}
      </p>
    </div>
  )
}

function Footer({ onBack, children, at = 4 }: { onBack?: () => void; children: ReactNode; at?: number }): JSX.Element {
  return (
    <footer className="onboarding__footer" style={stagger(at)}>
      {onBack ? (
        <button type="button" className="btn btn--ghost onboarding__btn onboarding__back" onClick={onBack}>
          <ArrowLeft size={15} strokeWidth={2} />
          Back
        </button>
      ) : (
        <span />
      )}
      <div className="onboarding__actions">{children}</div>
    </footer>
  )
}

function Welcome({ place, onPlace, onNext }: { place: number; onPlace: (i: number) => void; onNext: () => void }): JSX.Element {
  return (
    <>
      <Header title="Welcome to Eaon">Every model you use, the agents that work for you and the coding agents you run, in one app.</Header>
      <div className="onboarding__places" role="tablist" aria-label="What’s in Eaon" style={{ ...stagger(2), '--at': place } as CSSProperties}>
        <span className="onboarding__places-indicator" aria-hidden="true" />
        {PLACES.map((p, i) => (
          <button
            key={p.scene}
            type="button"
            role="tab"
            aria-selected={i === place}
            className="onboarding__place"
            data-on={i === place || undefined}
            onClick={() => onPlace(i)}
          >
            <span className="onboarding__place-icon">{p.icon}</span>
            <span className="onboarding__place-body">
              <span className="onboarding__place-title">{p.title}</span>
              <span className="onboarding__place-text">{p.text}</span>
            </span>
          </button>
        ))}
      </div>
      <Footer at={3}>
        <button type="button" className="btn btn--primary onboarding__btn" onClick={onNext} autoFocus>
          Get started
          <ArrowRight size={15} strokeWidth={2} />
        </button>
      </Footer>
    </>
  )
}

function ToknStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }): JSX.Element {
  const state = useToknAccount()
  const patchSettings = useApp((s) => s.patchSettings)
  // Offered on: it's the point of the step. It takes effect only with a Tokn account, on Continue.
  const [trackCli, setTrackCli] = useState(true)
  const account = state?.account ?? null
  const pending = state?.signIn.state === 'pending'
  const failed = state?.signIn.state === 'error'

  const proceed = (): void => {
    // The coding CLIs are tracked only with a Tokn account to publish to, and the person's yes.
    void patchSettings({ toknCli: { sync: Boolean(account) && trackCli } }).then(() => window.api.toknCli.apply())
    onNext()
  }

  return (
    <>
      <Header title="Track your usage with Tokn">
        See what your AI use costs, keep a streak going, and get a profile on toknhq.com. Eaon sends daily totals only, never your prompts or
        code.
      </Header>
      <div className="card" style={stagger(2)}>
        <label className="card__row onboarding__option">
          <span className="card__row-body">
            <span className="card__row-title">Also track Claude Code, Codex and other coding CLIs</span>
            <span className="card__row-desc">The tokn command that comes with Eaon publishes their usage to the same profile every hour.</span>
          </span>
          <Switch checked={trackCli} onChange={setTrackCli} label="Also track the coding CLIs" />
        </label>
      </div>
      <Footer onBack={onBack} at={3}>
        {account ? (
          <>
            <span className="onboarding__done">
              <Check size={14} strokeWidth={2.4} />
              Signed in as @{account.handle}
            </span>
            <button type="button" className="btn btn--primary onboarding__btn" onClick={proceed} autoFocus>
              Continue
              <ArrowRight size={15} strokeWidth={2} />
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn--ghost onboarding__btn" onClick={proceed}>
              Not now
            </button>
            {pending ? (
              <button type="button" className="btn onboarding__btn" onClick={() => void window.api.usage.cancelSignIn()} title="Cancel">
                <Loader2 size={15} className="spinner" />
                Waiting for your browser…
              </button>
            ) : (
              <button type="button" className="btn btn--primary onboarding__btn" onClick={() => void window.api.usage.signIn()} autoFocus>
                <ToknMark size={16} />
                {failed ? 'Try again' : 'Sign in with Tokn'}
              </button>
            )}
          </>
        )}
      </Footer>
      {failed && state?.signIn.error && <p className="onboarding__note onboarding__note--error">{state.signIn.error}</p>}
      {pending && <p className="onboarding__note">Approve Eaon on toknhq.com. No account yet? You can make one there.</p>}
    </>
  )
}

function ModelsStep({ ready, refresh, onBack, onNext }: { ready: string[]; refresh: () => void; onBack: () => void; onNext: () => void }): JSX.Element {
  const [linking, setLinking] = useState(false)
  const ways = [
    { title: 'An AI account you have', text: 'ChatGPT, Claude, GitHub Copilot and more, on the plan you already pay for.' },
    { title: 'An API key', text: 'OpenAI, Anthropic, Google, OpenRouter and dozens of others.' },
    { title: 'Models on this computer', text: 'Ollama and LM Studio when they’re installed, or download one in Models.' }
  ]
  return (
    <>
      <Header title="Connect a model">Eaon works with whatever you have. Connect as many as you like; every chat can use a different one.</Header>
      <div className="card" style={stagger(2)}>
        {ways.map((way) => (
          <div key={way.title} className="card__row">
            <span className="card__row-body">
              <span className="card__row-title">{way.title}</span>
              <span className="card__row-desc">{way.text}</span>
            </span>
          </div>
        ))}
      </div>
      {ready.length > 0 && (
        <p className="onboarding__done onboarding__ready" style={stagger(3)}>
          <Check size={14} strokeWidth={2.4} />
          Ready: {ready.join(', ')}
        </p>
      )}
      <Footer onBack={onBack}>
        <button type="button" className="btn btn--ghost onboarding__btn" onClick={onNext}>
          {ready.length > 0 ? 'Continue' : 'Not now'}
        </button>
        <button type="button" className={`btn onboarding__btn ${ready.length > 0 ? '' : 'btn--primary'}`} onClick={() => setLinking(true)} autoFocus={ready.length === 0}>
          {ready.length > 0 ? 'Connect another' : 'Connect a model'}
        </button>
      </Footer>
      <LinkAccounts
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

function LookStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }): JSX.Element {
  const mode = useApp((s) => s.settings?.appearance.mode ?? 'system')
  const patchSettings = useApp((s) => s.patchSettings)
  const options: { value: ThemeMode; label: string; icon: JSX.Element }[] = [
    { value: 'system', label: 'System', icon: <Laptop size={15} strokeWidth={2} /> },
    { value: 'light', label: 'Light', icon: <Sun size={15} strokeWidth={2} /> },
    { value: 'dark', label: 'Dark', icon: <Moon size={15} strokeWidth={2} /> }
  ]

  /**
   * The new look spreads out from the click, over the old one. A view
   * transition snapshots the window before and after, so everything (this
   * screen, the little window beside it) changes together in one sweep.
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
      <Header title="Light or dark?">Themes, accent colours and text size are in Settings → Appearance.</Header>
      <div className="onboarding__themes" role="radiogroup" aria-label="Appearance" style={stagger(2)}>
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
      <Footer onBack={onBack} at={3}>
        <button type="button" className="btn btn--primary onboarding__btn" onClick={onNext} autoFocus>
          Continue
          <ArrowRight size={15} strokeWidth={2} />
        </button>
      </Footer>
    </>
  )
}

function Ready({ onBack, onTour, onStart }: { onBack: () => void; onTour: () => void; onStart: () => void }): JSX.Element {
  const mod = window.api.platform === 'darwin' ? '⌘' : 'Ctrl'
  const keys = [
    { keys: [mod, '1'], text: 'Chat' },
    { keys: [mod, '2'], text: 'Workers' },
    { keys: [mod, '3'], text: 'ADE' },
    { keys: [mod, ','], text: 'Settings' }
  ]
  return (
    <>
      <Header title="You’re all set">Take a one-minute tour of where everything is, or start right away. The tour is in the Help menu whenever you want it.</Header>
      <div className="card onboarding__keys" style={stagger(2)}>
        {keys.map((key) => (
          <div key={key.text} className="card__row">
            <span className="card__row-body card__row-title">{key.text}</span>
            <span className="onboarding__kbd">
              {key.keys.map((k) => (
                <kbd key={k}>{k}</kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
      <Footer onBack={onBack} at={3}>
        <button type="button" className="btn btn--ghost onboarding__btn" onClick={onStart}>
          Start using Eaon
        </button>
        <button type="button" className="btn btn--primary onboarding__btn" onClick={onTour} autoFocus>
          Show me around
          <ArrowRight size={15} strokeWidth={2} />
        </button>
      </Footer>
    </>
  )
}
