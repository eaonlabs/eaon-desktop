import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * A terminal for someone else: a friend you shared a folder with through Eaon
 * Remote. Everything they run is confined by the operating system, not by the
 * shell, so nothing they type can talk their way out:
 *
 * - macOS: a Seatbelt profile run through /usr/bin/sandbox-exec (the same
 *   kernel sandbox Chrome's renderers and Claude Code's sandbox use). Denied by
 *   default; the shared folder and a private home are the only places it may
 *   write, and besides them it may read only the system files programs need to
 *   run. Your home folder, other drives, the Keychain and every other app's
 *   data are unreadable. The profile is inherited by every child and can't be
 *   lifted from inside.
 * - Linux: bubblewrap. A fresh mount namespace holding the system's read-only
 *   /usr (and friends), the shared folder and the private home, and nothing
 *   else; a fresh PID, IPC and (unless allowed) network namespace; every
 *   capability dropped and no_new_privs set, so setuid programs like sudo
 *   can't raise anything.
 * - Anywhere else: refused. A half-confined terminal is worse than none,
 *   because it looks safe.
 *
 * Two modes:
 * - `shell`: a shell that starts in the folder. `cd` works inside it and is
 *   refused above it (a nicety; the sandbox is what actually stops them). No
 *   network unless you allow it.
 * - `cli`: one CLI and nothing else. The CLI *is* the terminal's process, not
 *   something typed into a shell, so quitting it ends the session rather than
 *   leaving a prompt behind. Only that CLI's own files may be executed, so it
 *   can't start a shell or any other program either. CLIs need the network,
 *   so it is allowed.
 *
 * Nothing of yours goes in: the environment is built from scratch (no tokens,
 * no keys, no CLI logins), HOME is a private folder for this share, and a CLI
 * that wants an account asks your friend to sign in with theirs.
 */

export type GuestMode = 'shell' | 'cli'

export interface GuestSpec {
  /** Stable id for this share; names the private home. */
  id: string
  /** The folder being shared. */
  root: string
  mode: GuestMode
  /** In `cli` mode, the program to run: an absolute path (resolved from PATH by the caller). */
  program?: string
  /** Arguments for the CLI. Never a permission-skipping flag: the caller decides. */
  programArgs?: string[]
  /** Shell mode only: whether the shell may reach the internet. CLI mode always may. */
  network: boolean
  /** Shown in the friend's prompt and welcome line. */
  label: string
}

export interface GuestLaunch {
  bin: string
  argv: string[]
  cwd: string
  env: Record<string, string>
  home: string
}

export type Support = { ok: true } | { ok: false; reason: string }

const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

/** Whether locked guest terminals can run here, and why not when they can't. */
export function guestSandboxSupport(platform: NodeJS.Platform = process.platform, find: (bin: string) => string | null = findOnPath): Support {
  if (platform === 'darwin') {
    return fs.existsSync(SANDBOX_EXEC) ? { ok: true } : { ok: false, reason: 'macOS’s sandbox (sandbox-exec) isn’t on this Mac.' }
  }
  if (platform === 'linux') {
    return find('bwrap') ? { ok: true } : { ok: false, reason: 'Install bubblewrap (the “bwrap” command) to share locked terminals on Linux.' }
  }
  return { ok: false, reason: 'Locked terminals for friends are available on macOS and Linux. Windows has no sandbox Eaon can rely on yet.' }
}

function findOnPath(bin: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, bin)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      /* not here */
    }
  }
  return null
}

const within = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)

/**
 * The folder, resolved through any symlinks, or an error saying why it can't
 * be shared. A share must be a real folder of yours that isn't the home folder
 * itself, a parent of it, a system location, or somewhere secrets live.
 */
export function checkGuestRoot(dir: string, opts: { home?: string; userData?: string; uid?: number } = {}): { ok: true; root: string } | { ok: false; reason: string } {
  const home = fs.realpathSync(opts.home ?? os.homedir())
  let root: string
  try {
    root = fs.realpathSync(dir)
  } catch {
    return { ok: false, reason: 'That folder isn’t there.' }
  }
  let stat: fs.Stats
  try {
    stat = fs.statSync(root)
  } catch {
    return { ok: false, reason: 'That folder can’t be read.' }
  }
  if (!stat.isDirectory()) return { ok: false, reason: 'Pick a folder, not a file.' }
  if (root === path.parse(root).root) return { ok: false, reason: 'You can’t share the whole disk.' }
  if (within(home, root)) return { ok: false, reason: 'Pick a folder inside your home folder, not the home folder itself.' }

  const system = ['/System', '/usr', '/bin', '/sbin', '/etc', '/private', '/Library', '/Applications', '/var', '/opt', '/proc', '/sys', '/dev', '/boot', '/root', '/Volumes']
  if (system.some((s) => root === s || (within(root, s) && !within(root, home)))) return { ok: false, reason: 'That’s a system folder.' }

  const secret = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config', '.local', 'Library', '.npmrc', '.netrc', '.claude', '.codex', '.gemini', '.eaon']
  for (const name of secret) {
    const p = path.join(home, name)
    if (within(root, p)) return { ok: false, reason: `Folders inside ~/${name} can’t be shared: credentials and app data live there.` }
  }
  const uid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1)
  if (uid >= 0 && stat.uid !== uid) return { ok: false, reason: 'You can only share a folder you own.' }
  if (opts.userData && within(root, fs.existsSync(opts.userData) ? fs.realpathSync(opts.userData) : opts.userData)) {
    return { ok: false, reason: 'Eaon’s own data can’t be shared.' }
  }
  return { ok: true, root }
}

/* ------------------------------------------------------------------ macOS */

/** Seatbelt string literal. Paths come from realpath, but quote them properly anyway. */
const sb = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** Programs a guest may never run, even in a shell where /usr/bin is otherwise open. */
const MAC_REFUSED = [
  '/usr/bin/sudo', '/usr/bin/su', '/usr/bin/login', '/usr/bin/open', '/usr/bin/osascript', '/usr/bin/osacompile',
  '/bin/launchctl', '/usr/bin/security', '/usr/sbin/sysadminctl', '/usr/bin/dscl', '/usr/bin/dsenableroot',
  '/usr/sbin/chown', '/usr/bin/sandbox-exec', '/usr/bin/pkill', '/usr/bin/killall', '/usr/bin/screencapture',
  '/usr/bin/pbcopy', '/usr/bin/pbpaste', '/usr/sbin/networksetup', '/usr/bin/defaults', '/usr/bin/tccutil',
  '/usr/sbin/spctl', '/usr/bin/shortcuts', '/usr/bin/automator', '/usr/sbin/systemsetup', '/usr/bin/mdfind',
  '/usr/sbin/scutil', '/usr/bin/csrutil', '/usr/sbin/installer', '/usr/bin/hdiutil', '/usr/sbin/diskutil'
]

/** System locations programs read to start and run. Nothing personal lives under these. */
const MAC_SYSTEM_READ = [
  '/usr', '/bin', '/sbin', '/System', '/Library/Apple', '/Library/Developer/CommandLineTools',
  '/private/var/db/dyld', '/private/var/db/timezone', '/private/etc', '/System/Volumes/Preboot/Cryptexes', '/private/preboot',
  '/opt/homebrew', '/usr/local'
]

/** Folders a shell may run programs from. */
const MAC_SHELL_EXEC = ['/bin', '/usr/bin', '/usr/sbin', '/sbin', '/usr/libexec', '/Library/Developer/CommandLineTools/usr/bin', '/opt/homebrew/bin', '/opt/homebrew/Cellar', '/usr/local/bin', '/usr/local/Cellar']

export interface MacProfileOptions {
  network: boolean
  /** `shell`: the usual system program folders. Otherwise exactly these paths (and their subtrees). */
  exec: 'shell' | string[]
  /** Extra read-only paths (a CLI's install folder, its runtime). */
  readExtra?: string[]
  /**
   * Folders above the share, the home and those paths. Programs that resolve
   * their own path (Node does, at startup) stat every folder on the way down.
   * Stat only: what a folder holds stays unreadable.
   */
  ancestors?: string[]
}

/** Every folder above each path, up to but not including the root: stat-only rules for seatbeltProfile. */
export function ancestorsOf(paths: readonly string[]): string[] {
  const out = new Set<string>()
  for (const p of paths) {
    let dir = path.dirname(p)
    while (dir !== path.dirname(dir)) {
      out.add(dir)
      dir = path.dirname(dir)
    }
  }
  return [...out].sort()
}

/**
 * The Seatbelt profile. ROOT (the share) and HOME (the private home) are
 * passed as parameters, so the profile itself has no user paths in it.
 * SBPL takes the last matching rule, which is how the refusals below win over
 * the folders that would otherwise allow them.
 */
export function seatbeltProfile(opts: MacProfileOptions): string {
  const read = [...MAC_SYSTEM_READ, ...(opts.readExtra ?? [])]
  const exec = opts.exec === 'shell' ? MAC_SHELL_EXEC : opts.exec
  const lines = [
    '(version 1)',
    '(deny default)',
    '',
    '; processes: start children, signal only what is inside this sandbox',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    `(allow process-exec ${exec.map((p) => `(subpath ${sb(p)})`).join(' ')})`,
    `(deny process-exec ${MAC_REFUSED.map((p) => `(literal ${sb(p)})`).join(' ')})`,
    '',
    '; reading: the system files programs need, the share, the private home.',
    '; dyld opens "/" itself; listing it shows top-level names and nothing below.',
    `(allow file-read* (literal "/") ${read.map((p) => `(subpath ${sb(p)})`).join(' ')} (subpath (param "ROOT")) (subpath (param "HOME")))`,
    `(allow file-read-metadata (literal "/private") (literal "/private/var") (literal "/Library") (literal "/dev") (literal "/etc") (literal "/var") (literal "/tmp")${(opts.ancestors ?? []).map((p) => ` (literal ${sb(p)})`).join('')})`,
    '(allow file-read* file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/tty") (literal "/dev/dtracehelper"))',
    '; job control and ttyname on its own terminal. Opening any other terminal',
    '; device is denied above, so these reach nobody else’s.',
    '(allow file-ioctl (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))',
    '(allow file-read-metadata (regex #"^/dev/ttys[0-9]+$"))',
    '',
    '; writing: only the share and the private home',
    '(allow file-write* (subpath (param "ROOT")) (subpath (param "HOME")))',
    '',
    '; the few system services a shell needs. Nothing that launches apps,',
    '; reads the Keychain, or reaches the window server.',
    '(allow sysctl-read)',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.notification_center") (global-name "com.apple.logd"))',
    '(allow ipc-posix-shm-read-data (ipc-posix-name "apple.shm.notification_center"))'
  ]
  if (opts.network) {
    lines.push(
      '',
      '; network: outgoing connections and name lookups only; nothing listens',
      '(allow network-outbound)',
      '(allow system-socket)',
      '(allow mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.trustd"))'
    )
  }
  return lines.join('\n') + '\n'
}

/* ------------------------------------------------------------------ Linux */

export interface BwrapOptions {
  root: string
  home: string
  network: boolean
  /** Extra read-only paths (a CLI's install folder, its runtime). */
  readExtra?: string[]
}

/** bubblewrap's arguments, up to and including the `--` before the program. */
export function bwrapArgs(opts: BwrapOptions): string[] {
  const args = ['--die-with-parent', '--unshare-all']
  if (opts.network) args.push('--share-net')
  args.push(
    '--clearenv',
    '--cap-drop', 'ALL',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind-try', '/bin', '/bin',
    '--ro-bind-try', '/sbin', '/sbin',
    '--ro-bind-try', '/lib', '/lib',
    '--ro-bind-try', '/lib32', '/lib32',
    '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache',
    '--ro-bind-try', '/etc/alternatives', '/etc/alternatives',
    '--ro-bind-try', '/etc/ssl', '/etc/ssl',
    '--ro-bind-try', '/etc/ca-certificates', '/etc/ca-certificates',
    '--ro-bind-try', '/etc/pki', '/etc/pki',
    '--ro-bind-try', '/etc/localtime', '/etc/localtime'
  )
  if (opts.network) args.push('--ro-bind-try', '/etc/resolv.conf', '/etc/resolv.conf', '--ro-bind-try', '/etc/hosts', '/etc/hosts', '--ro-bind-try', '/etc/nsswitch.conf', '/etc/nsswitch.conf')
  for (const p of opts.readExtra ?? []) args.push('--ro-bind', p, p)
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', opts.root, opts.root, '--bind', opts.home, opts.home, '--chdir', opts.root, '--')
  return args
}

/* ------------------------------------------------------------ the friend's shell */

/** Single-quoted for POSIX shells. */
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * What the friend's shell reads first: the welcome line, a prompt that shows
 * where they are inside the share, and a `cd` that refuses to leave it. The
 * sandbox is the actual boundary; this just makes it read as a boundary
 * instead of a wall of "Operation not permitted".
 */
export function guestRc(root: string, label: string, shell: 'zsh' | 'bash'): string {
  const common = [
    `export SHARE_ROOT=${q(root)}`,
    `export SHARE_LABEL=${q(label)}`,
    'unset HISTFILE',
    '__share_inside() { case "$1/" in "$SHARE_ROOT"/*) return 0 ;; esac; return 1; }',
    'cd() {',
    '  if [ $# -eq 0 ]; then set -- "$SHARE_ROOT"; fi',
    '  local __before="$PWD"',
    '  builtin cd "$@" || return',
    '  if ! __share_inside "$(pwd -P)"; then',
    '    builtin cd "$__before"',
    '    echo "cd: that’s outside the shared folder. You can move around inside it only." >&2',
    '    return 1',
    '  fi',
    '}',
    'pushd() { cd "$@"; }',
    'popd() { echo "popd isn’t available here. Use cd." >&2; return 1; }',
    'cd "$SHARE_ROOT"',
    'echo "You’re in $SHARE_LABEL, shared with you through Eaon. You can work in this folder and its subfolders only."'
  ]
  if (shell === 'zsh') {
    return [...common, "setopt prompt_subst", "PROMPT='%F{cyan}${SHARE_LABEL}%f${${PWD#$SHARE_ROOT}:-} %# '"].join('\n') + '\n'
  }
  return [...common, '__share_prompt() { local rel="${PWD#$SHARE_ROOT}"; PS1="\\[\\e[36m\\]${SHARE_LABEL}\\[\\e[0m\\]${rel} \\$ "; }', 'PROMPT_COMMAND=__share_prompt'].join('\n') + '\n'
}

/* ------------------------------------------------------------------ launch */

/** The folders a CLI needs to read and run: its own install, and the runtime its first line names. */
export function cliPaths(program: string): { exec: string[]; read: string[] } {
  const real = fs.realpathSync(program)
  const dirs = new Set<string>()
  // An npm-installed CLI lives inside its package; the whole package (its
  // bundled helpers, ripgrep and so on) is part of it.
  const nm = real.lastIndexOf(`${path.sep}node_modules${path.sep}`)
  if (nm >= 0) {
    const rest = real.slice(nm + 14).split(path.sep)
    const pkg = rest[0].startsWith('@') ? rest.slice(0, 2) : rest.slice(0, 1)
    dirs.add(path.join(real.slice(0, nm + 13), ...pkg))
  } else {
    dirs.add(path.dirname(real))
  }
  const exec = new Set<string>([real, ...dirs])
  // A script starts with `#!/usr/bin/env node` or similar: allow env and the
  // runtime it finds, and that runtime's own install.
  let head = ''
  try {
    const fd = fs.openSync(real, 'r')
    const buf = Buffer.alloc(256)
    fs.readSync(fd, buf, 0, 256, 0)
    fs.closeSync(fd)
    head = buf.toString('utf8')
  } catch {
    /* unreadable: treated as a binary */
  }
  const shebang = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(head)
  if (shebang) {
    exec.add(shebang[1])
    const runtimeName = path.basename(shebang[1]) === 'env' ? shebang[2] : null
    const runtime = runtimeName ? findOnPath(runtimeName) : shebang[1]
    if (runtime) {
      const rt = fs.realpathSync(runtime)
      exec.add(rt)
      const prefix = path.dirname(path.dirname(rt))
      dirs.add(prefix === path.parse(prefix).root ? path.dirname(rt) : prefix)
    }
  }
  return { exec: [...exec, ...dirs], read: [...dirs] }
}

function scrubbedEnv(home: string, extra: Record<string, string>): Record<string, string> {
  return {
    HOME: home,
    TMPDIR: path.join(home, 'tmp'),
    PATH: ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: process.env.LANG || 'en_US.UTF-8',
    USER: 'guest',
    LOGNAME: 'guest',
    EAON_GUEST: '1',
    ...extra
  }
}

/**
 * How to start the friend's terminal: the program, its arguments, the folder
 * and the environment, ready for node-pty. Throws (with a sentence a person
 * can read) when it can't be done safely.
 */
export function buildGuestLaunch(spec: GuestSpec, deps: { homesDir: string; platform?: NodeJS.Platform; userData?: string }): GuestLaunch {
  const platform = deps.platform ?? process.platform
  const support = guestSandboxSupport(platform)
  if (!support.ok) throw new Error(support.reason)
  const checked = checkGuestRoot(spec.root, { userData: deps.userData })
  if (!checked.ok) throw new Error(checked.reason)
  const root = checked.root
  if (!/^[\w-]{1,80}$/.test(spec.id)) throw new Error('Bad share id.')

  fs.mkdirSync(deps.homesDir, { recursive: true, mode: 0o700 })
  const home = path.join(fs.realpathSync(deps.homesDir), spec.id)
  fs.mkdirSync(path.join(home, 'tmp'), { recursive: true, mode: 0o700 })
  fs.chmodSync(home, 0o700)

  let program: string
  let programArgs: string[]
  let env: Record<string, string>
  let exec: 'shell' | string[] = 'shell'
  let readExtra: string[] = []
  let network = spec.network

  if (spec.mode === 'shell') {
    const shell = platform === 'darwin' ? '/bin/zsh' : fs.existsSync('/bin/bash') ? '/bin/bash' : '/usr/bin/bash'
    const kind = path.basename(shell) === 'zsh' ? 'zsh' : 'bash'
    if (kind === 'zsh') {
      fs.writeFileSync(path.join(home, '.zshrc'), guestRc(root, spec.label, 'zsh'), { mode: 0o600 })
      // -d: none of the system-wide startup files; ZDOTDIR points at ours.
      program = shell
      programArgs = ['-d', '-i']
      env = scrubbedEnv(home, { ZDOTDIR: home, SHELL: shell })
    } else {
      const rc = path.join(home, '.bashrc')
      fs.writeFileSync(rc, guestRc(root, spec.label, 'bash'), { mode: 0o600 })
      program = shell
      programArgs = ['--noprofile', '--rcfile', rc, '-i']
      env = scrubbedEnv(home, { SHELL: shell })
    }
  } else {
    if (!spec.program || !path.isAbsolute(spec.program) || !fs.existsSync(spec.program)) throw new Error('That CLI isn’t installed on this computer.')
    program = fs.realpathSync(spec.program)
    programArgs = spec.programArgs ?? []
    const paths = cliPaths(program)
    exec = paths.exec
    readExtra = paths.read
    network = true
    env = scrubbedEnv(home, {})
  }

  if (platform === 'darwin') {
    const ancestors = ancestorsOf([root, home, program, ...readExtra])
    const profile = seatbeltProfile({ network, exec, readExtra, ancestors })
    return { bin: SANDBOX_EXEC, argv: ['-p', profile, '-D', `ROOT=${root}`, '-D', `HOME=${home}`, program, ...programArgs], cwd: root, env, home }
  }

  const bwrap = findOnPath('bwrap')!
  const args = bwrapArgs({ root, home, network, readExtra: readExtra.filter((p) => !p.startsWith('/usr/')) })
  // --clearenv wipes the environment; set ours inside.
  const sets = Object.entries(env).flatMap(([k, v]) => ['--setenv', k, v])
  const sep = args.lastIndexOf('--')
  return { bin: bwrap, argv: [...args.slice(0, sep), ...sets, '--', program, ...programArgs], cwd: root, env: {}, home }
}
