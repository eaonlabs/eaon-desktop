import type { EngineId, EngineModels, EngineStatus } from '@shared/engines'
import type { EffortLevel, StreamEvent, TokenUsage } from '@shared/types'

/**
 * What an agent engine must do for Eaon to drive it. The native engine wraps
 * Eaon's own loop (`agent/loop.ts`); an installed agent CLI (Codex) runs its
 * own loop in its own process and reports back through its session protocol,
 * normalized here into the `StreamEvent`s the transcript already draws.
 *
 * One adapter instance serves every worker and chat that uses the engine, but
 * each turn runs in its own session: a turn's failure, cancellation or crash
 * is reported for that turn only and never ends another's.
 */

/** Why a turn failed, so the UI can offer the right fix instead of a generic error. */
export type EngineErrorKind =
  /** The engine isn't installed (or Eaon can't find it). */
  | 'not-installed'
  /** Installed, but older than Eaon can drive. */
  | 'outdated'
  /** Never signed in. */
  | 'signed-out'
  /** Was signed in; the session expired or was revoked. Reconnect, not "model unavailable". */
  | 'auth-expired'
  /** The model asked for isn't one this engine/account offers. */
  | 'model-unavailable'
  /** Rate limit or plan quota. */
  | 'rate-limited'
  /** No network, DNS, TLS, a dropped connection. */
  | 'network'
  /** The engine's process exited or stopped answering. */
  | 'engine-crashed'
  | 'other'

export class EngineError extends Error {
  constructor(
    readonly kind: EngineErrorKind,
    message: string,
    /** The engine's own words, for "Copy diagnostics"; never shown as the headline. */
    readonly detail?: string
  ) {
    super(message)
    this.name = 'EngineError'
  }
}

/** Access a turn runs with, the worker's own level (shared/workers WorkerAccess). */
export type EngineAccess = 'autonomous' | 'safe' | 'read-only'

export interface EngineApprovalRequest {
  /** Normalized tool name ("run_command", "apply_patch"). */
  tool: string
  input: Record<string, unknown>
  /** One line for the user: the command, or the files a patch touches. */
  summary: string
  /** True for calls that change something; false for read-only ones. */
  mutating: boolean
}

export interface EngineTurnInput {
  /** The engine session to continue; null starts a new one. */
  sessionId: string | null
  /** The transcript message this turn's events stream into. */
  messageId: string
  cwd: string
  /** The engine's model id; null uses the engine's own default. */
  model: string | null
  effort: EffortLevel | null
  /** Who the agent is and how it works (a worker's persona), sent as developer instructions. */
  instructions: string
  /** The turn's message, and images to attach (absolute paths). */
  text: string
  images: string[]
  access: EngineAccess
  signal: AbortSignal
  emit: (event: StreamEvent) => void
  /**
   * Asked for each call the engine wants approved. Resolves true to allow it.
   * Eaon's approval policy decides here (agent/approvals); the engine never
   * approves its own calls.
   */
  approve: (request: EngineApprovalRequest) => Promise<boolean>
}

export interface EngineTurnResult {
  /** The session to continue next turn (new or the same). */
  sessionId: string | null
  /** The final answer text. */
  text: string
  usage: TokenUsage
  cancelled: boolean
  error?: string
  errorKind?: EngineErrorKind
  /** Whether anything outside the transcript may have changed (a command ran, a file was written). */
  sideEffects: boolean
}

export interface EngineAdapter {
  readonly id: EngineId
  /** Finds the engine, its version and sign-in state. Never throws; problems go in `error`. */
  detect(options?: { force?: boolean }): Promise<EngineStatus>
  /** The models this engine and account offer, freshest source first. Never throws. */
  listModels(options?: { force?: boolean }): Promise<EngineModels>
  /** Starts the engine's own sign-in. Resolves when it completed. */
  login?(): Promise<void>
  /** Runs one turn: resumes `sessionId` (or starts a session) and sends the message. */
  runTurn(input: EngineTurnInput): Promise<EngineTurnResult>
  /** Adds text to a running turn, when the engine supports steering. */
  steer?(sessionId: string, text: string): Promise<boolean>
  /** Releases processes and sessions, for quitting. */
  dispose(): Promise<void>
}
