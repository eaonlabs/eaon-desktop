/**
 * Types the computer-use feature shares between the main process, the preload
 * bridge and the Settings page.
 */

/** macOS privacy grants as Electron reports them; `not-needed` on platforms without the gate. */
export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown' | 'not-needed'

export type PermissionKind = 'screen' | 'accessibility'

/**
 * The app macOS charges Eaon's privacy permissions to (its "responsible"
 * process). That is Eaon when it is opened from Finder or the Dock, and the
 * terminal when it is started from one — `npm run dev`, for instance.
 */
export interface PermissionOwner {
  /** True when it is Eaon itself. */
  self: boolean
  /** The name System Settings lists it under; null when it could not be told. */
  name: string | null
}

export interface ComputerDisplay {
  id: number
  primary: boolean
  /** Size in points (DIP), the space the pointer moves in. */
  width: number
  height: number
  scaleFactor: number
}

export interface ComputerUseStatus {
  platform: 'darwin' | 'win32' | 'linux'
  /** Screen Recording on macOS. */
  screen: PermissionState
  /** Accessibility on macOS — needed to post mouse and keyboard events. */
  accessibility: PermissionState
  /** macOS: whose switch to turn on in System Settings; null on other platforms. */
  owner: PermissionOwner | null
  /**
   * macOS: Screen Recording has been asked for since Eaon started. macOS
   * applies it only after a relaunch, so until Eaon restarts `screen` can
   * read "denied" even once the switch is on.
   */
  screenRequested: boolean
  /** "Quit & reopen" can bring Eaon back by itself (false in development, where the terminal has to). */
  canRelaunch: boolean
  input: {
    available: boolean
    /** e.g. "CoreGraphics via JXA". */
    backend: string
    /** Why input is unavailable, or a caveat worth showing. */
    detail?: string
  }
  /** macOS only: while locked, input would land on the lock screen, so Eaon refuses to send any. */
  locked: boolean | null
  displays: ComputerDisplay[]
  /** Human-readable emergency-stop shortcut, e.g. "⌃⌥⌘." */
  stopShortcut: string
  /** True while an agent turn is using the computer. */
  driving: boolean
}

export interface ComputerTestResult {
  ok: boolean
  /** data:image/jpeg;base64,… exactly as the model would receive it. */
  dataUrl?: string
  width?: number
  height?: number
  bytes?: number
  ms?: number
  error?: string
}
