import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { Point } from './geometry'
import type { AppRef, BackendCheck, InputBackend, MouseButton } from './input'
import { XDOTOOL_MODIFIERS, xdotoolKey, type Combo } from './keys'

const run = promisify(execFile)

/**
 * Linux input through `xdotool`, when it is installed. One process per
 * action: xdotool starts in a few milliseconds, so a persistent helper would
 * buy nothing. X11 only — under Wayland it can move the pointer over
 * XWayland windows at best, which the status line says.
 *
 * Not exercised on a Linux desktop yet.
 */
export class LinuxInput implements InputBackend {
  readonly name = 'xdotool'

  constructor(private readonly scale: () => number) {}

  private native(point: Point): Point {
    const s = this.scale()
    return { x: Math.round(point.x * s), y: Math.round(point.y * s) }
  }

  private async xdo(args: string[]): Promise<string> {
    try {
      const { stdout } = await run('xdotool', args, { timeout: 30_000 })
      return stdout
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') throw new Error('xdotool is not installed. Install it (e.g. sudo apt install xdotool) to let Eaon use the pointer and keyboard.')
      throw new Error(String((error as { stderr?: string }).stderr || (error as Error).message).trim())
    }
  }

  async check(): Promise<BackendCheck> {
    try {
      await this.xdo(['version'])
    } catch (error) {
      return { available: false, detail: (error as Error).message }
    }
    const wayland = process.env['XDG_SESSION_TYPE'] === 'wayland' || Boolean(process.env['WAYLAND_DISPLAY'])
    return wayland
      ? { available: true, detail: 'This is a Wayland session; xdotool can only reach X11 (XWayland) windows.' }
      : { available: true }
  }

  async move(point: Point): Promise<void> {
    const p = this.native(point)
    await this.xdo(['mousemove', '--sync', String(p.x), String(p.y)])
  }

  async click(point: Point, button: MouseButton, clicks: number): Promise<void> {
    const p = this.native(point)
    const b = button === 'right' ? '3' : button === 'middle' ? '2' : '1'
    await this.xdo(['mousemove', '--sync', String(p.x), String(p.y), 'click', '--repeat', String(clicks), '--delay', '80', b])
  }

  async drag(from: Point, to: Point): Promise<void> {
    const a = this.native(from)
    const b = this.native(to)
    const steps: string[] = []
    for (let i = 1; i <= 12; i++) {
      steps.push('mousemove', String(Math.round(a.x + ((b.x - a.x) * i) / 12)), String(Math.round(a.y + ((b.y - a.y) * i) / 12)), 'sleep', '0.015')
    }
    await this.xdo(['mousemove', '--sync', String(a.x), String(a.y), 'mousedown', '1', 'sleep', '0.08', ...steps, 'sleep', '0.08', 'mouseup', '1'])
  }

  async scroll(point: Point, dx: number, dy: number): Promise<void> {
    const p = this.native(point)
    const args = ['mousemove', '--sync', String(p.x), String(p.y)]
    // Buttons 4/5 scroll up/down, 6/7 left/right.
    if (dy) args.push('click', '--repeat', String(Math.abs(dy)), '--delay', '16', dy > 0 ? '5' : '4')
    if (dx) args.push('click', '--repeat', String(Math.abs(dx)), '--delay', '16', dx > 0 ? '7' : '6')
    await this.xdo(args)
  }

  async type(text: string): Promise<void> {
    await this.xdo(['type', '--delay', '8', '--', text])
  }

  async key(combo: Combo): Promise<void> {
    if (combo.modifiers.includes('fn')) throw new Error('fn cannot be pressed from software on Linux.')
    const names = combo.modifiers.map((m) => XDOTOOL_MODIFIERS[m as Exclude<typeof m, 'fn'>])
    if (combo.key) names.push(xdotoolKey(combo.key))
    await this.xdo(['key', '--', names.join('+')])
  }

  async cursor(): Promise<Point> {
    const out = await this.xdo(['getmouselocation', '--shell'])
    const x = Number(/X=(\d+)/.exec(out)?.[1] ?? NaN)
    const y = Number(/Y=(\d+)/.exec(out)?.[1] ?? NaN)
    const s = this.scale()
    return { x: x / s, y: y / s }
  }

  async frontmost(): Promise<AppRef | null> {
    try {
      const window = (await this.xdo(['getactivewindow'])).trim()
      const pid = Number((await this.xdo(['getwindowpid', window])).trim())
      const name = (await this.xdo(['getwindowname', window])).trim()
      return { name, pid, bundleId: null, window }
    } catch {
      return null
    }
  }

  async activate(app: AppRef): Promise<void> {
    if (app.window) await this.xdo(['windowactivate', '--sync', app.window])
  }

  async locked(): Promise<boolean> {
    return false
  }

  async openApp(name: string): Promise<void> {
    // An executable name, not a shell line: no spaces, no metacharacters.
    if (!/^[\w.+-]+$/.test(name)) throw new Error('On Linux, app must be the name of an executable, e.g. "firefox".')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(name, [], { detached: true, stdio: 'ignore' })
      child.once('error', (error) => reject(new Error(`Could not open "${name}": ${error.message}`)))
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
  }

  dispose(): void {}
}
