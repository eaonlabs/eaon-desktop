import type { OpenTarget } from '@shared/chatCode'

/**
 * The editors to offer for opening a folder, in order: the one used last
 * first (when it is an editor: the remembered target can be a terminal app or
 * the file manager), then the others found on this computer.
 */
export function orderedEditors(targets: OpenTarget[] | null, preferredId: string | null): OpenTarget[] {
  const editors = (targets ?? []).filter((t) => t.kind === 'editor')
  const first = editors.find((t) => t.id === preferredId)
  return first ? [first, ...editors.filter((t) => t.id !== first.id)] : editors
}
