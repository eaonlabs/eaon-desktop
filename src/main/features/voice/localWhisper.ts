import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import {
  LOCAL_SPEECH_MODELS,
  hubSpeechEnglishOnly,
  hubSpeechId,
  hubSpeechLabel,
  localSpeechModel,
  localSpeechUrl,
  speechIdFor,
  type LocalSpeechModel,
  type LocalSpeechState
} from '@shared/speech'
import { hubFileInfo, hubFileUrl } from './speechHub'

/**
 * Dictation on this computer: whisper.cpp's `whisper-server`, bundled with
 * Eaon (resources/whisper, built by scripts/build-whisper.sh), running a model
 * downloaded once from Hugging Face. The recording never leaves the machine.
 *
 * The server starts on the first dictation and keeps the model loaded, so the
 * next one is quick; after a few idle minutes it is stopped and the memory
 * given back. Models live in <userData>/speech-models, checked against their
 * SHA-256 before they are used. Beside the three listed in @shared/speech,
 * any whisper.cpp model on Hugging Face can be downloaded (speechHub.ts):
 * those live in speech-models/hub, listed in its library.json, checked
 * against the SHA-256 Hugging Face keeps for the file and, before a byte
 * more is fetched, against whisper.cpp's own file signature.
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
const hubDir = (): string => join(modelsDir(), 'hub')
const libraryPath = (): string => join(hubDir(), 'library.json')
const modelPath = (model: LocalSpeechModel): string => (model.repoId ? join(hubDir(), model.file) : join(modelsDir(), model.file))

/** What whisper.cpp's model files start with: "ggml" as a little-endian number. GGUF and the rest don't. */
const GGML_MAGIC = Buffer.from('lmgg', 'latin1')

/** The models downloaded from Hugging Face, as library.json lists them. */
function hubModels(): LocalSpeechModel[] {
  try {
    const list = JSON.parse(readFileSync(libraryPath(), 'utf8')) as LocalSpeechModel[]
    return Array.isArray(list) ? list.filter((m) => m && typeof m.id === 'string' && typeof m.file === 'string' && m.repoId) : []
  } catch {
    return []
  }
}

async function saveHubModels(list: LocalSpeechModel[]): Promise<void> {
  await mkdir(hubDir(), { recursive: true })
  await writeFile(libraryPath(), JSON.stringify(list, null, 2))
}

/** A model by id: one of the listed ones, or one downloaded from Hugging Face. */
const modelById = (id: string): LocalSpeechModel | undefined => localSpeechModel(id, hubModels())

/** What to call a model in messages: "Whisper Base", or a Hugging Face model's name. */
export const localSpeechLabel = (id: string): string => modelById(id)?.label ?? 'Whisper'

/* ----------------------------------------------------------------- downloads */

let downloading: { id: string; label: string; bytes: number; progress: number; abort: AbortController } | null = null
let lastError: string | null = null
let notify: () => void = () => {}

/** Told whenever downloads or the model list change, so Settings can follow. */
export function onLocalSpeechChange(listener: () => void): void {
  notify = listener
}

export async function localSpeechState(): Promise<LocalSpeechState> {
  const downloaded: string[] = []
  for (const model of LOCAL_SPEECH_MODELS) if (existsSync(modelPath(model))) downloaded.push(model.id)
  const hub = hubModels().filter((model) => existsSync(modelPath(model)))
  downloaded.push(...hub.map((model) => model.id))
  return {
    available: whisperBinary() !== null,
    downloaded,
    downloading: downloading ? { id: downloading.id, label: downloading.label, bytes: downloading.bytes, progress: downloading.progress } : null,
    error: lastError,
    hub
  }
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/** One of the listed models, downloaded from whisper.cpp's own repo. */
export async function downloadLocalSpeechModel(id: string): Promise<void> {
  const model = localSpeechModel(id)
  if (!model) throw new Error('Unknown speech model.')
  await downloadModel(model, localSpeechUrl(model))
}

/**
 * A whisper.cpp model from any Hugging Face repo (Settings → Speech to text →
 * Find more). Its size and SHA-256 come from Hugging Face's own listing of
 * the repo; its first bytes are read before the rest, so a file whisper.cpp
 * can't load (a GGUF, say) is turned away without downloading it.
 */
export async function downloadHubSpeechModel(repoId: string, filename: string): Promise<string> {
  // One of the listed models, found on Hugging Face: the same file, kept once.
  const listed = speechIdFor(repoId, filename)
  if (localSpeechModel(listed)) {
    await downloadLocalSpeechModel(listed)
    return listed
  }
  const id = hubSpeechId(repoId, filename)
  if (downloading) throw new Error('Another speech model is downloading.')
  const known = hubModels().find((m) => m.id === id)
  if (known && existsSync(modelPath(known))) return id
  const info = await hubFileInfo(repoId, filename)
  const url = hubFileUrl(repoId, filename)
  if (!(await startsLikeWhisperModel(url))) {
    throw new Error(`${hubSpeechLabel(repoId, filename)} isn’t a whisper.cpp model, so it can’t run here. Pick another file.`)
  }
  const model: LocalSpeechModel = {
    id,
    label: hubSpeechLabel(repoId, filename),
    blurb: repoId,
    file: `${repoId.replace(/[^\w.-]+/g, '__')}__${filename.replace(/[^\w.-]+/g, '_')}`,
    bytes: info.bytes,
    sha256: info.sha256,
    englishOnly: hubSpeechEnglishOnly(filename),
    repoId
  }
  await downloadModel(model, url)
  await saveHubModels([...hubModels().filter((m) => m.id !== id), model])
  notify()
  return id
}

/** Whether a file on Hugging Face begins as whisper.cpp's models do: its first four bytes, and no more. */
async function startsLikeWhisperModel(url: string): Promise<boolean> {
  const response = await fetch(url, { headers: { Range: 'bytes=0-3' }, signal: AbortSignal.timeout(20_000) }).catch(() => null)
  if (!response?.ok || !response.body) throw new Error('Couldn’t reach Hugging Face. Check your connection and try again.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (length < 4) {
    const { done, value } = await reader.read()
    if (done || !value) break
    chunks.push(value)
    length += value.length
  }
  // A server that ignores the range sends the whole file: stop it there.
  await reader.cancel().catch(() => {})
  return Buffer.concat(chunks).subarray(0, 4).equals(GGML_MAGIC)
}

/**
 * Downloads a model, picking up where an interrupted download left off. The
 * file only takes its real name once its checksum matches, so a half or
 * damaged download is never loaded.
 */
async function downloadModel(model: LocalSpeechModel, url: string): Promise<void> {
  if (downloading) throw new Error('Another speech model is downloading.')
  if (existsSync(modelPath(model))) return
  await mkdir(model.repoId ? hubDir() : modelsDir(), { recursive: true })
  const part = `${modelPath(model)}.part`
  const abort = new AbortController()
  downloading = { id: model.id, label: model.label, bytes: model.bytes, progress: 0, abort }
  lastError = null
  notify()
  try {
    const have = await stat(part).then((s) => s.size).catch(() => 0)
    const response = await fetch(url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {}, signal: abort.signal })
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
  const model = modelById(id)
  if (!model) return
  if (server?.modelId === id) stopServer()
  await rm(modelPath(model), { force: true })
  await rm(`${modelPath(model)}.part`, { force: true })
  if (model.repoId) await saveHubModels(hubModels().filter((m) => m.id !== id))
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
  const model = modelById(modelId)
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
