import { ipcRenderer } from 'electron'
import type { CaptureChoices, LibraryFileStat, ScreenshotAttached } from '@shared/library'

/** Renderer bridge for the Library page. Exposed as `window.api.library`. */
export const libraryApi = {
  /** Whether each path still exists, with its size — for the Library grid. */
  stat: (paths: string[]): Promise<LibraryFileStat[]> => ipcRenderer.invoke('library:stat', paths),
  /** Opens with the default app; anything runnable is revealed in Finder instead. */
  open: (path: string): Promise<void> => ipcRenderer.invoke('library:open', path),
  reveal: (path: string): Promise<void> => ipcRenderer.invoke('library:reveal', path),
  /** The screens and windows the screenshot button can attach, with previews; or why not (Screen Recording off). */
  captureChoices: (): Promise<CaptureChoices> => ipcRenderer.invoke('library:capture-choices'),
  /** Captures one of them now and saves it as an attachment. */
  captureAttach: (id: string): Promise<ScreenshotAttached> => ipcRenderer.invoke('library:capture-attach', id)
}
