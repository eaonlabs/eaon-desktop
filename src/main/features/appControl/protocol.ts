import type { AppControlErrorCode } from '@shared/appControl'

/**
 * What the per-OS engines (native/app-control/mac, resources/app-control)
 * send back. They describe elements in their platform's own words; tree.ts
 * turns those into Eaon's. Every engine speaks the same line protocol:
 * `{"id", "op", ...}` in, `{"id", "ok", "result" | "code", "message"}` out.
 */

/** An element as an engine reports it. `n` is its number in the snapshot `sid`. */
export interface RawNode {
  n: number
  role: string
  subrole?: string
  roleDescription?: string
  title?: string
  value?: string
  description?: string
  help?: string
  placeholder?: string
  identifier?: string
  url?: string
  enabled?: boolean
  focused?: boolean
  selected?: boolean
  expanded?: boolean
  /** Windows and AT-SPI report checkboxes this way; macOS through `value`. */
  checked?: boolean | 'mixed'
  minimized?: boolean
  modal?: boolean
  main?: boolean
  required?: boolean
  visited?: boolean
  fullscreen?: boolean
  /** [x, y, w, h] in screen points. */
  bounds?: number[]
  actions?: string[]
  valueSettable?: boolean
  /** A password field: its value is never sent. */
  secure?: boolean
  children?: RawNode[]
  more?: number
  /** Present on window, surface and focused results. */
  sid?: string
  pid?: number
}

export interface RawApp {
  pid: number
  name: string
  bundleId?: string
  path?: string
  active?: boolean
  hidden?: boolean
  launched?: boolean
  regular?: boolean
  alreadyRunning?: boolean
}

export interface RawSnapshot {
  sid: string
  pid: number
  tree: RawNode
  count: number
  truncated: boolean
}

export interface RawActResult {
  note?: string
  after?: RawNode
  gone?: boolean
}

export interface RawStatus {
  trusted: boolean | null
  version: string
  os?: string
  /** Why the engine can't work here (missing bindings, no desktop session). */
  problem?: string
}

/** An engine's refusal, carried through to the envelope. */
export class AppControlFailure extends Error {
  constructor(
    readonly code: AppControlErrorCode,
    message: string,
    readonly hint?: string
  ) {
    super(message)
    this.name = 'AppControlFailure'
  }
}

export const failure = (code: AppControlErrorCode, message: string, hint?: string): AppControlFailure =>
  new AppControlFailure(code, message, hint)

/** How the commands reach the engine: the helper process, or a fake in tests. */
export interface AppControlEngine {
  readonly platform: NodeJS.Platform
  /** Sends one request; rejects with an AppControlFailure. */
  call<T>(op: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>
  /** Changes whenever the engine restarts: refs from before are stale. */
  readonly epoch: number
  dispose(): void
}
