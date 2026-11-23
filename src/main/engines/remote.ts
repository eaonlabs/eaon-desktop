import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { remoteLocation, type SshHost } from '@shared/adeRemote'
import { shQuote, sshBinary } from '../features/ade/ssh'
import { openRemote, sshCallArgv, sshRun } from '../remoteWork'

/**
 * An agent CLI run on the machine a session's folder is on, for a session in
 * a cloud environment or a project on another machine (shared/environments.ts,
 * shared/adeRemote.ts). Its protocol (Codex's app-server, Claude Code's
 * stream-json) is stdin and stdout, which ssh carries as they are, so the
 * engine drives it exactly as it would here; only the process is started
 * there, by `ssh`, in the folder, through a login shell so it finds the CLI on
 * the PATH a terminal there would have.
 *
 * It runs on that machine's own sign-in: Codex's or Claude Code's login there,
 * never this computer's. Signing in there is the user's to do, in its
 * terminal (`signInCommand`).
 */

export interface RemotePlace {
  host: SshHost
  /** The folder on the host. */
  root: string
  /** The host as people know it, for messages. */
  where: string
}

/** The place an `ssh://` folder is, or null for a folder on this computer. */
export async function remotePlace(cwd: string): Promise<RemotePlace | null> {
  if (!remoteLocation(cwd)) return null
  const project = await openRemote(cwd)
  return { host: project.host, root: project.root, where: project.host.label }
}

/** Names an environment variable can have, and only those. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * The command line sshd runs for `program args…` in `root`, with `env` set:
 * every word quoted, through the remote user's login shell (`$SHELL -l`) so
 * the PATH is a terminal's there, where npm's and ~/.local/bin's CLIs are.
 */
export function remoteLine(root: string, program: string, args: string[], env: Record<string, string | undefined> = {}): string {
  const vars = Object.entries(env)
    .filter((entry): entry is [string, string] => NAME.test(entry[0]) && typeof entry[1] === 'string')
    .map(([name, value]) => `${name}=${shQuote(value)}`)
  const line = `cd ${shQuote(root)} && exec ${vars.length ? `env ${vars.join(' ')} ` : ''}${[program, ...args].map(shQuote).join(' ')}`
  return `exec "$SHELL" -lc ${shQuote(line)}`
}

/** `ssh`'s command and arguments to run `program args…` in `root` on the host, with `env` set there. */
export function remoteSpawn(place: Pick<RemotePlace, 'host' | 'root'>, program: string, args: string[], env: Record<string, string | undefined> = {}): { command: string; args: string[] } {
  return { command: sshBinary(), args: [...sshCallArgv(place.host), remoteLine(place.root, program, args, env)] }
}

/** What to run in a terminal on that machine to sign an agent in there. */
export function signInCommand(agent: 'codex' | 'claude'): string {
  return agent === 'codex' ? 'codex login --device-auth' : 'claude auth login'
}

/**
 * Pictures attached to a message, copied to the machine (in its /tmp) so an
 * agent there can open them by path; the ones that won't copy are left out.
 */
export async function sendImages(place: Pick<RemotePlace, 'host'>, images: string[]): Promise<string[]> {
  const sent: string[] = []
  for (const image of images) {
    const bytes = await readFile(image).catch(() => null)
    if (!bytes) continue
    const target = `/tmp/eaon-${randomUUID().slice(0, 8)}-${basename(image).replace(/[^A-Za-z0-9._-]/g, '_')}`
    const result = await sshRun(place.host, `cat > ${shQuote(target)}`, { stdin: bytes, timeoutMs: 120_000 })
    if (result.code === 0) sent.push(target)
  }
  return sent
}
