import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Segmented, Select, Slider, Switch } from '../../ui'
import { Folder, Search } from 'lucide-react'
import type { AppIcon, Glass, SeeThroughStyle, Settings, ThemeMode } from '@shared/types'
import { GLASS_CLEAR_BLUR, GLASS_DEFAULT } from '@shared/glass'
import { THEMES, type Palette, type Theme } from '../../../lib/themes'
import { isMac } from '../../../lib/platform'
import defaultIcon from '../../../assets/app-icons/default.png'
import agentIcon from '../../../assets/app-icons/agent.png'
import lightIcon from '../../../assets/app-icons/light.png'
import oceanIcon from '../../../assets/app-icons/ocean.png'
import sunsetIcon from '../../../assets/app-icons/sunset.png'
import forestIcon from '../../../assets/app-icons/forest.png'
import grapeIcon from '../../../assets/app-icons/grape.png'
import auroraIcon from '../../../assets/app-icons/aurora.png'
import peaksIcon from '../../../assets/app-icons/peaks.png'

/** Built from resources/Eaon.icon and EaonAgent.icon by scripts/make-icon.py; the backgrounds are its VARIANTS. */
const APP_ICONS: { id: AppIcon; label: string; image: string }[] = [
  { id: 'default', label: 'Eaon', image: defaultIcon },
  { id: 'agent', label: 'Agent', image: agentIcon },
  { id: 'light', label: 'Light', image: lightIcon },
  { id: 'ocean', label: 'Ocean', image: oceanIcon },
  { id: 'sunset', label: 'Sunset', image: sunsetIcon },
  { id: 'forest', label: 'Forest', image: forestIcon },
  { id: 'grape', label: 'Grape', image: grapeIcon },
  { id: 'aurora', label: 'Aurora', image: auroraIcon },
  { id: 'peaks', label: 'Peaks', image: peaksIcon }
]

const GROUPS: { id: Theme['group']; label: string }[] = [
  { id: 'neutral', label: 'Neutral' },
  { id: 'coloured', label: 'Coloured' }
]

/**
 * Which appearance the theme previews should be painted in. `system` follows the
 * OS, so the previews show what picking a theme would actually look like right
 * now rather than an arbitrary half.
 */
function useResolvedTone(mode: ThemeMode): 'light' | 'dark' {
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setSystemDark(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode
}

/**
 * Choosing a theme or mode here takes the app back from the ADE's terminal
 * theme, which restyles the app while it is picked: the terminals go back to
 * following the app (`eaon`), so the two never disagree.
 */
function releaseAde(settings: Settings | null): Partial<Settings> {
  if (!settings || settings.ade.theme === 'eaon') return {}
  return { ade: { ...settings.ade, theme: 'eaon', appBefore: null } }
}

export function AppearancePage(): JSX.Element {
  const { settings, patchSettings } = useApp(useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings })))
  const a = settings?.appearance
  const tone = useResolvedTone(a?.mode ?? 'dark')
  if (!settings || !a) return <></>

  return (
    <>
      <h1 className="settings__h1">Appearance</h1>

      <Section label="Theme">
        <div className="theme-grid">
          {(['system', 'light', 'dark'] as ThemeMode[]).map((mode) => (
            <button
              key={mode}
              className="theme-card"
              data-active={a.mode === mode}
              onClick={() => void patchSettings({ appearance: { mode }, ...releaseAde(settings) })}
            >
              <span className="theme-card__preview">
                {mode === 'system' ? (
                  <>
                    <ThemeHalf tone="light" />
                    <ThemeHalf tone="dark" />
                  </>
                ) : (
                  <ThemeHalf tone={mode} />
                )}
              </span>
              <span className="theme-card__label">
                {mode === 'system' ? 'System' : mode === 'light' ? 'Light' : 'Dark'}
              </span>
            </button>
          ))}
        </div>

        <DiffPreview />
      </Section>

      <Section label="Color theme">
        {GROUPS.map((group) => (
          <div key={group.id} className="theme-group">
            <div className="theme-group__label">{group.label}</div>
            <div className="theme-swatch-grid">
              {THEMES.filter((theme) => theme.group === group.id).map((theme) => (
                <button
                  key={theme.name}
                  className="theme-swatch"
                  data-active={a.light.preset === theme.name || undefined}
                  onClick={() => {
                    // textFade belongs to the theme, not the stored palette —
                    // useTheme() looks it up by preset name.
                    const { textFade: _lightFade, ...light } = theme.light
                    const { textFade: _darkFade, ...dark } = theme.dark
                    void patchSettings({
                      appearance: {
                        // Both appearances move together, so switching Light/Dark
                        // never drops you into a different theme.
                        light: { preset: theme.name, ...light },
                        dark: { preset: theme.name, ...dark }
                      },
                      ...releaseAde(settings)
                    })
                  }}
                >
                  <ThemeSwatch palette={theme[tone]} tone={tone} />
                  <span className="theme-swatch__name">{theme.name}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </Section>

      <SeeThroughSection />

      <GlassSection />

      <AdeBackgroundSection />

      <Section label="Preferences">
        <Card>
          <Row
            title="App icon"
            description={
              isMac
                ? 'Shown in the Dock while Eaon is running'
                : "Shown on Eaon's windows and taskbar button"
            }
          />
          <div className="app-icon-picker" role="radiogroup" aria-label="App icon">
            {APP_ICONS.map((icon) => (
              <button
                key={icon.id}
                className="app-icon-choice"
                role="radio"
                aria-checked={a.appIcon === icon.id}
                data-active={a.appIcon === icon.id}
                onClick={() => void patchSettings({ appearance: { appIcon: icon.id } })}
              >
                <img className="app-icon-choice__image" src={icon.image} alt="" width={56} height={56} />
                <span className="app-icon-choice__label">{icon.label}</span>
              </button>
            ))}
          </div>
          <Row title="Use pointer cursors" description="Change the cursor to a pointer when hovering over interactive elements">
            <Switch
              label="Use pointer cursors"
              checked={a.pointerCursors}
              onChange={(on) => void patchSettings({ appearance: { pointerCursors: on } })}
            />
          </Row>
          <Row title="Reduce motion" description="Reduce animations or match your system">
            <Segmented
              value={a.reduceMotion}
              onChange={(reduceMotion) => void patchSettings({ appearance: { reduceMotion } })}
              options={[
                { value: 'system', label: 'System' },
                { value: 'on', label: 'On' },
                { value: 'off', label: 'Off' }
              ]}
            />
          </Row>
          <Row title="UI font size" description="Adjust the base size used for the app UI">
            <span className="stepper">
              <FontSizeInput value={a.fontSize} onChange={(fontSize) => void patchSettings({ appearance: { fontSize } })} />
              px
            </span>
          </Row>
          {/* Weight only: the typeface is always the system's own, the way
              ChatGPT's is — a picker of novelty faces made the app look
              less like a tool and more like a theme demo. */}
          <Row title="Text weight" description="How heavy text looks across the app">
            <Select
              width={116}
              value={a[tone].fontWeight}
              onChange={(fontWeight) =>
                void patchSettings({ appearance: { light: { fontWeight }, dark: { fontWeight } } })
              }
              options={[
                { value: 'Light', label: 'Light' },
                { value: 'Regular', label: 'Regular' },
                { value: 'Medium', label: 'Medium' }
              ]}
            />
          </Row>
          {/* macOS-only: font smoothing is a WebKit switch only macOS
              honours. Elsewhere the switch would do nothing. */}
          {isMac && (
            <Row title="Font smoothing" description="Use native macOS font anti-aliasing">
              <Switch
                label="Font smoothing"
                checked={a.fontSmoothing}
                onChange={(on) => void patchSettings({ appearance: { fontSmoothing: on } })}
              />
            </Row>
          )}
        </Card>
      </Section>
    </>
  )
}

const FONT_MIN = 11
const FONT_MAX = 20

/**
 * Clamping on every keystroke made most sizes impossible to type: "1" became
 * 11 and the "6" after it made 116, so 20. What is typed stays as typed; an
 * in-range value applies at once and anything else is clamped on blur or Enter.
 */
function FontSizeInput({ value, onChange }: { value: number; onChange: (size: number) => void }): JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const size = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(Number(draft)) || value))
    setDraft(String(size))
    if (size !== value) onChange(size)
  }
  return (
    <input
      type="number"
      aria-label="UI font size"
      min={FONT_MIN}
      max={FONT_MAX}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value)
        const size = Number(e.target.value)
        if (Number.isInteger(size) && size >= FONT_MIN && size <= FONT_MAX && size !== value) onChange(size)
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
    />
  )
}

function ThemeHalf({ tone }: { tone: 'light' | 'dark' }): JSX.Element {
  const bg = tone === 'light' ? '#f2f2f3' : '#3a3a3c'
  const bar = tone === 'light' ? '#d9d9dc' : '#5a5a5e'
  const panel = tone === 'light' ? '#ffffff' : '#2a2a2c'
  return (
    <span className="theme-card__half" style={{ background: bg }}>
      <span className="theme-card__bar" style={{ background: bar, width: '62%', alignSelf: 'center' }} />
      <span className="theme-card__bar" style={{ background: bar, width: '44%', alignSelf: 'center' }} />
      <span className="theme-card__panel" style={{ background: panel }}>
        <span className="theme-card__bar" style={{ background: bar, width: '70%' }} />
        <span className="theme-card__bar" style={{ background: bar, width: '90%' }} />
        <span className="theme-card__bar" style={{ background: bar, width: '55%' }} />
      </span>
    </span>
  )
}

function DiffPreview(): JSX.Element {
  const head = (
    <>
      <span className="tok-key">const</span> <span className="tok-name">themePreview</span>
      <span className="tok-punc">: </span>
      <span className="tok-name">ThemeConfig</span> <span className="tok-punc">= {'{'}</span>
    </>
  )

  const side = (surface: string, accent: string, contrast: string, mark: 'del' | 'add'): JSX.Element => {
    const field = (key: string, value: JSX.Element): JSX.Element => (
      <>
        {'  '}
        <span className="tok-key">{key}</span>
        <span className="tok-punc">: </span>
        {value}
        <span className="tok-punc">,</span>
      </>
    )
    const rows: { mark: 'del' | 'add' | null; content: JSX.Element }[] = [
      { mark: null, content: head },
      { mark, content: field('surface', <span className="tok-str">&quot;{surface}&quot;</span>) },
      { mark, content: field('accent', <span className="tok-str">&quot;{accent}&quot;</span>) },
      { mark, content: field('contrast', <span className="tok-num">{contrast}</span>) },
      { mark: null, content: <span className="tok-punc">{'};'}</span> }
    ]
    return (
      <div className="diff-preview__side">
        {rows.map((row, index) => (
          <div key={index} className="diff-preview__line" data-mark={row.mark ?? undefined}>
            <span className="diff-preview__num">{index + 1}</span>
            <span>{row.content}</span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="diff-preview">
      {side('sidebar', '#2563eb', '42', 'del')}
      {side('sidebar-elevated', '#0ea5e9', '68', 'add')}
    </div>
  )
}

/**
 * Miniature of the app painted in a theme's own colours, mixed the way
 * tokens.css mixes the real thing: the page is `--canvas` (22% under the
 * background by night, the background itself by day) and the sidebar panel is
 * `--surface-1`, lifted toward the ink by the theme's own contrast.
 */
function ThemeSwatch({ palette, tone }: { palette: Palette; tone: 'light' | 'dark' }): JSX.Element {
  const tint = (amount: number): string =>
    `color-mix(in srgb, ${palette.background}, ${palette.foreground} ${amount}%)`
  const page = tone === 'dark' ? `color-mix(in srgb, ${palette.background}, #000 22%)` : palette.background
  const side = tint((tone === 'dark' ? 1.6 : 1.5) * 0.055 * palette.contrast)

  return (
    <span className="theme-swatch__preview" style={{ background: page }}>
      <span className="theme-swatch__side" style={{ background: side }}>
        <span className="theme-swatch__dot" style={{ background: palette.accent }} />
        <span className="theme-swatch__bar" style={{ background: tint(34), width: '68%' }} />
        <span className="theme-swatch__bar" style={{ background: tint(22), width: '48%' }} />
      </span>
      <span className="theme-swatch__body">
        <span className="theme-swatch__bar" style={{ background: palette.foreground, width: '76%', opacity: 0.8 }} />
        <span className="theme-swatch__bar" style={{ background: tint(30), width: '92%' }} />
        <span className="theme-swatch__bar" style={{ background: tint(30), width: '60%' }} />
        <span className="theme-swatch__pill" style={{ background: palette.accent }} />
      </span>
    </span>
  )
}

/** What each wallpaper style looks like, under the Style control. */
const STYLE_HINTS: Record<SeeThroughStyle, string> = {
  photo: 'The wallpaper as it is',
  halftone: 'A print-style dot screen made from the wallpaper itself',
  ascii: 'The wallpaper redrawn as ASCII art, in its own colours'
}

/**
 * See-through: a picture behind the app (components/SeeThrough) — the
 * desktop's own wallpaper, or one the user picks. The OS only says which
 * picture the desktop shows on macOS and Windows; anywhere, a chosen picture
 * works.
 */
function SeeThroughSection(): JSX.Element | null {
  const { settings, patchSettings } = useApp(useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings })))
  const see = settings?.appearance.seeThrough
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [choosing, setChoosing] = useState(false)
  const hasCustom = see?.source === 'custom' && Boolean(see.custom)

  // The chosen picture's thumbnail, once, when the page opens on it.
  useEffect(() => {
    if (!hasCustom) return
    let live = true
    void window.api.wallpaper.preview().then((url) => live && setPreview(url))
    return () => {
      live = false
    }
  }, [hasCustom])

  if (!see) return null
  const style = see.style ?? (see.texture ? 'halftone' : 'photo')
  const desktopKnown = window.api.platform === 'darwin' || window.api.platform === 'win32'
  const usable = desktopKnown || hasCustom
  const set = (patch: Partial<typeof see>): void => void patchSettings({ appearance: { seeThrough: { ...see, ...patch } } })

  const choose = async (): Promise<void> => {
    setError(null)
    setChoosing(true)
    try {
      const picked = await window.api.wallpaper.choose()
      if (picked) {
        setPreview(picked.preview)
        set({ source: 'custom', custom: picked.path })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    } finally {
      setChoosing(false)
    }
  }

  return (
    <Section label="Window">
      <Card>
        <Row
          title="See-through"
          description={
            usable
              ? 'Show a wallpaper through the window, with the panels as frosted glass over it'
              : 'Choose a picture below: on Linux the desktop doesn’t say which wallpaper it shows'
          }
        >
          <Switch label="See-through" checked={see.enabled && usable} disabled={!usable} onChange={(enabled) => set({ enabled })} />
        </Row>
        {(see.enabled || !desktopKnown) && (
          <Row title="Wallpaper" description={see.source === 'custom' ? 'A picture of your own, filling the screen' : 'Your desktop’s wallpaper, lined up with the screen'}>
            <Segmented
              value={see.source}
              onChange={(source) => {
                // Custom with nothing chosen yet goes straight to choosing one.
                if (source === 'custom' && !see.custom) void choose()
                else set({ source })
              }}
              options={[
                ...(desktopKnown ? [{ value: 'desktop' as const, label: 'Desktop' }] : []),
                { value: 'custom' as const, label: 'Custom' }
              ]}
            />
          </Row>
        )}
        {see.source === 'custom' && (see.enabled || !desktopKnown) && (
          <Row title="Picture" description={error ?? 'JPEG, PNG, HEIC, WebP and more. Eaon keeps its own copy'}>
            <div className="wallpaper-pick">
              {preview && <img className="wallpaper-pick__thumb" src={preview} alt="Chosen wallpaper" />}
              <button className="btn btn--ghost" disabled={choosing} onClick={() => void choose()}>
                {see.custom ? 'Change…' : 'Choose image…'}
              </button>
            </div>
          </Row>
        )}
        {see.enabled && usable && (
          <>
            <Row title="Tint" description="How much of the theme’s colour lies over the wallpaper. Higher is easier to read">
              <Slider label="Tint" value={see.tint} min={0} max={100} onChange={(tint) => set({ tint })} />
            </Row>
            <Row title="Style" description={STYLE_HINTS[style]}>
              <Segmented
                value={style}
                // `texture` follows along for builds from before `style`.
                onChange={(next) => set({ style: next, texture: next === 'halftone' })}
                options={[
                  { value: 'photo' as const, label: 'Photo' },
                  { value: 'halftone' as const, label: 'Halftone' },
                  { value: 'ascii' as const, label: 'ASCII' }
                ]}
              />
            </Row>
          </>
        )}
      </Card>
    </Section>
  )
}

/** Whether the system asks for less transparency (macOS: Accessibility → Display → Reduce transparency). */
function useReducedTransparency(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-transparency: reduce)').matches)
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-transparency: reduce)')
    const onChange = (): void => setReduced(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/**
 * Frosted glass: how soft the page gets behind what floats over it (menus,
 * popovers, toasts, the see-through panels) and how much of it shows
 * through. The preview is drawn with the same tokens, so it moves with the
 * sliders.
 */
function GlassSection(): JSX.Element | null {
  const { settings, patchSettings } = useApp(useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings })))
  const reduced = useReducedTransparency()
  const tone = useResolvedTone(settings?.appearance.mode ?? 'dark')
  const a = settings?.appearance
  if (!a) return null
  const glass = a.glass ?? GLASS_DEFAULT
  const set = (patch: Partial<Glass>): void => void patchSettings({ appearance: { glass: { ...glass, ...patch } } })
  const changed = glass.blur !== GLASS_DEFAULT.blur || glass.transparency !== GLASS_DEFAULT.transparency
  return (
    <Section label="Glass">
      <Card>
        <GlassPreview />
        <Row title="Blur" description="How soft the page gets behind menus, popovers and frosted panels">
          <Slider label="Blur" value={glass.blur} onChange={(blur) => set({ blur })} />
        </Row>
        <Row
          title="Transparency"
          description={
            reduced
              ? 'Solid while your system’s Reduce transparency is on'
              : glass.blur < GLASS_CLEAR_BLUR
                ? 'With little blur, glass stays nearly solid so the page’s text never shows through sharp'
                : 'How much of the page shows through them. Lower is easier to read'
          }
        >
          <Slider label="Transparency" value={glass.transparency} onChange={(transparency) => set({ transparency })} />
        </Row>
        {/* macOS-only: the window's vibrancy material. Elsewhere the switch would do nothing. */}
        {isMac && (
          <Row title="Translucent sidebar" description="Blur the desktop through the sidebar">
            <Switch
              label="Translucent sidebar"
              checked={a[tone].translucentSidebar}
              onChange={(on) => void patchSettings({ appearance: { light: { translucentSidebar: on }, dark: { translucentSidebar: on } } })}
            />
          </Row>
        )}
        {changed && (
          <Row title="Default glass" description="Blur and transparency as Eaon comes">
            <button className="btn btn--ghost" onClick={() => set(GLASS_DEFAULT)}>
              Reset
            </button>
          </Row>
        )}
      </Card>
    </Section>
  )
}

/** A corner of a page with a project menu open over it, frosted the way the app frosts one. */
function GlassPreview(): JSX.Element {
  return (
    <div className="glass-preview" aria-hidden="true">
      <div className="glass-preview__page">
        <span className="glass-preview__glow" />
        <span className="glass-preview__title">What should we work on?</span>
        <span className="glass-preview__chips">
          <span>Research</span>
          <span>Organize files</span>
          <span>Build an app</span>
        </span>
      </div>
      <div className="glass-preview__menu">
        <span className="glass-preview__search">
          <Search size={12} strokeWidth={2} />
          Search projects
        </span>
        {['Desktop', 'Documents', 'Downloads'].map((name) => (
          <span key={name} className="glass-preview__row">
            <Folder size={13} strokeWidth={1.8} />
            {name}
          </span>
        ))}
      </div>
    </div>
  )
}

/** The ADE's terminal backgrounds: each theme's scene, and how soft it is. */
function AdeBackgroundSection(): JSX.Element | null {
  const { settings, patchSettings } = useApp(useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings })))
  const ade = settings?.ade
  if (!ade) return null
  const set = (patch: Partial<typeof ade>): void => void patchSettings({ ade: { ...ade, ...patch } })
  return (
    <Section label="ADE background">
      <Card>
        <Row title="Scenes" description="Draw each terminal theme’s scene behind the text. Pick a theme from the ADE’s theme button">
          <Switch label="Scenes" checked={ade.scenes} onChange={(scenes) => set({ scenes })} />
        </Row>
        {ade.scenes && (
          <Row title="Blur" description="Soften the scene so it reads as a backdrop and the text stands out">
            <Switch label="Blur" checked={ade.blur} onChange={(blur) => set({ blur })} />
          </Row>
        )}
        {ade.scenes && ade.blur && (
          <Row title="Blur strength" description="How soft the scene gets">
            <Slider label="Blur strength" value={ade.blurAmount} min={2} max={30} onChange={(blurAmount) => set({ blurAmount })} />
          </Row>
        )}
      </Card>
    </Section>
  )
}
