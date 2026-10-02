import { create } from 'zustand'
import { useApp } from '../../../state/store'
import { useCode } from '../codeStore'
import { PANE_NAMES, type TerminalAgent, type TerminalAgentId, type TerminalLayout, type TerminalPaneSpec } from '@shared/terminals'
import { terminals } from './registry'

/**
 * Which panes each folder has in the ADE's terminal view, saved so the grid
 * comes back the way it was left. The terminals themselves live in the
 * registry (renderer) and the main process (shells).
 */
interface TerminalsState {
  loaded: boolean
  layout: TerminalLayout
  agents: TerminalAgent[]
  /** The pane filling the whole grid, if one is maximised. */
  maximized: string | null

  load: () => Promise<void>
  refreshAgents: () => Promise<void>
  add: (cwd: string, agent: TerminalAgentId) => TerminalPaneSpec
  close: (cwd: string, paneId: string) => void
  rename: (cwd: string, paneId: string, name: string) => void
  /** What runs in a pane changed under it — its logo and label follow. */
  setAgent: (paneId: string, agent: TerminalAgentId) => void
  toggleMaximized: (paneId: string) => void
}

const uid = (): string => `pane-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
let saveTimer: ReturnType<typeof setTimeout> | null = null
let loading = false

function persist(layout: TerminalLayout): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void window.api.terminals.saveLayout(layout), 300)
}

export const useTerminals = create<TerminalsState>((set, get) => ({
  loaded: false,
  layout: {},
  agents: [],
  maximized: null,

  async load() {
    if (get().loaded || loading) return
    loading = true
    // Main reads what each pane is running off the process table: quit Codex
    // and type `opencode`, and the pane stops calling itself Codex.
    window.api.terminals.onAgent(({ paneId, agent }) => get().setAgent(paneId, agent))
    const [layout, agents, running] = await Promise.all([
      window.api.terminals.layout(),
      window.api.terminals.agents(),
      window.api.terminals.running().catch(() => ({}) as Record<string, TerminalAgentId>)
    ])
    set({ layout: layout ?? {}, agents, loaded: true })
    for (const [paneId, agent] of Object.entries(running)) get().setAgent(paneId, agent)
  },

  async refreshAgents() {
    set({ agents: await window.api.terminals.agents() })
  },

  add(cwd, agent) {
    const panes = get().layout[cwd] ?? []
    // The first name no pane in this folder is using, so "Sarah" means one pane.
    const taken = new Set(panes.map((p) => p.name))
    const name = PANE_NAMES.find((n) => !taken.has(n)) ?? `Terminal ${panes.length + 1}`
    const pane: TerminalPaneSpec = { id: uid(), name, agent }
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
  useTerminals.getState().add(cwd, agent)
  if (useApp.getState().view !== 'chat') useApp.getState().setView('chat')
}

/** Switches to the ADE and opens `agent` in a new pane — e.g. Claude Code, from the Anthropic provider's page. */
export async function openInAde(agent: TerminalAgentId): Promise<void> {
  const app = useApp.getState()
  const ade = app.workspaces.find((w) => w.kind === 'code')
  if (ade && ade.id !== app.settings?.activeWorkspaceId) app.setWorkspace(ade.id)
  await openNewTerminal(agent)
  if (useApp.getState().view !== 'chat') useApp.getState().setView('chat')
}
