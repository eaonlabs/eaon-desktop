import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Segmented, Select, Switch } from '../../ui'
import type { AppIcon, ThemeMode } from '@shared/types'
import { THEMES, type Palette, type Theme } from '../../../lib/themes'
import defaultIcon from '../../../assets/app-icons/default.png'
import agentIcon from '../../../assets/app-icons/agent.png'

/** Built from resources/Eaon.icon and EaonAgent.icon by scripts/make-icon.py. */
const APP_ICONS: { id: AppIcon; label: string; image: string }[] = [
  { id: 'default', label: 'Eaon', image: defaultIcon },
  { id: 'agent', label: 'Agent', image: agentIcon }
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
              onClick={() => void patchSettings({ appearance: { mode } })}
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
                      }
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

      <Section label="Preferences">
        <Card>
          <Row
            title="App icon"
            description={
              window.api.platform === 'darwin'
                ? 'Shown in the Dock while Eaon is running'
                : "Shown on Eaon's windows and taskbar button"
            }
          >
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
          </Row>
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
          <Row title="Translucent sidebar" description="Blur the desktop through the sidebar">
            <Switch
              label="Translucent sidebar"
              checked={a[tone].translucentSidebar}
              onChange={(on) =>
                void patchSettings({
                  appearance: { light: { translucentSidebar: on }, dark: { translucentSidebar: on } }
                })
              }
            />
          </Row>
          <Row title="Font smoothing" description="Use native macOS font anti-aliasing">
            <Switch
              label="Font smoothing"
              checked={a.fontSmoothing}
              onChange={(on) => void patchSettings({ appearance: { fontSmoothing: on } })}
            />
          </Row>
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
