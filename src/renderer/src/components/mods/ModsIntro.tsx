import { useEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { BadgeCheck, X } from 'lucide-react'
import { useApp } from '../../state/store'
import { useMods } from '../../state/mods'
import { useOnboardingShowing } from '../onboarding/onboardingStore'
import { ModPreview } from './ModPreview'
import { CATEGORY_ICONS } from './ModsPage'
import { MOD_CATEGORIES } from '@shared/mods'
import './mods.css'

/**
 * Says once, after updating to a version with mods, that they're here. Not
 * on a fresh install (whose setup has just shown it around), never over the
 * setup or a tour, and not before the what's-new tour that is due has had
 * its turn. Seen is `settings.onboarding.modsIntro`.
 */
export function ModsIntro(): JSX.Element | null {
  const onboarding = useApp((s) => s.settings?.onboarding)
  const patchSettings = useApp((s) => s.patchSettings)
  const touring = useOnboardingShowing()
  const list = useMods((s) => s.list)
  const [ready, setReady] = useState(false)
  const primary = useRef<HTMLButtonElement>(null)

  const due = Boolean(onboarding && !onboarding.modsIntro && !onboarding.fresh && onboarding.setup !== 'pending' && onboarding.whatsNew !== null && !touring)
  // A moment after the window settles, so it isn't the first thing drawn.
  useEffect(() => {
    if (!due) return
    const timer = setTimeout(() => setReady(true), 1200)
    return () => clearTimeout(timer)
  }, [due])

  const showing = due && ready && Boolean(list)
  useEffect(() => {
    if (!showing) return
    primary.current?.focus({ preventScroll: true })
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showing])

  if (!showing || !onboarding) return null

  function dismiss(): void {
    void patchSettings({ onboarding: { ...useApp.getState().settings!.onboarding, modsIntro: true } })
  }

  const browse = (): void => {
    dismiss()
    useApp.getState().setSettingsPage('mods')
  }

  return createPortal(
    <div className="layer layer--scrim" onMouseDown={(e) => e.target === e.currentTarget && dismiss()}>
      <div className="mods-intro" role="dialog" aria-modal="true" aria-labelledby="mods-intro-title">
        <button type="button" className="modal__close" onClick={dismiss} aria-label="Close">
          <X size={16} strokeWidth={2} />
        </button>
        <div className="mods-intro__text">
          <span className="mods-intro__new">New</span>
          <h2 id="mods-intro-title" className="mods-intro__title">
            Mods
          </h2>
          <p>Add themes, slash commands, dock panels, worker templates and ADE presets, and load commands, skills and hooks into the Claude Code and Codex sessions Eaon starts.</p>
          <p>Every mod shows what it can touch before it installs. Eaon’s own mods come with the app and work offline; you can also install mods from a folder, a file or a link.</p>
          <p className="mods-intro__where">Change or turn them off anytime in Settings → Mods.</p>
          <button ref={primary} type="button" className="btn btn--primary mods-intro__go" onClick={browse}>
            Browse mods
          </button>
        </div>
        <IntroPreview />
      </div>
    </div>,
    document.body
  )
}

/** A few of Eaon's own mods as small cards, one lit after another. */
function IntroPreview(): JSX.Element {
  const list = useMods((s) => s.list)
  // One of each of a few kinds, so the strip shows the range.
  const picks = (['themes', 'panels', 'cli', 'workers'] as const)
    .map((category) => list?.mods.find((m) => m.official && m.manifest.category === category))
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
  const [lit, setLit] = useState(0)
  useEffect(() => {
    if (picks.length < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const timer = setInterval(() => setLit((n) => (n + 1) % picks.length), 2400)
    return () => clearInterval(timer)
  }, [picks.length])
  return (
    <div className="mods-intro__preview" aria-hidden>
      {picks.map((info, i) => (
        <div key={info.manifest.id} className="mods-intro__card" data-lit={i === lit || undefined}>
          <ModPreview manifest={info.manifest} claude={info.claude} />
          <div className="mods-intro__card-body">
            <span className="mods-intro__card-name">
              {info.manifest.name}
              <BadgeCheck size={12} strokeWidth={2} />
            </span>
            <span className="mods-intro__card-tag">
              {CATEGORY_ICONS[info.manifest.category]}
              {MOD_CATEGORIES.find((c) => c.id === info.manifest.category)?.label}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}
