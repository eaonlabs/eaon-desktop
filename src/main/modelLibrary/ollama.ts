import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { InstalledModel, OllamaStatus } from '@shared/modelLibrary'

/**
 * The slice of Ollama's admin API the model library needs. Ollama's native API
 * always listens on 11434 regardless of the "Ollama" provider's
 * OpenAI-compatible base URL in Settings — the two are unrelated, so the port
 * is fixed here, as in modelHub.ts.
 */
export const OLLAMA_ROOT = 'http://127.0.0.1:11434'

export async function ollamaVersion(timeoutMs = 1500, root = OLLAMA_ROOT): Promise<string | null> {
  try {
    const response = await fetch(`${root}/api/version`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return null
    const body = (await response.json()) as { version?: string }
    return body.version ?? 'unknown'
  } catch {
    return null
  }
}

interface TagsRow {
  name: string
  size?: number
  digest?: string
  modified_at?: string
  remote_host?: string
  capabilities?: string[]
  details?: { family?: string; parameter_size?: string; quantization_level?: string }
}

export async function listInstalled(): Promise<InstalledModel[]> {
  const response = await fetch(`${OLLAMA_ROOT}/api/tags`, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`Ollama returned ${response.status}`)
  const body = (await response.json()) as { models?: TagsRow[] }
  return (body.models ?? []).map((row) => ({
    name: row.name,
    digest: row.digest ?? '',
    sizeBytes: row.size ?? 0,
    modifiedAt: row.modified_at ?? '',
    ...(row.details?.parameter_size ? { parameterSize: row.details.parameter_size } : {}),
    ...(row.details?.quantization_level ? { quantization: row.details.quantization_level } : {}),
    ...(row.details?.family ? { family: row.details.family } : {}),
    ...(row.capabilities ? { capabilities: row.capabilities } : {}),
    ...(row.remote_host ? { cloud: true } : {})
  }))
}

/**
 * Where the `ollama` binary lives. PATH first — main adopts the login shell's
 * PATH at startup, so Homebrew and custom installs resolve — then the places
 * the official installers put it, for when that lookup came back empty.
 */
export function findOllamaBinary(): string | null {
  const exe = process.platform === 'win32' ? 'ollama.exe' : 'ollama'
  const fromPath = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, exe))
  const known =
    process.platform === 'darwin'
      ? [
          '/Applications/Ollama.app/Contents/Resources/ollama',
          join(homedir(), 'Applications/Ollama.app/Contents/Resources/ollama'),
          '/opt/homebrew/bin/ollama',
          '/usr/local/bin/ollama'
        ]
      : process.platform === 'win32'
        ? [join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'Ollama', 'ollama.exe')]
        : ['/usr/local/bin/ollama', '/usr/bin/ollama']
  return [...fromPath, ...known].find((candidate) => existsSync(candidate)) ?? null
}

export async function ollamaStatus(): Promise<OllamaStatus> {
  const version = await ollamaVersion()
  if (version) return { state: 'running', version }
  const binary = findOllamaBinary()
  return binary ? { state: 'stopped', binary } : { state: 'missing' }
}

/**
 * Starts `ollama serve` detached, so it keeps serving the chat picker after
 * Eaon quits — the same lifetime it has when started from Ollama's own app —
 * then waits for the API to answer. `host` (Ollama's own OLLAMA_HOST format)
 * exists so the live test can start a throwaway server on another port rather
 * than touching the user's.
 */
export async function startOllama(options: { host?: string; timeoutMs?: number } = {}): Promise<OllamaStatus> {
  const root = options.host ? `http://${options.host}` : OLLAMA_ROOT
  const running = await ollamaVersion(1500, root)
  if (running) return { state: 'running', version: running }
  const binary = findOllamaBinary()
  if (!binary) return { state: 'missing' }

  const env = options.host ? { ...process.env, OLLAMA_HOST: options.host } : process.env
  const child = spawn(binary, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true, env })
  const failure: { error?: Error } = {}
  child.once('error', (error) => {
    failure.error = error
  })
  child.unref()

  const timeoutMs = options.timeoutMs ?? 20_000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (failure.error) throw new Error(`Could not start Ollama: ${failure.error.message}`)
    const version = await ollamaVersion(1000, root)
    if (version) return { state: 'running', version }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error(`Ollama was started but did not answer at ${root} within ${Math.round(timeoutMs / 1000)} seconds.`)
}

export interface PullProgress {
  receivedBytes: number
  totalBytes: number
  phase: 'downloading' | 'registering'
}

interface PullEvent {
  status?: string
  digest?: string
  total?: number
  completed?: number
  error?: string
}

/**
 * Folds `/api/pull`'s per-layer events into one byte count. Ollama announces
 * layers as it reaches them, so early on the sum of known layer sizes
 * undercounts the pull; the catalog's size for the whole pull keeps the
 * percentage from jumping backwards when a big layer is announced late.
 */
export class PullTracker {
  private layers = new Map<string, { total: number; completed: number }>()
  private finishing = false

  constructor(private readonly expectedBytes: number) {}

  update(event: PullEvent): PullProgress {
    if (event.error) throw new Error(event.error)
    if (event.digest && typeof event.total === 'number') {
      const prev = this.layers.get(event.digest)
      this.layers.set(event.digest, {
        total: event.total,
        completed: Math.max(prev?.completed ?? 0, event.completed ?? 0)
      })
    }
    // Everything after the layers download is local bookkeeping in Ollama.
    if (event.status && /^(verifying|writing|removing|success)/.test(event.status)) this.finishing = true
    return this.snapshot()
  }

  snapshot(): PullProgress {
    let total = 0
    let received = 0
    for (const layer of this.layers.values()) {
      total += layer.total
      received += Math.min(layer.completed, layer.total)
    }
    const totalBytes = Math.max(total, this.expectedBytes)
    return { receivedBytes: this.finishing ? totalBytes : received, totalBytes, phase: this.finishing ? 'registering' : 'downloading' }
  }
}

/** Splits a streamed body into NDJSON lines, carrying partial lines across chunks. */
export async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<PullEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) yield JSON.parse(line) as PullEvent
      newline = buffer.indexOf('\n')
    }
    if (done) break
  }
  if (buffer.trim()) yield JSON.parse(buffer) as PullEvent
}

export async function pullModel(
  name: string,
  expectedBytes: number,
  onProgress: (progress: PullProgress) => void,
  signal: AbortSignal
): Promise<void> {
  let response: Response
  try {
    response = await fetch(`${OLLAMA_ROOT}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, stream: true }),
      signal
    })
  } catch (error) {
    if (signal.aborted) throw new Error('Download cancelled')
    throw new Error(`Could not reach Ollama — ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    let message = text
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text
    } catch {
      /* not JSON */
    }
    throw new Error(`Ollama couldn’t pull ${name}: ${message.slice(0, 300) || response.status}`)
  }

  const tracker = new PullTracker(expectedBytes)
  let succeeded = false
  try {
    for await (const event of ndjson(response.body)) {
      onProgress(tracker.update(event))
      if (event.status === 'success') succeeded = true
    }
  } catch (error) {
    if (signal.aborted) throw new Error('Download cancelled')
    throw error
  }
  if (!succeeded) throw new Error(`Ollama stopped pulling ${name} before it finished.`)
}

export async function deleteModel(name: string): Promise<void> {
  const response = await fetch(`${OLLAMA_ROOT}/api/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: name })
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Ollama couldn’t delete ${name}: ${text.slice(0, 200) || response.status}`)
  }
}
