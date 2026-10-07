import { MAX_WORKERS, type Worker, type WorkerAccess, type WorkerDraft, type WorkerSendOptions, type WorkerThread } from '@shared/workers'
import {
  REMOTE_API_VERSION,
  REMOTE_BASE_PATH,
  REMOTE_LIMITS,
  type RemoteHello,
  type RemoteModelEntry,
  type RemoteModelRef,
  type RemoteModels
} from '@shared/remote'
import { pathScrubber, remoteThreadPage, remoteWorker } from './view'

/**
 * Routing and validation for `/remote/v1/*`, without any HTTP in it: a
 * request in, a status and a JSON body out, over an engine-like interface. The
 * server (`server.ts`) does the keys, the limits and the sockets; the event
 * stream and the model endpoints live there too, because they need the socket.
 */

/** The part of the workers engine this API drives; `WorkersEngine` satisfies it. */
export interface RemoteEngine {
  list(): Worker[]
  getThread(id: string): WorkerThread
  save(draft: WorkerDraft): Worker
  send(id: string, text: string, files?: string[], options?: WorkerSendOptions): void
  clear(id: string): void
  setPaused(id: string, paused: boolean): Worker
  setGoal(id: string, status: 'active' | 'paused' | null): void
  wake(id: string): void
  stopTurn(id: string): void
  markRead(id: string): void
  answer(id: string, askId: string, answer: { text?: string; approved?: boolean }): void
}

export interface RemoteApiDeps {
  engine: RemoteEngine
  /** Forgets a worker and closes its browser (the service's `remove`). */
  remove: (id: string) => Promise<void>
  /** This computer's name and Eaon's version, for the phone's hello. */
  info: () => { name: string; appVersion: string }
  models: () => RemoteModelEntry[]
  defaultModel: () => string | null
  modelLabel?: (model: RemoteModelRef) => string | undefined
  now?: () => number
  /** The home directory to scrub out of text; the real one unless a test says otherwise. */
  home?: string
}

export interface ApiRequest {
  method: string
  /** The path, without the query and without a trailing slash. */
  path: string
  query: URLSearchParams
  /** The parsed JSON body; undefined when there was none. */
  body: unknown
}

export interface ApiResponse {
  status: number
  body: unknown
}

export type ErrorCode = 'unauthorized' | 'forbidden' | 'rate_limited' | 'not_found' | 'invalid_request' | 'too_large' | 'conflict' | 'server_error'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string
  ) {
    super(message)
  }
}

export const errorBody = (code: ErrorCode, message: string): { error: { code: ErrorCode; message: string } } => ({ error: { code, message } })

const bad = (message: string): ApiError => new ApiError(400, 'invalid_request', message)
const conflict = (message: string): ApiError => new ApiError(409, 'conflict', message)
const missing = (message: string): ApiError => new ApiError(404, 'not_found', message)

const ACCESS: WorkerAccess[] = ['autonomous', 'safe', 'read-only']
const COLOR = /^#[0-9a-f]{6}$/i
const ok = (): ApiResponse => ({ status: 200, body: { ok: true } })
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The body as an object; an absent body is an empty one. */
function objectBody(body: unknown): Record<string, unknown> {
  if (body === undefined) return {}
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('The body must be a JSON object.')
  return body as Record<string, unknown>
}

function text(body: Record<string, unknown>, key: string, { min = 0, max, required = false }: { min?: number; max: number; required?: boolean }): string | undefined {
  const value = body[key]
  if (value === undefined) {
    if (required) throw bad(`${key} is required.`)
    return undefined
  }
  if (typeof value !== 'string') throw bad(`${key} must be text.`)
  const trimmed = value.trim()
  if (trimmed.length < min) throw bad(min === 1 ? `${key} can't be empty.` : `${key} is too short.`)
  if (trimmed.length > max) throw bad(`${key} can be at most ${max} characters.`)
  return trimmed
}

function modelRef(body: Record<string, unknown>): RemoteModelRef | null | undefined {
  const value = body.model
  if (value === undefined) return undefined
  if (value === null) return null
  const ref = value as Partial<RemoteModelRef>
  if (typeof value !== 'object' || typeof ref.providerId !== 'string' || typeof ref.modelId !== 'string' || !ref.providerId.trim() || !ref.modelId.trim()) {
    throw bad('model must be null or { providerId, modelId }.')
  }
  if (ref.providerId.length > 200 || ref.modelId.length > 200) throw bad('model is too long.')
  return { providerId: ref.providerId.trim(), modelId: ref.modelId.trim() }
}

interface Fields {
  name?: string
  color?: string
  purpose?: string
  personality?: string
  access?: WorkerAccess
  model?: RemoteModelRef | null
}

/** The fields of a draft that are present, checked. A new worker needs `name` and `purpose` on top of this. */
function draftFields(body: Record<string, unknown>): Fields {
  const fields: Fields = {}
  const name = text(body, 'name', { min: 1, max: REMOTE_LIMITS.name })
  if (name !== undefined) fields.name = name
  const purpose = text(body, 'purpose', { min: 1, max: REMOTE_LIMITS.purpose })
  if (purpose !== undefined) fields.purpose = purpose
  // The engine keeps 600 characters; say so rather than quietly cutting it.
  const personality = text(body, 'personality', { max: REMOTE_LIMITS.personality })
  if (personality !== undefined) fields.personality = personality
  if (body.color !== undefined) {
    if (typeof body.color !== 'string' || !COLOR.test(body.color)) throw bad('color must look like #3E86C6.')
    fields.color = body.color
  }
  if (body.access !== undefined) {
    if (typeof body.access !== 'string' || !ACCESS.includes(body.access as WorkerAccess)) throw bad(`access must be one of ${ACCESS.join(', ')}.`)
    fields.access = body.access as WorkerAccess
  }
  const model = modelRef(body)
  if (model !== undefined) fields.model = model
  return fields
}

/** Runs an engine call whose refusals are the worker's state, not a bad request. */
function state<T>(call: () => T): T {
  try {
    return call()
  } catch (error) {
    throw conflict(errorText(error))
  }
}

export async function handleApi(deps: RemoteApiDeps, request: ApiRequest): Promise<ApiResponse> {
  const { engine } = deps
  const now = (): number => (deps.now ?? Date.now)()
  const view = (worker: Worker): ReturnType<typeof remoteWorker> =>
    remoteWorker(worker, { now: now(), modelLabel: deps.modelLabel, scrub: pathScrubber(worker.folder, deps.home) })
  const find = (id: string): Worker => {
    const worker = engine.list().find((w) => w.id === id)
    if (!worker) throw missing('There is no such worker.')
    return worker
  }

  const { method, path } = request
  if (!path.startsWith(`${REMOTE_BASE_PATH}/`)) throw missing(`There is no ${method} ${path}.`)
  let parts: string[]
  try {
    parts = path.slice(REMOTE_BASE_PATH.length + 1).split('/').map(decodeURIComponent)
  } catch {
    throw bad('That address is not valid.')
  }
  const [head, id, action, ...extra] = parts

  if (head === 'hello' && parts.length === 1 && method === 'GET') {
    const workers = engine.list()
    const info = deps.info()
    const hello: RemoteHello = {
      app: 'Eaon',
      apiVersion: REMOTE_API_VERSION,
      appVersion: info.appVersion,
      name: info.name,
      workers: workers.length,
      running: workers.filter((w) => w.status === 'working').length
    }
    return { status: 200, body: hello }
  }

  if (head === 'models' && parts.length === 1 && method === 'GET') {
    const models: RemoteModels = { models: deps.models(), default: deps.defaultModel() }
    return { status: 200, body: models }
  }

  if (head !== 'workers' || extra.length > 0) throw missing(`There is no ${method} ${path}.`)

  // /workers
  if (id === undefined) {
    if (method === 'GET') return { status: 200, body: { workers: engine.list().map(view) } }
    if (method === 'POST') {
      const fields = draftFields(objectBody(request.body))
      if (fields.name === undefined) throw bad('name is required.')
      if (fields.purpose === undefined) throw bad('purpose is required.')
      if (engine.list().length >= MAX_WORKERS) throw conflict(`You can have up to ${MAX_WORKERS} workers. Remove one to make room for another.`)
      let created: Worker
      try {
        created = engine.save({
          name: fields.name,
          // An empty colour makes the engine pick one nobody is using.
          color: fields.color ?? '',
          personality: fields.personality ?? '',
          purpose: fields.purpose,
          ...(fields.model !== undefined ? { model: fields.model } : {}),
          access: fields.access ?? 'autonomous'
        })
      } catch (error) {
        throw bad(errorText(error))
      }
      return { status: 201, body: { worker: view(created) } }
    }
    throw missing(`There is no ${method} ${path}.`)
  }

  // /workers/:id
  if (action === undefined) {
    if (method === 'GET') return { status: 200, body: { worker: view(find(id)) } }
    if (method === 'PATCH') {
      const existing = find(id)
      const fields = draftFields(objectBody(request.body))
      // The engine replaces every field of a draft, so what the phone left out
      // is carried over from the worker rather than blanked.
      let saved: Worker
      try {
        saved = engine.save({
          id,
          name: fields.name ?? existing.name,
          color: fields.color ?? existing.color,
          personality: fields.personality ?? existing.personality,
          purpose: fields.purpose ?? existing.purpose,
          model: fields.model === undefined ? existing.model : fields.model,
          access: fields.access ?? existing.access
        })
      } catch (error) {
        throw bad(errorText(error))
      }
      return { status: 200, body: { worker: view(saved) } }
    }
    if (method === 'DELETE') {
      find(id)
      await deps.remove(id)
      return ok()
    }
    throw missing(`There is no ${method} ${path}.`)
  }

  // /workers/:id/thread
  if (action === 'thread' && method === 'GET') {
    const worker = find(id)
    const limitText = request.query.get('limit')
    let limit: number = REMOTE_LIMITS.threadDefault
    if (limitText !== null) {
      limit = Number(limitText)
      if (!/^\d+$/.test(limitText) || limit < 1 || limit > REMOTE_LIMITS.threadPage) throw bad(`limit must be between 1 and ${REMOTE_LIMITS.threadPage}.`)
    }
    const page = remoteThreadPage(engine.getThread(id).messages, {
      limit,
      before: request.query.get('before'),
      scrub: pathScrubber(worker.folder, deps.home),
      runningMessageId: worker.runningMessageId
    })
    if (!page) throw missing('That message is not in the thread any more.')
    return { status: 200, body: page }
  }

  if (method !== 'POST') throw missing(`There is no ${method} ${path}.`)
  const worker = find(id)
  const body = (): Record<string, unknown> => objectBody(request.body)

  switch (action) {
    case 'send': {
      const fields = body()
      const message = text(fields, 'text', { min: 1, max: REMOTE_LIMITS.send, required: true })!
      if (fields.goal !== undefined && typeof fields.goal !== 'boolean') throw bad('goal must be true or false.')
      engine.send(id, message, [], fields.goal === true ? { goal: true } : {})
      return ok()
    }
    case 'stop':
      engine.stopTurn(id)
      return ok()
    case 'wake':
      state(() => engine.wake(id))
      return ok()
    case 'pause': {
      const { paused } = body()
      if (typeof paused !== 'boolean') throw bad('paused must be true or false.')
      return { status: 200, body: { worker: view(engine.setPaused(id, paused)) } }
    }
    case 'goal': {
      const fields = body()
      const status = fields.status
      if (!('status' in fields) || (status !== null && status !== 'active' && status !== 'paused')) throw bad('status must be "active", "paused" or null.')
      state(() => engine.setGoal(id, status))
      return ok()
    }
    case 'answer': {
      const fields = body()
      const askId = text(fields, 'askId', { min: 1, max: 200, required: true })!
      const ask = worker.asks.find((a) => a.id === askId)
      if (!ask) throw missing('That question was already answered.')
      const reply = text(fields, 'text', { max: REMOTE_LIMITS.answer })
      if (fields.approved !== undefined && typeof fields.approved !== 'boolean') throw bad('approved must be true or false.')
      if (ask.approve) {
        // Approving or declining is the whole answer; a note is optional.
        if (typeof fields.approved !== 'boolean') throw bad('approved must be true or false for this question.')
      } else if (!reply) {
        throw bad('text is required to answer this question.')
      }
      engine.answer(id, askId, { ...(reply ? { text: reply } : {}), approved: fields.approved === true })
      return ok()
    }
    case 'clear':
      engine.clear(id)
      return ok()
    case 'read':
      engine.markRead(id)
      return ok()
    default:
      throw missing(`There is no ${method} ${path}.`)
  }
}
