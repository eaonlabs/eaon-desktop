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

/** Another copy of Eaon on this Mac. */
export interface EaonCopy {
  path: string
  version: string | null
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
   * macOS, while Accessibility is refused: other copies of Eaon signed
   * differently (the old Swift app, say). macOS keeps one "Eaon" switch for
   * all of them, so the one showing as on may be theirs.
   */
  otherCopies?: EaonCopy[]
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

/** Who an agent run that wants the mouse and keyboard is. */
export type ComputerLeaseOwnerKind = 'worker' | 'chat' | 'scheduled'

export interface ComputerLeaseOwner {
  kind: ComputerLeaseOwnerKind
  /** The worker's id, the chat's id, or the scheduled task's id. */
  id: string
  /** What to call it: the worker's name, the chat's title, the task's name. */
  name: string
  /** The run (its reply's message id): a lease lasts at most one run. */
  runId: string
}

/**
 * The one real pointer and keyboard: which run may use them now, and which
 * are waiting. Pushed as `computer:lease-changed`; `computer:lease` returns it.
 */
export interface ComputerLeaseState {
  holder: (ComputerLeaseOwner & { since: number; lastActive: number }) | null
  waiting: (ComputerLeaseOwner & { since: number })[]
}

/**
 * What the app calls whoever holds or wants the computer, in a few words:
 * a worker by name, a chat or scheduled task by its title in quotes.
 */
export function leaseOwnerName(owner: Pick<ComputerLeaseOwner, 'kind' | 'name'>): string {
  const name = owner.name.trim().replace(/\s+/g, ' ')
  const short = name.length > 28 ? `${name.slice(0, 27)}…` : name
  if (owner.kind === 'worker') return short || 'A worker'
  if (owner.kind === 'scheduled') return short ? `Task “${short}”` : 'A scheduled task'
  return short ? `Chat “${short}”` : 'Eaon'
}
