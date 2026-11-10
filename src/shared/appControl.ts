/**
 * App control: agents read and operate the user's desktop apps through the
 * operating system's accessibility tree (the one screen readers use) rather
 * than screenshots and the mouse. Eaon's own agents get it as the
 * `app_control` tool; coding agents in the ADE as the `eaon-apps` command and
 * the `app_control` tool of Eaon's MCP server. Types shared by the main
 * process, the preload bridge and the Settings page.
 */

/** Bumped only when the envelope's shape changes. */
export const APP_CONTROL_ENVELOPE_VERSION = 1

/** The command ADE terminals get on their PATH. */
export const APP_CONTROL_CLI = 'eaon-apps'

export type AppControlErrorCode =
  /** Settings → App control is off (or its terminal-agent switch is). */
  | 'DISABLED'
  | 'UNSUPPORTED_PLATFORM'
  /** The engine for this OS is missing or won't start (Linux without AT-SPI's Python bindings, say). */
  | 'ENGINE_UNAVAILABLE'
  /** macOS hasn't given Eaon Accessibility access. */
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGS'
  | 'UNKNOWN_COMMAND'
  | 'APP_NOT_FOUND'
  | 'WINDOW_NOT_FOUND'
  | 'ELEMENT_NOT_FOUND'
  /** Not a ref, or a ref to an element its snapshot doesn't have. */
  | 'BAD_REF'
  /** The ref's snapshot is gone, or its element no longer exists: take a new snapshot. */
  | 'STALE_REF'
  | 'ACTION_UNSUPPORTED'
  | 'ACTION_FAILED'
  | 'TIMEOUT'
  /** Eaon itself, a password manager or a sign-in prompt, or a password field. */
  | 'PROTECTED'
  /** key-down, key-up, mouse-down, mouse-up: reserved, they always refuse. */
  | 'RESERVED'
  /** Pointer gestures (hover, drag, clicks at coordinates): computer use does those. */
  | 'NEEDS_POINTER'
  /** The user said no in the approval prompt. */
  | 'DECLINED'
  | 'INTERNAL'

export interface AppControlError {
  code: AppControlErrorCode
  message: string
  /** What to do about it, when there is something. */
  hint?: string
}

/** What every command answers with: one JSON object, the same on every OS. */
export type AppControlEnvelope =
  | { version: typeof APP_CONTROL_ENVELOPE_VERSION; ok: true; command: string; data: unknown }
  | { version: typeof APP_CONTROL_ENVELOPE_VERSION; ok: false; command: string; error: AppControlError }

/**
 * One element of an app's interface. `ref` names it for later commands until
 * its snapshot is dropped. Roles are the same words on every OS (button,
 * textfield, menuitem…); `native` is the platform's own role when it differs.
 */
export interface UiNode {
  ref: string
  role: string
  name?: string
  value?: string
  description?: string
  placeholder?: string
  /** The app's own identifier for the element, when it gives one. */
  id?: string
  /** disabled, focused, selected, checked, unchecked, mixed, expanded, collapsed, minimized, modal, required… */
  states?: string[]
  /** Screen points, top-left origin: [x, y, width, height]. */
  bounds?: [number, number, number, number]
  actions?: string[]
  native?: string
  children?: UiNode[]
  /** Children left out by a depth or size limit; `snapshot --root <ref>` shows them. */
  more?: number
}

export interface AppInfo {
  pid: number
  name: string
  bundleId?: string
  path?: string
  active?: boolean
  hidden?: boolean
}

export interface AppControlSettings {
  /** Off by default: nothing reads or touches another app until the user turns it on. */
  enabled: boolean
  /** Coding agents in ADE terminals (and Claude Code through Eaon's MCP) may use it too. */
  terminalAgents: boolean
  /** Briefly outline each element an agent acts on, so the user sees what it did. */
  showActions: boolean
}

export type AppControlSourceKind = 'chat' | 'worker' | 'scheduled' | 'terminal' | 'settings'

/** Who ran a command, for the activity list. */
export interface AppControlSource {
  kind: AppControlSourceKind
  /** The chat's title, the worker's name, "Claude Code", "eaon-apps"… */
  name: string
}

export interface AppControlTraceEntry {
  id: number
  at: number
  source: AppControlSource
  command: string
  /** What it acted on, in words: `button "Save" in TextEdit`. Never typed text. */
  target: string | null
  ok: boolean
  code?: AppControlErrorCode
  message?: string
  ms: number
}

export type AppControlPermission = 'granted' | 'denied' | 'not-needed' | 'unknown'

export interface AppControlStatus {
  platform: 'darwin' | 'win32' | 'linux'
  settings: AppControlSettings
  engine: {
    available: boolean
    /** "macOS Accessibility (AX)", "Windows UI Automation", "AT-SPI"… */
    name: string
    version: string | null
    /** Why it's unavailable, or how to fix it. */
    detail: string | null
  }
  permission: AppControlPermission
  /** Apps agents may never read or act on. */
  protectedApps: string[]
  cli: { command: string }
}

export type AppControlCommandGroup = 'apps' | 'observe' | 'interact' | 'keyboard' | 'wait' | 'clipboard' | 'system'

export interface AppControlCommandInfo {
  name: string
  group: AppControlCommandGroup
  summary: string
  /** Changes something (goes through approval for Eaon's own agents). */
  acts: boolean
  /** `eaon-apps` usage, e.g. "click <ref>". */
  usage: string
}
