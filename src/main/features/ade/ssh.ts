import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { hostLabel, type ManualHostInput, type SshHost } from '@shared/adeRemote'

/**
 * Connections to other machines, ported from the standalone Eaon ADE
 * (`main/ssh.ts`).
 *
 * `sshArgv` and the command-line builders are pure: given a host and a
 * command they say exactly what would run, which is what makes them testable
 * without a server. `remoteExec` is the one function that shells out.
 *
 * Nothing here touches a passphrase or a key's bytes. `identityFile` is a
 * path handed to the real `ssh` with `-i`; ssh decides whether the key needs
 * unlocking and, in a pane, prompts there like any terminal would.
 */

/** The ssh client: the user's own. EAON_SSH_BIN swaps in a stand-in for the end-to-end tests. */
export const sshBinary = (): string => process.env.EAON_SSH_BIN || 'ssh'

/** Timeout on connecting, not on how long a command runs. */
const CONNECT_TIMEOUT_S = 10

/**
 * The `ssh` arguments for reaching a host; none of them go through a shell.
 * A host from ~/.ssh/config is reached by its alias alone, so its ProxyJump,
 * Include, IdentityFile lines and Match blocks apply exactly as in a
 * terminal. A host added in Eaon passes every flag itself.
 */
export function sshArgv(host: SshHost, opts: { interactive: boolean }): string[] {
  const args = ['-o', `ConnectTimeout=${CONNECT_TIMEOUT_S}`, '-o', 'ServerAliveInterval=15']
  // -tt: a real pty on the far end even though a command follows.
  if (opts.interactive) args.push('-tt')
  // A command run in the background has nobody to type a password: fail rather than hang.
  else args.push('-o', 'BatchMode=yes')
  if (host.source === 'config' && host.alias) {
    args.push(host.alias)
    return args
  }
  if (host.port) args.push('-p', String(host.port))
  if (host.identityFile) args.push('-i', host.identityFile)
  args.push(host.user ? `${host.user}@${host.hostname}` : host.hostname)
  return args
}

/** POSIX single quotes: the one way to make any string one shell word. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * One command for sshd, which runs it through the remote user's shell: every
 * argument quoted, run in `cwd`. The only place a string crosses a shell.
 */
export function remoteCommandLine(cwd: string | null, cmd: string, args: string[]): string {
  const line = [cmd, ...args].map(shQuote).join(' ')
  return cwd ? `cd ${shQuote(cwd)} && ${line}` : line
}

/**
 * What a terminal pane runs on the host: land in `cwd`, then a login shell
 * (whatever the remote user's is). A folder that has gone leaves the shell in
 * the home folder rather than the pane on a dead connection.
 */
export function remoteShellCommand(cwd: string): string {
  return `cd ${shQuote(cwd)} 2>/dev/null; exec "$SHELL" -l`
}

export interface RemoteExecResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
}

/** Runs one command line on the host (built by `remoteCommandLine`, or a fixed snippet) and captures its output. */
export function remoteExec(host: SshHost, commandLine: string, opts: { timeoutMs?: number } = {}): Promise<RemoteExecResult> {
  return new Promise((resolve) => {
    execFile(
      sshBinary(),
      [...sshArgv(host, { interactive: false }), commandLine],
      { timeout: opts.timeoutMs ?? 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : null) : 0
        resolve({ ok: !error, code, stdout: String(stdout ?? ''), stderr: String(stderr ?? (error ? error.message : '')) })
      }
    )
  })
}

/**
 * A folder on the host as an absolute path: `~` and `~/x` expanded by the
 * remote shell, and the folder checked to exist. The snippet is fixed text
 * with the path quoted, except the home prefix, which is the point.
 */
export async function resolveRemoteFolder(host: SshHost, folder: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const trimmed = folder.trim() || '~'
  const tail = trimmed === '~' ? '' : trimmed.startsWith('~/') ? trimmed.slice(2) : null
  const target = tail === null ? shQuote(trimmed) : tail ? `"$HOME"/${shQuote(tail)}` : '"$HOME"'
  const res = await remoteExec(host, `cd ${target} && pwd -P`, { timeoutMs: 20_000 })
  if (res.ok && res.stdout.trim().startsWith('/')) return { ok: true, path: res.stdout.trim() }
  return { ok: false, error: connectProblem(host, res, trimmed) }
}

/** What went wrong reaching a host, in words. */
export function connectProblem(host: SshHost, res: RemoteExecResult, folder?: string): string {
  const said = res.stderr.trim().split('\n').filter(Boolean).pop() ?? ''
  const name = hostLabel(host)
  if (/permission denied|publickey|passphrase|authentication/i.test(said)) {
    return `${name} wouldn’t let Eaon in without a password or passphrase. Add your key to the SSH agent (ssh-add) so Eaon can connect without asking.`
  }
  if (/could not resolve|name or service not known|nodename nor servname/i.test(said)) return `Couldn’t find ${name}: ${said}`
  if (/timed out|connection refused|no route/i.test(said)) return `Couldn’t reach ${name}: ${said}`
  if (res.code === 255) return `Couldn’t connect to ${name}${said ? `: ${said}` : '.'}`
  if (folder) return `${folder} isn’t a folder on ${name}.`
  return said || `The command failed on ${name}.`
}

/* ------------------------------------------------------- ~/.ssh/config, read only */

interface RawBlock {
  patterns: string[]
  fields: Map<string, string>
}

/**
 * Top-level `Host` blocks only. `Include` isn't followed and `Match` isn't
 * evaluated: half-implementing ssh_config's resolution would show hosts that
 * connect differently for the real ssh. A wildcard pattern isn't one host.
 * Reading this only fills a picker; ssh itself reads its config to connect.
 */
function readBlocks(text: string): RawBlock[] {
  const blocks: RawBlock[] = []
  let current: RawBlock | null = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = /^(\S+)\s*(?:=\s*|\s+)(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (key === 'host') {
      current = { patterns: value.split(/\s+/), fields: new Map() }
      blocks.push(current)
      continue
    }
    // First occurrence wins, as in ssh_config.
    if (current && !current.fields.has(key)) current.fields.set(key, value)
  }
  return blocks
}

const expandHome = (p: string): string => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)

export function hostsFromConfig(text: string): SshHost[] {
  const hosts: SshHost[] = []
  for (const block of readBlocks(text)) {
    for (const alias of block.patterns) {
      if (/[*?!]/.test(alias)) continue
      const portRaw = block.fields.get('port')
      const identity = block.fields.get('identityfile') || null
      const host: SshHost = {
        id: `cfg:${alias}`,
        label: '',
        hostname: block.fields.get('hostname') || alias,
        user: block.fields.get('user') || null,
        port: portRaw && /^\d+$/.test(portRaw) ? Number(portRaw) : null,
        identityFile: identity ? expandHome(identity) : null,
        source: 'config',
        alias
      }
      host.label = hostLabel(host)
      hosts.push(host)
    }
  }
  return hosts
}

export async function readSshConfig(file = path.join(os.homedir(), '.ssh', 'config')): Promise<SshHost[]> {
  try {
    return hostsFromConfig(await fs.readFile(file, 'utf8'))
  } catch {
    return []
  }
}

/** A host typed into Eaon. Throws on what ssh would choke on. */
export function hostFromManualInput(input: ManualHostInput, id: string): SshHost {
  const hostname = input.hostname?.trim() ?? ''
  if (!hostname || /\s/.test(hostname) || hostname.startsWith('-')) throw new Error('Enter a host name or address, like build-box.local or 10.0.0.5.')
  const user = input.user?.trim() || null
  if (user && (/[\s@]/.test(user) || user.startsWith('-'))) throw new Error('A user name can’t have spaces or @ in it.')
  const port = input.port ? Number(input.port) : null
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('A port is a number from 1 to 65535.')
  const identityFile = input.identityFile?.trim() ? expandHome(input.identityFile.trim()) : null
  const host: SshHost = { id, label: '', hostname, user, port, identityFile, source: 'manual', alias: null }
  host.label = input.label?.trim() || hostLabel(host)
  return host
}
