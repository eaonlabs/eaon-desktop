import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { ChatGitStatus } from '@shared/chatCode'
import { isRemote } from '@shared/adeRemote'
import { notify } from '../Notice'
import { useCode } from '../code/codeStore'
import { terminals } from '../code/terminal/registry'
import { useTerminals } from '../code/terminal/terminalStore'
import type { DockPlace } from './dockPlace'
import { createDock } from './ideStore'
import { linkedPullsInText, type LinkedPull } from './surfaces/linkedPulls'

/**
 * The ADE's dock, beside its terminals: Chat's surfaces but the terminal,
 * which the ADE has its own of, on the open session's folder. A line or a
 * comment goes to the session's agent, typed at its prompt and not sent.
 */

/** The session's folder when it is on this computer; one over SSH has nothing here to show. */
const localFolder = (cwd: string | null): string | null => (cwd && !isRemote(cwd) ? cwd : null)

export const useAdeDock = createDock({
  surfacesKey: 'eaon.adeDock.surfaces',
  widthKey: 'eaon.adeDock.width',
  root: async () => localFolder(useCode.getState().cwd)
})

interface AdeCodeState {
  folder: string | null
  status: ChatGitStatus | null
  files: string[] | null
  /** Follows the session's folder; reads it again when it moved. */
  sync: (folder: string | null) => void
  refresh: () => Promise<void>
  loadFiles: () => void
}

/** The file list is read again after this long: agents add files. */
const FILES_FRESH_MS = 20_000
let filesAt = 0
let filesLoading = false

/** Where the ADE's folder stands in git, and its files for finding one by name. */
const useAdeCode = create<AdeCodeState>((set, get) => ({
  folder: null,
  status: null,
  files: null,

  sync(folder) {
    if (folder === get().folder) return
    filesAt = 0
    set({ folder, status: null, files: null })
    void get().refresh()
  },

  async refresh() {
    const folder = get().folder
    if (!folder) return
    try {
      const status = await window.api.chatCode.status(folder)
      if (get().folder === folder) set({ status })
    } catch {
      if (get().folder === folder) set({ status: null })
    }
  },

  loadFiles() {
    const folder = get().folder
    if (!folder || filesLoading || Date.now() - filesAt < FILES_FRESH_MS) return
    filesLoading = true
    filesAt = Date.now()
    window.api.chatCode
      .files(folder)
      .then((files) => get().folder === folder && set({ files }))
      .catch(() => get().folder === folder && set({ files: [] }))
      .finally(() => (filesLoading = false))
  }
}))

/** How often git is asked again while the dock is open: agents commit and switch branches in the terminals. */
const STATUS_EVERY_MS = 5000

/** The session's agent to give a line or a comment to: the one last typed in, else its first. Never a plain shell. */
function agentPane(cwd: string): { id: string; name: string } | null {
  const agents = (useTerminals.getState().layout[cwd] ?? []).filter((p) => p.agent !== 'shell')
  const last = terminals.lastFocused()
  return agents.find((p) => p.id === last) ?? agents[0] ?? null
}

/** The ADE's dock, on the open session. */
export function useAdePlace(): DockPlace {
  const cwd = useCode((s) => s.cwd)
  const folder = localFolder(cwd)
  const { status, files } = useAdeCode(useShallow((s) => ({ status: s.status, files: s.files })))

  // Another session: its folder, its tree and its git.
  useEffect(() => {
    useAdeCode.getState().sync(folder)
    void useAdeDock.getState().syncRoot()
  }, [folder])

  useEffect(() => {
    if (!folder) return
    const ask = (): void => {
      if (document.visibilityState === 'visible') void useAdeCode.getState().refresh()
    }
    const timer = window.setInterval(ask, STATUS_EVERY_MS)
    window.addEventListener('focus', ask)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', ask)
    }
  }, [folder])

  return useMemo(
    () => ({
      id: 'ade',
      store: useAdeDock,
      browser: cwd ? `code:${cwd}` : 'chat',
      folder,
      status,
      refreshStatus: () => void useAdeCode.getState().refresh(),
      missing: !cwd ? 'Open a project first' : !folder ? 'This session is on another computer' : undefined,
      coding: true,
      files,
      loadFiles: () => useAdeCode.getState().loadFiles(),
      prompt: 'agent',
      addToPrompt: (text, what) => {
        const pane = cwd ? agentPane(cwd) : null
        if (!pane) return notify('Start an agent in this session first.', 'error')
        if (!terminals.paste(pane.id, text)) return notify(`${pane.name} isn’t running.`, 'error')
        notify(`Added ${what} to ${pane.name}`)
      }
    }),
    [cwd, folder, status, files]
  )
}

/** How often the terminals are read again for pull request links while something shows them. */
const PULLS_EVERY_MS = 5000

/** Pull requests the session's terminals show links to, newest first. */
export function useTerminalPulls(cwd: string | null): LinkedPull[] {
  const [pulls, setPulls] = useState<LinkedPull[]>([])
  useEffect(() => {
    if (!cwd) return setPulls([])
    const read = (): void => {
      const panes = useTerminals.getState().layout[cwd] ?? []
      const next = linkedPullsInText(panes.map((p) => terminals.screenText(p.id, 3000)))
      setPulls((now) => (now.length === next.length && now.every((p, i) => p.url === next[i].url) ? now : next))
    }
    read()
    const timer = window.setInterval(read, PULLS_EVERY_MS)
    return () => window.clearInterval(timer)
  }, [cwd])
  return pulls
}
