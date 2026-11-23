import { spawn } from 'node:child_process'
import type { ExeAccount, ExeVm } from '@shared/environments'
import { sshBinary } from '../ade/ssh'

/**
 * exe.dev, through its own front door: `ssh exe.dev <command>`. The user's
 * SSH key is their login there (they signed up by running `ssh exe.dev` in a
 * terminal), so Eaon holds no token, and whatever ssh-agent and
 * ~/.ssh/config do for a terminal they do here. Every command is asked for
 * with `--json`; an error comes back as `{"error": "…"}`.
 *
 * What goes to exe.dev is a fixed command word and flags whose values Eaon
 * checks first (a VM name, numbers, an image reference); a setup script goes
 * on stdin (`--setup-script=/dev/stdin`), never into the command line.
 */

export interface ExeResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
}

export type ExeRunner = (args: string[], opts?: { stdin?: string; timeoutMs?: number }) => Promise<ExeResult>

/** exe.dev's endpoint. EAON_EXE_HOST points the tests at a stand-in. */
const exeTarget = (): string => process.env.EAON_EXE_HOST || 'exe.dev'

export const runExe: ExeRunner = (args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(
      sshBinary(),
      // No password prompt in the background, and exe.dev's own host key taken once, as a terminal's first `ssh exe.dev` would.
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new', exeTarget(), ...args],
      { stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true }
    )
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      stderr += '\nTimed out.'
      child.kill('SIGTERM')
    }, opts.timeoutMs ?? 30_000)
    const done = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout, stderr })
    }
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('error', (error) => {
      stderr += (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'ssh isn’t installed on this computer.' : error.message
      done(null)
    })
    child.on('close', (code) => done(code))
    if (opts.stdin !== undefined) {
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(opts.stdin)
    }
  })

/* ---------------------------------------------------------------- parsing */

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const GB = 1024 ** 3

/** One VM from `ls --json` (or `new --json`), in the shape Eaon uses. */
export function vmFrom(raw: unknown): ExeVm | null {
  if (!raw || typeof raw !== 'object') return null
  const vm = raw as Record<string, unknown>
  const name = str(vm.vm_name) ?? str(vm.name)
  if (!name) return null
  const host = str(vm.ssh_host) ?? str(vm.dns_name) ?? `${name}.exe.xyz`
  const memory = num(vm.memory_capacity_bytes)
  const disk = num(vm.disk_capacity_bytes)
  return {
    name,
    status: str(vm.status) ?? 'unknown',
    host,
    dest: str(vm.ssh_dest) ?? host,
    user: str(vm.ssh_user),
    cpus: num(vm.allocated_cpus) ?? num(vm.cpus),
    memoryGb: memory ? Math.round(memory / GB) : null,
    diskGb: disk ? Math.round(disk / GB) : null,
    image: str(vm.image),
    httpsUrl: str(vm.https_url),
    createdAt: str(vm.created_at),
    tags: Array.isArray(vm.tags) ? vm.tags.filter((t): t is string => typeof t === 'string') : []
  }
}

/** The VMs in `ls --json`'s answer: `{"vms": [...]}`. */
export function vmsFrom(text: string): ExeVm[] {
  const parsed = jsonOf(text)
  const list = parsed && typeof parsed === 'object' && Array.isArray((parsed as { vms?: unknown }).vms) ? (parsed as { vms: unknown[] }).vms : []
  return list.map(vmFrom).filter((vm): vm is ExeVm => vm !== null)
}

/** The JSON in an answer, or null. exe.dev prints one object; anything around it (a banner) is skipped. */
export function jsonOf(text: string): unknown {
  const trimmed = text.trim()
  const start = trimmed.indexOf('{')
  if (start === -1) return null
  try {
    return JSON.parse(trimmed.slice(start))
  } catch {
    return null
  }
}

/** What exe.dev said went wrong, in its own words where it gave some. */
export function exeError(result: ExeResult): string {
  const parsed = jsonOf(result.stdout) ?? jsonOf(result.stderr)
  const said = parsed && typeof parsed === 'object' ? str((parsed as { error?: unknown }).error) : null
  if (said) return said.replace(/\n+/g, ' ').trim()
  const text = `${result.stdout}\n${result.stderr}`.trim().split('\n').filter(Boolean).pop() ?? ''
  return text || 'exe.dev didn’t answer.'
}

/** Why the account can't be used, from what `whoami` (or anything) said. */
export function accountProblem(result: ExeResult): Extract<ExeAccount, { ok: false }> {
  const said = `${result.stdout}\n${result.stderr}`
  if (/isn’t installed|ENOENT/.test(said)) return { ok: false, reason: 'no-ssh', message: 'ssh isn’t installed on this computer, and exe.dev is reached with it.' }
  if (/complete registration|ssh exe\.dev\b.*sign|not registered|unknown key/i.test(said)) {
    return { ok: false, reason: 'not-registered', message: 'This computer’s SSH key isn’t signed up with exe.dev. Run ssh exe.dev in Terminal once to sign up, then check again.' }
  }
  if (/permission denied|publickey/i.test(said)) {
    return { ok: false, reason: 'not-registered', message: 'exe.dev didn’t accept this computer’s SSH key. Run ssh exe.dev in Terminal to sign up or add the key, then check again.' }
  }
  if (/choose a plan|billing/i.test(said)) return { ok: false, reason: 'no-plan', message: 'Your exe.dev account has no plan yet, so it can’t make VMs. Choose one at exe.dev/billing, then check again.' }
  if (/could not resolve|timed out|connection refused|no route|network is unreachable/i.test(said)) {
    return { ok: false, reason: 'unreachable', message: `Couldn’t reach exe.dev: ${exeError(result)}` }
  }
  return { ok: false, reason: 'other', message: exeError(result) }
}

/** `whoami`'s lines, `Email Address: …` and `Region: lax (Los Angeles, USA)`. */
export function whoamiFrom(text: string): { email: string | null; region: string | null } {
  const parsed = jsonOf(text) as Record<string, unknown> | null
  if (parsed && typeof parsed === 'object') return { email: str(parsed.email), region: str(parsed.region_display) ?? str(parsed.region) }
  const field = (name: string): string | null => new RegExp(`^\\s*${name}:\\s*(.+)$`, 'mi').exec(text)?.[1].trim() ?? null
  return { email: field('Email Address') ?? field('Email'), region: field('Region') }
}

/* ----------------------------------------------------------------- client */

export interface NewVm {
  name: string
  cpu?: number
  memory?: number
  disk?: number
  image?: string
  setup?: string
}

/** The flags for `new`, every value checked so none can carry another flag or word. */
export function newVmArgs(vm: NewVm): string[] {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(vm.name)) throw new Error(`“${vm.name}” isn’t a name exe.dev takes: lowercase letters, digits and hyphens.`)
  const args = ['new', `--name=${vm.name}`, '--json', '--no-email', '--tag=eaon']
  const whole = (n: number | undefined, what: string, max: number): void => {
    if (n === undefined) return
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${what} is a whole number from 1 to ${max}.`)
  }
  whole(vm.cpu, 'CPUs', 64)
  whole(vm.memory, 'Memory (GB)', 512)
  whole(vm.disk, 'Disk (GB)', 4096)
  if (vm.cpu) args.push(`--cpu=${vm.cpu}`)
  if (vm.memory) args.push(`--memory=${vm.memory}GB`)
  if (vm.disk) args.push(`--disk=${vm.disk}GB`)
  if (vm.image) {
    const image = vm.image.trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(image)) throw new Error('An image is a name like ubuntu:24.04 or ghcr.io/me/app:latest.')
    args.push(`--image=${image}`)
  }
  if (vm.setup?.trim()) args.push('--setup-script=/dev/stdin')
  return args
}

export class ExeClient {
  constructor(private readonly run: ExeRunner = runExe) {}

  async account(): Promise<ExeAccount> {
    const who = await this.run(['whoami'], { timeoutMs: 20_000 })
    if (!who.ok) return accountProblem(who)
    const list = await this.run(['ls', '--json'], { timeoutMs: 20_000 })
    if (!list.ok) return accountProblem(list)
    return { ok: true, ...whoamiFrom(who.stdout), vms: vmsFrom(list.stdout) }
  }

  async list(): Promise<ExeVm[]> {
    const result = await this.run(['ls', '--json'], { timeoutMs: 20_000 })
    if (!result.ok) throw new Error(accountProblem(result).message)
    return vmsFrom(result.stdout)
  }

  async find(name: string): Promise<ExeVm | null> {
    return (await this.list()).find((vm) => vm.name === name) ?? null
  }

  /** Makes a VM and says how to reach it. `new` can take minutes; it answers once the VM is up. */
  async create(vm: NewVm): Promise<ExeVm> {
    const args = newVmArgs(vm)
    const result = await this.run(args, { timeoutMs: 9 * 60_000, ...(vm.setup?.trim() ? { stdin: vm.setup } : {}) })
    if (!result.ok) throw new Error(`exe.dev couldn’t make the VM: ${exeError(result)}`)
    const made = vmFrom(jsonOf(result.stdout))
    // The answer's shape isn't promised: the listing says for sure.
    return (made && made.host ? made : null) ?? (await this.find(vm.name)) ?? { name: vm.name, status: 'running', host: `${vm.name}.exe.xyz`, dest: `${vm.name}.exe.xyz`, user: null, cpus: null, memoryGb: null, diskGb: null, image: null, httpsUrl: null, createdAt: null, tags: ['eaon'] }
  }

  async remove(name: string): Promise<void> {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error('That isn’t a VM name.')
    const result = await this.run(['rm', name, '--json'], { timeoutMs: 120_000 })
    if (!result.ok) throw new Error(`exe.dev couldn’t delete ${name}: ${exeError(result)}`)
  }

  /** A paused VM is woken, a stopped one started; one that is running is left alone. */
  async wake(vm: ExeVm): Promise<void> {
    if (/running/i.test(vm.status)) return
    const verb = /paus/i.test(vm.status) ? 'resume' : 'restart'
    const result = await this.run([verb, vm.name, '--json'], { timeoutMs: 180_000 })
    if (!result.ok) throw new Error(`exe.dev couldn’t start ${vm.name}: ${exeError(result)}`)
  }
}
