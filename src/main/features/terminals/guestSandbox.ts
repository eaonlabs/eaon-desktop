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
 *   lifted from inside. What actually holds is the file, IPC and network
 *   rules: with them, launchd takes no jobs, the Keychain, the pasteboard and
 *   other apps can't be reached, and sudo won't run, even for a program the
 *   friend brought along. So programs may run from the share and the home
 *   (their project's scripts, an npm install), not just from the system.
 * - Linux: bubblewrap. A fresh mount namespace holding the system's read-only
 *   /usr (and friends), the shared folder and the private home, and nothing
 *   else; a fresh PID, IPC and (unless allowed) network namespace; every
 *   capability dropped and no_new_privs set, so setuid programs like sudo
 *   can't raise anything.
 * - Anywhere else: refused. A half-confined terminal is worse than none,
 *   because it looks safe.
 *
 * With the internet on, this computer's own loopback services stay out of
 * reach: Eaon's Local API Server answers keyless requests from programs here
 * (it would spend your models), and dev servers and databases listen there
 * too. On macOS the profile refuses loopback and local sockets (DNS's aside);
 * on Linux the network comes through pasta, a namespace of its own with no
 * way back to the host's loopback.
 *
 * Two modes:
 * - `shell`: a shell that starts in the folder. `cd` works inside it and is
 *   refused above it (a nicety; the sandbox is what actually stops them). No
 *   network unless you allow it.
 * - `cli`: one CLI. The CLI *is* the terminal's process, not something typed
 *   into a shell, so quitting it ends the session rather than leaving a
 *   prompt behind. It may run the same programs a shell here could (a coding
 *   CLI runs tests and git), inside the same walls. CLIs need the network, so
 *   it is allowed.
 *
 * Nothing of yours goes in: the environment is built from scratch (no tokens,
 * no keys, no CLI logins), and HOME is a private folder for this friend, the
 * same one in each of their terminals, so what they sign in to stays signed in
 * from one session to the next. A CLI that wants an account asks your friend
 * to sign in with theirs. On macOS, CLIs that keep a sign-in in the Keychain
 * (Claude Code does, through the `security` command) get a stand-in that keeps
 * it in that home instead: your Keychain stays yours.
 */

export type GuestMode = 'shell' | 'cli'

export interface GuestSpec {
  /** Stable id for this terminal; names its shell's startup files. */
  id: string
  /** Names the private home: one per friend, so their sign-ins carry over between their terminals. Defaults to `id`. */
  homeId?: string
  /** The folder being shared. */
  root: string
  mode: GuestMode
  /** In `cli` mode, the program to run: an absolute path (resolved from PATH by the caller). */
  program?: string
  /** Arguments for the CLI. Never a permission-skipping flag: the caller decides. */
  programArgs?: string[]
  /** CLIs installed here to put on the PATH by name, so `claude` works in a shell: command name → absolute path. */
  tools?: Record<string, string>
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

/**
 * Programs a guest may never run, even where /usr/bin is otherwise open. The
 * profile's IPC and file rules already stop each of these; refusing them too
 * keeps a mistake in those rules from being the only thing in the way.
 */
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
  '/private/var/db/dyld', '/private/var/db/timezone', '/private/var/select', '/private/etc', '/System/Volumes/Preboot/Cryptexes', '/private/preboot',
  '/opt/homebrew', '/usr/local', '/Applications/Xcode.app/Contents/Developer'
]

/**
 * Folders programs may run from, besides the share and the private home: the
 * system's, the developer tools', and what Homebrew and npm installed (a
 * global npm CLI is a script inside lib/node_modules, not in bin).
 */
const MAC_EXEC = [
  '/bin', '/usr/bin', '/usr/sbin', '/sbin', '/usr/libexec', '/Library/Developer/CommandLineTools/usr', '/Applications/Xcode.app/Contents/Developer',
  '/opt/homebrew', '/usr/local'
]

export interface MacProfileOptions {
  network: boolean
  /** Besides the system's program folders, the share and the home: more paths programs may run from (a CLI's install, its runtime). */
  exec?: string[]
  /** Extra read-only paths (a CLI's install folder, its runtime). */
  readExtra?: string[]
  /**
   * Folders above the share, the home and those paths. Programs that resolve
   * their own path (Node does, at startup) stat every folder on the way down.
   * Stat only: what a folder holds stays unreadable.
   */
  ancestors?: string[]
  /** Let programs listen on a port. One-CLI mode only: in a shell, anything could. */
  listen?: boolean
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
  const exec = [...MAC_EXEC, ...(opts.exec ?? [])]
  const lines = [
    '(version 1)',
    '(deny default)',
    '',
    '; processes: start children, signal only what is inside this sandbox',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    `(allow process-exec ${exec.map((p) => `(subpath ${sb(p)})`).join(' ')} (subpath (param "ROOT")) (subpath (param "HOME")))`,
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
      '; network: outgoing connections and name lookups',
      '(allow network-outbound)',
      '(allow system-socket)',
      '(allow mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.trustd"))',
      '; but not this computer’s own services: Eaon’s Local API Server answers',
      '; keyless requests from programs here, and dev servers and databases',
      '; listen on loopback too. Nor local sockets (Docker’s, an SSH agent’s),',
      '; except the one name lookups go through.',
      '(deny network-outbound (remote ip "localhost:*"))',
      '(deny network-outbound (remote unix-socket))',
      '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))'
    )
  }
  if (opts.network && opts.listen) {
    lines.push(
      '; listening, for a CLI\'s sign-in (it waits for its OAuth callback on a',
      '; port). Seatbelt checks only the port, never the address, so this is',
      '; given only where the one program that can run is that CLI',
      '(allow network-bind network-inbound (local ip "*:*"))'
    )
  }
  return lines.join('\n') + '\n'
}

/* ------------------------------------------------------------------ Linux */

export interface BwrapOptions {
  root: string
  home: string
  network: boolean
  /** A resolv.conf to use instead of the host's (see pastaResolv). */
  resolv?: string
  /** Inside pasta's user namespace the user is root: who to be instead (the user's own ids). */
  user?: { uid: number; gid: number }
  /** Extra read-only paths (a CLI's install folder, its runtime). */
  readExtra?: string[]
}

/** Where name lookups go inside pasta's namespace when the host's only resolver is on its own loopback. */
const PASTA_DNS = '169.254.1.53'

export interface PastaOptions {
  /** A resolver on the host's loopback to hand lookups to; null when the friend's resolv.conf names a reachable one. */
  dns: string | null
  /** Whether the host has an IPv6 route out. Without one pasta warns into the friend's terminal. */
  ipv6: boolean
}

/**
 * pasta's arguments: a network namespace of the friend's own, with the
 * internet through pasta and no way back to this computer. Nothing is
 * forwarded in either direction (-t -u -T -U none), and the gateway isn't
 * mapped to the host's loopback (--no-map-gw), so the Local API Server and
 * whatever else listens there can't be reached. Abstract sockets (X11's,
 * D-Bus's) belong to a network namespace too, so those stay out as well.
 */
export function pastaArgs(opts: PastaOptions = { dns: null, ipv6: true }): string[] {
  return [
    '--config-net', '--quiet', '--no-map-gw', '-t', 'none', '-u', 'none', '-T', 'none', '-U', 'none',
    ...(opts.ipv6 ? [] : ['-4']),
    // Only port 53 of that one resolver, never the rest of the loopback.
    ...(opts.dns ? ['--dns-forward', PASTA_DNS, '-D', opts.dns] : ['-D', 'none'])
  ]
}

const nameservers = (file: string): string[] => {
  try {
    return [...fs.readFileSync(file, 'utf8').matchAll(/^\s*nameserver\s+(\S+)/gm)].map((m) => m[1])
  } catch {
    return []
  }
}
const loopbackAddress = (ip: string): boolean => ip.startsWith('127.') || ip === '::1'

/**
 * The resolv.conf for inside pasta's namespace, where the host's loopback
 * isn't reachable: the host's own if it names a resolver elsewhere, else
 * systemd-resolved's list of the servers behind its 127.0.0.53, else one
 * pointing at pasta, which hands lookups to the loopback resolver.
 */
export function pastaResolv(home: string, files = { etc: '/etc/resolv.conf', resolved: '/run/systemd/resolve/resolv.conf' }): { file: string; dns: string | null } {
  const host = nameservers(files.etc)
  if (host.some((ip) => !loopbackAddress(ip))) return { file: files.etc, dns: null }
  if (nameservers(files.resolved).some((ip) => !loopbackAddress(ip))) return { file: files.resolved, dns: null }
  const file = path.join(home, '.eaon', 'resolv.conf')
  fs.writeFileSync(file, `nameserver ${PASTA_DNS}\n`, { mode: 0o644 })
  return { file, dns: host[0] ?? '127.0.0.53' }
}

/** Whether the host has a default IPv6 route on a real interface. */
function hasIpv6Route(): boolean {
  try {
    return fs
      .readFileSync('/proc/net/ipv6_route', 'utf8')
      .split('\n')
      .some((line) => {
        const f = line.trim().split(/\s+/)
        return f.length >= 10 && /^0{32}$/.test(f[0]) && f[1] === '00' && f[9] !== 'lo'
      })
  } catch {
    return false
  }
}

/** bubblewrap's arguments, up to and including the `--` before the program. */
export function bwrapArgs(opts: BwrapOptions): string[] {
  const args = ['--die-with-parent', '--unshare-all']
  if (opts.network) args.push('--share-net')
  if (opts.user) args.push('--uid', String(opts.user.uid), '--gid', String(opts.user.gid))
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
  if (opts.network) args.push('--ro-bind-try', opts.resolv ?? '/etc/resolv.conf', '/etc/resolv.conf', '--ro-bind-try', '/etc/hosts', '/etc/hosts', '--ro-bind-try', '/etc/nsswitch.conf', '/etc/nsswitch.conf')
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
    'echo "You’re in $SHARE_LABEL, shared with you through Eaon. You can work in this folder and its subfolders only."',
    'echo "What you sign in to here (Claude Code, Codex, gh…) stays signed in for your next session."'
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

/**
 * The `security` command inside a friend's terminal on a Mac. The real one
 * opens the Keychain of whoever owns this Mac, which the sandbox keeps out of
 * reach, and a CLI that keeps its sign-in there then can't sign in at all
 * (Claude Code says to unlock the keychain). This one keeps generic and
 * internet passwords in the friend's private home instead: it does what CLIs
 * ask of `security` (find, add, delete, and `-i` reading those from stdin),
 * and nothing else.
 */
export function securityStandIn(): string {
  return `#!/bin/zsh -f
# Eaon: \`security\` in a terminal shared with you. The Keychain on this Mac
# isn't yours, so the passwords CLIs keep here are kept in your private home.
emulate -L zsh
umask 077
store=$HOME/.eaon/keychain
h() { print -rn -- "$1" | /sbin/md5 -q }

# The file an item lives in: one folder per kind and service, one file per account.
item() {
  local kind=$1 svc=$2 acct=$3
  if [[ -n $svc && -n $acct ]]; then print -r -- $store/$(h $kind:$svc)/$(h $acct); return; fi
  local found
  if [[ -n $svc ]]; then found=( $store/$(h $kind:$svc)/*(N.) )
  elif [[ -n $acct ]]; then found=( $store/*/$(h $acct)(N.) )
  else found=( $store/*/*(N.) ); fi
  print -r -- \${found[1]:-$store/none}
}

run() {
  local cmd=$1; shift
  local kind=\${\${cmd#*-}%-password} acct= svc= pw= hex= show=0 show_g=0 update=0 asked=0
  while (( $# )); do
    case $1 in
      -a) acct=$2; shift ;;
      -s) svc=$2; shift ;;
      -X) hex=$2; shift ;;
      -w) if [[ $cmd == add-* ]]; then
            if (( $# > 1 )) && [[ $2 != -* ]]; then pw=$2; shift; else asked=1; fi
          else show=1; fi ;;
      -g) show_g=1 ;;
      -U) update=1 ;;
      -[lDjcCGTpPrtdSk]) shift ;;
    esac
    shift
  done
  local f
  case $cmd in
    find-generic-password|find-internet-password)
      f=$(item $kind "$svc" "$acct")
      if [[ ! -f $f ]]; then print -u2 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.'; return 44; fi
      if (( show )); then /bin/cat -- $f; print; return 0; fi
      print -r -- "keychain: \\"$store\\""
      print -r -- "class: \\"\${\${kind/generic/genp}/internet/inet}\\""
      print -r -- 'attributes:'
      [[ -n $acct ]] && print -r -- "    \\"acct\\"<blob>=\\"$acct\\""
      [[ -n $svc ]] && print -r -- "    \\"svce\\"<blob>=\\"$svc\\""
      (( show_g )) && print -ru2 -- "password: \\"$(/bin/cat -- $f)\\""
      return 0 ;;
    add-generic-password|add-internet-password)
      f=$store/$(h $kind:$svc)/$(h $acct)
      if [[ -f $f ]] && (( ! update )); then print -u2 'security: SecKeychainItemCreateFromContent (<default>): The specified item already exists in the keychain.'; return 45; fi
      if (( asked )); then print -nu2 'password data for new item: '; read -rs pw; print -u2; fi
      /bin/mkdir -p -- \${f:h} || return 1
      if [[ -n $hex ]]; then print -rn -- $hex | /usr/bin/xxd -r -p > $f.new || return 1
      else print -rn -- $pw > $f.new || return 1; fi
      /bin/mv -f -- $f.new $f ;;
    delete-generic-password|delete-internet-password)
      f=$(item $kind "$svc" "$acct")
      if [[ ! -f $f ]]; then print -u2 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.'; return 44; fi
      /bin/rm -f -- $f
      print -r -- 'password has been deleted.' ;;
    show-keychain-info) print -ru2 -- "Keychain \\"$store\\" no-timeout" ;;
    list-keychains|default-keychain|login-keychain) print -r -- "    \\"$store\\"" ;;
    unlock-keychain|lock-keychain|set-keychain-settings) ;;
    *) print -ru2 -- "security: $cmd isn’t available in a terminal shared through Eaon."; return 1 ;;
  esac
}

typeset interactive=0
while [[ $1 == -* ]]; do
  case $1 in
    -i) interactive=1 ;;
    -p) interactive=1; shift ;;
  esac
  shift
done
if (( interactive && ! $# )); then
  typeset line rc=0 words
  while IFS= read -r line || [[ -n $line ]]; do
    words=( "\${(@Q)\${(z)line}}" )
    (( $#words )) || continue
    [[ $words[1] == (quit|exit) ]] && break
    run "\${words[@]}"; rc=$?
  done
  exit $rc
fi
(( $# )) || { print -u2 'usage: security command [options]'; exit 2 }
run "$@"
`
}

/**
 * The friend's own program folder, first on their PATH: the CLIs installed
 * here by name (so `claude` works in a shell, wherever it's installed), and
 * on a Mac the `security` stand-in.
 */
function guestBin(home: string, tools: Record<string, string>, platform: NodeJS.Platform): string {
  const bin = path.join(home, '.eaon', 'bin')
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 })
  const links = Object.fromEntries(Object.entries(tools).filter(([name]) => /^[\w.-]{1,40}$/.test(name) && name !== 'security'))
  const standIn = platform === 'darwin' ? securityStandIn() : null
  // Only what changed: the friend's other terminals may be using these right now.
  for (const name of fs.readdirSync(bin)) {
    const p = path.join(bin, name)
    let keep = false
    try {
      keep = name === 'security' ? standIn !== null && fs.readFileSync(p, 'utf8') === standIn : links[name] === fs.readlinkSync(p)
    } catch {
      /* a folder, or not what we put there */
    }
    if (keep) delete links[name]
    else fs.rmSync(p, { recursive: true, force: true })
  }
  for (const [name, target] of Object.entries(links)) fs.symlinkSync(target, path.join(bin, name))
  if (standIn !== null && !fs.existsSync(path.join(bin, 'security'))) fs.writeFileSync(path.join(bin, 'security'), standIn, { mode: 0o700 })
  return bin
}

/** The installed CLIs that are really there, resolved: name → real path. */
function realTools(tools: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, target] of Object.entries(tools ?? {})) {
    try {
      if (path.isAbsolute(target)) out[name] = fs.realpathSync(target)
    } catch {
      /* uninstalled since: left off */
    }
  }
  return out
}

function scrubbedEnv(home: string, bin: string, extra: Record<string, string>): Record<string, string> {
  return {
    HOME: home,
    TMPDIR: path.join(home, 'tmp'),
    // Claude Code keeps its temp files in /tmp/claude-<uid>, not TMPDIR, and
    // exits when it can't make that folder. That is your own Claude Code's
    // folder, which the sandbox rightly hides, so point the guest's at its home.
    CLAUDE_CODE_TMPDIR: path.join(home, 'tmp'),
    PATH: [bin, path.join(home, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
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
  const homeId = spec.homeId ?? spec.id
  if (!/^[\w-]{1,80}$/.test(spec.id) || !/^[\w-]{1,80}$/.test(homeId)) throw new Error('Bad share id.')
  const network = spec.mode === 'cli' || spec.network
  // On Linux the internet comes only through pasta (see pastaArgs): sharing
  // the host's network would hand the friend this computer's loopback.
  const pasta = platform === 'linux' && network ? findOnPath('pasta') : null
  if (platform === 'linux' && network && !pasta) {
    throw new Error('Install passt (the “pasta” command) to give a friend the internet on Linux. Without it, their terminal could reach this computer’s own services.')
  }

  fs.mkdirSync(deps.homesDir, { recursive: true, mode: 0o700 })
  const home = path.join(fs.realpathSync(deps.homesDir), homeId)
  fs.mkdirSync(path.join(home, 'tmp'), { recursive: true, mode: 0o700 })
  fs.chmodSync(home, 0o700)
  const tools = realTools(spec.tools)
  const bin = guestBin(home, tools, platform)

  let program: string
  let programArgs: string[]
  let env: Record<string, string>
  const exec: string[] = []
  const readExtra: string[] = []
  for (const tool of Object.values(tools)) {
    const paths = cliPaths(tool)
    exec.push(...paths.exec)
    readExtra.push(...paths.read)
  }

  if (spec.mode === 'shell') {
    const shell = platform === 'darwin' ? '/bin/zsh' : fs.existsSync('/bin/bash') ? '/bin/bash' : '/usr/bin/bash'
    const kind = path.basename(shell) === 'zsh' ? 'zsh' : 'bash'
    // This terminal's own startup files: the home is shared by the friend's other terminals.
    const dot = path.join(home, '.eaon', 'shells', spec.id)
    fs.mkdirSync(dot, { recursive: true, mode: 0o700 })
    if (kind === 'zsh') {
      fs.writeFileSync(path.join(dot, '.zshrc'), guestRc(root, spec.label, 'zsh'), { mode: 0o600 })
      // -d: none of the system-wide startup files; ZDOTDIR points at ours.
      program = shell
      programArgs = ['-d', '-i']
      env = scrubbedEnv(home, bin, { ZDOTDIR: dot, SHELL: shell })
    } else {
      const rc = path.join(dot, '.bashrc')
      fs.writeFileSync(rc, guestRc(root, spec.label, 'bash'), { mode: 0o600 })
      program = shell
      programArgs = ['--noprofile', '--rcfile', rc, '-i']
      env = scrubbedEnv(home, bin, { SHELL: shell })
    }
  } else {
    if (!spec.program || !path.isAbsolute(spec.program) || !fs.existsSync(spec.program)) throw new Error('That CLI isn’t installed on this computer.')
    program = fs.realpathSync(spec.program)
    programArgs = spec.programArgs ?? []
    const paths = cliPaths(program)
    exec.push(...paths.exec)
    readExtra.push(...paths.read)
    env = scrubbedEnv(home, bin, {})
  }

  if (platform === 'darwin') {
    const ancestors = ancestorsOf([root, home, program, ...readExtra, ...Object.values(tools)])
    const profile = seatbeltProfile({ network, exec: [...new Set(exec)], readExtra: [...new Set(readExtra)], ancestors, listen: spec.mode === 'cli' })
    return { bin: SANDBOX_EXEC, argv: ['-p', profile, '-D', `ROOT=${root}`, '-D', `HOME=${home}`, program, ...programArgs], cwd: root, env, home }
  }

  const bwrap = findOnPath('bwrap')!
  const dns = pasta ? pastaResolv(home) : null
  const user = pasta && typeof process.getuid === 'function' && typeof process.getgid === 'function' ? { uid: process.getuid(), gid: process.getgid() } : undefined
  const args = bwrapArgs({ root, home, network, resolv: dns?.file, user, readExtra: [...new Set(readExtra)].filter((p) => !p.startsWith('/usr/')) })
  // --clearenv wipes the environment; set ours inside.
  const sets = Object.entries(env).flatMap(([k, v]) => ['--setenv', k, v])
  const sep = args.lastIndexOf('--')
  const sandboxed = [...args.slice(0, sep), ...sets, '--', program, ...programArgs]
  if (pasta) return { bin: pasta, argv: [...pastaArgs({ dns: dns?.dns ?? null, ipv6: hasIpv6Route() }), '--', bwrap, ...sandboxed], cwd: root, env: {}, home }
  return { bin: bwrap, argv: sandboxed, cwd: root, env: {}, home }
}
