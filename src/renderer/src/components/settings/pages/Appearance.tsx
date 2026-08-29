import { useEffect, useState } from 'react'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Segmented, Select, Switch } from '../../ui'
import type { ThemeMode, ThemePalette } from '@shared/types'

/** A palette pair — one theme, rendered for either appearance. */
type Palette = Pick<ThemePalette, 'accent' | 'background' | 'foreground' | 'contrast'>

interface Theme {
  name: string
  light: Palette
  dark: Palette
}

/**
 * Every surface, border and text tone in the app is mixed from `--bg`, `--fg`
 * and `--contrast` (see tokens.css), so a theme only has to supply those four
 * values per appearance to restyle the whole interface.
 */
const THEMES: Theme[] = [
  {
    name: 'Codex',
    light: { accent: '#0A84FF', background: '#FFFFFF', foreground: '#1A1C1F', contrast: 45 },
    dark: { accent: '#0A84FF', background: '#111111', foreground: '#FCFCFC', contrast: 60 }
  },
  {
    name: 'Graphite',
    light: { accent: '#5A6472', background: '#F7F7F8', foreground: '#16181D', contrast: 38 },
    dark: { accent: '#8A93A0', background: '#0E0E10', foreground: '#F2F2F4', contrast: 52 }
  },
  {
    name: 'Nord',
    light: { accent: '#4C7FA8', background: '#F6F8FA', foreground: '#16202A', contrast: 40 },
    dark: { accent: '#7FB3D5', background: '#0D1117', foreground: '#E8EFF5', contrast: 56 }
  },
  {
    name: 'Indigo',
    light: { accent: '#6355FF', background: '#FCFBFF', foreground: '#1A1830', contrast: 42 },
    dark: { accent: '#8B7DFF', background: '#100F1A', foreground: '#EFEDFA', contrast: 58 }
  },
  {
    name: 'Moss',
    light: { accent: '#2F9E68', background: '#FBFDFB', foreground: '#16201A', contrast: 40 },
    dark: { accent: '#3FBF7F', background: '#0F1411', foreground: '#EEF6F1', contrast: 58 }
  },
  {
    name: 'Ember',
    light: { accent: '#E4572E', background: '#FFFDFB', foreground: '#221A16', contrast: 42 },
    dark: { accent: '#FF6B3D', background: '#141010', foreground: '#F8F1EC', contrast: 64 }
  },
  {
    name: 'Rose',
    light: { accent: '#E0407A', background: '#FFFBFC', foreground: '#241419', contrast: 42 },
    dark: { accent: '#FF6B9A', background: '#150F12', foreground: '#F9EDF1', contrast: 60 }
  },
  {
    name: 'Sand',
    light: { accent: '#A97142', background: '#FBF7F0', foreground: '#22190F', contrast: 40 },
    dark: { accent: '#D9A066', background: '#14110C', foreground: '#F5EEE2', contrast: 56 }
  }
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
  const { settings, patchSettings } = useApp()
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
        <div className="theme-swatch-grid">
          {THEMES.map((theme) => (
            <button
              key={theme.name}
              className="theme-swatch"
              data-active={a.light.preset === theme.name || undefined}
              onClick={() =>
                void patchSettings({
                  appearance: {
                    // Both appearances move together, so switching Light/Dark
                    // never drops you into a different theme.
                    light: { preset: theme.name, ...theme.light },
                    dark: { preset: theme.name, ...theme.dark }
                  }
                })
              }
            >
              <ThemeSwatch palette={theme[tone]} />
              <span className="theme-swatch__name">{theme.name}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section label="Preferences">
        <Card>
          <Row title="Use pointer cursors" description="Change the cursor to a pointer when hovering over interactive elements">
            <Switch
              label="Use pointer cursors"
              checked={a.pointerCursors}
              onChange={(on) => void patchSettings({ appearance: { pointerCursors: on } })}
            />
          </Row>
          <Row title="Dock icon" description="Choose the icon the app will use in the dock">
            <div className="dock-choice">
              {(['mono', 'color'] as const).map((choice) => (
                <button
                  key={choice}
                  className="dock-choice__item"
                  data-active={a.dockIcon === choice}
                  onClick={() => void patchSettings({ appearance: { dockIcon: choice } })}
                  aria-label={choice === 'mono' ? 'Monochrome icon' : 'Colour icon'}
                >
                  <DockGlyph variant={choice} />
                </button>
              ))}
            </div>
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
              <input
                type="number"
                min={11}
                max={20}
                value={a.fontSize}
                onChange={(e) =>
                  void patchSettings({
                    appearance: { fontSize: Math.min(20, Math.max(11, Number(e.target.value) || 14)) }
                  })
                }
              />
              px
            </span>
          </Row>
          <Row title="UI font" description="Typeface and weight used across the app">
            <Select
              width={150}
              value={a[tone].fontFamily}
              onChange={(fontFamily) =>
                void patchSettings({ appearance: { light: { fontFamily }, dark: { fontFamily } } })
              }
              options={[
                { value: 'System default', label: 'System default' },
                { value: 'Inter', label: 'Inter' },
                { value: 'SF Mono', label: 'SF Mono' },
                { value: 'Georgia', label: 'Georgia' }
              ]}
            />
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


function DockGlyph({ variant }: { variant: 'mono' | 'color' }): JSX.Element {
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
      <defs>
        <linearGradient id={`dock-${variant}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7c8cff" />
          <stop offset="100%" stopColor="#b06cf5" />
        </linearGradient>
      </defs>
      <rect width="44" height="44" fill={variant === 'mono' ? '#0d0d0d' : `url(#dock-${variant})`} />
      {variant === 'mono' ? (
        <path
          d="M22 10c6.6 0 12 5.4 12 12s-5.4 12-12 12-12-5.4-12-12 5.4-12 12-12zm0 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 3.4a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2z"
          fill="#fff"
        />
      ) : (
        <>
          <circle cx="22" cy="22" r="9.5" fill="rgba(255,255,255,0.9)" />
          <circle cx="22" cy="22" r="4.6" fill="rgba(124,140,255,0.95)" />
        </>
      )}
    </svg>
  )
}

/** Miniature of the app painted in a theme's own colours. */
function ThemeSwatch({ palette }: { palette: Palette }): JSX.Element {
  const tint = (amount: number): string =>
    `color-mix(in srgb, ${palette.background}, ${palette.foreground} ${amount}%)`

  return (
    <span className="theme-swatch__preview" style={{ background: palette.background }}>
      <span className="theme-swatch__side" style={{ background: tint(7) }}>
        <span className="theme-swatch__dot" style={{ background: palette.accent }} />
        <span className="theme-swatch__bar" style={{ background: tint(24), width: '68%' }} />
        <span className="theme-swatch__bar" style={{ background: tint(16), width: '48%' }} />
      </span>
      <span className="theme-swatch__body">
        <span className="theme-swatch__bar" style={{ background: tint(30), width: '76%' }} />
        <span className="theme-swatch__bar" style={{ background: tint(18), width: '92%' }} />
        <span className="theme-swatch__bar" style={{ background: tint(18), width: '60%' }} />
        <span className="theme-swatch__pill" style={{ background: palette.accent }} />
      </span>
    </span>
  )
}
