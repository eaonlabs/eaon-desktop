import type { EffortLevel } from './types'

/**
 * Agent engines: what actually runs an agent turn.
 *
 * A provider is an API that answers model requests (Anthropic, OpenAI, a
 * local llama-server). An engine is a runtime that runs a whole agent: it
 * owns the loop, the tools, the session and its own model list. Eaon's own
 * loop (`native`) runs on any provider; an installed agent CLI such as Codex
 * is its own engine with its own sign-in and its own models, and Eaon drives
 * it through its real session protocol rather than sending its model names
 * through the native loop.
 *
 * Main implements engines in `src/main/engines/`; the renderer only sees the
 * status and model lists defined here.
 */

export type EngineId = 'native' | 'codex'

export const ENGINE_LABEL: Record<EngineId, string> = {
  native: 'Eaon',
  codex: 'Codex'
}

/** Where a model in a picker came from, freshest first. */
export type ModelSourceKind =
  /** The installed, signed-in engine reported it just now (Codex `model/list`). */
  | 'engine-live'
  /** The signed-in provider's own listing (`/v1/models`). */
  | 'provider-live'
  /** Eaon's remote model catalog, fetched in the background. */
  | 'remote-catalog'
  /** The last live list that worked, kept on disk for when the live one fails. */
  | 'cache'
  /** The catalog shipped inside this build of Eaon. */
  | 'shipped'
  /** Added by hand in Settings. */
  | 'custom'

export interface ModelSource {
  kind: ModelSourceKind
  /** When that source produced it; null for the shipped catalog. */
  retrievedAt: number | null
}

/**
 * A capability Eaon has evidence for (`true`/`false`), or `null` when nothing
 * says either way. Unknown is not the same as yes: a picker shows no badge
 * and the loop probes or degrades rather than assuming.
 */
export type Capability = boolean | null

export interface EngineModel {
  id: string
  label: string
  description?: string
  efforts: EffortLevel[]
  defaultEffort: EffortLevel | null
  vision: Capability
  /** The engine's own default when nothing is picked. */
  isDefault: boolean
  /** A newer model the engine recommends instead, if it names one. */
  upgrade?: string | null
  source: ModelSource
}

export type EngineAuthState =
  /** Signed in and usable. */
  | 'signed-in'
  /** Never signed in, or signed out. */
  | 'signed-out'
  /** Was signed in; the session ran out or was revoked. Reconnect, don't reinstall. */
  | 'expired'
  /** The engine runs without an account (a local model behind it). */
  | 'not-required'
  /** Couldn't tell (the engine didn't answer). */
  | 'unknown'

export interface EngineAuth {
  state: EngineAuthState
  /** How it is signed in, in the engine's words: "ChatGPT", "API key". */
  method: string | null
  /** The plan, when the engine reports one ("Plus", "Pro", "Free"). Never an email or token. */
  plan: string | null
}

export interface EngineStatus {
  id: EngineId
  name: string
  installed: boolean
  /** The executable Eaon found and would run. */
  path: string | null
  /** Where it was found, for the user: "ChatGPT app", "npm", "Homebrew", "PATH". */
  foundIn: string | null
  version: string | null
  /** The newest version Eaon knows of, when it could check. */
  latestVersion: string | null
  updateAvailable: boolean
  /** Below the oldest version Eaon can drive: it must be updated before use. */
  outdated: boolean
  /** The oldest version Eaon can drive. */
  minVersion: string | null
  /** How to update it, as a command or an instruction. */
  updateHint: string | null
  auth: EngineAuth
  /** What went wrong while checking, in plain words; null when the check worked. */
  error: string | null
  /**
   * Set when the engine is installed and answers, but Eaon won't run turns on
   * it, with the reason in plain words — Codex set up (by Connect apps) to use
   * Eaon's own gateway, which would send every request back into Eaon.
   */
  blockedReason?: string | null
  /** Other copies found besides the one Eaon runs, newest first, so Settings can say which one is used. */
  others?: EngineInstallCopy[]
  checkedAt: number
}

/** A copy of an engine found on this computer. */
export interface EngineInstallCopy {
  path: string
  foundIn: string
  version: string | null
}

/** The engine's model list with where it came from and how fresh it is. */
export interface EngineModels {
  engine: EngineId
  models: EngineModel[]
  /** When the list shown was retrieved; null for the shipped fallback. */
  retrievedAt: number | null
  /** Set when the latest refresh failed and an older list is shown instead. */
  staleBecause: string | null
}
