import { ipcRenderer } from 'electron'
import type { WallpaperFrame } from '@shared/types'

/** See-through windows: the desktop's picture and where this window sits over it. Exposed as `window.api.wallpaper`. */
export const wallpaperApi = {
  /** Starts (or stops) hearing this window's position; starting resolves to where it is now. */
  watch: (on: boolean): Promise<WallpaperFrame | null> => ipcRenderer.invoke('wallpaper:watch', on),
  /** The picture on a display, as a data URL, or null when the OS won't say. */
  picture: (displayId: number): Promise<string | null> => ipcRenderer.invoke('wallpaper:picture', displayId),
  /** Asks for a picture or video of the user's own; resolves to Eaon's copy of it and a picture's preview, or null if none was picked. */
  choose: (): Promise<{ path: string; preview: string | null } | null> => ipcRenderer.invoke('wallpaper:choose'),
  /** A thumbnail of the chosen picture, for Settings (null for a video, which Settings plays). */
  preview: (): Promise<string | null> => ipcRenderer.invoke('wallpaper:preview'),
  /** The picture behind this window now, small: Settings draws its style previews from it. Null for a video. */
  thumbnail: (): Promise<string | null> => ipcRenderer.invoke('wallpaper:thumbnail'),
  /** Hands a title-bar drag to main, which moves the window under the pointer until `end`. */
  drag: (phase: 'start' | 'end'): void => ipcRenderer.send('wallpaper:drag', phase),
  titleDoubleClick: (): void => ipcRenderer.send('wallpaper:title-double-click'),
  onFrame: (listener: (frame: WallpaperFrame) => void): (() => void) => {
    const handler = (_e: unknown, frame: WallpaperFrame): void => listener(frame)
    ipcRenderer.on('wallpaper:frame', handler)
    return () => ipcRenderer.removeListener('wallpaper:frame', handler)
  }
}
