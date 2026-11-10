/** What `library:stat` reports for one attached file. */
export interface LibraryFileStat {
  path: string
  exists: boolean
  size: number
  /** Last-modified time in ms; 0 when the file is gone. */
  modified: number
  directory: boolean
}

/** One thing the screenshot button can attach. `preview` is a small JPEG data URL for the picker. */
export interface CaptureChoice {
  id: string
  name: string
  kind: 'screen' | 'window'
  preview: string
}

/** The screenshot picker's contents, or why there is none; `permission` is Screen Recording being off. */
export type CaptureChoices = { ok: true; choices: CaptureChoice[] } | { ok: false; permission: boolean; message: string }

/** The path of the saved screenshot, ready to attach, or why it could not be taken. */
export type ScreenshotAttached = { ok: true; path: string } | { ok: false; permission: boolean; message: string }
