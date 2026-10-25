import { createContext, useContext, useMemo, type JSX, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ChatGitStatus } from '@shared/chatCode'
import { useApp } from '../../state/store'
import { notify } from '../Notice'
import { useChatCode } from '../chatCode/chatCodeStore'
import { useIde, type DockStore } from './ideStore'

/**
 * Where a dock is: beside a Chat conversation, or beside the ADE's
 * terminals. The surfaces read what differs from here: the dock's own
 * tabs and files, the browser's pages, the folder and where it stands in
 * git, and where a line or a comment goes for the agent to read (Chat's
 * message box, or the ADE's agent terminal).
 */
export interface DockPlace {
  id: 'chat' | 'ade'
  store: DockStore
  /** The in-app browser's scope the dock's pages are in. */
  browser: string
  /** The folder the agent works in, and where it stands in git. */
  folder: string | null
  status: ChatGitStatus | null
  refreshStatus: () => void
  /** Why the folder's files, diff and pull request can't open (no folder yet, or a session on another computer); undefined when they can. */
  missing?: string
  /** Whether it is beside coding work: the ADE, or a chat in a project. Beside an ordinary chat it has only the browser and the device. */
  coding: boolean
  /** The folder's files, relative, for finding one by name; null until read. */
  files: string[] | null
  loadFiles: () => void
  /** What the user writes to the agent in, for buttons: "Add to message". */
  prompt: string
  /** Puts `text` where the user writes to the agent, without sending it, and says so naming `what`. */
  addToPrompt: (text: string, what: string) => void
}

const Place = createContext<DockPlace | null>(null)

export function DockPlaceProvider({ place, children }: { place: DockPlace; children: ReactNode }): JSX.Element {
  return <Place.Provider value={place}>{children}</Place.Provider>
}

export function useDockPlace(): DockPlace {
  const place = useContext(Place)
  if (!place) throw new Error('A dock surface was drawn outside a dock.')
  return place
}

/** Chat's dock: the folder of the chat's project, its browser pages, and the message box. */
export function useChatPlace(): DockPlace {
  const { folder, status, files, refresh, loadFiles } = useChatCode(
    useShallow((s) => ({ folder: s.folder, status: s.status, files: s.files, refresh: s.refresh, loadFiles: s.loadFiles }))
  )
  return useMemo(
    () => ({
      id: 'chat',
      store: useIde,
      browser: 'chat',
      folder,
      status,
      refreshStatus: () => void refresh(),
      missing: folder ? undefined : 'Pick a folder for this chat first',
      coding: folder !== null,
      files,
      loadFiles,
      prompt: 'message',
      addToPrompt: (text, what) => {
        useApp.getState().appendToComposer({ text, attachments: [] })
        notify(`Added ${what} to your message`)
      }
    }),
    [folder, status, files, refresh, loadFiles]
  )
}
