import { useEffect, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { OpenTarget } from '@shared/chatCode'
import { isRemote } from '@shared/adeRemote'
import { orderedEditors } from '@shared/openTargets'
import { useChatCode } from '../chatCode/chatCodeStore'
import { TargetIcon } from '../chatCode/CodeTools'
import { notify } from '../Notice'

/**
 * A session's folder in an editor outside Eaon (Cursor, VS Code, Zed…), the
 * same way Chat's Open button does it: the editors found on this computer
 * (chatCode.openTargets), and the one last used remembered for next time.
 */

/** Opens `folder` in `target`, and remembers it as the editor to offer first. */
export function openFolderIn(folder: string, target: OpenTarget): void {
  useChatCode.getState().setPreferred(target.id)
  window.api.chatCode
    .openIn(folder, target.id)
    .catch((e: unknown) => notify(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(e), 'error'))
}

/**
 * Menu items for opening `folder` in an editor: the one used last first, then
 * the others found. None for a folder on another machine, which has nothing
 * here to open. The editors are looked for once the menu is asked for
 * (`wanted`), not at startup.
 */
export function useEditorMenuItems(folder: string, wanted: boolean): { icon: JSX.Element; label: string; action: () => void }[] {
  const { targets, preferred, loadTargets } = useChatCode(useShallow((s) => ({ targets: s.targets, preferred: s.preferred, loadTargets: s.loadTargets })))
  useEffect(() => {
    if (wanted) void loadTargets()
  }, [wanted, loadTargets])
  if (isRemote(folder)) return []
  return orderedEditors(targets, preferred).map((target) => ({ icon: <TargetIcon target={target} size={15} />, label: `Open in ${target.label}`, action: () => openFolderIn(folder, target) }))
}
