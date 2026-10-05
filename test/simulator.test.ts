import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import type { ToolContext, ToolResult } from '../src/main/agent/tools'
import {
  appStillRunning,
  execRun,
  iosRuntimes,
  iphoneMirroringAvailability,
  launchedPid,
  setSimulatorDeps,
  simulatorTool,
  xcodeMajor,
  type RunOptions,
  type RunResult
} from '../src/main/features/simulator'

/**
 * The iOS Simulator tool against a fake Mac: every xcrun, xcode-select,
 * xcodebuild and open call is answered by `machine()`, so each way a real
 * Mac can be set up (no Xcode, only the Command Line Tools, an unaccepted
 * license, no runtimes, a hung boot, a crashing app) is checked without
 * Xcode. The error text used is what those tools really print.
 */

const XCODE = '/Applications/Xcode.app'
const DEVELOPER = `${XCODE}/Contents/Developer`

interface Device {
  name: string
  udid: string
  state: string
}

interface MachineOptions {
  developer?: string | { stderr: string }
  version?: string | { stderr: string }
  runtimes?: { name: string; identifier: string; platform?: string; isAvailable?: boolean }[]
  devices?: Record<string, Device[]>
  exists?: string[]
  launchctl?: string
  /** Answers a simctl subcommand instead of the defaults; undefined falls through. */
  simctl?: (args: string[], options: RunOptions) => Promise<RunResult> | undefined
}

const fail = (stderr: string, extra: Record<string, unknown> = {}): Error => Object.assign(new Error('Command failed'), { stderr, stdout: '', ...extra })

const IOS_26 = { name: 'iOS 26.5', identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5', platform: 'iOS', isAvailable: true }

function machine(options: MachineOptions = {}): { calls: { file: string; args: string[]; options: RunOptions }[]; devices: Record<string, Device[]> } {
  const calls: { file: string; args: string[]; options: RunOptions }[] = []
  const devices = options.devices ?? {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [{ name: 'iPhone 16 Pro', udid: 'OLD', state: 'Shutdown' }],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
      { name: 'iPhone 17 Pro', udid: 'NEW', state: 'Shutdown' },
      { name: 'iPad Air 11-inch (M3)', udid: 'PAD', state: 'Shutdown' }
    ]
  }
  const exists = new Set(options.exists ?? [XCODE, DEVELOPER, `${XCODE}/Contents/Applications/DeviceHub.app`])
  const ok = (stdout: string): Promise<RunResult> => Promise.resolve({ stdout, stderr: '' })
  setSimulatorDeps({
    platform: 'darwin',
    osRelease: () => '24.1.0',
    exists: (path) => exists.has(path),
    sleep: (_ms, signal) => (signal?.aborted ? Promise.reject(new Error('Stopped by the user.')) : Promise.resolve()),
    run: async (file, args, runOptions) => {
      calls.push({ file, args, options: runOptions })
      if (file === '/usr/bin/xcode-select') {
        const developer = options.developer ?? DEVELOPER
        if (typeof developer !== 'string') throw fail(developer.stderr, { code: 2 })
        return ok(`${developer}\n`)
      }
      if (file === '/usr/bin/xcodebuild') {
        const version = options.version ?? 'Xcode 26.0\nBuild version 17A324\n'
        if (typeof version !== 'string') throw fail(version.stderr, { code: 69 })
        return ok(version)
      }
      if (file === '/usr/bin/open') return ok('')
      assert.equal(file, '/usr/bin/xcrun')
      assert.equal(args[0], 'simctl')
      const rest = args.slice(1)
      const custom = options.simctl?.(rest, runOptions)
      if (custom) return custom
      const find = (udid: string): Device | undefined => Object.values(devices).flat().find((d) => d.udid === udid)
      switch (rest[0]) {
        case 'list':
          if (rest[1] === 'runtimes') return ok(JSON.stringify({ runtimes: options.runtimes ?? [IOS_26] }))
          return ok(JSON.stringify({ devices: Object.fromEntries(Object.entries(devices).map(([k, v]) => [k, v.map((d) => ({ ...d, isAvailable: true }))])) }))
        case 'boot': {
          const d = find(rest[1])!
          if (d.state === 'Booted') throw fail('An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\nUnable to boot device in current state: Booted')
          d.state = 'Booted'
          return ok('')
        }
        case 'bootstatus':
          find(rest[1])!.state = 'Booted'
          return ok(`Monitoring boot status for ${find(rest[1])!.name} (${rest[1]}).\nFinished in 4.2 seconds.\n`)
        case 'launch':
          return ok(`${rest[2]}: 4242\n`)
        case 'spawn':
          return ok(options.launchctl ?? `PID\tStatus\tLabel\n4242\t0\tUIKitApplication:${'com.example.app'}[1a2b][rb-legacy]\n`)
        default:
          return ok('')
      }
    }
  })
  return { calls, devices }
}

function ctx(signal = new AbortController().signal): ToolContext {
  return { request: { chatId: 'c1', messageId: 'm1' }, signal, cwd: '/tmp' } as unknown as ToolContext
}

async function call(input: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
  try {
    const result = (await simulatorTool.run(input, ctx(signal))) as ToolResult | string
    return typeof result === 'string' ? { text: result, isError: false } : { text: result.text, isError: Boolean(result.isError) }
  } catch (error) {
    // What the loop would show the model.
    return { text: `Error: ${(error as Error).message}`, isError: true }
  }
}

const simctlCalls = (calls: { file: string; args: string[] }[], sub: string): string[][] =>
  calls.filter((c) => c.file === '/usr/bin/xcrun' && c.args[1] === sub).map((c) => c.args.slice(1))

afterEach(() => setSimulatorDeps(null))

/* ------------------------------------------------------------ environment */

test('on Windows or Linux the tool says the Simulator needs macOS', async () => {
  machine()
  setSimulatorDeps({ platform: 'win32' })
  const result = await call({ action: 'list' })
  assert.equal(result.isError, true)
  assert.match(result.text, /only runs on macOS/)
})

test('no Xcode and no developer folder: install Xcode from the App Store', async () => {
  machine({
    developer: { stderr: 'xcode-select: error: unable to get active developer directory. Use `sudo xcode-select --switch path/to/Xcode.app` to set one (or see `man xcode-select`)' },
    exists: []
  })
  const result = await call({ action: 'list' })
  assert.equal(result.isError, true)
  assert.match(result.text, /needs Xcode, which is not installed/)
  assert.match(result.text, /App Store/)
})

test('the Command Line Tools selected while Xcode is installed: says the xcode-select command that fixes it', async () => {
  // What this Mac really reports with only the Command Line Tools selected.
  const { calls } = machine({ developer: '/Library/Developer/CommandLineTools' })
  const result = await call({ action: 'boot' })
  assert.equal(result.isError, true)
  assert.match(result.text, /Xcode is installed at \/Applications\/Xcode\.app, but the Command Line Tools are selected/)
  assert.match(result.text, /sudo xcode-select -s \/Applications\/Xcode\.app\/Contents\/Developer/)
  assert.match(result.text, /Settings → Locations/)
  assert.equal(simctlCalls(calls, 'boot').length, 0)
})

test('only the Command Line Tools, no Xcode: says the full Xcode is needed', async () => {
  machine({ developer: '/Library/Developer/CommandLineTools', exists: [] })
  const result = await call({ action: 'list' })
  assert.match(result.text, /Only Apple's Command Line Tools are installed; the iOS Simulator needs the full Xcode/)
})

test('a selected Xcode that has since been deleted is named', async () => {
  machine({ exists: [] })
  const result = await call({ action: 'list' })
  assert.match(result.text, /selected Xcode \(\/Applications\/Xcode\.app\) is no longer there/)
})

test('an unaccepted Xcode license is reported as such, with the fix', async () => {
  machine({ version: { stderr: 'You have not agreed to the Xcode license agreements. You must agree to both license agreements below in order to use Xcode.' } })
  const result = await call({ action: 'list' })
  assert.match(result.text, /license hasn't been accepted/)
  assert.match(result.text, /sudo xcodebuild -license accept/)
})

test("Xcode's first-launch components missing: open Xcode once", async () => {
  machine({ version: { stderr: "A required plugin failed to load. Please ensure system content is up-to-date — try running 'xcodebuild -runFirstLaunch'." } })
  const result = await call({ action: 'list' })
  assert.match(result.text, /hasn't finished installing its components/)
  assert.match(result.text, /xcodebuild -runFirstLaunch/)
})

test('an Xcode older than the minimum is refused with its version', async () => {
  machine({ version: 'Xcode 11.3\nBuild version 11C29\n' })
  const result = await call({ action: 'list' })
  assert.match(result.text, /version 11\.3, and Eaon's Simulator tool needs Xcode 12 or later/)
  assert.equal(xcodeMajor('Xcode 26.0\nBuild version 17A324'), 26)
})

test('no iOS runtime installed: says where to download one', async () => {
  machine({ runtimes: [{ name: 'watchOS 11.5', identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-11-5', platform: 'watchOS' }] })
  const result = await call({ action: 'list' })
  assert.match(result.text, /no iOS Simulator runtime is/)
  assert.match(result.text, /Settings → Components/)
  assert.deepEqual(iosRuntimes(JSON.stringify({ runtimes: [IOS_26, { ...IOS_26, isAvailable: false }] })).length, 1)
})

test('xcrun without simctl (Command Line Tools) mid-session is explained, not dumped', async () => {
  machine({ simctl: (args) => (args[0] === 'list' && args[1] === 'devices' ? Promise.reject(fail('xcrun: error: unable to find utility "simctl", not a developer tool or in PATH', { code: 72 })) : undefined) })
  const result = await call({ action: 'list' })
  assert.match(result.text, /Command Line Tools/)
  assert.doesNotMatch(result.text, /xcrun: error/)
})

test('a good environment check is reused for a minute; a failed one is checked again next time', async () => {
  let accepted = false
  const calls: { file: string; args: string[] }[] = []
  setSimulatorDeps({
    platform: 'darwin',
    exists: () => true,
    now: () => 1_000,
    run: async (file, args) => {
      calls.push({ file, args })
      if (file === '/usr/bin/xcode-select') return { stdout: `${DEVELOPER}\n`, stderr: '' }
      if (file === '/usr/bin/xcodebuild') {
        if (!accepted) throw fail('You have not agreed to the Xcode license agreements.')
        return { stdout: 'Xcode 26.0\n', stderr: '' }
      }
      if (args[2] === 'runtimes') return { stdout: JSON.stringify({ runtimes: [IOS_26] }), stderr: '' }
      return { stdout: JSON.stringify({ devices: {} }), stderr: '' }
    }
  })
  assert.match((await call({ action: 'list' })).text, /license/)
  accepted = true
  assert.doesNotMatch((await call({ action: 'list' })).text, /license/)
  const checks = calls.filter((c) => c.file === '/usr/bin/xcode-select').length
  await call({ action: 'list' })
  assert.equal(calls.filter((c) => c.file === '/usr/bin/xcode-select').length, checks, 'cached within the minute')
})

/* ------------------------------------------------------------------- boot */

test('boot with no device starts an iPhone on the newest iOS (it used to fail with "Boot one first")', async () => {
  const { calls, devices } = machine()
  const result = await call({ action: 'boot' })
  assert.equal(result.isError, false, result.text)
  assert.match(result.text, /iPhone 17 Pro \(iOS 26\.5\) is running/)
  assert.match(result.text, /No device was named, so this started iPhone 17 Pro/)
  assert.deepEqual(simctlCalls(calls, 'boot'), [['boot', 'NEW']])
  assert.deepEqual(simctlCalls(calls, 'bootstatus'), [['bootstatus', 'NEW', '-b']])
  assert.equal(devices['com.apple.CoreSimulator.SimRuntime.iOS-26-5'][0].state, 'Booted')
  assert.match(result.text, /showing on the user's screen in Device Hub/)
})

test('boot of a device that is already running does not boot it again', async () => {
  const { calls } = machine({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ name: 'iPhone 17 Pro', udid: 'NEW', state: 'Booted' }] } })
  const result = await call({ action: 'boot', device: 'iPhone 17 Pro' })
  assert.match(result.text, /already running/)
  assert.equal(simctlCalls(calls, 'boot').length, 0)
  assert.equal(simctlCalls(calls, 'bootstatus').length, 0)
})

test('boot of a device that is still booting waits for it instead of booting it twice', async () => {
  const { calls } = machine({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ name: 'iPhone 17 Pro', udid: 'NEW', state: 'Booting' }] } })
  const result = await call({ action: 'boot', device: 'iPhone 17 Pro' })
  assert.match(result.text, /is running/)
  assert.equal(simctlCalls(calls, 'boot').length, 0)
  assert.equal(simctlCalls(calls, 'bootstatus').length, 1)
})

test('a boot that hangs ends after the time limit with what to do', async () => {
  const { calls } = machine({
    simctl: (args) => (args[0] === 'bootstatus' ? Promise.reject(fail('', { killed: true, signal: 'SIGTERM' })) : undefined)
  })
  const result = await call({ action: 'boot' })
  assert.equal(result.isError, true)
  assert.match(result.text, /did not finish booting within 3 minutes/)
  assert.match(result.text, /shut it down \(action "shutdown"\) and boot it again/)
  assert.equal(calls.find((c) => c.args[1] === 'bootstatus')?.options.timeout, 180_000)
})

test('stopping the turn while a boot waits cancels the wait', async () => {
  const controller = new AbortController()
  const { calls } = machine({
    simctl: (args, options) =>
      args[0] === 'bootstatus'
        ? new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })))
            setTimeout(() => controller.abort(), 10)
          })
        : undefined
  })
  const result = await call({ action: 'boot' }, controller.signal)
  assert.equal(result.text, 'Error: Stopped by the user.')
  assert.equal(calls.find((c) => c.args[1] === 'bootstatus')?.options.signal, controller.signal)
})

/* ------------------------------------------------------ choosing a device */

test('with several simulators running and none named, the result says which one it used and how to pick', async () => {
  machine({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
        { name: 'iPhone 17 Pro', udid: 'A', state: 'Booted' },
        { name: 'iPhone 17', udid: 'B', state: 'Booted' }
      ]
    },
    launchctl: 'PID\tStatus\tLabel\n4242\t0\tUIKitApplication:com.apple.mobilesafari[1a2b][rb-legacy]\n'
  })
  const result = await call({ action: 'launch', bundle_id: 'com.apple.mobilesafari' })
  assert.equal(result.isError, false, result.text)
  assert.match(result.text, /2 simulators are running \(iPhone 17 Pro, iPhone 17\); this used iPhone 17 Pro\. Pass "device" to act on another\./)
})

test('an action on a named device that is not running asks for a boot first, without calling simctl', async () => {
  const { calls } = machine()
  const result = await call({ action: 'open_url', device: 'iPhone 17 Pro', url: 'https://eaon.dev' })
  assert.match(result.text, /iPhone 17 Pro \(iOS 26\.5\) is not running\. Boot it first: action "boot" with device "iPhone 17 Pro"/)
  assert.equal(simctlCalls(calls, 'openurl').length, 0)
})

test('with nothing running, an action says to boot (and that boot picks an iPhone)', async () => {
  machine()
  const result = await call({ action: 'screenshot' })
  assert.match(result.text, /No simulator is running\. Boot one first: action "boot" \(with no device it starts an iPhone\)/)
})

test("simctl's \"current state: Shutdown\" (a device shut down in between) reads as not running", async () => {
  machine({
    devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ name: 'iPhone 17 Pro', udid: 'A', state: 'Booted' }] },
    simctl: (args) =>
      args[0] === 'ui'
        ? Promise.reject(fail('An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\nUnable to lookup in current state: Shutdown'))
        : undefined
  })
  const result = await call({ action: 'appearance', mode: 'dark' })
  assert.match(result.text, /That simulator is not running\. Boot it first/)
})

test('shutting down a device that is already off does nothing', async () => {
  const { calls } = machine()
  const result = await call({ action: 'shutdown', device: 'iPhone 17 Pro' })
  assert.match(result.text, /already shut down/)
  assert.equal(simctlCalls(calls, 'shutdown').length, 0)
})

/* ----------------------------------------------------------------- launch */

test('an app that quits right after launch is reported as a likely crash, with where the report is', async () => {
  machine({
    devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ name: 'iPhone 17 Pro', udid: 'A', state: 'Booted' }] },
    launchctl: 'PID\tStatus\tLabel\n-\t-9\tUIKitApplication:com.example.app[1a2b][rb-legacy]\n311\t0\tcom.apple.SpringBoard\n'
  })
  const result = await call({ action: 'launch', bundle_id: 'com.example.app' })
  assert.equal(result.isError, true)
  assert.match(result.text, /quit within 2 s of launching, which usually means it crashed/)
  assert.match(result.text, /~\/Library\/Logs\/DiagnosticReports/)
})

test('an app still running after launch is just launched', async () => {
  machine({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ name: 'iPhone 17 Pro', udid: 'A', state: 'Booted' }] } })
  const result = await call({ action: 'launch', bundle_id: 'com.example.app' })
  assert.equal(result.isError, false, result.text)
  assert.match(result.text, /^Launched com\.example\.app on iPhone 17 Pro\./)
  assert.equal(launchedPid('com.example.app: 4242\n'), 4242)
  assert.equal(appStillRunning('4242\t0\tsomething-else', 'com.example.app', 4242), true)
  assert.equal(appStillRunning('PID\tStatus\tLabel\n', 'com.example.app', 4242), false)
})

/* ---------------------------------------------------- what the tool claims */

test('the tool never presents the Simulator as the user\'s own iPhone, and says how to tap, type and rotate', () => {
  assert.match(simulatorTool.description, /not the user's own phone/)
  assert.match(simulatorTool.description, /cannot tap, type, swipe or rotate/)
})

/* ---------------------------------------------------------- iPhone Mirroring */

test('iPhone Mirroring: available on macOS 15+ with the app, and otherwise says exactly what is missing', () => {
  setSimulatorDeps({ platform: 'darwin', osRelease: () => '24.1.0', exists: (p) => p === '/System/Applications/iPhone Mirroring.app' })
  assert.deepEqual(iphoneMirroringAvailability(), { available: true })

  setSimulatorDeps({ platform: 'darwin', osRelease: () => '23.6.0', exists: () => true })
  const old = iphoneMirroringAvailability()
  assert.equal(old.available, false)
  assert.match(old.reason!, /needs macOS 15 Sequoia or later, and this Mac runs macOS 14/)

  setSimulatorDeps({ platform: 'darwin', osRelease: () => '27.0.0', exists: () => false })
  assert.match(iphoneMirroringAvailability().reason!, /iPhone Mirroring app isn't on this Mac/)

  setSimulatorDeps({ platform: 'linux', osRelease: () => '6.8.0', exists: () => true })
  assert.match(iphoneMirroringAvailability().reason!, /macOS app/)
})

/* ------------------------------------------------- the real command runner */

const running = (marker: string): boolean => {
  try {
    return execFileSync('/usr/bin/pgrep', ['-f', marker], { encoding: 'utf8' }).trim().length > 0
  } catch {
    return false
  }
}

test('the real runner kills the command when the turn is stopped or the time limit passes', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  const controller = new AbortController()
  const aborted = execRun('/bin/sleep', ['37.123'], { timeout: 20_000, signal: controller.signal })
  setTimeout(() => controller.abort(), 100)
  await assert.rejects(aborted, (error: Error) => error.name === 'AbortError')
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(running('sleep 37.123'), false, 'no child left after a stop')

  await assert.rejects(execRun('/bin/sleep', ['38.321'], { timeout: 200 }), (error: { killed?: boolean }) => error.killed === true)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(running('sleep 38.321'), false, 'no child left after a timeout')
})
