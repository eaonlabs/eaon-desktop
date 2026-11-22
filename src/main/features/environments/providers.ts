import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { SshHost } from '@shared/adeRemote'
import { PROVIDER_NAMES, type ProviderId, type ProviderMachine, type ProviderStatus } from '@shared/environments'
import { onPath } from '../../shellEnv'
import { shQuote } from '../ade/ssh'

/**
 * The CLI sniffer: the VM providers whose command-line tools are on this
 * computer, whether each is signed in, and the machines it can see, so one
 * can be picked as a cloud environment (shared/environments.ts) without
 * typing an address. Only reading commands are run (version, who am I, list);
 * nothing is started, made or changed at the provider.
 *
 * Each provider says how ssh reaches its machines: an address and a user (a
 * cloud VM), the provider's own ssh config (Lima, OrbStack, a codespace,
 * which `gh` writes one for), or a proxy command through its CLI (Coder).
 * Signing in is the person's own doing: Eaon says the command for Terminal.
 */

export interface CliResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
}

export type CliRunner = (bin: string, args: string[], timeoutMs?: number) => Promise<CliResult>

export const runCli: CliRunner = (bin, args, timeoutMs = 30_000) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, NO_COLOR: '1', CI: '1' } }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null) : 0
      resolve({ ok: !error, code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (error?.message ?? '') })
    })
  })

/** Where a provider's CLI often is when the login shell's PATH doesn't say (an app started from the Dock). */
const EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), join(homedir(), 'bin'), join(homedir(), 'google-cloud-sdk', 'bin'), join(homedir(), '.orbstack', 'bin')]

/** The first of `bins` found on PATH or in the usual folders, or at one of `paths`. */
export function findCli(bins: string[], paths: string[] = []): string | null {
  for (const bin of bins) {
    const found = onPath(bin)
    if (found) return found
    for (const dir of EXTRA_DIRS) {
      const candidate = join(dir, bin)
      if (executable(candidate)) return candidate
    }
  }
  return paths.find(executable) ?? null
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The JSON a CLI printed, or null. Some print a banner or a warning first. */
export function jsonOut(text: string): unknown {
  const trimmed = text.trim()
  for (const start of [0, trimmed.search(/[[{]/)]) {
    if (start < 0) continue
    try {
      return JSON.parse(trimmed.slice(start))
    } catch {
      /* the next try */
    }
  }
  return null
}

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const arr = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object') : [])
const obj = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/** A machine's name as ssh and a shell can take it: nothing that could be read as another word or an option. */
export const safeName = (name: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._@:/+-]{0,200}$/.test(name)

/** What a list said, for each provider: its machines, or why there are none to show. */
export type Listing = { machines: Machine[]; account?: string | null } | { state: 'signed-out' | 'error'; message: string; fix: string | null }

export interface Machine extends ProviderMachine {
  /** How ssh reaches it; built when it is picked. */
  reach: Reach | null
}

type Reach =
  | { kind: 'address'; hostname: string; user: string | null; identityFile?: string | null }
  | { kind: 'config'; alias: string; configFile: string }
  | { kind: 'proxy'; hostname: string; proxyCommand: string; user?: string | null }
  | { kind: 'codespace'; name: string }

interface Provider {
  id: ProviderId
  bins: string[]
  paths?: string[]
  site: string
  install: string
  list: (bin: string, run: CliRunner) => Promise<{ listing: Listing; machines?: Machine[] }>
}

const machine = (m: Omit<Machine, 'why'> & { why?: string | null }): Machine => ({ ...m, why: m.why ?? null })

/** A first matching line of a CLI's complaint, cut short, for people. */
const said = (result: CliResult): string =>
  (result.stderr || result.stdout)
    .trim()
    .split('\n')
    .find((line) => line.trim())
    ?.trim()
    .slice(0, 240) ?? 'No answer.'

const signedOut = (message: string, fix: string | null): Listing => ({ state: 'signed-out', message, fix })
const failed = (result: CliResult): Listing => ({ state: 'error', message: said(result), fix: null })

/* ------------------------------------------------------------- parsers */

/** `gh codespace list --json name,displayName,state,repository,machineName` */
export function parseCodespaces(text: string): Machine[] {
  return arr(jsonOut(text)).flatMap((c) => {
    const name = str(c.name)
    if (!name || !safeName(name)) return []
    const state = str(c.state) ?? 'Unknown'
    const repo = typeof c.repository === 'string' ? c.repository : str(obj(c.repository).nameWithOwner)
    return [machine({ id: name, name: str(c.displayName) ?? name, status: state, running: state === 'Available', detail: [repo, str(c.machineName)].filter(Boolean).join(' · ') || null, user: null, reach: { kind: 'codespace', name } })]
  })
}

/** `limactl list --json`: one JSON object per line. */
export function parseLima(text: string): Machine[] {
  return text
    .split('\n')
    .map((line) => jsonOut(line))
    .flatMap((value) => {
      const vm = obj(value)
      const name = str(vm.name)
      const config = str(vm.sshConfigFile)
      if (!name || !safeName(name)) return []
      const status = str(vm.status) ?? 'Unknown'
      const running = status === 'Running'
      const cpus = typeof vm.cpus === 'number' ? `${vm.cpus} CPU` : null
      return [
        machine({
          id: name,
          name,
          status,
          running,
          detail: [cpus, str(vm.arch), str(vm.vmType)].filter(Boolean).join(' · ') || null,
          user: null,
          why: running ? null : `It’s ${status.toLowerCase()}. Start it in Terminal: limactl start ${name}`,
          reach: config ? { kind: 'config', alias: `lima-${name}`, configFile: config } : null
        })
      ]
    })
}

/** `orbctl list -f json` (or its table, when the version can't say it as JSON). */
export function parseOrb(text: string): Machine[] {
  const parsed = jsonOut(text)
  const rows = Array.isArray(parsed)
    ? arr(parsed).map((m) => ({ name: str(m.name), state: str(m.state) ?? str(obj(m.record).state), detail: [str(obj(m.image).distro) ?? str(m.distro), str(obj(m.image).version)].filter(Boolean).join(' ') }))
    : text
        .split('\n')
        .slice(1)
        .map((line) => line.trim().split(/\s+/))
        .filter((cols) => cols.length >= 2 && cols[0])
        .map((cols) => ({ name: cols[0], state: cols[1], detail: cols.slice(2, 4).join(' ') }))
  const config = join(homedir(), '.orbstack', 'ssh', 'config')
  return rows.flatMap((row) => {
    if (!row.name || !safeName(row.name)) return []
    const status = row.state ?? 'unknown'
    const running = /running/i.test(status)
    return [
      machine({
        id: row.name,
        name: row.name,
        status,
        running,
        detail: row.detail || null,
        user: null,
        why: running ? null : `It’s ${status}. Start it in Terminal: orb start ${row.name}`,
        reach: { kind: 'config', alias: `${row.name}@orb`, configFile: config }
      })
    ]
  })
}

/** `tailscale status --json`: the other machines on the tailnet that can run a session (not phones or Windows). */
export function parseTailscale(text: string): Listing {
  const status = obj(jsonOut(text))
  const backend = str(status.BackendState)
  if (backend && backend !== 'Running') return signedOut(`Tailscale is ${backend === 'NeedsLogin' ? 'signed out' : backend.toLowerCase()} on this computer.`, 'tailscale up')
  const peers = Object.values(obj(status.Peer)).map(obj)
  const machines = peers.flatMap((peer) => {
    const os = (str(peer.OS) ?? '').toLowerCase()
    if (!['linux', 'macos', 'freebsd', 'openbsd'].includes(os)) return []
    const dns = (str(peer.DNSName) ?? '').replace(/\.$/, '')
    const name = str(peer.HostName) ?? dns
    const id = str(peer.ID) ?? dns
    if (!dns || !safeName(dns) || !id) return []
    const online = peer.Online === true
    return [
      machine({
        id,
        name,
        status: online ? 'online' : 'offline',
        running: online,
        detail: `${os === 'macos' ? 'macOS' : os} · ${dns}`,
        user: null,
        why: online ? null : 'It’s offline on your tailnet.',
        reach: { kind: 'address', hostname: dns, user: null }
      })
    ]
  })
  return { machines, account: str(obj(obj(status.CurrentTailnet)).Name) ?? str(obj(status.Self).HostName) }
}

/** `hcloud server list -o json` */
export function parseHetzner(text: string): Machine[] {
  return arr(jsonOut(text)).flatMap((s) => {
    const name = str(s.name)
    const ip = str(obj(obj(obj(s.public_net).ipv4)).ip)
    if (!name) return []
    const status = str(s.status) ?? 'unknown'
    const running = status === 'running'
    return [
      machine({
        id: String(s.id ?? name),
        name,
        status,
        running,
        detail: [str(obj(obj(obj(s.datacenter).location)).name), str(obj(s.server_type).name), ip].filter(Boolean).join(' · ') || null,
        user: 'root',
        why: !ip ? 'It has no public IPv4 address.' : running ? null : `It’s ${status}. Start it: hcloud server poweron ${name}`,
        reach: ip ? { kind: 'address', hostname: ip, user: 'root' } : null
      })
    ]
  })
}

/** `doctl compute droplet list -o json` */
export function parseDigitalOcean(text: string): Machine[] {
  return arr(jsonOut(text)).flatMap((d) => {
    const name = str(d.name)
    if (!name) return []
    const ip = arr(obj(d.networks).v4).find((n) => n.type === 'public')?.ip_address
    const address = typeof ip === 'string' ? ip : null
    const status = str(d.status) ?? 'unknown'
    const running = status === 'active'
    return [
      machine({
        id: String(d.id ?? name),
        name,
        status,
        running,
        detail: [str(obj(d.region).slug), str(d.size_slug), address].filter(Boolean).join(' · ') || null,
        user: 'root',
        why: !address ? 'It has no public IPv4 address.' : running ? null : `It’s ${status}. Power it on: doctl compute droplet-action power-on ${String(d.id ?? name)}`,
        reach: address ? { kind: 'address', hostname: address, user: 'root' } : null
      })
    ]
  })
}

/** `aws ec2 describe-instances --output json` */
export function parseAws(text: string, home = homedir()): Machine[] {
  return arr(obj(jsonOut(text)).Reservations).flatMap((r) =>
    arr(r.Instances).flatMap((i) => {
      const id = str(i.InstanceId)
      if (!id) return []
      const name = str(arr(i.Tags).find((t) => t.Key === 'Name')?.Value) ?? id
      const status = str(obj(i.State).Name) ?? 'unknown'
      const running = status === 'running'
      const address = str(i.PublicDnsName) ?? str(i.PublicIpAddress)
      const key = str(i.KeyName)
      const pem = key ? [join(home, '.ssh', `${key}.pem`), join(home, '.ssh', key)].find((p) => existsSync(p)) : undefined
      const windows = /windows/i.test(str(i.Platform) ?? str(i.PlatformDetails) ?? '')
      if (windows) return []
      return [
        machine({
          id,
          name,
          status,
          running,
          detail: [str(obj(i.Placement).AvailabilityZone), str(i.InstanceType), address].filter(Boolean).join(' · ') || null,
          // Amazon Linux's; Ubuntu's images use ubuntu, Debian's admin: changeable when it is picked.
          user: 'ec2-user',
          why: !address ? 'It has no public address.' : running ? null : `It’s ${status}. Start it: aws ec2 start-instances --instance-ids ${id}`,
          reach: address ? { kind: 'address', hostname: address, user: 'ec2-user', identityFile: pem ?? null } : null
        })
      ]
    })
  )
}

/** `gcloud compute instances list --format=json` */
export function parseGcp(text: string, home = homedir(), user = safeUser()): Machine[] {
  const key = join(home, '.ssh', 'google_compute_engine')
  return arr(jsonOut(text)).flatMap((i) => {
    const name = str(i.name)
    if (!name) return []
    const ip = str(arr(arr(i.networkInterfaces)[0]?.accessConfigs)[0]?.natIP)
    const status = str(i.status) ?? 'UNKNOWN'
    const running = status === 'RUNNING'
    const zone = (str(i.zone) ?? '').split('/').pop() ?? ''
    const type = (str(i.machineType) ?? '').split('/').pop() ?? ''
    return [
      machine({
        id: `${zone}/${name}`,
        name,
        status: status.toLowerCase(),
        running,
        detail: [zone, type, ip].filter(Boolean).join(' · ') || null,
        user,
        why: !ip ? 'It has no external IP address.' : running ? null : `It’s ${status.toLowerCase()}. Start it: gcloud compute instances start ${name} --zone ${zone}`,
        reach: ip ? { kind: 'address', hostname: ip, user, identityFile: existsSync(key) ? key : null } : null
      })
    ]
  })
}

/** `az vm list -d --output json` */
export function parseAzure(text: string): Machine[] {
  return arr(jsonOut(text)).flatMap((v) => {
    const name = str(v.name)
    if (!name) return []
    if (/windows/i.test(str(obj(obj(v.storageProfile).osDisk).osType) ?? '')) return []
    const ip = (str(v.publicIps) ?? '').split(',')[0]?.trim() || null
    const host = (str(v.fqdns) ?? '').split(',')[0]?.trim() || ip
    const status = str(v.powerState) ?? 'unknown'
    const running = /running/i.test(status)
    const user = str(obj(v.osProfile).adminUsername)
    return [
      machine({
        id: str(v.id) ?? name,
        name,
        status: status.replace(/^VM /, ''),
        running,
        detail: [str(v.location), str(obj(v.hardwareProfile).vmSize), host].filter(Boolean).join(' · ') || null,
        user,
        why: !host ? 'It has no public IP address.' : running ? null : `It’s ${status.replace(/^VM /, '')}. Start it: az vm start -n ${name} -g ${str(v.resourceGroup) ?? '<group>'}`,
        reach: host ? { kind: 'address', hostname: host, user } : null
      })
    ]
  })
}

/** `linode-cli linodes list --json` */
export function parseLinode(text: string): Machine[] {
  return arr(jsonOut(text)).flatMap((l) => {
    const name = str(l.label)
    if (!name) return []
    const ip = Array.isArray(l.ipv4) ? (l.ipv4.find((a): a is string => typeof a === 'string' && !/^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(a)) ?? null) : null
    const status = str(l.status) ?? 'unknown'
    const running = status === 'running'
    return [
      machine({
        id: String(l.id ?? name),
        name,
        status,
        running,
        detail: [str(l.region), str(l.type), ip].filter(Boolean).join(' · ') || null,
        user: 'root',
        why: !ip ? 'It has no public IPv4 address.' : running ? null : `It’s ${status}. Boot it: linode-cli linodes boot ${String(l.id ?? '')}`,
        reach: ip ? { kind: 'address', hostname: ip, user: 'root' } : null
      })
    ]
  })
}

/** `vultr-cli instance list -o json` */
export function parseVultr(text: string): Machine[] {
  const parsed = jsonOut(text)
  return arr(Array.isArray(parsed) ? parsed : obj(parsed).instances).flatMap((v) => {
    const name = str(v.label) ?? str(v.hostname)
    if (!name) return []
    const ip = str(v.main_ip)
    const address = ip && ip !== '0.0.0.0' ? ip : null
    const status = str(v.power_status) ?? str(v.status) ?? 'unknown'
    const running = /running|active/.test(status)
    return [
      machine({
        id: String(v.id ?? name),
        name,
        status,
        running,
        detail: [str(v.region), str(v.plan), address].filter(Boolean).join(' · ') || null,
        user: 'root',
        why: !address ? 'It has no public IPv4 address.' : running ? null : `It’s ${status}. Start it: vultr-cli instance start ${String(v.id ?? '')}`,
        reach: address ? { kind: 'address', hostname: address, user: 'root' } : null
      })
    ]
  })
}

/** `coder list -o json`: workspaces, reached through `coder ssh --stdio`. */
export function parseCoder(text: string, bin: string): Machine[] {
  return arr(jsonOut(text)).flatMap((w) => {
    const name = str(w.name)
    if (!name || !safeName(name)) return []
    const owner = str(w.owner_name)
    const target = owner && safeName(owner) ? `${owner}/${name}` : name
    const build = obj(w.latest_build)
    const status = str(build.status) ?? 'unknown'
    const running = status === 'running'
    return [
      machine({
        id: target,
        name,
        status,
        running,
        detail: [str(w.template_name), owner].filter(Boolean).join(' · ') || null,
        user: null,
        why: running ? null : `It’s ${status}. Start it: coder start ${target}`,
        reach: { kind: 'proxy', hostname: `coder.${name}`, proxyCommand: `${shQuote(bin)} ssh --stdio ${shQuote(target)}` }
      })
    ]
  })
}

function safeUser(): string | null {
  try {
    const name = userInfo().username
    return /^[a-z_][a-z0-9_.-]*$/i.test(name) ? name : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------ providers */

const json = (result: CliResult, parse: (text: string) => Machine[]): { listing: Listing; machines?: Machine[] } => {
  if (!result.ok) return { listing: failed(result) }
  const machines = parse(result.stdout)
  return { listing: { machines }, machines }
}

export const PROVIDERS: Provider[] = [
  {
    id: 'codespaces',
    bins: ['gh'],
    site: 'https://github.com/features/codespaces',
    install: 'brew install gh',
    async list(bin, run) {
      const result = await run(bin, ['codespace', 'list', '--json', 'name,displayName,state,repository,machineName'])
      if (!result.ok) {
        const text = `${result.stderr}\n${result.stdout}`
        if (/codespace" scope|-s codespace/.test(text)) return { listing: signedOut('The GitHub CLI is signed in, but not allowed to see your codespaces.', 'gh auth refresh -h github.com -s codespace') }
        if (/gh auth login|not logged in/i.test(text)) return { listing: signedOut('The GitHub CLI isn’t signed in.', 'gh auth login') }
        return { listing: failed(result) }
      }
      return json(result, parseCodespaces)
    }
  },
  {
    id: 'aws',
    bins: ['aws'],
    site: 'https://aws.amazon.com/ec2/',
    install: 'brew install awscli',
    async list(bin, run) {
      const result = await run(bin, ['ec2', 'describe-instances', '--output', 'json'], 60_000)
      if (!result.ok && /Unable to locate credentials|ExpiredToken|SSO|token has expired|InvalidClientTokenId|AuthFailure|could not be found/i.test(result.stderr)) {
        return { listing: signedOut('The AWS CLI isn’t signed in (or its sign-in has expired).', 'aws configure') }
      }
      if (!result.ok && /You must specify a region/i.test(result.stderr)) return { listing: signedOut('The AWS CLI has no region set.', 'aws configure set region us-east-1') }
      return json(result, (text) => parseAws(text))
    }
  },
  {
    id: 'gcp',
    bins: ['gcloud'],
    site: 'https://cloud.google.com/compute',
    install: 'brew install --cask google-cloud-sdk',
    async list(bin, run) {
      const result = await run(bin, ['compute', 'instances', 'list', '--format=json', '--quiet'], 60_000)
      if (!result.ok && /do not currently have an active account|gcloud auth login|Reauthentication|refresh token/i.test(result.stderr)) {
        return { listing: signedOut('The Google Cloud CLI isn’t signed in.', 'gcloud auth login') }
      }
      if (!result.ok && /project property|required property \[project\]/i.test(result.stderr)) return { listing: signedOut('The Google Cloud CLI has no project set.', 'gcloud config set project <your-project>') }
      return json(result, (text) => parseGcp(text))
    }
  },
  {
    id: 'azure',
    bins: ['az'],
    site: 'https://azure.microsoft.com/products/virtual-machines',
    install: 'brew install azure-cli',
    async list(bin, run) {
      const who = await run(bin, ['account', 'show', '--output', 'json'])
      if (!who.ok) {
        if (/az login|Please run/i.test(who.stderr)) return { listing: signedOut('The Azure CLI isn’t signed in.', 'az login') }
        return { listing: failed(who) }
      }
      const account = str(obj(jsonOut(who.stdout)).name)
      const result = await run(bin, ['vm', 'list', '-d', '--output', 'json'], 90_000)
      const listed = json(result, parseAzure)
      return 'machines' in listed.listing ? { ...listed, listing: { ...listed.listing, account } } : listed
    }
  },
  {
    id: 'digitalocean',
    bins: ['doctl'],
    site: 'https://www.digitalocean.com/products/droplets',
    install: 'brew install doctl',
    async list(bin, run) {
      const result = await run(bin, ['compute', 'droplet', 'list', '-o', 'json'])
      if (!result.ok && /access token|auth init|Unable to initialize|401/i.test(result.stderr)) return { listing: signedOut('doctl isn’t signed in.', 'doctl auth init') }
      return json(result, parseDigitalOcean)
    }
  },
  {
    id: 'hetzner',
    bins: ['hcloud'],
    site: 'https://www.hetzner.com/cloud',
    install: 'brew install hcloud',
    async list(bin, run) {
      const result = await run(bin, ['server', 'list', '-o', 'json'])
      if (!result.ok && /no active context|token|unauthorized/i.test(result.stderr)) return { listing: signedOut('hcloud has no project (context) set up.', 'hcloud context create <name>') }
      return json(result, parseHetzner)
    }
  },
  {
    id: 'linode',
    bins: ['linode-cli'],
    site: 'https://www.linode.com/products/shared/',
    install: 'pipx install linode-cli',
    async list(bin, run) {
      const result = await run(bin, ['linodes', 'list', '--json'])
      if (!result.ok && /configure|token|401/i.test(`${result.stderr}${result.stdout}`)) return { listing: signedOut('linode-cli isn’t set up.', 'linode-cli configure') }
      return json(result, parseLinode)
    }
  },
  {
    id: 'vultr',
    bins: ['vultr-cli'],
    site: 'https://www.vultr.com/products/cloud-compute/',
    install: 'brew install vultr/vultr-cli/vultr-cli',
    async list(bin, run) {
      const result = await run(bin, ['instance', 'list', '-o', 'json'])
      if (!result.ok && /api key|VULTR_API_KEY|401|unauthorized/i.test(result.stderr)) return { listing: signedOut('vultr-cli has no API key.', 'export VULTR_API_KEY=<your key>') }
      return json(result, parseVultr)
    }
  },
  {
    id: 'coder',
    bins: ['coder'],
    site: 'https://coder.com',
    install: 'brew install coder',
    async list(bin, run) {
      const result = await run(bin, ['list', '-o', 'json'])
      if (!result.ok && /not logged in|coder login|unauthorized|401/i.test(result.stderr)) return { listing: signedOut('The Coder CLI isn’t signed in.', 'coder login <your Coder URL>') }
      return json(result, (text) => parseCoder(text, bin))
    }
  },
  {
    id: 'tailscale',
    bins: ['tailscale'],
    paths: ['/Applications/Tailscale.app/Contents/MacOS/Tailscale'],
    site: 'https://tailscale.com',
    install: 'brew install --cask tailscale',
    async list(bin, run) {
      const result = await run(bin, ['status', '--json'])
      if (!result.ok && !result.stdout.trim()) return { listing: /not running|stopped|failed to connect/i.test(result.stderr) ? signedOut('Tailscale isn’t running on this computer.', 'tailscale up') : failed(result) }
      const parsed = parseTailscale(result.stdout)
      return 'state' in parsed ? { listing: parsed } : { listing: parsed, machines: parsed.machines }
    }
  },
  {
    id: 'lima',
    bins: ['limactl'],
    site: 'https://lima-vm.io',
    install: 'brew install lima',
    async list(bin, run) {
      return json(await run(bin, ['list', '--json']), parseLima)
    }
  },
  {
    id: 'orbstack',
    bins: ['orbctl', 'orb'],
    site: 'https://orbstack.dev',
    install: 'brew install --cask orbstack',
    async list(bin, run) {
      const asJson = await run(bin, ['list', '-f', 'json'])
      return json(asJson.ok ? asJson : await run(bin, ['list']), parseOrb)
    }
  }
]

/* --------------------------------------------------------------- sniff */

/** What was last found, by provider, so picking a machine doesn't ask its CLI again. */
const lastFound = new Map<ProviderId, { bin: string; machines: Machine[] }>()

/** Every provider: whether its CLI is here, signed in, and its machines. All at once; each CLI's slowness is its own. */
export async function sniff(run: CliRunner = runCli, find: (bins: string[], paths?: string[]) => string | null = findCli): Promise<ProviderStatus[]> {
  return Promise.all(
    PROVIDERS.map(async (provider): Promise<ProviderStatus> => {
      const base = { id: provider.id, name: PROVIDER_NAMES[provider.id], site: provider.site, account: null, message: null, fix: null, machines: [] }
      const bin = find(provider.bins, provider.paths)
      if (!bin) return { ...base, state: 'missing', cli: provider.bins[0], fix: provider.install }
      const cli = bin.split('/').pop() ?? provider.bins[0]
      try {
        const { listing, machines } = await provider.list(bin, run)
        if ('state' in listing) return { ...base, cli, state: listing.state, message: listing.message, fix: listing.fix }
        lastFound.set(provider.id, { bin, machines: machines ?? [] })
        return { ...base, cli, state: 'ready', account: listing.account ?? null, machines: listing.machines.map(({ reach: _reach, ...rest }) => rest) }
      } catch (error) {
        return { ...base, cli, state: 'error', message: error instanceof Error ? error.message : String(error) }
      }
    })
  )
}

/**
 * How ssh reaches a machine the sniffer found: an SSH host for the ADE's
 * host book, kept by provider and machine so picking it again replaces it.
 * A codespace's config is asked of `gh` and written beside Eaon's data.
 */
export async function hostFor(providerId: ProviderId, machineId: string, opts: { user?: string; dataDir: string; run?: CliRunner }): Promise<SshHost> {
  const found = lastFound.get(providerId)
  const target = found?.machines.find((m) => m.id === machineId)
  if (!found || !target) throw new Error('That machine wasn’t in the last look. Look again, then pick it.')
  if (!target.reach) throw new Error(target.why ?? `Eaon can’t reach ${target.name} over SSH.`)
  const user = opts.user?.trim() || null
  if (user && !/^[a-z_][a-z0-9_.-]*$/i.test(user)) throw new Error('A user name is letters, digits, dots, hyphens and underscores.')
  const id = `prov:${providerId}:${machineId}`
  const label = `${target.name} (${PROVIDER_NAMES[providerId]})`
  const base: SshHost = { id, label, hostname: target.name, user: null, port: null, identityFile: null, source: 'manual', alias: null, provider: providerId }
  const reach = target.reach
  switch (reach.kind) {
    case 'address':
      if (!safeName(reach.hostname)) throw new Error('That machine’s address can’t be used.')
      return { ...base, hostname: reach.hostname, user: user ?? reach.user, identityFile: reach.identityFile ?? null }
    case 'config':
      return { ...base, source: 'config', alias: user && !reach.alias.includes('@') ? `${user}@${reach.alias}` : reach.alias, configFile: reach.configFile }
    case 'proxy':
      return { ...base, hostname: reach.hostname, user: user ?? reach.user ?? null, proxyCommand: reach.proxyCommand }
    case 'codespace': {
      const run = opts.run ?? runCli
      const result = await run(found.bin, ['codespace', 'ssh', '--config', '-c', reach.name], 120_000)
      const alias = /^Host\s+(\S+)/m.exec(result.stdout)?.[1]
      if (!result.ok || !alias) throw new Error(`gh couldn’t set up ssh for ${target.name}: ${said(result)}`)
      const dir = join(opts.dataDir, 'environments', 'ssh')
      await mkdir(dir, { recursive: true })
      const file = join(dir, `codespace-${reach.name.replace(/[^A-Za-z0-9._-]/g, '-')}.config`)
      await writeFile(file, `# Written by Eaon from \`gh codespace ssh --config -c ${reach.name}\`; picked again, it is written again.\n${result.stdout}`, { mode: 0o600 })
      return { ...base, source: 'config', alias, configFile: file }
    }
  }
}

/** For the tests: what a sniff found, set by hand. */
export function rememberFound(providerId: ProviderId, bin: string, machines: Machine[]): void {
  lastFound.set(providerId, { bin, machines })
}
