import type { Settings, ThemePalette } from '@shared/types'
import { THEMES, type ThemeTone } from '../../../lib/themes'
import type { AppearancePreview } from '../../../state/store'
import type { TerminalTheme } from './themes'

/**
 * The whole app follows the ADE's terminal theme: its colours, in the
 * theme's own mode (a light terminal theme turns the app light). Not its
 * scene — the pictures stay behind the terminal text.
 *
 * A theme maps to one of the app's own themes (lib/themes.ts), whose colours
 * are tuned for the app's surfaces and held to WCAG AA by test/themes.test.ts.
 */

type Appearance = Settings['appearance']
type Snapshot = NonNullable<Settings['ade']['appBefore']>

/** An app theme's tone as the palette settings store, keeping what isn't a colour (weight, translucency). */
function palette(name: string, tone: ThemeTone, current: ThemePalette): ThemePalette {
  const { textFade: _fade, ...colours } = tone
  return { ...current, preset: name, ...colours }
}

/** The appearance a terminal theme gives the app, or null when it leaves the app alone (`eaon`). */
export function appearanceFor(theme: TerminalTheme, current: Appearance): Snapshot | null {
  const app = theme.app ? THEMES.find((t) => t.name === theme.app) : undefined
  if (!app) return null
  return { mode: theme.mode, light: palette(app.name, app.light, current.light), dark: palette(app.name, app.dark, current.dark) }
}

/** What the app shows while the picker sits on `theme`: its appearance, or for `eaon` the app's own again. */
export function previewFor(theme: TerminalTheme, settings: Settings): AppearancePreview | null {
  return appearanceFor(theme, settings.appearance) ?? settings.ade.appBefore ?? null
}

/**
 * The settings to save for picking `theme`. The app's own appearance is kept
 * the first time a terminal theme takes over, and put back when `eaon` is
 * picked again.
 */
export function settingsFor(theme: TerminalTheme, settings: Settings): Partial<Settings> {
  const next = appearanceFor(theme, settings.appearance)
  const before = settings.ade.appBefore
  if (next) {
    const snapshot: Snapshot = before ?? { mode: settings.appearance.mode, light: settings.appearance.light, dark: settings.appearance.dark }
    return { ade: { ...settings.ade, theme: theme.id, appBefore: snapshot }, appearance: { ...settings.appearance, ...next } }
  }
  if (before) return { ade: { ...settings.ade, theme: theme.id, appBefore: null }, appearance: { ...settings.appearance, ...before } }
  return { ade: { ...settings.ade, theme: theme.id } }
}
