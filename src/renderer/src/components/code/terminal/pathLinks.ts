import { isRemote } from '@shared/adeRemote'
import { preferredTarget, useChatCode } from '../../chatCode/chatCodeStore'
import { useAdeDock } from '../../ide/adeDock'
import { openInCode } from '../../ide/ideStore'
import { notify } from '../../Notice'
import type { PathLinks } from './registry'
import { useTerminals } from './terminalStore'

/**
 * File paths in a terminal's output as links, the way Chat opens a path in a
 * reply (ChatView `fileLinks`): a click opens the file at its line in the
 * editor beside the terminals (the ADE's dock); ⌘-click (Ctrl) opens it in the
 * editor Chat's Open button uses, when there is one.
 */

/** How long what main said about a path (is it a file) is believed: long enough that moving the mouse over a line isn't a round trip each time, short enough that a file an agent just wrote gets its link. */
const KNOWN_FOR_MS = 4000
const known = new Map<string, { at: number; file: string | null }>()

/** The folder of the session a pane belongs to, when that is on this computer. */
function folderOf(paneId: string): string | null {
  for (const [cwd, panes] of Object.entries(useTerminals.getState().layout)) {
    if (panes.some((p) => p.id === paneId)) return isRemote(cwd) ? null : cwd
  }
  return null
}

async function resolve(folder: string, refs: string[]): Promise<(string | null)[]> {
  const now = Date.now()
  const asked = refs.filter((ref) => {
    const hit = known.get(`${folder}\0${ref}`)
    return !hit || now - hit.at > KNOWN_FOR_MS
  })
  if (asked.length > 0) {
    const files = await window.api.adeTools.existingFiles(folder, asked).catch(() => asked.map(() => null))
    asked.forEach((ref, i) => known.set(`${folder}\0${ref}`, { at: now, file: files[i] ?? null }))
    // A long session prints thousands of paths; the memory is for the ones just looked at.
    if (known.size > 500) for (const key of [...known.keys()].slice(0, 250)) known.delete(key)
  }
  return refs.map((ref) => known.get(`${folder}\0${ref}`)?.file ?? null)
}

async function open(file: string, line: number | null, external: boolean, paneId: string): Promise<void> {
  const folder = folderOf(paneId)
  if (external && folder) {
    const code = useChatCode.getState()
    if (!code.targets) await code.loadTargets()
    const now = useChatCode.getState()
    const target = preferredTarget(now.targets, now.preferred)
    if (target && target.kind === 'editor') {
      try {
        await window.api.chatCode.openIn(folder, target.id, file, line)
        return
      } catch {
        /* the editor wouldn't open it: it opens beside the terminals instead */
      }
    }
  }
  try {
    await openInCode(file, line ?? undefined, useAdeDock)
  } catch (error) {
    notify(`Couldn’t open ${file}: ${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

export const adePathLinks: PathLinks = {
  folderOf,
  resolve,
  open: (file, line, external, paneId) => void open(file, line, external, paneId)
}
