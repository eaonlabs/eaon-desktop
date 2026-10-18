import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { LOCAL_SPEECH_MODELS, localSpeechModel, localSpeechUrl, type LocalSpeechModel, type LocalSpeechState } from '@shared/speech'

/**
 * Dictation on this computer: whisper.cpp's `whisper-server`, bundled with
 * Eaon (resources/whisper, built by scripts/build-whisper.sh), running a model
 * downloaded once from Hugging Face. The recording never leaves the machine.
 *
 * The server starts on the first dictation and keeps the model loaded, so the
 * next one is quick; after a few idle minutes it is stopped and the memory
 * given back. Models live in <userData>/speech-models, checked against their
 * SHA-256 before they are used.
 */

const IDLE_MS = 5 * 60_000
const THREADS = Math.max(1, Math.floor(availableParallelism() / 2))

const platformDir = (): string => `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
const binaryName = (): string => (process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server')

/** The bundled whisper-server for this machine, or null when this build has none. */
export function whisperBinary(): string | null {
  const candidates = [
    process.env.EAON_WHISPER_SERVER || null,
    app.isPackaged ? join(process.resourcesPath, 'whisper', platformDir(), binaryName()) : null,
    fileURLToPath(new URL(`../../resources/whisper/${platformDir()}/${binaryName()}`, import.meta.url))
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      /* not here */
    }
  }
  return null
}

const modelsDir = (): string => join(app.getPath('userData'), 'speech-models')
const modelPath = (model: LocalSpeechModel): string => join(modelsDir(), model.file)

/* ----------------------------------------------------------------- downloads */

let downloading: { id: string; progress: number; abort: AbortController } | null = null
let lastError: string | null = null
let notify: () => void = () => {}

/** Told whenever downloads or the model list change, so Settings can follow. */
export function onLocalSpeechChange(listener: () => void): void {
  notify = listener
}

export async function localSpeechState(): Promise<LocalSpeechState> {
  const downloaded: string[] = []
  for (const model of LOCAL_SPEECH_MODELS) if (existsSync(modelPath(model))) downloaded.push(model.id)
  return {
    available: whisperBinary() !== null,
    downloaded,
    downloading: downloading ? { id: downloading.id, progress: downloading.progress } : null,
    error: lastError
  }
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/**
 * Downloads a model, picking up where an interrupted download left off. The
 * file only takes its real name once its checksum matches, so a half or
 * damaged download is never loaded.
 */
export async function downloadLocalSpeechModel(id: string): Promise<void> {
  const model = localSpeechModel(id)
  if (!model) throw new Error('Unknown speech model.')
  if (downloading) throw new Error('Another speech model is downloading.')
  if (existsSync(modelPath(model))) return
  await mkdir(modelsDir(), { recursive: true })
  const part = `${modelPath(model)}.part`
  const abort = new AbortController()
  downloading = { id, progress: 0, abort }
  lastError = null
  notify()
  try {
    const have = await stat(part).then((s) => s.size).catch(() => 0)
    const response = await fetch(localSpeechUrl(model), { headers: have > 0 ? { Range: `bytes=${have}-` } : {}, signal: abort.signal })
    if (!response.ok || !response.body) throw new Error(`Hugging Face answered ${response.status}.`)
    // A server that ignores the range sends the whole file again: start over.
    const resumed = response.status === 206
    let received = resumed ? have : 0
    let lastTick = 0
    const counted = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).on('data', (chunk: Buffer) => {
      received += chunk.length
      const now = Date.now()
      if (now - lastTick > 250 && downloading) {
        lastTick = now
        downloading.progress = Math.min(0.99, received / model.bytes)
        notify()
      }
    })
    await pipeline(counted, createWriteStream(part, { flags: resumed ? 'a' : 'w' }))
    if (downloading) {
      downloading.progress = 1
      notify()
    }
    if ((await sha256Of(part)) !== model.sha256) {
      await rm(part, { force: true })
      throw new Error('The download was damaged. Try again.')
    }
    await rename(part, modelPath(model))
  } catch (error) {
    // Stopped by the user: the part stays, so the next try resumes.
    if (!abort.signal.aborted) lastError = `Couldn't download ${model.label}: ${(error as Error).message}`
    throw error
  } finally {
    downloading = null
    notify()
  }
}

export function cancelLocalSpeechDownload(): void {
  downloading?.abort.abort()
}

export async function deleteLocalSpeechModel(id: string): Promise<void> {
  const model = localSpeechModel(id)
  if (!model) return
  if (server?.modelId === id) stopServer()
  await rm(modelPath(model), { force: true })
  await rm(`${modelPath(model)}.part`, { force: true })
  notify()
}

/* -------------------------------------------------------------------- server */

interface Server {
  modelId: string
  port: number
  child: ChildProcess
  ready: Promise<void>
  idle: ReturnType<typeof setTimeout> | null
  log: string[]
}

let server: Server | null = null

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No free port'))))
    })
  })
}

function stopServer(): void {
  if (!server) return
  if (server.idle) clearTimeout(server.idle)
  server.child.kill()
  server = null
}

process.on('exit', stopServer)
app.on('before-quit', stopServer)

/** whisper-server listens only once the model has loaded: poll until it answers. */
async function waitUntilListening(port: number, child: ChildProcess, log: string[]): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The speech model couldn't start: ${log.slice(-3).join(' ').trim() || `exit ${child.exitCode}`}`)
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  throw new Error('The speech model took too long to load.')
}

async function serverFor(model: LocalSpeechModel): Promise<Server> {
  if (server && server.modelId === model.id && server.child.exitCode === null) return server
  stopServer()
  const binary = whisperBinary()
  if (!binary) throw new Error('This build of Eaon has no local speech engine for this computer.')
  if (!existsSync(modelPath(model))) throw new Error(`${model.label} isn't downloaded yet. Download it in Settings → Model providers → Speech to text.`)
  const port = await freePort()
  const args = ['--model', modelPath(model), '--host', '127.0.0.1', '--port', String(port), '--threads', String(THREADS), '--language', model.englishOnly ? 'en' : 'auto']
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const log: string[] = []
  const keep = (data: Buffer): void => {
    log.push(...data.toString().split('\n').filter(Boolean))
    if (log.length > 40) log.splice(0, log.length - 40)
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  const started: Server = { modelId: model.id, port, child, log, idle: null, ready: Promise.resolve() }
  child.on('exit', () => {
    if (server === started) server = null
  })
  started.ready = waitUntilListening(port, child, log)
  server = started
  try {
    await started.ready
  } catch (error) {
    stopServer()
    throw error
  }
  return started
}

/** Turns a 16 kHz mono WAV recording into text with the chosen local model. */
export async function transcribeLocally(wav: Uint8Array, modelId: string): Promise<string> {
  const model = localSpeechModel(modelId)
  if (!model) throw new Error('Pick a speech model in Settings → Model providers → Speech to text.')
  const running = await serverFor(model)
  if (running.idle) clearTimeout(running.idle)
  try {
    const form = new FormData()
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav')
    form.append('response_format', 'json')
    form.append('temperature', '0')
    // A hint for words the model can't know how to spell: the app's own name.
    form.append('prompt', 'Eaon')
    const response = await fetch(`http://127.0.0.1:${running.port}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(180_000) })
    if (!response.ok) throw new Error(`The speech model couldn't transcribe the recording (${response.status}).`)
    const body = (await response.json()) as { text?: unknown; error?: unknown }
    if (typeof body.error === 'string') throw new Error(body.error)
    return typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : ''
  } finally {
    // Kept loaded for the next dictation; let go of the memory once it's been quiet a while.
    if (server === running) running.idle = setTimeout(() => server === running && stopServer(), IDLE_MS)
  }
}
