import { create } from 'zustand'
import type { ModInfo, ModManifest, ModNote, ModPanel, ModsList, ModSessionPreset, ModSnippet, ModSoundEvent, ModWidget, ModWorkerTemplate } from '@shared/mods'
import { setModThemes } from '../lib/themes'
import { setModTerminalThemes, type TerminalTheme } from '../components/code/terminal/themes'
import { SCENES } from '../components/code/terminal/scenes'
import { setModLanguages } from '../components/agent/highlight'

/**
 * Installed mods, mirrored from main (features/mods), and the parts of the
 * enabled ones the renderer applies: themes, slash commands, snippets,
 * languages, panels, ADE presets and widgets, sounds and worker templates.
 * One subscription for the whole renderer, opened at startup (App.tsx).
 *
 * `version` changes with every update, for views that read a module-level
 * list (the theme lists) to re-render on.
 */

interface ModsStore {
  list: ModsList | null
  /** Enabled mods' manifests, in install order. */
  enabled: ModManifest[]
  version: number
  ensure: () => void
  apply: (list: ModsList) => void
}

let listening = false

/** A mod's app themes as the app's own theme type. */
function appThemesOf(mods: ModManifest[]): Parameters<typeof setModThemes>[0] {
  return mods.flatMap((m) => (m.contributes.appThemes ?? []).map((t) => ({ name: t.name, group: 'mods' as const, light: t.light, dark: t.dark })))
}

function terminalThemesOf(mods: ModManifest[]): TerminalTheme[] {
  return mods.flatMap((m) =>
    (m.contributes.terminalThemes ?? []).map(
      (t): TerminalTheme => ({
        id: `${m.id}/${t.id}`,
        name: t.name,
        mode: t.mode,
        // A scene this version doesn't draw is left out rather than breaking the panes.
        scene: t.scene && t.scene in SCENES ? (t.scene as TerminalTheme['scene']) : null,
        blurb: t.blurb,
        colors: t.colors,
        app: t.app
      })
    )
  )
}

export const useMods = create<ModsStore>((set, get) => ({
  list: null,
  enabled: [],
  version: 0,
  ensure: () => {
    if (listening) return
    listening = true
    window.api.mods.onChanged((list) => get().apply(list))
    void window.api.mods
      .list()
      .then((list) => get().apply(list))
      .catch((error) => console.error('[mods] could not list mods:', error))
  },
  apply: (list) => {
    const enabled = list.mods.filter((m) => m.installed && m.enabled).map((m) => m.manifest)
    setModThemes(appThemesOf(enabled))
    setModTerminalThemes(terminalThemesOf(enabled))
    setModLanguages(enabled.flatMap((m) => m.contributes.languages ?? []))
    set((s) => ({ list, enabled, version: s.version + 1 }))
  }
}))

export const modInfo = (id: string): ModInfo | undefined => useMods.getState().list?.mods.find((m) => m.manifest.id === id)

/* ------------------------------------------------------------ the parts */

export interface ModPanelRef extends ModPanel {
  modId: string
  modName: string
  /** `<mod id>/<panel id>`, the dock surface's key. */
  key: string
  url: string
}

export function panelsOf(mods: ModManifest[]): ModPanelRef[] {
  return mods.flatMap((m) =>
    (m.contributes.panels ?? []).map((p) => ({ ...p, modId: m.id, modName: m.name, key: `${m.id}/${p.id}`, url: `eaon-mod://${m.id}/${p.entry}` }))
  )
}

export const snippetsOf = (mods: ModManifest[]): ModSnippet[] => mods.flatMap((m) => m.contributes.snippets ?? [])

export const presetsOf = (mods: ModManifest[]): (ModSessionPreset & { modName: string; key: string })[] =>
  mods.flatMap((m) => (m.contributes.sessionPresets ?? []).map((p) => ({ ...p, modName: m.name, key: `${m.id}/${p.id}` })))

export const widgetsOf = (mods: ModManifest[]): (ModWidget & { key: string })[] =>
  mods.flatMap((m) => (m.contributes.widgets ?? []).map((w) => ({ ...w, key: `${m.id}/${w.id}` })))

export const workerTemplatesOf = (mods: ModManifest[]): (ModWorkerTemplate & { key: string; modName: string })[] =>
  mods.flatMap((m) => (m.contributes.workerTemplates ?? []).map((t) => ({ ...t, key: `${m.id}/${t.id}`, modName: m.name })))

/** The notes the enabled mods play for an event; the first mod that has one wins. */
export function soundFor(event: ModSoundEvent): ModNote[] | null {
  for (const mod of useMods.getState().enabled) {
    const notes = mod.contributes.sounds?.[event]
    if (notes?.length) return notes
  }
  return null
}
