import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { nativeImage } from 'electron'
import { registerToolSource, type AgentTool } from '../agent/tools'

const run = promisify(execFile)

/**
 * `ios_simulator`: Xcode's iOS Simulator through `xcrun simctl` — boot a
 * device, install and launch apps, open links, switch light and dark, and
 * take screenshots at the device's own resolution (for capturing every
 * screen of an app). simctl can't tap, so taps and swipes go through the
 * computer tool on the Simulator window, which the guidance says.
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

async function viewer(): Promise<Viewer> {
  if (viewerFound && existsSync(viewerFound.path)) return viewerFound
  let developer = '/Applications/Xcode.app/Contents/Developer'
  try {
    developer = (await run('/usr/bin/xcode-select', ['-p'], { timeout: 10_000 })).stdout.trim() || developer
  } catch {
    /* the default Xcode location */
  }
  const found = viewerCandidates(developer).find((v) => existsSync(v.path))
  if (!found) throw new Error(`neither DeviceHub nor Simulator is in the selected Xcode (${developer})`)
  viewerFound = found
  return found
}

/** Devices whose window has been brought to the front once; later steps leave focus alone. */
const shown = new Set<string>()

/**
 * Puts the simulator's window on screen, so the user sees what the agent
 * does. The first time for a device it comes to the front; after that it is
 * only (re)opened behind, without taking focus. Returns a sentence for the
 * result either way: failing to show the window doesn't fail the action.
 */
async function showDevice(target: SimDevice, front = !shown.has(target.udid)): Promise<string> {
  try {
    const v = await viewer()
    const args = [...(front ? [] : ['-g']), '-a', v.path]
    if (v.bundleId === 'com.apple.iphonesimulator') args.push('--args', '-CurrentDeviceUDID', target.udid)
    await run('/usr/bin/open', args, { timeout: 15_000 })
    shown.add(target.udid)
    return front ? `It is showing on the user's screen in ${v.windowApp}; to tap or type in it, use the computer tool with screenshot app: "${v.windowApp}".` : ''
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? '').trim()
    return `It runs in the background, but its window could not be opened (${stderr || (error as Error).message}), so the user can't see it; say so.`
  }
}

async function simctl(args: string[], timeout = 60_000): Promise<string> {
  try {
    const { stdout } = await run('/usr/bin/xcrun', ['simctl', ...args], { timeout, maxBuffer: 32 * 1024 * 1024 })
    return stdout
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? '').trim()
    if (/unable to find utility "simctl"|xcrun: error/i.test(stderr)) {
      throw new Error('The iOS Simulator needs Xcode. Tell the user to install Xcode from the App Store and open it once, then try again.')
    }
    throw new Error(stderr.split('\n').slice(-3).join(' ') || (error as Error).message)
  }
}

export function parseDevices(json: string): SimDevice[] {
  const parsed = JSON.parse(json) as { devices?: Record<string, { name: string; udid: string; state: string; isAvailable?: boolean }[]> }
  const out: SimDevice[] = []
  for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
    const label = runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-/g, ' ')
    for (const d of devices) if (d.isAvailable !== false) out.push({ name: d.name, udid: d.udid, state: d.state, runtime: label })
  }
  return out
}

async function devices(): Promise<SimDevice[]> {
  return parseDevices(await simctl(['list', 'devices', 'available', '-j']))
}

/** A device by udid or name (a booted one first); "booted" or nothing means the booted device. */
async function device(wanted: unknown): Promise<SimDevice> {
  const all = await devices()
  const name = typeof wanted === 'string' ? wanted.trim() : ''
  if (!name || name.toLowerCase() === 'booted') {
    const booted = all.find((d) => d.state === 'Booted')
    if (!booted) throw new Error('No simulator is running. Boot one first (action "boot" with a device from "list").')
    return booted
  }
  const matches = all.filter((d) => d.udid === name || d.name.toLowerCase() === name.toLowerCase())
  const found = matches.find((d) => d.state === 'Booted') ?? matches[matches.length - 1]
  if (!found) throw new Error(`No simulator called "${name}". Use "list" to see them.`)
  return found
}

function outPath(cwd: string, saveTo: string, deviceName: string): string {
  const absolute = isAbsolute(saveTo) ? saveTo : resolve(cwd, saveTo)
  if (/\.png$/i.test(absolute)) return absolute
  if (extname(absolute)) throw new Error('"save_to" must end in .png, or be a folder.')
  const slug = deviceName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  return join(absolute, `${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const READ_ONLY = new Set(['list', 'apps'])

export const simulatorTool: AgentTool = {
  name: 'ios_simulator',
  description: [
    "Xcode's iOS Simulator. list (devices), boot {device}, shutdown {device?}, apps (installed apps), install {app_path}, launch {bundle_id}, terminate {bundle_id}, open_url {url} (a website in Safari, or an app's deep link),",
    'appearance {mode: "light" | "dark"}, location {latitude, longitude}, screenshot {save_to?} (at the device\'s own resolution; save_to a .png or folder).',
    'device defaults to the booted one. Booting and acting on a device puts its window on the user\'s screen (DeviceHub on Xcode 27, Simulator before). simctl cannot tap: to tap, type or swipe, use the computer tool on that window (screenshot with the app name the result gives).'
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
    if (process.platform !== 'darwin') return { text: 'The iOS Simulator only runs on macOS.', isError: true }
    const action = str(input.action)
    switch (action) {
      case 'list': {
        const all = await devices()
        const booted = all.filter((d) => d.state === 'Booted')
        const phones = all.filter((d) => d.state !== 'Booted' && /iPhone|iPad/.test(d.name))
        const line = (d: SimDevice): string => `- ${d.name} (${d.runtime}) ${d.udid}${d.state === 'Booted' ? ' — running' : ''}`
        return [
          booted.length ? `Running:\n${booted.map(line).join('\n')}` : 'No simulator is running.',
          phones.length ? `Available:\n${phones.slice(-25).map(line).join('\n')}` : 'No iPhone or iPad simulators are installed; Xcode → Settings → Platforms adds them.'
        ].join('\n')
      }
      case 'boot': {
        const target = await device(input.device || undefined)
        if (target.state !== 'Booted') await simctl(['boot', target.udid], 120_000)
        return `${target.name} (${target.runtime}) is running. ${await showDevice(target, true)}`
      }
      case 'shutdown': {
        const target = await device(input.device)
        await simctl(['shutdown', target.udid])
        return `Shut down ${target.name}.`
      }
      case 'apps': {
        const target = await device(input.device)
        const raw = await simctl(['listapps', target.udid])
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
        return apps.length ? `Apps on ${target.name}:\n${apps.slice(0, 80).join('\n')}` : `No apps found on ${target.name}.`
      }
      case 'install': {
        const target = await device(input.device)
        const path = str(input.app_path)
        if (!path) return { text: 'install needs app_path: a built .app for the simulator.', isError: true }
        await simctl(['install', target.udid, isAbsolute(path) ? path : resolve(ctx.cwd, path)], 180_000)
        return `Installed ${path} on ${target.name}. ${await showDevice(target)}`.trim()
      }
      case 'launch':
      case 'terminate': {
        const target = await device(input.device)
        const id = str(input.bundle_id)
        if (!/^[\w.-]+$/.test(id)) return { text: `${action} needs bundle_id, e.g. "com.apple.mobilesafari" (see "apps").`, isError: true }
        await simctl([action, target.udid, id])
        return `${action === 'launch' ? 'Launched' : 'Quit'} ${id} on ${target.name}. ${await showDevice(target)}`.trim()
      }
      case 'open_url': {
        const target = await device(input.device)
        const url = str(input.url)
        if (!/^[a-z][\w+.-]*:/i.test(url)) return { text: 'open_url needs a full url with a scheme, e.g. "https://apple.com" or "myapp://screen".', isError: true }
        await simctl(['openurl', target.udid, url])
        return `Opened ${url} on ${target.name}. ${await showDevice(target)}`.trim()
      }
      case 'appearance': {
        const target = await device(input.device)
        const mode = str(input.mode)
        if (mode !== 'light' && mode !== 'dark') return { text: 'appearance needs mode "light" or "dark".', isError: true }
        await simctl(['ui', target.udid, 'appearance', mode])
        return `${target.name} is in ${mode} mode. ${await showDevice(target)}`.trim()
      }
      case 'location': {
        const target = await device(input.device)
        const lat = Number(input.latitude)
        const lon = Number(input.longitude)
        if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return { text: 'location needs latitude and longitude.', isError: true }
        await simctl(['location', target.udid, 'set', `${lat},${lon}`])
        return `Set ${target.name}'s location to ${lat}, ${lon}.`
      }
      case 'screenshot': {
        const target = await device(input.device)
        const file = join(tmpdir(), `eaon-sim-${randomUUID()}.png`)
        try {
          await simctl(['io', target.udid, 'screenshot', '--type=png', file])
          const image = nativeImage.createFromPath(file)
          if (image.isEmpty()) throw new Error('The simulator returned an empty screenshot.')
          const { width, height } = image.getSize()
          let saved = ''
          if (str(input.save_to)) {
            saved = outPath(ctx.cwd, str(input.save_to), target.name)
            await mkdir(dirname(saved), { recursive: true })
            await copyFile(file, saved)
          }
          const scale = Math.min(1, LONG_EDGE / Math.max(width, height))
          const small = scale < 1 ? image.resize({ width: Math.round(width * scale), quality: 'best' }) : image
          return {
            text: [
              `Screenshot of ${target.name}: ${width}×${height} px at the device's resolution (shown smaller).`,
              saved ? `Saved to ${saved}.` : '',
              'These are not screen coordinates: to tap, use the computer tool with a screenshot of the simulator window (app "Device Hub" on Xcode 27, "Simulator" before).'
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
        return { text: `Unknown action "${action}".`, isError: true }
    }
  }
}

registerToolSource({
  id: 'simulator',
  tools: (query) =>
    process.platform === 'darwin' && query.mode === 'work' && query.depth === 0 && query.settings.computerUse.enabled && !query.request.chatId?.startsWith('trading:')
      ? [simulatorTool]
      : [],
  guidance: () =>
    'ios_simulator runs iPhone apps in Xcode\'s Simulator: boot a device, launch or open_url, then drive its window with the computer tool (screenshot app: "Device Hub" on Xcode 27, "Simulator" before; the boot result names it). For screenshots of every screen of an app, save each with ios_simulator screenshot save_to into one folder.'
})
