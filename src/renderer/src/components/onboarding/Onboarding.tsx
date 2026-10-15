import { useEffect, useMemo, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, Bot, Check, Laptop, Loader2, MessagesSquare, Moon, SquareTerminal, Sun } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { providerReadiness } from '@shared/modelSelection'
import type { ThemeMode } from '@shared/types'
import { useApp } from '../../state/store'
import { ToknMark, useToknAccount } from '../account/ToknAccount'
import { LinkAccounts } from '../LinkAccounts'
import { Switch } from '../ui'
import { useOnboarding } from './onboardingStore'
import '../../styles/onboarding.css'

/**
 * The first-run setup: a few steps over the whole window on a fresh install
 * (main/features/onboarding.ts decides which installs are fresh). Welcome,
 * the Tokn account that tracks usage, a model, light or dark, then an offer
 * of the tour. Every step can be skipped, and so can the whole setup; nothing
 * in it is needed to use Eaon, and all of it is in Settings afterwards.
 *
 * The step reached is kept in memory only: quitting halfway starts the setup
 * again next time, from the top, until it is finished or skipped.
 */

const STEPS = ['welcome', 'tokn', 'models', 'look', 'ready'] as const
type Step = (typeof STEPS)[number]

export function Onboarding(): JSX.Element | null {
  const status = useApp((s) => s.settings?.onboarding.setup)
  const patchSettings = useApp((s) => s.patchSettings)
  const startTour = useOnboarding((s) => s.startTour)
  const [step, setStep] = useState<Step>('welcome')
  // Which way the last move went, for the slide.
  const [direction, setDirection] = useState<1 | -1>(1)
  const [leaving, setLeaving] = useState(false)

  if (status !== 'pending') return null

  const index = STEPS.indexOf(step)
  const go = (to: Step): void => {
    setDirection(STEPS.indexOf(to) >= index ? 1 : -1)
    setStep(to)
  }
  const next = (): void => go(STEPS[Math.min(index + 1, STEPS.length - 1)])
  const back = (): void => go(STEPS[Math.max(index - 1, 0)])

  /** Closes the setup with a short fade, then hands over to the tour or the app. */
  const finish = (how: 'done' | 'skipped', tour: boolean): void => {
    setLeaving(true)
    window.setTimeout(() => {
      void patchSettings({ onboarding: { setup: how, finishedAt: Date.now(), tour: tour ? 'pending' : 'skipped' } })
      if (tour) startTour()
    }, 220)
  }

  // On <body>, like the app's dialogs: nothing in the app around it can move or clip it.
  return createPortal(
    <div className="onboarding" data-leaving={leaving || undefined} role="dialog" aria-modal="true" aria-label="Set up Eaon">
      <div className="onboarding__glow" aria-hidden="true" />
      <header className="onboarding__top">
        <ol className="onboarding__progress" aria-label={`Step ${index + 1} of ${STEPS.length}`}>
          {STEPS.map((s, i) => (
            <li key={s} data-state={i < index ? 'done' : i === index ? 'current' : 'todo'} />
          ))}
        </ol>
        <button type="button" className="onboarding__skip" onClick={() => finish('skipped', false)}>
          Skip setup
        </button>
      </header>

      <main className="onboarding__stage">
        <div key={step} className="onboarding__step" data-direction={direction}>
          {step === 'welcome' && <Welcome onNext={next} />}
          {step === 'tokn' && <ToknStep onBack={back} onNext={next} />}
          {step === 'models' && <ModelsStep onBack={back} onNext={next} />}
          {step === 'look' && <LookStep onBack={back} onNext={next} />}
          {step === 'ready' && <Ready onBack={back} onTour={() => finish('done', true)} onStart={() => finish('done', false)} />}
        </div>
      </main>
    </div>,
    document.body
  )
}

/** Eaon's mark, in the accent colour. */
function EaonSymbol({ size = 56 }: { size?: number }): JSX.Element {
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

function Footer({ onBack, children }: { onBack?: () => void; children: ReactNode }): JSX.Element {
  return (
    <footer className="onboarding__footer">
      {onBack ? (
        <button type="button" className="onboarding__back" onClick={onBack}>
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

/** Children appear one after another, a beat apart. */
const stagger = (i: number): CSSProperties => ({ '--i': i }) as CSSProperties

function Welcome({ onNext }: { onNext: () => void }): JSX.Element {
  const places = [
    { icon: <MessagesSquare size={18} strokeWidth={1.9} />, title: 'Chat', text: 'Ask anything, or hand Eaon a task, with any model.' },
    { icon: <Bot size={18} strokeWidth={1.9} />, title: 'Workers', text: 'Agents that keep working on their own, on a schedule.' },
    { icon: <SquareTerminal size={18} strokeWidth={1.9} />, title: 'ADE', text: 'Claude Code, Codex and more, side by side in real terminals.' }
  ]
  return (
    <>
      <div className="onboarding__hero">
        <div className="onboarding__mark" style={stagger(0)}>
          <EaonSymbol />
        </div>
        <h1 className="onboarding__title" style={stagger(1)}>
          Welcome to Eaon
        </h1>
        <p className="onboarding__lede" style={stagger(2)}>
          Every model you use, the agents that work for you, and the coding agents you run, in one app. Setting it up takes about a minute.
        </p>
      </div>
      <div className="onboarding__places">
        {places.map((place, i) => (
          <div key={place.title} className="onboarding__place" style={stagger(3 + i)}>
            <span className="onboarding__place-icon">{place.icon}</span>
            <span className="onboarding__place-title">{place.title}</span>
            <span className="onboarding__place-text">{place.text}</span>
          </div>
        ))}
      </div>
      <Footer>
        <button type="button" className="btn btn--primary onboarding__cta" onClick={onNext} autoFocus>
          Get started
          <ArrowRight size={15} strokeWidth={2} />
        </button>
      </Footer>
    </>
  )
}

/** A dot grid like the one on a Tokn profile: random but steady, brighter towards today. */
function DotGrid({ weeks = 26, filled }: { weeks?: number; filled: boolean }): JSX.Element {
  const levels = useMemo(() => {
    let seed = 7
    const random = (): number => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    return Array.from({ length: weeks * 7 }, (_, i) => {
      const recent = i / (weeks * 7)
      const r = random()
      return r < 0.35 - recent * 0.2 ? 0 : Math.min(4, 1 + Math.floor(r * 3 + recent * 2))
    })
  }, [weeks])
  return (
    <div className="tokn-preview__grid" data-filled={filled || undefined} style={{ '--weeks': weeks } as CSSProperties}>
      {levels.map((level, i) => (
        <span key={i} data-level={level} style={{ '--d': `${(i % 7) * 12 + Math.floor(i / 7) * 9}ms` } as CSSProperties} />
      ))}
    </div>
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
      <div className="onboarding__split">
        <div className="onboarding__copy">
          <span className="onboarding__eyebrow" style={stagger(0)}>
            Your profile
          </span>
          <h1 className="onboarding__title" style={stagger(1)}>
            Track your usage with Tokn
          </h1>
          <p className="onboarding__lede" style={stagger(2)}>
            Sign in with Tokn to see what your AI use costs, keep a streak going, and get a profile on toknhq.com and tokns.eaon.dev with a
            place on the Eaon leaderboard. Eaon sends daily totals only, never your prompts or code.
          </p>
          <label className="onboarding__option" style={stagger(3)}>
            <span className="onboarding__option-text">
              <span className="onboarding__option-title">Also track Claude Code, Codex and other coding CLIs</span>
              <span className="onboarding__option-sub">With the tokn command that comes with Eaon. It publishes their usage to the same profile every hour.</span>
            </span>
            <Switch checked={trackCli} onChange={setTrackCli} label="Also track the coding CLIs" />
          </label>
        </div>
        <div className="tokn-preview" style={stagger(2)} aria-hidden="true">
          <div className="tokn-preview__head">
            <span className="tokn-preview__avatar">{account ? (account.name || account.handle).trim()[0]?.toUpperCase() : <ToknMark size={22} />}</span>
            <span className="tokn-preview__who">
              <span className="tokn-preview__name">{account ? account.name || account.handle : 'Your name'}</span>
              <span className="tokn-preview__handle">@{account?.handle ?? 'you'}</span>
            </span>
          </div>
          <div className="tokn-preview__stats">
            {[
              ['Agents', account ? '—' : '128'],
              ['Streak', account ? '—' : '12d'],
              ['Tokens', account ? '—' : '4.2M']
            ].map(([label, value]) => (
              <span key={label} className="tokn-preview__stat">
                <span className="tokn-preview__label">{label}</span>
                <span className="tokn-preview__value">{value}</span>
              </span>
            ))}
          </div>
          <DotGrid filled={!account} />
          <svg className="tokn-preview__chart" viewBox="0 0 240 48" preserveAspectRatio="none">
            <path className="tokn-preview__area" d="M0 44 L20 40 L40 41 L60 30 L80 34 L100 22 L120 27 L140 14 L160 20 L180 9 L200 16 L220 6 L240 11 L240 48 L0 48 Z" />
            <path className="tokn-preview__line" d="M0 44 L20 40 L40 41 L60 30 L80 34 L100 22 L120 27 L140 14 L160 20 L180 9 L200 16 L220 6 L240 11" />
          </svg>
        </div>
      </div>
      <Footer onBack={onBack}>
        {account ? (
          <>
            <span className="onboarding__done">
              <Check size={15} strokeWidth={2.4} />
              Signed in as @{account.handle}
            </span>
            <button type="button" className="btn btn--primary onboarding__cta" onClick={proceed} autoFocus>
              Continue
              <ArrowRight size={15} strokeWidth={2} />
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn--ghost" onClick={proceed}>
              Not now
            </button>
            {pending ? (
              <button type="button" className="btn onboarding__cta" onClick={() => void window.api.usage.cancelSignIn()} title="Cancel">
                <Loader2 size={15} className="spinner" />
                Waiting for your browser…
              </button>
            ) : (
              <button type="button" className="btn btn--primary onboarding__cta" onClick={() => void window.api.usage.signIn()} autoFocus>
                <ToknMark size={16} />
                {failed ? 'Try again' : 'Sign in with Tokn'}
              </button>
            )}
          </>
        )}
      </Footer>
      {failed && state?.signIn.error && <p className="onboarding__error">{state.signIn.error}</p>}
      {pending && <p className="onboarding__hint">Approve Eaon on toknhq.com. No account yet? You can make one there.</p>}
    </>
  )
}

function ModelsStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }): JSX.Element {
  const { providers, refreshProviders } = useApp(useShallow((s) => ({ providers: s.providers, refreshProviders: s.refreshProviders })))
  const [linking, setLinking] = useState(false)
  useEffect(() => {
    void refreshProviders()
  }, [refreshProviders])
  const ready = providers.filter((p) => providerReadiness(p).state === 'ready')
  const ways = [
    { title: 'An AI account you have', text: 'ChatGPT, Claude, GitHub Copilot and more, on the plan you already pay for.' },
    { title: 'An API key', text: 'OpenAI, Anthropic, Google, OpenRouter and dozens of others.' },
    { title: 'Models on this computer', text: 'Ollama and LM Studio when they’re installed, or download one in Models.' }
  ]
  return (
    <>
      <div className="onboarding__hero onboarding__hero--left">
        <span className="onboarding__eyebrow" style={stagger(0)}>
          Models
        </span>
        <h1 className="onboarding__title" style={stagger(1)}>
          Connect a model
        </h1>
        <p className="onboarding__lede" style={stagger(2)}>
          Eaon works with whatever you have. Connect as many as you like; every chat can use a different one.
        </p>
      </div>
      <div className="onboarding__ways">
        {ways.map((way, i) => (
          <div key={way.title} className="onboarding__way" style={stagger(3 + i)}>
            <span className="onboarding__way-title">{way.title}</span>
            <span className="onboarding__way-text">{way.text}</span>
          </div>
        ))}
      </div>
      {ready.length > 0 && (
        <p className="onboarding__ready" style={stagger(6)}>
          <Check size={14} strokeWidth={2.4} />
          Ready: {ready.map((p) => p.name).join(', ')}
        </p>
      )}
      <Footer onBack={onBack}>
        <button type="button" className="btn btn--ghost" onClick={onNext}>
          {ready.length > 0 ? 'Continue' : 'Not now'}
        </button>
        <button type="button" className={`btn onboarding__cta ${ready.length > 0 ? '' : 'btn--primary'}`} onClick={() => setLinking(true)} autoFocus={ready.length === 0}>
          {ready.length > 0 ? 'Connect another' : 'Connect a model'}
        </button>
      </Footer>
      <LinkAccounts
        open={linking}
        onClose={() => {
          setLinking(false)
          void refreshProviders()
        }}
      />
    </>
  )
}

function LookStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }): JSX.Element {
  const mode = useApp((s) => s.settings?.appearance.mode ?? 'system')
  const patchSettings = useApp((s) => s.patchSettings)
  const options: { value: ThemeMode; label: string; icon: JSX.Element }[] = [
    { value: 'system', label: 'Match the system', icon: <Laptop size={15} strokeWidth={2} /> },
    { value: 'light', label: 'Light', icon: <Sun size={15} strokeWidth={2} /> },
    { value: 'dark', label: 'Dark', icon: <Moon size={15} strokeWidth={2} /> }
  ]
  return (
    <>
      <div className="onboarding__hero">
        <span className="onboarding__eyebrow" style={stagger(0)}>
          Appearance
        </span>
        <h1 className="onboarding__title" style={stagger(1)}>
          Light or dark?
        </h1>
        <p className="onboarding__lede" style={stagger(2)}>
          Themes, accent colours and text size are in Settings → Appearance.
        </p>
      </div>
      <div className="onboarding__themes" role="radiogroup" aria-label="Appearance">
        {options.map((option, i) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={mode === option.value}
            className="onboarding__theme"
            data-on={mode === option.value || undefined}
            style={stagger(3 + i)}
            onClick={() => void patchSettings({ appearance: { mode: option.value } })}
          >
            <span className="onboarding__window" data-look={option.value}>
              <span className="onboarding__window-side" />
              <span className="onboarding__window-main">
                <span />
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
      <Footer onBack={onBack}>
        <button type="button" className="btn btn--primary onboarding__cta" onClick={onNext} autoFocus>
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
      <div className="onboarding__hero">
        <div className="onboarding__check" style={stagger(0)}>
          <Check size={28} strokeWidth={2.6} />
        </div>
        <h1 className="onboarding__title" style={stagger(1)}>
          You’re all set
        </h1>
        <p className="onboarding__lede" style={stagger(2)}>
          Take a one-minute tour of where everything is, or start right away. The tour is in the Help menu whenever you want it.
        </p>
      </div>
      <div className="onboarding__keys" style={stagger(3)}>
        {keys.map((key) => (
          <span key={key.text} className="onboarding__key">
            {key.keys.map((k) => (
              <kbd key={k}>{k}</kbd>
            ))}
            <span>{key.text}</span>
          </span>
        ))}
      </div>
      <Footer onBack={onBack}>
        <button type="button" className="btn btn--ghost" onClick={onStart}>
          Start using Eaon
        </button>
        <button type="button" className="btn btn--primary onboarding__cta" onClick={onTour} autoFocus>
          Show me around
          <ArrowRight size={15} strokeWidth={2} />
        </button>
      </Footer>
    </>
  )
}
