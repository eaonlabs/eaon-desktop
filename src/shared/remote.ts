import type { WorkerAccess, WorkerMood, WorkerStatus } from './workers'

/**
 * Eaon's remote API: how a phone on the user's own network sees and controls
 * the Workers running in Eaon Desktop. The contract is `docs/remote-api.md`;
 * the server is `src/main/remote/`. Everything here is plain data, so the
 * Settings page, the server and the tests share one set of shapes.
 */

export const REMOTE_DEFAULT_PORT = 3266
/** Bumps only on a breaking change; fields may be added without it. */
export const REMOTE_API_VERSION = 1
/** The prefix of the remote key, so it can't be mistaken for the Local API Server's (`eaon-`). */
export const REMOTE_TOKEN_PREFIX = 'eaonr-'
export const REMOTE_BASE_PATH = '/remote/v1'
/** What the Mac announces over Bonjour, and what the phone browses for. */
export const REMOTE_BONJOUR_TYPE = '_eaon._tcp'
/** The pairing link's own version, separate from the API's. */
export const REMOTE_PAIR_VERSION = 1

/** Request bodies, apart from chat (images ride along there). */
export const REMOTE_MAX_BODY = 256 * 1024
export const REMOTE_MAX_CHAT_BODY = 8 * 1024 * 1024
/** A comment goes out on every SSE stream this often, so a dead connection is noticed. */
export const REMOTE_PING_MS = 20_000
/** Wrong keys one address may try within `REMOTE_FAILURE_WINDOW_MS` before it is turned away. */
export const REMOTE_MAX_FAILURES = 10
export const REMOTE_FAILURE_WINDOW_MS = 60_000

export const REMOTE_LIMITS = {
  name: 40,
  purpose: 2000,
  /** The engine keeps 600 characters of it (the spec said 1000). */
  personality: 600,
  send: 8000,
  answer: 8000,
  threadPage: 100,
  threadDefault: 40,
  toolDetail: 120,
  toolOutput: 800
} as const

export interface RemoteModelRef {
  providerId: string
  modelId: string
}

export interface RemoteAsk {
  id: string
  question: string
  /** Quick answers. */
  options: string[]
  /** A specific action the worker may not take alone; the call's arguments are not sent. */
  approve: { tool: string; summary: string } | null
  at: number
}

export interface RemoteRoutine {
  id: string
  name: string
  task: string
  everyMs: number | null
  daily: string | null
  nextAt: number
}

export interface RemoteGoalRun {
  text: string
  status: 'active' | 'achieved' | 'blocked' | 'paused'
  turns: number
  summary?: string
}

export interface RemoteWorker {
  id: string
  name: string
  /** CSS hex, "#3E86C6". */
  color: string
  purpose: string
  personality: string
  status: WorkerStatus
  mood: WorkerMood
  /** The worker's own one-line status. */
  activity: string
  paused: boolean
  access: WorkerAccess
  /** Null follows the app's selected model. */
  model: (RemoteModelRef & { label: string }) | null
  goal: string
  goalRun: RemoteGoalRun | null
  /** Questions waiting on the user, oldest first. */
  asks: RemoteAsk[]
  unread: number
  lastRunAt: number | null
  lastOutcome: { at: number; ok: boolean } | null
  lastError: string | null
  /** The soonest heartbeat, routine or goal continuation; null when paused or nothing is scheduled. */
  nextWakeAt: number | null
  routines: RemoteRoutine[]
  /** The message streaming right now. */
  runningMessageId: string | null
  createdAt: number
}

export type RemotePart =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      /** A short phrase: "Ran a command", "Read a file". */
      title: string
      /** One line, at most 120 characters: the command, file, URL or query. */
      detail?: string
      status: 'running' | 'done' | 'denied' | 'error'
      /** At most 800 characters. */
      output?: string
    }

export interface RemoteMessage {
  id: string
  role: 'user' | 'assistant'
  at: number
  /** A user turn that was mail from someone else: who wrote it. The user themself is omitted. */
  from?: { name: string; color?: string }
  parts: RemotePart[]
  error?: string
  /** An assistant turn its own schedule woke: the note it left itself. */
  heartbeat?: string
  streaming: boolean
}

export interface RemoteDraft {
  name: string
  color?: string
  purpose: string
  personality?: string
  access?: WorkerAccess
  model?: RemoteModelRef | null
}

export interface RemoteHello {
  app: 'Eaon'
  apiVersion: number
  appVersion: string
  name: string
  workers: number
  /** Workers with a turn running right now. */
  running: number
}

export interface RemoteModelEntry {
  /** `provider/model`. */
  id: string
  name: string
  provider: string
}

export interface RemoteModels {
  models: RemoteModelEntry[]
  /** The app's selected model as `provider/model`, or null. */
  default: string | null
}

/** What goes out on the event stream, by event name. */
export type RemoteEvent =
  | { event: 'workers'; data: { workers: RemoteWorker[] } }
  | { event: 'message'; data: { workerId: string; message: RemoteMessage } }
  | { event: 'delta'; data: { workerId: string; messageId: string; text: string } }
  | { event: 'tool'; data: { workerId: string; messageId: string; part: Extract<RemotePart, { kind: 'tool' }> } }

export interface RemoteStatus {
  running: boolean
  port: number
  error?: string
}

/** What Settings → Remote devices shows. */
export interface RemoteInfo {
  enabled: boolean
  status: RemoteStatus
  /** Non-internal IPv4 addresses, most likely first. */
  addresses: string[]
  /** `<hostname>.local`, the name Bonjour announces. */
  hostName: string
  /** The computer's name, as the phone lists it. */
  computerName: string
  /** The key; null until the first time remote devices are turned on. */
  token: string | null
  /** The `eaon://pair` link (and its QR code), null while there is no key. */
  link: string | null
}

export interface RemotePairing {
  host: string
  port: number
  key: string
  name: string
}

/** `eaon://pair?v=1&host=…&port=…&key=…&name=…`, values percent-encoded. */
export function remotePairingLink({ host, port, key, name }: RemotePairing): string {
  const query = [
    ['v', String(REMOTE_PAIR_VERSION)],
    ['host', host],
    ['port', String(port)],
    ['key', key],
    ['name', name]
  ]
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')
  return `eaon://pair?${query}`
}
