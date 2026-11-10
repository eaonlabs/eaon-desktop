/**
 * Sandboxed command execution (macOS). With the setting on, the commands the
 * agent runs go through Apple's Seatbelt (`sandbox-exec`) with a profile built
 * here: they may read most of the disk, but write only in the work folder (and
 * the repository's own git folder when it is a worktree), the temp folders and
 * the usual tool caches; they can't read the keys and credentials folders;
 * and, unless the person allowed it, they can't use the network except to
 * this computer. The profile is plain text so it can be tested and read.
 */

export interface SandboxConfig {
  enabled: boolean
  /** Let commands reach the internet (npm install, git fetch). Off: only this computer. */
  network: boolean
}

export const DEFAULT_SANDBOX: SandboxConfig = { enabled: false, network: false }

export function normalizeSandbox(raw: unknown): SandboxConfig {
  const r = (raw ?? {}) as Partial<SandboxConfig>
  return { enabled: r.enabled === true, network: r.network === true }
}

/** Folders under the home folder that tools write caches into; writing there is how `npm install` and `cargo build` work. */
export const CACHE_DIRS = ['.npm', '.cache', '.yarn', '.pnpm-store', '.bun', '.local/share/pnpm', '.cargo/registry', '.cargo/git', '.rustup', 'go/pkg', '.gradle/caches', '.m2/repository', 'Library/Caches', 'Library/pnpm']

/** Folders under the home folder a command may not read: where keys, tokens and passwords live. */
export const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.azure', '.config/gcloud', '.config/gh', '.docker', 'Library/Keychains', 'Library/Cookies', 'Library/Safari', 'Library/Messages', 'Library/Mail']
/** Single files likewise. */
export const SECRET_FILES = ['.netrc', '.npmrc', '.pypirc', '.git-credentials', '.claude/.credentials.json']

/** A string as Seatbelt's profile language writes it. */
export const quote = (path: string): string => `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

export interface ProfileInput {
  /** The folder the command works in (its real path). */
  cwd: string
  home: string
  /** Where the temp files go. */
  tmp: string[]
  /** More places that may be written: a worktree's repository git folder. */
  writable?: string[]
  network: boolean
}

export function seatbeltProfile(input: ProfileInput): string {
  const join = (a: string, b: string): string => `${a.replace(/\/+$/, '')}/${b}`
  const writable = [input.cwd, ...input.tmp, ...(input.writable ?? []), ...CACHE_DIRS.map((d) => join(input.home, d))]
  const lines = [
    '(version 1)',
    '(deny default)',
    // Running programs: what every command needs.
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm)',
    '(allow signal (target self))',
    '(allow file-read*)',
    // Then what may not be read: the person's keys and passwords.
    ...[...SECRET_DIRS.map((d) => `(deny file-read* (subpath ${quote(join(input.home, d))}))`), ...SECRET_FILES.map((f) => `(deny file-read* (literal ${quote(join(input.home, f))}))`)],
    `(allow file-write* ${writable.map((p) => `(subpath ${quote(p)})`).join(' ')} (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/(fd|ttys)"))`,
    // This computer's own network, always: dev servers and their tests. Written as outbound to localhost, and
    // bind and inbound on localhost: a broad `(allow network* (local ip "localhost:*"))` lets every connection
    // out, as it matches before the connection has a local address. Everything else stays denied by the rule at
    // the top unless it was allowed, and a later "deny" would win over these, so there is none.
    '(allow network-outbound (remote ip "localhost:*"))',
    '(allow network-bind (local ip "localhost:*"))',
    '(allow network-inbound (local ip "localhost:*"))',
    '(allow network-outbound (remote unix-socket))',
    ...(input.network ? ['(allow network*)'] : [])
  ]
  // The secrets are denied after the broad read; tool caches written under the home folder must not re-open them.
  return lines.join('\n') + '\n'
}
