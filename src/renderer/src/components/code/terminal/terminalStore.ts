import { create } from 'zustand'
import { useApp } from '../../../state/store'
import { useCode } from '../codeStore'
import { PANE_NAMES, type TerminalAgent, type TerminalAgentId, type TerminalLayout, type TerminalPaneSpec } from '@shared/terminals'
import { terminals } from './registry'
import { swapped } from './gridLayout'
import { previewFor, settingsFor } from './appLook'
import { findTheme } from './themes'
import { reportError } from '../../ErrorBoundary'

/**
 * Which panes each folder has in the ADE's terminal view, saved so the grid
 * comes back the way it was left. The terminals themselves live in the
 * registry (renderer) and the main process (shells).
 */
interface TerminalsState {
  loaded: boolean
  /** Why the saved layout could not be read; the workspace shows it with a retry. */
  loadError: string | null
  layout: TerminalLayout
  agents: TerminalAgent[]
  /** The pane filling the whole grid, if one is maximised. */
  maximized: string | null
  /** The pane being dragged to a new place in the grid. */
  dragging: string | null
  /** The theme picker is open (`/theme` in a pane, or the header's Theme button). */
  pickerOpen: boolean
  /** A theme shown on every pane while the picker is browsing; null shows the saved one. */
  preview: string | null
  /** The pane `/theme` was typed in, which gets the keyboard back when the picker closes. */
  pickerFrom: string | null

  load: () => Promise<void>
  refreshAgents: () => Promise<void>
  /** A new pane in `cwd` running `agent`, on a past conversation of it when `resume` names one. */
  add: (cwd: string, agent: TerminalAgentId, resume?: string, prompt?: string) => TerminalPaneSpec
  close: (cwd: string, paneId: string) => void
  rename: (cwd: string, paneId: string, name: string) => void
  /** What runs in a pane changed under it — its logo and label follow. */
  setAgent: (paneId: string, agent: TerminalAgentId) => void
  toggleMaximized: (paneId: string) => void
  /** Two panes trade places in a folder's grid. */
  swap: (cwd: string, a: string, b: string) => void
  setDragging: (paneId: string | null) => void
  openPicker: (fromPane?: string) => void
  /** Closes the picker; what it was previewing goes back to the saved theme. */
  closePicker: () => void
  setPreview: (themeId: string | null) => void
  /** Saves a theme (and whether scenes are drawn) for every pane. */
  saveLook: (look: { theme?: string; scenes?: boolean }) => void
}

const uid = (): string => `pane-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
let saveTimer: ReturnType<typeof setTimeout> | null = null
let loading: Promise<void> | null = null
let listening = false

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function persist(layout: TerminalLayout): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void window.api.terminals.saveLayout(layout), 300)
}

export const useTerminals = create<TerminalsState>((set, get) => ({
  loaded: false,
  loadError: null,
  layout: {},
  agents: [],
  maximized: null,
  dragging: null,
  pickerOpen: false,
  preview: null,
  pickerFrom: null,

  load() {
    if (get().loaded) return Promise.resolve()
    // Callers wait for the load already on its way rather than adding a pane
    // to a layout that isn't there yet. A failed one is forgotten, so opening
    // the ADE again tries again.
    loading ??= loadLayout().finally(() => {
      loading = null
    })
    return loading
  },

  async refreshAgents() {
    set({ agents: await window.api.terminals.agents() })
  },

  add(cwd, agent, resume, prompt) {
    const panes = get().layout[cwd] ?? []
    // The first name no pane in this folder is using, so "Sarah" means one pane.
    const taken = new Set(panes.map((p) => p.name))
    const name = PANE_NAMES.find((n) => !taken.has(n)) ?? `Terminal ${panes.length + 1}`
    const pane: TerminalPaneSpec = { id: uid(), name, agent, ...(resume ? { resume } : {}), ...(prompt ? { prompt } : {}) }
    const layout = { ...get().layout, [cwd]: [...panes, pane] }
    set({ layout, maximized: null })
    persist(layout)
    return pane
  },

  close(cwd, paneId) {
    terminals.dispose(paneId)
    const layout = { ...get().layout, [cwd]: (get().layout[cwd] ?? []).filter((p) => p.id !== paneId) }
    set((s) => ({ layout, maximized: s.maximized === paneId ? null : s.maximized }))
    persist(layout)
  },

  rename(cwd, paneId, name) {
    const layout = { ...get().layout, [cwd]: (get().layout[cwd] ?? []).map((p) => (p.id === paneId ? { ...p, name } : p)) }
    set({ layout })
    persist(layout)
  },

  setAgent(paneId, agent) {
    const layout = get().layout
    for (const [cwd, panes] of Object.entries(layout)) {
      const pane = panes.find((p) => p.id === paneId)
      if (!pane) continue
      if (pane.agent === agent) return
      const next = { ...layout, [cwd]: panes.map((p) => (p.id === paneId ? { ...p, agent } : p)) }
      set({ layout: next })
      persist(next)
      return
    }
  },

  toggleMaximized(paneId) {
    set((s) => ({ maximized: s.maximized === paneId ? null : paneId }))
  },

  swap(cwd, a, b) {
    const panes = get().layout[cwd] ?? []
    const next = swapped(panes, a, b)
    if (next === panes) return
    const layout = { ...get().layout, [cwd]: next }
    set({ layout })
    persist(layout)
  },

  setDragging(paneId) {
    set({ dragging: paneId })
  },

  openPicker(fromPane) {
    set({ pickerOpen: true, preview: null, pickerFrom: fromPane ?? null })
  },

  closePicker() {
    const from = get().pickerFrom
    set({ pickerOpen: false, preview: null, pickerFrom: null })
    useApp.getState().setAppearancePreview(null)
    if (from) requestAnimationFrame(() => terminals.focus(from))
  },

  setPreview(themeId) {
    set({ preview: themeId })
    // The app follows along (appLook.ts): its colours, not the scene.
    const settings = useApp.getState().settings
    useApp.getState().setAppearancePreview(themeId && settings ? previewFor(findTheme(themeId), settings) : null)
  },

  saveLook(look) {
    const app = useApp.getState()
    const settings = app.settings
    if (!settings) return
    if (look.theme !== undefined) {
      // A theme restyles the app too; `eaon` gives it back its own look.
      void app.patchSettings(settingsFor(findTheme(look.theme), settings)).then(() => app.setAppearancePreview(null))
    }
    if (look.scenes !== undefined) void app.patchSettings({ ade: { ...useApp.getState().settings!.ade, scenes: look.scenes } })
  }
}))

/**
 * "New terminal" from the sidebar (or ⌘N-style entry points): a shell in the
 * ADE's folder — asking for a folder first when none is open — shown in view.
 */
export async function openNewTerminal(agent: TerminalAgentId = 'shell'): Promise<void> {
  const code = useCode.getState()
  await code.init()
  if (!useCode.getState().cwd) await code.chooseFolder()
  const cwd = useCode.getState().cwd
  if (!cwd) return
  await useTerminals.getState().load()
  // A pane added to a layout that didn't load would be saved over the real one.
  if (useTerminals.getState().loaded) useTerminals.getState().add(cwd, agent)
  if (useApp.getState().view !== 'chat') useApp.getState().setView('chat')
}

async function loadLayout(): Promise<void> {
  const { setState: set, getState: get } = useTerminals
  try {
    // Main reads what each pane is running off the process table: quit Codex
    // and type `opencode`, and the pane stops calling itself Codex. Bound once,
    // whatever happens to the rest of the load.
    if (!listening) {
      listening = true
      window.api.terminals.onAgent(({ paneId, agent }) => get().setAgent(paneId, agent))
      // A shell running a full-screen program keeps a typed `/theme` (registry.ts).
      terminals.setAgentLookup((paneId) => {
        for (const panes of Object.values(get().layout)) {
          const pane = panes.find((p) => p.id === paneId)
          if (pane) return pane.agent
        }
        return undefined
      })
      // `/theme` typed in any pane.
      terminals.onCommand((_command, paneId) => get().openPicker(paneId))
    }
    const [layout, agents, running] = await Promise.all([
      window.api.terminals.layout(),
      window.api.terminals.agents(),
      window.api.terminals.running().catch(() => ({}) as Record<string, TerminalAgentId>)
    ])
    set({ layout: layout ?? {}, agents, loaded: true, loadError: null })
    for (const [paneId, agent] of Object.entries(running)) get().setAgent(paneId, agent)
  } catch (error) {
    reportError({ message: errorText(error), stack: error instanceof Error ? error.stack : undefined, source: 'terminals' })
    set({ loadError: errorText(error) })
  }
}

/** Switches to the ADE and opens `agent` in a new pane — e.g. Claude Code, from the Anthropic provider's page. */
export async function openInAde(agent: TerminalAgentId): Promise<void> {
  const app = useApp.getState()
  const ade = app.workspaces.find((w) => w.kind === 'code')
  if (ade && ade.id !== app.settings?.activeWorkspaceId) app.setWorkspace(ade.id)
  await openNewTerminal(agent)
  if (useApp.getState().view !== 'chat') useApp.getState().setView('chat')
}
