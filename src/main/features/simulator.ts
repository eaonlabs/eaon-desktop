import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { release, tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { nativeImage } from 'electron'
import { registerToolSource, type AgentTool } from '../agent/tools'

/**
 * `ios_simulator`: Xcode's iOS Simulator through `xcrun simctl` — boot a
 * device, install and launch apps, open links, switch light and dark, and
 * take screenshots at the device's own resolution (for capturing every
 * screen of an app). simctl can't tap, type or rotate, so those go through
 * the computer tool on the simulator's window, which the guidance says.
 *
 * A simulator is a simulated iPhone running on the Mac, not the user's own
 * phone: none of their apps, accounts or data are on it. The user's real
 * iPhone is reachable only through iPhone Mirroring (see
 * `iphoneMirroringAvailability`), and nothing here may suggest otherwise.
 *
 * macOS only, offered with computer use (the user has said the agent may
 * drive their devices), to the main agent only.
 */

interface SimDevice {
  name: string
  udid: string
  state: string
  runtime: string
}

const LONG_EDGE = 1280

/* ------------------------------------------------------------ dependencies */

export interface RunResult {
  stdout: string
  stderr: string
}

export interface RunOptions {
  timeout: number
  signal?: AbortSignal
}

/**
 * Everything this tool asks of the machine, so tests can play a Mac with or
 * without Xcode, a hung boot or a crashing app, without any of them.
 */
export interface SimulatorDeps {
  /** Runs a program; rejects with `stderr` on the error, `killed` on a timeout, and an AbortError when `signal` fires. */
  run: (file: string, args: string[], options: RunOptions) => Promise<RunResult>
  exists: (path: string) => boolean
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  platform: NodeJS.Platform
  /** The Darwin kernel release (`os.release()`), e.g. "24.1.0" on macOS 15. */
  osRelease: () => string
  now: () => number
}

/**
 * The real runner. `signal` kills the child (execFile's own abort), and so
 * does `timeout`, so a hung `simctl bootstatus` never outlives the call.
 */
export function execRun(file: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((done, fail) => {
    execFile(
      file,
      args,
      { timeout: options.timeout, signal: options.signal, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) fail(Object.assign(error, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }))
        else done({ stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })
}

function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    if (signal?.aborted) return fail(new Error('Stopped by the user.'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      done()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      fail(new Error('Stopped by the user.'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const realDeps: SimulatorDeps = {
  run: execRun,
  exists: existsSync,
  sleep: realSleep,
  platform: process.platform,
  osRelease: release,
  now: Date.now
}

let deps: SimulatorDeps = realDeps

/** Tests swap in fakes; null puts the real machine back and forgets what was learned about it. */
export function setSimulatorDeps(replacement: Partial<SimulatorDeps> | null): void {
  deps = replacement ? { ...realDeps, ...replacement } : realDeps
  environment = null
  viewerFound = null
  shown.clear()
}

/* ------------------------------------------------------------- environment */

/**
 * The oldest Xcode treated as supported. Every simctl subcommand used here
 * (`list -j`, `bootstatus -b`, `ui … appearance`, `location … set`,
 * `io screenshot`, `listapps`, `spawn`) is there from Xcode 12 on; older
 * versions lack some of them (`ui … appearance` arrived in 11.4), and the
 * failure would otherwise surface as a usage dump mid-task.
 */
export const MIN_XCODE_MAJOR = 12

/** Where the App Store and Apple's downloads put Xcode. */
const XCODE_APPS = ['/Applications/Xcode.app', '/Applications/Xcode-beta.app']

/** How long a good environment check stands before it is made again. A failure is never cached. */
const ENVIRONMENT_TTL_MS = 60_000

const BOOT_TIMEOUT_MS = 180_000

let environment: { at: number; developer: string } | null = null

/** A tool error whose message is already written for the model and the user: say it as it is. */
export class SimulatorError extends Error {}

const stderrOf = (error: unknown): string => String((error as { stderr?: unknown })?.stderr ?? '').trim()

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (error as { name?: string })?.name === 'AbortError'
}

const LICENSE = /not agreed to the Xcode (and Apple SDKs )?license|xcodebuild -license|license agreements?/i
const FIRST_LAUNCH = /runFirstLaunch|required plugin failed to load|CoreSimulator is out of date|install (the )?additional (required )?components/i
const NO_DEVELOPER_DIR = /unable to get active developer directory|invalid active developer path|missing xcrun|missing DEVELOPER_DIR/i
const NO_SIMCTL = /unable to find utility "simctl"|requires Xcode, but active developer directory .* is a command line tools instance/i

const licenseError = (): SimulatorError =>
  new SimulatorError(
    "Xcode's license hasn't been accepted on this Mac, so the Simulator can't run. Ask the user to open Xcode once and agree to the license (or run `sudo xcodebuild -license accept` in Terminal), then try again."
  )

const firstLaunchError = (): SimulatorError =>
  new SimulatorError(
    "Xcode hasn't finished installing its components, so the Simulator can't run. Ask the user to open Xcode once and let it install what it asks for (or run `xcodebuild -runFirstLaunch` in Terminal), then try again."
  )

function installedXcode(): string | null {
  return XCODE_APPS.find((path) => deps.exists(path)) ?? null
}

/** No full Xcode is selected: say whether one is installed (select it) or not (install it). */
function noXcodeError(reason: 'none' | 'clt'): SimulatorError {
  const app = installedXcode()
  if (app) {
    return new SimulatorError(
      `Xcode is installed at ${app}, but ${reason === 'clt' ? 'the Command Line Tools are selected instead' : 'no developer folder is selected'}, so the Simulator can't run. Ask the user to run \`sudo xcode-select -s ${app}/Contents/Developer\` in Terminal, or to choose Xcode in Xcode → Settings → Locations → Command Line Tools, then try again.`
    )
  }
  return new SimulatorError(
    reason === 'clt'
      ? "Only Apple's Command Line Tools are installed; the iOS Simulator needs the full Xcode. Ask the user to install Xcode from the App Store and open it once, then try again."
      : 'The iOS Simulator needs Xcode, which is not installed on this Mac. Ask the user to install Xcode from the App Store and open it once, then try again.'
  )
}

/** "Xcode 16.4\nBuild version 16F6" → 16. */
export function xcodeMajor(versionOutput: string): number | null {
  const match = /^Xcode\s+(\d+)/m.exec(versionOutput)
  return match ? Number(match[1]) : null
}

/**
 * Checks, in order, everything the Simulator needs, and stops at the first
 * thing missing with what to do about it: a selected developer folder that
 * is a full Xcode, a supported Xcode version, its license accepted and its
 * components installed, and at least one iOS runtime. Returns the developer
 * folder. A good answer is kept for a minute; a bad one is asked again next
 * time, so the user fixing it takes effect at once.
 */
async function ensureEnvironment(signal?: AbortSignal): Promise<string> {
  if (deps.platform !== 'darwin') throw new SimulatorError('The iOS Simulator only runs on macOS.')
  if (environment && deps.now() - environment.at < ENVIRONMENT_TTL_MS) return environment.developer

  let developer: string
  try {
    developer = (await deps.run('/usr/bin/xcode-select', ['-p'], { timeout: 10_000, signal })).stdout.trim()
  } catch (error) {
    if (isAbort(error, signal)) throw new Error('Stopped by the user.')
    throw noXcodeError('none')
  }
  if (!developer) throw noXcodeError('none')
  if (/CommandLineTools/i.test(developer) || !/\.app\/Contents\/Developer\/?$/.test(developer)) throw noXcodeError('clt')
  if (!deps.exists(developer)) {
    throw new SimulatorError(
      `The selected Xcode (${developer.replace(/\/Contents\/Developer\/?$/, '')}) is no longer there. Ask the user to reinstall Xcode, or to select another with \`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer\`, then try again.`
    )
  }

  try {
    const { stdout } = await deps.run('/usr/bin/xcodebuild', ['-version'], { timeout: 30_000, signal })
    const major = xcodeMajor(stdout)
    if (major !== null && major < MIN_XCODE_MAJOR) {
      throw new SimulatorError(
        `The selected Xcode is version ${stdout.split('\n')[0].replace(/^Xcode\s+/, '')}, and Eaon's Simulator tool needs Xcode ${MIN_XCODE_MAJOR} or later. Ask the user to update Xcode from the App Store (or select a newer one with \`sudo xcode-select -s\`), then try again.`
      )
    }
  } catch (error) {
    if (error instanceof SimulatorError) throw error
    if (isAbort(error, signal)) throw new Error('Stopped by the user.')
    const stderr = stderrOf(error)
    if (LICENSE.test(stderr)) throw licenseError()
    if (FIRST_LAUNCH.test(stderr)) throw firstLaunchError()
    if (NO_SIMCTL.test(stderr) || NO_DEVELOPER_DIR.test(stderr)) throw noXcodeError('clt')
    // Anything else: simctl below will say what is wrong, if anything is.
  }

  const runtimes = await simctl(['list', 'runtimes', '-j'], { timeout: 60_000, signal, checked: false })
  if (iosRuntimes(runtimes).length === 0) {
    throw new SimulatorError(
      'Xcode is installed, but no iOS Simulator runtime is. Ask the user to download one in Xcode → Settings → Components ("Platforms" in older versions), or with `xcodebuild -downloadPlatform iOS` in Terminal, then try again.'
    )
  }
  environment = { at: deps.now(), developer }
  return developer
}

/** The available iOS runtimes in `simctl list runtimes -j`. */
export function iosRuntimes(json: string): { name: string; identifier: string }[] {
  try {
    const parsed = JSON.parse(json) as { runtimes?: { name?: string; identifier?: string; platform?: string; isAvailable?: boolean }[] }
    return (parsed.runtimes ?? [])
      .filter((r) => r.isAvailable !== false && (r.platform === 'iOS' || /SimRuntime\.iOS-/.test(r.identifier ?? '') || /^iOS\b/.test(r.name ?? '')))
      .map((r) => ({ name: r.name ?? '', identifier: r.identifier ?? '' }))
  } catch {
    return []
  }
}

/**
 * One simctl call. Failures come back in words: Xcode gone or unselected,
 * license, missing components, a device that isn't running; anything else
 * as simctl's own last lines. Any failure also makes the next call check the
 * environment again.
 */
async function simctl(args: string[], options: { timeout?: number; signal?: AbortSignal; checked?: boolean } = {}): Promise<string> {
  const { timeout = 60_000, signal, checked = true } = options
  if (checked) await ensureEnvironment(signal)
  try {
    return (await deps.run('/usr/bin/xcrun', ['simctl', ...args], { timeout, signal })).stdout
  } catch (error) {
    environment = null
    if (isAbort(error, signal)) throw new Error('Stopped by the user.')
    const stderr = stderrOf(error)
    if (NO_SIMCTL.test(stderr)) throw noXcodeError('clt')
    if (NO_DEVELOPER_DIR.test(stderr)) throw noXcodeError('none')
    if (LICENSE.test(stderr)) throw licenseError()
    if (FIRST_LAUNCH.test(stderr)) throw firstLaunchError()
    if ((error as { killed?: boolean }).killed) {
      throw new SimulatorError(`simctl ${args[0]} did not finish within ${Math.round(timeout / 1000)} s and was stopped.`)
    }
    if (/current state: (Shutdown|Shutting Down)|Invalid device state|No devices are booted/i.test(stderr)) {
      throw new SimulatorError('That simulator is not running. Boot it first (action "boot"), then try again.')
    }
    if (/Invalid device:/i.test(stderr)) throw new SimulatorError('That simulator no longer exists. Use "list" to see the ones there are.')
    throw new Error(stderr.split('\n').filter(Boolean).slice(-3).join(' ') || (error as Error).message)
  }
}

/* ---------------------------------------------------------------- devices */

export function parseDevices(json: string): SimDevice[] {
  const parsed = JSON.parse(json) as { devices?: Record<string, { name: string; udid: string; state: string; isAvailable?: boolean }[]> }
  const out: SimDevice[] = []
  for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
    const label = runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-/g, ' ')
    for (const d of devices) if (d.isAvailable !== false) out.push({ name: d.name, udid: d.udid, state: d.state, runtime: label })
  }
  return out
}

/** "iOS 26.5" → [26, 5], for picking the newest. */
function runtimeVersion(label: string): number[] {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(label)
  return match ? match.slice(1).map((n) => Number(n ?? 0)) : [0]
}

function newerFirst(a: SimDevice, b: SimDevice): number {
  const va = runtimeVersion(a.runtime)
  const vb = runtimeVersion(b.runtime)
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] ?? 0) - (va[i] ?? 0)
    if (d) return d
  }
  return 0
}

async function devices(signal?: AbortSignal): Promise<SimDevice[]> {
  return parseDevices(await simctl(['list', 'devices', 'available', '-j'], { signal }))
}

/** The booted ones, and a sentence saying which was picked when there was a choice. */
function pickBooted(all: SimDevice[]): { device: SimDevice; note: string } | null {
  const booted = all.filter((d) => d.state === 'Booted')
  if (booted.length === 0) return null
  const note =
    booted.length > 1
      ? `${booted.length} simulators are running (${booted.map((d) => d.name).join(', ')}); this used ${booted[0].name}. Pass "device" to act on another.`
      : ''
  return { device: booted[0], note }
}

/**
 * A device by udid or name (a booted one first); "booted" or nothing means
 * the running one. `needsBooted` refuses a device that isn't running rather
 * than letting simctl fail with "Unable to lookup in current state".
 */
async function device(wanted: unknown, signal?: AbortSignal, needsBooted = true): Promise<{ device: SimDevice; note: string }> {
  const all = await devices(signal)
  const name = typeof wanted === 'string' ? wanted.trim() : ''
  if (!name || name.toLowerCase() === 'booted') {
    const picked = pickBooted(all)
    if (!picked) throw new SimulatorError('No simulator is running. Boot one first: action "boot" (with no device it starts an iPhone).')
    return picked
  }
  const matches = all.filter((d) => d.udid === name || d.name.toLowerCase() === name.toLowerCase())
  const found = matches.find((d) => d.state === 'Booted') ?? [...matches].sort(newerFirst)[0]
  if (!found) throw new SimulatorError(`No simulator called "${name}". Use "list" to see them.`)
  if (needsBooted && found.state !== 'Booted') {
    throw new SimulatorError(`${found.name} (${found.runtime}) is not running. Boot it first: action "boot" with device "${found.name}".`)
  }
  return { device: found, note: '' }
}

/** What "boot" with no device starts: the running one, else an iPhone on the newest iOS. */
async function bootTarget(wanted: unknown, signal?: AbortSignal): Promise<{ device: SimDevice; note: string }> {
  const name = typeof wanted === 'string' ? wanted.trim() : ''
  if (name && name.toLowerCase() !== 'booted') return device(name, signal, false)
  const all = await devices(signal)
  const running = pickBooted(all)
  if (running) return running
  const phones = all.filter((d) => /^iPhone/i.test(d.name) && /^iOS/i.test(d.runtime)).sort(newerFirst)
  if (phones.length === 0) {
    throw new SimulatorError(
      all.length
        ? `There is no iPhone simulator to boot. Boot one of these by name instead: ${all.slice(0, 8).map((d) => d.name).join(', ')}; or ask the user to add an iPhone in Xcode's Devices and Simulators window.`
        : "There are no simulators on this Mac. Ask the user to add an iPhone in Xcode's Devices and Simulators window."
    )
  }
  return { device: phones[0], note: `No device was named, so this started ${phones[0].name}.` }
}

/* ----------------------------------------------------------------- viewer */

/**
 * The app that shows simulators on screen. Xcode 27 replaced Simulator.app
 * with DeviceHub (com.apple.dt.Devices, windows owned by "Device Hub"), and
 * LaunchServices can still point "Simulator" at the old, deleted path — so
 * `open -a Simulator` fails there. Found by path inside the selected Xcode.
 */
interface Viewer {
  bundleId: string
  path: string
  /** The window owner name, for the computer tool's screenshot app: "…". */
  windowApp: string
}

let viewerFound: Viewer | null = null

export function viewerCandidates(developerDir: string): Viewer[] {
  const contents = dirname(developerDir)
  return [
    { bundleId: 'com.apple.dt.Devices', path: join(contents, 'Applications/DeviceHub.app'), windowApp: 'Device Hub' },
    { bundleId: 'com.apple.iphonesimulator', path: join(developerDir, 'Applications/Simulator.app'), windowApp: 'Simulator' }
  ]
}

async function viewer(signal?: AbortSignal): Promise<Viewer> {
  if (viewerFound && deps.exists(viewerFound.path)) return viewerFound
  const developer = await ensureEnvironment(signal)
  const found = viewerCandidates(developer).find((v) => deps.exists(v.path))
  if (!found) throw new Error(`neither DeviceHub nor Simulator is in the selected Xcode (${developer})`)
  viewerFound = found
  return found
}

/** Devices whose window has been brought to the front once; later steps leave focus alone. */
const shown = new Set<string>()

/** How to rotate and type, which simctl can't do, for the window the device shows in. */
function handsOn(v: Viewer): string {
  return v.windowApp === 'Simulator'
    ? `To tap, type or swipe, use the computer tool with screenshot app: "Simulator"; rotate with cmd+left / cmd+right (Device → Rotate Left/Right) while it is in front.`
    : `To tap, type or swipe, use the computer tool with screenshot app: "${v.windowApp}".`
}

/**
 * Puts the simulator's window on screen, so the user sees what the agent
 * does. The first time for a device it comes to the front; after that it is
 * only (re)opened behind, without taking focus. Returns a sentence for the
 * result either way: failing to show the window doesn't fail the action.
 */
async function showDevice(target: SimDevice, signal?: AbortSignal, front = !shown.has(target.udid)): Promise<string> {
  try {
    const v = await viewer(signal)
    const args = [...(front ? [] : ['-g']), '-a', v.path]
    if (v.bundleId === 'com.apple.iphonesimulator') args.push('--args', '-CurrentDeviceUDID', target.udid)
    await deps.run('/usr/bin/open', args, { timeout: 15_000, signal })
    shown.add(target.udid)
    return front ? `It is showing on the user's screen in ${v.windowApp}. ${handsOn(v)}` : ''
  } catch (error) {
    if (isAbort(error, signal)) throw new Error('Stopped by the user.')
    const stderr = stderrOf(error)
    return `It runs in the background, but its window could not be opened (${stderr || (error as Error).message}), so the user can't see it; say so.`
  }
}

/* ------------------------------------------------------------- boot, launch */

/**
 * Boots `target` and waits until it is usable. `simctl boot` returns once the
 * boot has started; `bootstatus -b` then waits for the home screen (and boots
 * it itself if something shut it down meanwhile). Both run under the turn's
 * signal and the waiting under a time limit, so a hung boot ends with a
 * clear answer and no simctl left running.
 */
async function bootAndWait(target: SimDevice, signal?: AbortSignal): Promise<string> {
  if (target.state === 'Shutting Down') {
    for (let i = 0; i < 30; i++) {
      await deps.sleep(1000, signal)
      const now = (await devices(signal)).find((d) => d.udid === target.udid)
      if (!now || now.state !== 'Shutting Down') break
    }
  }
  if (target.state !== 'Booting') {
    try {
      await simctl(['boot', target.udid], { timeout: 60_000, signal })
    } catch (error) {
      // Someone (the user, another step) booted it in between: that's the goal anyway.
      if (!/current state: Booted/i.test(String((error as Error).message))) throw error
    }
  }
  try {
    await simctl(['bootstatus', target.udid, '-b'], { timeout: BOOT_TIMEOUT_MS, signal })
  } catch (error) {
    if (isAbort(error, signal) || (error as Error).message === 'Stopped by the user.') throw new Error('Stopped by the user.')
    if (/did not finish within/.test((error as Error).message)) {
      return `${target.name} did not finish booting within ${BOOT_TIMEOUT_MS / 60_000} minutes and may be stuck. Check "list" in a minute; if it is still not running, shut it down (action "shutdown") and boot it again.`
    }
    throw error
  }
  return ''
}

/** "com.apple.mobilesafari: 12345" → 12345. */
export function launchedPid(stdout: string): number | null {
  const match = /:\s*(\d+)\s*$/m.exec(stdout.trim())
  return match ? Number(match[1]) : null
}

/**
 * Whether the app launched is still running, from the simulator's own
 * `launchctl list`: a line with its pid, or a `UIKitApplication:<bundle id>`
 * label with a pid. An app that crashed is either gone from the list or
 * listed with "-" for its pid.
 */
export function appStillRunning(launchctl: string, bundleId: string, pid: number | null): boolean {
  for (const line of launchctl.split('\n')) {
    const [first, , label = ''] = line.trim().split(/\s+/)
    if (!/^\d+$/.test(first ?? '')) continue
    if (pid !== null && Number(first) === pid) return true
    if (label.startsWith(`UIKitApplication:${bundleId}[`)) return true
  }
  return false
}

/** How long an app gets after launch before it counts as having quit at once. */
const LAUNCH_SETTLE_MS = 2000

async function launchApp(target: SimDevice, bundleId: string, signal?: AbortSignal): Promise<string> {
  const stdout = await simctl(['launch', target.udid, bundleId], { signal })
  const pid = launchedPid(stdout)
  await deps.sleep(LAUNCH_SETTLE_MS, signal)
  let listing: string
  try {
    listing = await simctl(['spawn', target.udid, 'launchctl', 'list'], { timeout: 15_000, signal })
  } catch (error) {
    if ((error as Error).message === 'Stopped by the user.') throw error
    return '' // Not knowing doesn't make the launch fail.
  }
  if (appStillRunning(listing, bundleId, pid)) return ''
  return `But ${bundleId} quit within ${LAUNCH_SETTLE_MS / 1000} s of launching, which usually means it crashed. Its crash report is in ~/Library/Logs/DiagnosticReports on the Mac (newest file named after the app); say so rather than retrying the same launch.`
}

/* -------------------------------------------------------------- the tool */

function outPath(cwd: string, saveTo: string, deviceName: string): string {
  const absolute = isAbsolute(saveTo) ? saveTo : resolve(cwd, saveTo)
  if (/\.png$/i.test(absolute)) return absolute
  if (extname(absolute)) throw new SimulatorError('"save_to" must end in .png, or be a folder.')
  const slug = deviceName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  return join(absolute, `${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const READ_ONLY = new Set(['list', 'apps'])
const join2 = (...parts: string[]): string => parts.filter(Boolean).join(' ')

export const simulatorTool: AgentTool = {
  name: 'ios_simulator',
  description: [
    "Xcode's iOS Simulator: a simulated iPhone running on this Mac, not the user's own phone (none of their apps, accounts or data are on it).",
    'list (devices), boot {device?} (no device: the running one, else an iPhone on the newest iOS), shutdown {device?}, apps (installed apps), install {app_path}, launch {bundle_id}, terminate {bundle_id}, open_url {url} (a website in Safari, or an app\'s deep link),',
    'appearance {mode: "light" | "dark"}, location {latitude, longitude}, screenshot {save_to?} (at the device\'s own resolution; save_to a .png or folder).',
    "device defaults to the booted one. Booting and acting on a device puts its window on the user's screen (DeviceHub on Xcode 27, Simulator before).",
    'simctl cannot tap, type, swipe or rotate: do those with the computer tool on that window (screenshot with the app name the result gives).'
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'boot', 'shutdown', 'apps', 'install', 'launch', 'terminate', 'open_url', 'appearance', 'location', 'screenshot'] },
      device: { type: 'string', description: 'Device name (e.g. "iPhone 17 Pro") or UDID; defaults to the booted one' },
      bundle_id: { type: 'string' },
      app_path: { type: 'string', description: 'install: path to a built .app' },
      url: { type: 'string' },
      mode: { type: 'string', enum: ['light', 'dark'] },
      latitude: { type: 'number' },
      longitude: { type: 'number' },
      save_to: { type: 'string', description: 'screenshot: .png path or folder, relative to the work folder' }
    },
    required: ['action']
  },
  mutating: (input) => !READ_ONLY.has(str(input.action)) && !(str(input.action) === 'screenshot' && !str(input.save_to)),
  describe: (input) => [str(input.action), str(input.device) || str(input.bundle_id) || str(input.url) || str(input.mode)].filter(Boolean).join(' '),
  run: async (input, ctx) => {
    if (deps.platform !== 'darwin') return { text: 'The iOS Simulator only runs on macOS.', isError: true }
    const action = str(input.action)
    const signal = ctx.signal
    switch (action) {
      case 'list': {
        await ensureEnvironment(signal)
        const all = await devices(signal)
        const booted = all.filter((d) => d.state === 'Booted')
        const phones = all.filter((d) => d.state !== 'Booted' && /iPhone|iPad/.test(d.name))
        const line = (d: SimDevice): string => `- ${d.name} (${d.runtime}) ${d.udid}${d.state === 'Booted' ? ' — running' : d.state === 'Booting' ? ' — starting' : ''}`
        return [
          booted.length ? `Running:\n${booted.map(line).join('\n')}` : 'No simulator is running.',
          phones.length ? `Available:\n${phones.slice(-25).map(line).join('\n')}` : "No iPhone or iPad simulators are set up; the user can add one in Xcode's Devices and Simulators window."
        ].join('\n')
      }
      case 'boot': {
        const { device: target, note } = await bootTarget(input.device, signal)
        if (target.state === 'Booted') return join2(`${target.name} (${target.runtime}) is already running.`, note, await showDevice(target, signal, true))
        const stuck = await bootAndWait(target, signal)
        if (stuck) return { text: join2(note, stuck), isError: true }
        return join2(`${target.name} (${target.runtime}) is running.`, note, await showDevice(target, signal, true))
      }
      case 'shutdown': {
        const { device: target, note } = await device(input.device, signal, false)
        if (target.state === 'Shutdown') return `${target.name} is already shut down.`
        await simctl(['shutdown', target.udid], { signal })
        return join2(`Shut down ${target.name}.`, note)
      }
      case 'apps': {
        const { device: target, note } = await device(input.device, signal)
        const raw = await simctl(['listapps', target.udid], { signal })
        const apps: string[] = []
        let current: { id: string; name: string; user: boolean } | null = null
        for (const line of raw.split('\n')) {
          const open = /^\s{4}"?([\w.-]+)"?\s*=\s*\{/.exec(line)
          if (open) {
            if (current) apps.push(`- ${current.name || current.id} (${current.id})${current.user ? '' : ' [system]'}`)
            current = { id: open[1], name: '', user: false }
            continue
          }
          const name = /CFBundleDisplayName\s*=\s*"?([^";]+)"?;/.exec(line) ?? /CFBundleName\s*=\s*"?([^";]+)"?;/.exec(line)
          if (current && name && !current.name) current.name = name[1]
          if (current && /ApplicationType\s*=\s*User;/.test(line)) current.user = true
        }
        if (current) apps.push(`- ${current.name || current.id} (${current.id})${current.user ? '' : ' [system]'}`)
        apps.sort((a, b) => Number(a.includes('[system]')) - Number(b.includes('[system]')))
        const head = apps.length ? `Apps on ${target.name}:\n${apps.slice(0, 80).join('\n')}` : `No apps found on ${target.name}.`
        return note ? `${note}\n${head}` : head
      }
      case 'install': {
        const path = str(input.app_path)
        if (!path) return { text: 'install needs app_path: a built .app for the simulator.', isError: true }
        const { device: target, note } = await device(input.device, signal)
        await simctl(['install', target.udid, isAbsolute(path) ? path : resolve(ctx.cwd, path)], { timeout: 180_000, signal })
        return join2(`Installed ${path} on ${target.name}.`, note, await showDevice(target, signal))
      }
      case 'launch':
      case 'terminate': {
        const id = str(input.bundle_id)
        if (!/^[\w.-]+$/.test(id)) return { text: `${action} needs bundle_id, e.g. "com.apple.mobilesafari" (see "apps").`, isError: true }
        const { device: target, note } = await device(input.device, signal)
        if (action === 'terminate') {
          await simctl(['terminate', target.udid, id], { signal })
          return join2(`Quit ${id} on ${target.name}.`, note)
        }
        const crashed = await launchApp(target, id, signal)
        if (crashed) return { text: join2(`Launched ${id} on ${target.name}.`, crashed, note), isError: true }
        return join2(`Launched ${id} on ${target.name}.`, note, await showDevice(target, signal))
      }
      case 'open_url': {
        const url = str(input.url)
        if (!/^[a-z][\w+.-]*:/i.test(url)) return { text: 'open_url needs a full url with a scheme, e.g. "https://apple.com" or "myapp://screen".', isError: true }
        const { device: target, note } = await device(input.device, signal)
        await simctl(['openurl', target.udid, url], { signal })
        return join2(`Opened ${url} on ${target.name}.`, note, await showDevice(target, signal))
      }
      case 'appearance': {
        const mode = str(input.mode)
        if (mode !== 'light' && mode !== 'dark') return { text: 'appearance needs mode "light" or "dark".', isError: true }
        const { device: target, note } = await device(input.device, signal)
        await simctl(['ui', target.udid, 'appearance', mode], { signal })
        return join2(`${target.name} is in ${mode} mode.`, note, await showDevice(target, signal))
      }
      case 'location': {
        const lat = Number(input.latitude)
        const lon = Number(input.longitude)
        if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return { text: 'location needs latitude and longitude.', isError: true }
        const { device: target, note } = await device(input.device, signal)
        await simctl(['location', target.udid, 'set', `${lat},${lon}`], { signal })
        return join2(`Set ${target.name}'s location to ${lat}, ${lon}.`, note)
      }
      case 'screenshot': {
        const { device: target, note } = await device(input.device, signal)
        const file = join(tmpdir(), `eaon-sim-${randomUUID()}.png`)
        try {
          await simctl(['io', target.udid, 'screenshot', '--type=png', file], { signal })
          const image = nativeImage.createFromBuffer(await readFile(file))
          const { width, height } = image.getSize()
          if (!width || !height) throw new SimulatorError('The simulator returned an empty screenshot.')
          let saved = ''
          if (str(input.save_to)) {
            saved = outPath(ctx.cwd, str(input.save_to), target.name)
            await mkdir(dirname(saved), { recursive: true })
            await copyFile(file, saved)
          }
          const scale = Math.min(1, LONG_EDGE / Math.max(width, height))
          const small = scale < 1 ? image.resize({ width: Math.round(width * scale), quality: 'best' }) : image
          const windowApp = viewerFound?.windowApp
          return {
            text: [
              `Screenshot of the ${target.name} simulator: ${width}×${height} px at the device's resolution (shown smaller).`,
              note,
              saved ? `Saved to ${saved}.` : '',
              `These are not screen coordinates: to tap, use the computer tool with a screenshot of the simulator window (app "${windowApp ?? 'Device Hub'}"${windowApp ? '' : ' on Xcode 27, "Simulator" before'}).`
            ]
              .filter(Boolean)
              .join('\n'),
            images: [{ mime: 'image/jpeg', data: small.toJPEG(75).toString('base64') }]
          }
        } finally {
          await rm(file, { force: true })
        }
      }
      default:
        return { text: `Unknown action "${action}". Use one of: list, boot, shutdown, apps, install, launch, terminate, open_url, appearance, location, screenshot.`, isError: true }
    }
  }
}

/* --------------------------------------------------------- iPhone Mirroring */

const MIRRORING_APP = '/System/Applications/iPhone Mirroring.app'

/**
 * Whether the user's real iPhone can be reached through iPhone Mirroring on
 * this Mac, and if not, exactly which requirement is missing. It needs macOS
 * 15 or later (Darwin 24+) and the iPhone Mirroring app.
 *
 * What can't be told from here: whether an iPhone is paired (iOS 18+, the
 * same Apple Account, nearby, locked), whether the Mac's region allows it
 * (not in the EU), and whether the Mac has Apple silicon or a T2 chip. When
 * this says available, the app still has to be opened and looked at — a
 * setup or "connect" screen means the user has to finish pairing.
 */
export function iphoneMirroringAvailability(): { available: boolean; reason?: string } {
  if (deps.platform !== 'darwin') {
    return { available: false, reason: "iPhone Mirroring is a macOS app, so the user's real iPhone can't be controlled from this computer. Only Xcode's iOS Simulator (on a Mac) can be used." }
  }
  const darwin = Number.parseInt(deps.osRelease(), 10)
  if (Number.isFinite(darwin) && darwin < 24) {
    const macos = darwin >= 20 ? `macOS ${darwin - 9}` : 'an older macOS'
    return {
      available: false,
      reason: `iPhone Mirroring needs macOS 15 Sequoia or later, and this Mac runs ${macos}, so the user's real iPhone can't be controlled from here. The iOS Simulator (a simulated iPhone, not theirs) can be used instead.`
    }
  }
  if (!deps.exists(MIRRORING_APP)) {
    return {
      available: false,
      reason: "The iPhone Mirroring app isn't on this Mac, so the user's real iPhone can't be controlled from here. The iOS Simulator (a simulated iPhone, not theirs) can be used instead."
    }
  }
  return { available: true }
}

registerToolSource({
  id: 'simulator',
  tools: (query) =>
    process.platform === 'darwin' && query.mode === 'work' && query.depth === 0 && query.settings.computerUse.enabled && !query.request.chatId?.startsWith('trading:')
      ? [simulatorTool]
      : [],
  guidance: () =>
    'ios_simulator runs iPhone apps in Xcode\'s Simulator — a simulated iPhone on the Mac, not the user\'s own phone: boot a device, launch or open_url, then drive its window with the computer tool to tap, type, swipe or rotate (screenshot app: "Device Hub" on Xcode 27, "Simulator" before; the boot result names it). For screenshots of every screen of an app, save each with ios_simulator screenshot save_to into one folder.'
})
