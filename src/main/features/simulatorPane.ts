import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { get as httpGet, type ClientRequest } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, clipboard, nativeImage, shell, type WebContents } from 'electron'
import WebSocket from 'ws'
import { forPeople, type HardwareButton, type PaneDevice, type PaneSession, type PaneState, type SimOrientation, type TouchFrame } from '@shared/simulatorPane'
import {
  bootAndWait,
  devices,
  ensureEnvironment,
  execRun,
  newerFirst,
  programPath,
  runProgram,
  scaleOf,
  setPaneControl,
  setPaneReveal,
  setSimulatorDeps,
  SimulatorError,
  simctl,
  xcodeEnv,
  type SimDevice
} from './simulator'
import { buttonMessage, JpegFrames, jpegSize, keyFrames, message, pasteFrames, readConfig, TAG, textFrames, touchMessage, type KeyFrame } from './simulatorInput'
import { deviceLook } from './simulatorLook'
import type { Feature } from './types'

/**
 * Eaon's Device pane (the dock's Device surface): a simulator inside the app,
 * live, with its touches, keys, buttons and turns, and nothing else on
 * screen. As Orca does, it runs serve-sim on the booted device: a helper
 * that serves the screen as an MJPEG stream and takes input over a local
 * socket, all through Xcode's own simulator frameworks. simctl boots and
 * shuts devices down without opening Simulator or DeviceHub, and serve-sim's
 * own opening of Simulator (it keeps the device's display attached) is made
 * to open it hidden, in the background.
 *
 * One session per device, shared by every window showing it and by the
 * agent's ios_simulator tool; it ends a little after the last of them stops
 * looking. Without serve-sim (it failed to start), the pane shows simctl
 * screenshots one after another, to look at only.
 */

const XCRUN = '/usr/bin/xcrun'
/** How long a session outlives its last viewer, so switching tabs doesn't restart it. */
const LINGER_MS = 30_000
/** …and the agent's last tap, which has no viewer to keep it. */
const AGENT_LINGER_MS = 120_000
/** The least time between two screenshots in the fallback, so an idle screen doesn't keep simctl busy. */
const POLL_GAP_MS = 80
/** Between two key frames: the device drops presses that come closer together. */
const KEY_GAP_MS = 4

/* ------------------------------------------------------------- serve-sim */

/** serve-sim's command line: bundled with the app, unpacked from the archive (it has native parts). */
function serveSimEntry(): string {
  const override = process.env.EAON_SERVE_SIM
  if (override && !app.isPackaged) return override
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', '..', 'node_modules', 'serve-sim', 'dist', 'serve-sim.js').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
}

/**
 * A folder holding an `open` that serve-sim finds first on its PATH. It opens
 * Simulator (or DeviceHub) to keep the device's display attached; this opens
 * it hidden and behind, since the device is on show in Eaon instead.
 */
function quietOpen(): string {
  const dir = join(app.getPath('userData'), 'serve-sim', 'bin')
  const file = join(dir, 'open')
  const script = `#!/bin/sh
# Written by Eaon: the simulator shows in Eaon's Device pane, so its own window opens hidden.
for arg in "$@"; do
  case "$arg" in
    Simulator|Simulator.app|*/Simulator.app|com.apple.iphonesimulator|DeviceHub|DeviceHub.app|*/DeviceHub.app|com.apple.dt.Devices)
      exec /usr/bin/open -g -j "$@" ;;
  esac
done
exec /usr/bin/open "$@"
`
  try {
    mkdirSync(dir, { recursive: true })
    if (!existsSync(file) || readFileSync(file, 'utf8') !== script) writeFileSync(file, script)
    chmodSync(file, 0o755)
  } catch {
    // Without it serve-sim opens Simulator in front, which is only untidy.
  }
  return dir
}

/** Runs serve-sim with Eaon's own Node (Electron as Node); resolves with what it printed, rejects with its last error line. */
function runServeSim(args: string[], timeout = 60_000): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [serveSimEntry(), ...args], {
      // With the Xcode in use: serve-sim and its helper find it as xcrun does, by DEVELOPER_DIR when set.
      env: { ...process.env, ...xcodeEnv(), ELECTRON_RUN_AS_NODE: '1', PATH: `${quietOpen()}${delimiter}${process.env.PATH ?? '/usr/bin:/bin'}` },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('error', (error) => {
      clearTimeout(timer)
      fail(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) return done(stdout)
      const said = (stderr || stdout)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-1)[0]
      fail(new Error(said || `serve-sim stopped (${code ?? 'killed'})`))
    })
  })
}

/** The endpoints `serve-sim --detach -q` prints as JSON. */
export function readEndpoints(stdout: string): { streamUrl: string; wsUrl: string } | null {
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const json = JSON.parse(line) as { url?: string; streamUrl?: string; wsUrl?: string }
      const streamUrl = json.streamUrl ?? (json.url ? `${json.url.replace(/\/$/, '')}/stream.mjpeg` : undefined)
      if (streamUrl && json.wsUrl) return { streamUrl, wsUrl: json.wsUrl }
    } catch {
      // Not the JSON line.
    }
  }
  return null
}

/** Waits until something listens at the URL's port. */
async function reachable(url: string, within = 5000): Promise<boolean> {
  const { hostname, port } = new URL(url)
  const until = Date.now() + within
  while (Date.now() < until) {
    const open = await new Promise<boolean>((done) => {
      const socket = connect({ host: hostname, port: Number(port) })
      socket.once('connect', () => (socket.destroy(), done(true)))
      socket.once('error', () => (socket.destroy(), done(false)))
    })
    if (open) return true
    await new Promise((done) => setTimeout(done, 100))
  }
  return false
}

/**
 * Xcode 27's Device Hub, while it shows a device, takes its touches and keys
 * for itself (it sets this in the simulator), and serve-sim's input is
 * dropped. Unknown counts as free: input says for itself if it fails.
 */
async function deviceHubHasInput(udid: string): Promise<boolean> {
  try {
    const { stdout } = await runProgram(XCRUN, ['simctl', 'spawn', udid, 'notifyutil', '-g', 'com.apple.coredevice.dtuhidd.active'], { timeout: 5000 })
    return /\s1\s*$/.test(stdout)
  } catch {
    return false
  }
}

/* --------------------------------------------------------------- sessions */

class Session {
  readonly viewers = new Set<WebContents>()
  live = false
  problem: string | null = null
  orientation: SimOrientation = 'portrait'
  size: { width: number; height: number } | null = null
  last: Buffer | null = null
  /** Settles once serve-sim is up (live) or has failed (screenshots). */
  readonly started: Promise<void>
  private ws: WebSocket | null = null
  private request: ClientRequest | null = null
  private stopped = false
  private helper = false
  private linger: NodeJS.Timeout | null = null
  private firstFrame: Array<() => void> = []

  constructor(readonly udid: string) {
    this.started = this.start()
  }

  private async start(): Promise<void> {
    try {
      const endpoints = readEndpoints(await runServeSim(['--detach', '-q', this.udid], 90_000))
      this.helper = true
      if (!endpoints) throw new Error('it gave no stream to show')
      if (!(await reachable(endpoints.streamUrl))) throw new Error('its stream never opened')
      if (this.stopped) return
      this.connect(endpoints.wsUrl)
      this.watch(endpoints.streamUrl, 0)
      this.live = true
      if (await deviceHubHasInput(this.udid)) {
        this.live = false
        this.problem = 'Xcode’s Device Hub has this simulator’s touches and keyboard. Quit Device Hub to use it here.'
      }
    } catch (error) {
      if (this.stopped) return
      this.live = false
      this.problem = `The live screen couldn’t start (${forPeople((error as Error).message)}), so this shows screenshots and can’t be tapped.`
      void this.poll()
    }
    this.announce()
  }

  /** The control socket: input goes out, the screen's size and turn come back. Reconnects while the session lasts. */
  private connect(url: string): void {
    const ws = new WebSocket(url)
    this.ws = ws
    ws.on('message', (data: Buffer) => {
      const config = Buffer.isBuffer(data) ? readConfig(data) : null
      if (config?.orientation && config.orientation !== this.orientation) {
        this.orientation = config.orientation
        this.announce()
      }
    })
    ws.on('error', () => ws.close())
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null
      if (!this.stopped) setTimeout(() => !this.stopped && !this.ws && this.connect(url), 750)
    })
  }

  /** The MJPEG stream, frame by frame; picked up again if it drops, screenshots after three tries with nothing. */
  private watch(url: string, failures: number): void {
    const reader = new JpegFrames()
    let frames = 0
    const request = httpGet(url, (response) => {
      response.on('data', (chunk: Buffer) => {
        const frame = reader.push(chunk)
        if (frame && !this.stopped) {
          frames++
          this.send(frame)
        }
      })
      response.on('end', () => again())
      response.on('error', () => again())
    })
    request.on('error', () => again())
    this.request = request
    let ended = false
    const again = (): void => {
      if (ended || this.stopped) return
      ended = true
      const tries = frames ? 0 : failures + 1
      if (tries >= 3) {
        this.live = false
        this.problem = 'The live screen stopped, so this shows screenshots and can’t be tapped.'
        this.announce()
        void this.poll()
        return
      }
      setTimeout(() => !this.stopped && this.watch(url, tries), 1000)
    }
  }

  /** Screenshot after screenshot: what works with Xcode alone. */
  private async poll(): Promise<void> {
    const file = join(tmpdir(), `eaon-sim-view-${randomUUID()}.jpg`)
    try {
      while (!this.stopped) {
        const began = Date.now()
        try {
          await runProgram(XCRUN, ['simctl', 'io', this.udid, 'screenshot', '--type=jpeg', file], { timeout: 15_000 })
          if (this.stopped) break
          this.send(await readFile(file))
        } catch {
          // Not running (yet, or any more): look again in a moment.
          await new Promise((done) => setTimeout(done, 1000))
        }
        const wait = POLL_GAP_MS - (Date.now() - began)
        if (wait > 0) await new Promise((done) => setTimeout(done, wait))
      }
    } finally {
      await rm(file, { force: true })
    }
  }

  private send(frame: Buffer): void {
    if (this.last?.equals(frame)) return
    this.last = frame
    this.size = jpegSize(frame) ?? this.size
    if (!this.size) return
    for (const resolve of this.firstFrame.splice(0)) resolve()
    for (const viewer of this.viewers) {
      if (viewer.isDestroyed()) this.viewers.delete(viewer)
      else viewer.send('simulator:frame', { udid: this.udid, data: frame, width: this.size.width, height: this.size.height })
    }
  }

  /** The screen's size, once a frame has come (or after a few seconds, whatever there is). */
  async screen(): Promise<{ width: number; height: number } | null> {
    if (!this.size) await Promise.race([new Promise<void>((done) => this.firstFrame.push(done)), new Promise((done) => setTimeout(done, 5000))])
    return this.size
  }

  state(): PaneSession {
    return { udid: this.udid, live: this.live, problem: this.problem, orientation: this.orientation }
  }

  announce(): void {
    for (const viewer of this.viewers) if (!viewer.isDestroyed()) viewer.send('simulator:session', this.state())
  }

  /** Sends on the control socket; false when it isn't open. */
  post(data: Buffer): boolean {
    if (!this.live || this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(data)
    return true
  }

  /** Key presses, a few milliseconds apart, in order. */
  async keys(frames: KeyFrame[]): Promise<void> {
    for (const frame of frames) {
      if (!this.post(message(TAG.key, frame))) throw new Error('The simulator isn’t taking input right now.')
      await new Promise((done) => setTimeout(done, KEY_GAP_MS))
    }
  }

  /** Ends the session after `ms` unless someone looks again (keep). */
  release(ms: number): void {
    if (this.linger) clearTimeout(this.linger)
    this.linger = setTimeout(() => {
      if (this.viewers.size === 0) end(this.udid)
    }, ms)
  }

  keep(): void {
    if (this.linger) clearTimeout(this.linger)
    this.linger = null
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.keep()
    this.ws?.close()
    this.request?.destroy()
    for (const resolve of this.firstFrame.splice(0)) resolve()
    await this.started.catch(() => {})
    if (this.helper) await runServeSim(['--kill', this.udid], 20_000).catch(() => {})
  }
}

const sessions = new Map<string, Session>()

function sessionFor(udid: string): Session {
  let session = sessions.get(udid)
  if (!session) {
    session = new Session(udid)
    sessions.set(udid, session)
  }
  return session
}

function end(udid: string): Promise<void> {
  const session = sessions.get(udid)
  if (!session) return Promise.resolve()
  sessions.delete(udid)
  return session.stop()
}

function watchFor(udid: string, viewer: WebContents): void {
  const session = sessionFor(udid)
  session.keep()
  if (!session.viewers.has(viewer)) {
    session.viewers.add(viewer)
    viewer.once('destroyed', () => unwatch(udid, viewer))
  }
  // Someone new sees the screen at once, not at its next change.
  viewer.send('simulator:session', session.state())
  if (session.last && session.size) viewer.send('simulator:frame', { udid, data: session.last, width: session.size.width, height: session.size.height })
}

function unwatch(udid: string, viewer: WebContents): void {
  const session = sessions.get(udid)
  if (!session) return
  session.viewers.delete(viewer)
  if (session.viewers.size === 0) session.release(LINGER_MS)
}

/** The session, live, for input: it starts one if none is running and says why when it can't take input. */
async function liveSession(udid: string): Promise<Session> {
  const session = sessionFor(udid)
  await session.started
  if (!session.live) throw new Error(session.problem ?? 'The simulator isn’t taking input right now.')
  return session
}

/** Types text: as key presses when it is all on a US keyboard, else onto the device's pasteboard and pasted. */
async function typeText(session: Session, text: string): Promise<void> {
  const frames = textFrames(text)
  if (frames) return session.keys(frames)
  await pasteboard(session.udid, text)
  await session.keys(pasteFrames)
}

/** Text onto the device's own pasteboard. */
function pasteboard(udid: string, text: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(programPath(XCRUN), ['simctl', 'pbcopy', udid], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, ...xcodeEnv() } })
    child.on('error', fail)
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error('The clipboard couldn’t be sent to the device.'))))
    child.stdin?.end(text)
  })
}

/* ------------------------------------------------------------------ state */

function problemOf(error: unknown): PaneState['problem'] {
  const message = forPeople(error instanceof Error ? error.message : String(error))
  if (/only runs on macOS/i.test(message)) return { kind: 'platform', message: 'The iOS Simulator runs on a Mac.' }
  if (/runtime/i.test(message)) return { kind: 'devices', message }
  if (/Xcode|developer folder|Command Line Tools|license/i.test(message)) return { kind: 'xcode', message }
  return { kind: 'other', message }
}

const paneDevice = (d: SimDevice): PaneDevice => ({ udid: d.udid, name: d.name, runtime: d.runtime, state: d.state })

async function state(): Promise<PaneState> {
  try {
    await ensureEnvironment()
    const all = (await devices()).filter((d) => /^(iOS|iPadOS)/i.test(d.runtime) && /iPhone|iPad/i.test(d.name)).sort(newerFirst)
    return { problem: null, devices: all.map(paneDevice) }
  } catch (error) {
    return { problem: problemOf(error), devices: [] }
  }
}

async function find(udid: string): Promise<SimDevice> {
  const found = (await devices()).find((d) => d.udid === udid)
  if (!found) throw new SimulatorError('That simulator is gone. Pick another.')
  return found
}

/* ---------------------------------------------------------------- actions */

const stamp = (): string => {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`
}

const fileName = (kind: string, name: string, ext: string): string => `${kind} - ${name.replace(/[/:]/g, '-')} - ${stamp()}.${ext}`

/** A screenshot to the Desktop (as Simulator saves them), the clipboard, or a file for the chat to attach. */
async function screenshot(udid: string, to: 'desktop' | 'clipboard' | 'chat'): Promise<string | null> {
  const target = await find(udid)
  const folder = to === 'desktop' ? app.getPath('desktop') : join(tmpdir(), 'eaon-simulator')
  await mkdir(folder, { recursive: true })
  const file = join(folder, fileName('Simulator Screenshot', target.name, 'png'))
  await simctl(['io', udid, 'screenshot', '--type=png', file])
  if (to === 'clipboard') {
    clipboard.writeImage(nativeImage.createFromPath(file))
    await rm(file, { force: true })
    return null
  }
  return file
}

const recordings = new Map<string, { child: ChildProcess; file: string }>()

async function record(udid: string, on: boolean): Promise<string | null> {
  const running = recordings.get(udid)
  if (on) {
    if (running) return null
    const target = await find(udid)
    const file = join(app.getPath('desktop'), fileName('Simulator Recording', target.name, 'mov'))
    const child = spawn(programPath(XCRUN), ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', file], { stdio: 'ignore', env: { ...process.env, ...xcodeEnv() } })
    recordings.set(udid, { child, file })
    child.on('exit', () => {
      if (recordings.get(udid)?.child === child) recordings.delete(udid)
    })
    return null
  }
  if (!running) return null
  recordings.delete(udid)
  // simctl finishes the movie on an interrupt, as Control-C would.
  const ended = new Promise<void>((done) => {
    running.child.once('exit', () => done())
    setTimeout(done, 10_000)
  })
  running.child.kill('SIGINT')
  await ended
  return existsSync(running.file) ? running.file : null
}

/** Errors reach the pane as sentences for people. */
async function said<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw new Error(forPeople(error instanceof Error ? error.message : String(error)))
  }
}

export const simulatorPaneFeature: Feature = {
  id: 'simulatorPane',
  register(ctx) {
    // Development only: Xcode's tools played by stand-ins in a folder, for testing the pane on a Mac without Xcode.
    const fake = process.env.EAON_SIM_FAKE
    if (fake && !app.isPackaged) {
      const program = (file: string): string => (/^\/usr\/bin\/(xcrun|xcode-select|xcodebuild|plutil)$/.test(file) ? join(fake, basename(file)) : file)
      setSimulatorDeps({ program, run: (file, args, options) => execRun(program(file), args, options), exists: (path) => path.startsWith('/Applications/Xcode') || existsSync(path) })
    }

    setPaneReveal((udid) => {
      if (ctx.getWindows().length === 0) return false
      ctx.send('simulator:reveal', udid)
      return true
    })

    // The agent's taps, in the device's points: the screenshot it took is in pixels of the screen's native frame.
    setPaneControl({
      async input(target, act) {
        const session = await liveSession(target.udid)
        session.release(AGENT_LINGER_MS)
        if (act.kind === 'type') return typeText(session, act.text)
        if (act.kind === 'button') {
          session.post(buttonMessage(act.name))
          return
        }
        const size = await session.screen()
        if (!size) throw new Error('The simulator’s screen hasn’t shown yet.')
        const scale = await scaleOf(target)
        const at = (x: number, y: number): { x: number; y: number } => ({
          x: Math.min(1, Math.max(0, x / (size.width / scale))),
          y: Math.min(1, Math.max(0, y / (size.height / scale)))
        })
        const from = at(act.x, act.y)
        const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
        session.post(touchMessage({ type: 'begin', ...from }))
        if (act.kind === 'swipe') {
          const to = at(act.toX, act.toY)
          for (let i = 1; i <= 10; i++) {
            await pause(30)
            session.post(touchMessage({ type: 'move', x: from.x + ((to.x - from.x) * i) / 10, y: from.y + ((to.y - from.y) * i) / 10 }))
          }
          session.post(touchMessage({ type: 'end', ...to }))
        } else {
          await pause(40)
          session.post(touchMessage({ type: 'end', ...from }))
        }
      }
    })

    ctx.ipcMain.handle('simulator:state', () => state())
    ctx.ipcMain.handle('simulator:look', async (_event, udid: string) => deviceLook(await find(udid)).catch(() => null))
    ctx.ipcMain.handle('simulator:watch', (event, udid: string) => watchFor(udid, event.sender))
    ctx.ipcMain.handle('simulator:unwatch', (event, udid: string) => unwatch(udid, event.sender))
    // Starts serve-sim afresh, for a session that fell back to screenshots.
    ctx.ipcMain.handle('simulator:reconnect', async (event, udid: string) => {
      await end(udid)
      watchFor(udid, event.sender)
    })
    ctx.ipcMain.handle('simulator:boot', (_event, udid: string) =>
      said(async () => {
        const stuck = await bootAndWait(await find(udid))
        if (stuck) throw new Error(stuck)
      })
    )
    ctx.ipcMain.handle('simulator:shutdown', (_event, udid: string) =>
      said(async () => {
        await record(udid, false)
        await end(udid)
        await simctl(['shutdown', udid])
      })
    )
    // Touches and key presses as they happen: sent, not asked, so a drag doesn't wait on replies.
    ctx.ipcMain.on('simulator:touch', (_event, udid: string, touch: TouchFrame) => {
      sessions.get(udid)?.post(touchMessage(touch))
    })
    ctx.ipcMain.on('simulator:key', (_event, udid: string, key: string, shift: boolean) => {
      const frames = keyFrames(key, shift)
      if (frames) void sessions.get(udid)?.keys(frames).catch(() => {})
    })
    ctx.ipcMain.handle('simulator:button', (_event, udid: string, name: HardwareButton) =>
      said(async () => {
        if (!(await liveSession(udid)).post(buttonMessage(name))) throw new Error('The simulator isn’t taking input right now.')
      })
    )
    ctx.ipcMain.handle('simulator:rotate', (_event, udid: string, orientation: SimOrientation) =>
      said(async () => {
        if (!(await liveSession(udid)).post(message(TAG.rotate, { orientation }))) throw new Error('The simulator isn’t taking input right now.')
      })
    )
    ctx.ipcMain.handle('simulator:appearance', (_event, udid: string, mode?: 'light' | 'dark') =>
      said(async () => {
        if (mode) await simctl(['ui', udid, 'appearance', mode])
        const now = (await simctl(['ui', udid, 'appearance'])).trim()
        return now === 'dark' || now === 'light' ? now : null
      })
    )
    ctx.ipcMain.handle('simulator:open-url', (_event, udid: string, url: string) =>
      said(async () => {
        if (!/^[a-z][\w+.-]*:/i.test(url)) throw new Error('That isn’t a link: it needs to start with https:// or an app’s scheme.')
        await simctl(['openurl', udid, url])
      })
    )
    // Pasting types the Mac's clipboard into the field in focus; "pasteboard" only puts it on the device's, to paste there.
    ctx.ipcMain.handle('simulator:paste', (_event, udid: string, how: 'type' | 'pasteboard') =>
      said(async () => {
        const text = clipboard.readText()
        if (how === 'pasteboard') return pasteboard(udid, text)
        if (text) await typeText(await liveSession(udid), text)
      })
    )
    ctx.ipcMain.handle('simulator:screenshot', (_event, udid: string, to: 'desktop' | 'clipboard' | 'chat') => said(() => screenshot(udid, to)))
    ctx.ipcMain.handle('simulator:record', (_event, udid: string, on: boolean) => said(() => record(udid, on)))
    ctx.ipcMain.handle('simulator:show-file', (_event, file: string) => shell.showItemInFolder(file))
    ctx.ipcMain.handle('simulator:get-xcode', () => shell.openExternal('macappstores://apps.apple.com/app/id497799835'))
  },
  dispose() {
    for (const { child } of recordings.values()) child.kill('SIGINT')
    setPaneReveal(null)
    setPaneControl(null)
  },
  // serve-sim's helpers are their own processes: each is stopped, not left running after Eaon quits.
  async shutdown() {
    await Promise.all([...sessions.keys()].map((udid) => end(udid)))
  }
}
