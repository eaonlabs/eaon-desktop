/**
 * How dangerous a shell command looks, by reading it. Pure, so the main
 * process (auto-approve, scheduled runs) and the renderer (the approval
 * card's colour) judge a command the same way. Re-exported from
 * main/agent/approvals.ts.
 */

/**
 * Shell commands that can destroy work or reach beyond the project, which
 * "Approve for me" still stops to ask about. A deny-list is not a sandbox and
 * does not pretend to be one — it catches the commands a model most plausibly
 * runs by mistake, so auto mode is safe to leave on for ordinary work.
 */
const RISKY_COMMANDS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, // rm -rf, rm -r, rm -f
  /\bsudo\b/,
  /\bmkfs\b|\bdd\s+if=|\bdiskutil\s+(erase|partition)/,
  /\bchmod\s+(-R\s+)?[0-7]*7{2}\b|\bchown\s+-R\b/,
  /\bgit\s+push\b[^\n]*(--force|-f\b)/,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D|stash\s+(drop|clear)|filter-branch)/,
  /\bgit\s+push\b/,
  /(curl|wget)[^|\n]*\|\s*(sh|bash|zsh|python)/,
  /\b(shutdown|reboot|halt)\b|\blaunchctl\b|\bsystemctl\b|\bdefaults\s+write\b|\bcrontab\b/,
  /\bkill(all)?\s+-9\b|\bpkill\b/,
  /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/,
  /\bdocker\s+(system\s+prune|rm\s+-f|volume\s+rm)/,
  /\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\b/i,
  />\s*\/dev\/(sd|disk)/,
  /\bsecurity\s+(delete|dump|find-(generic|internet)-password)|\bkeychain\b/,
  // rm with its flags spelled out or apart (`rm --recursive`, `rm -v -rf`).
  /\brm\b(\s+-[\w-]+)*\s+(-[a-zA-Z]*[rRf][a-zA-Z]*|--(recursive|force))\b/,
  /\bfind\b[^|;&\n]*\s-(delete|exec(dir)?\s+rm)\b/,
  // Throwing away uncommitted work.
  /\bgit\s+(checkout\s+(--\s+)?\.(\s|$)|restore\b(?![^\n]*--staged)|clean\b)/,
  // Anything piped into a shell, or decoded or substituted and then run.
  /\|\s*(sudo\s+)?(sh|bash|zsh)\b/,
  /\b(eval|(ba|z)?sh\s+-c)\b[^\n]*(\$\(|`|base64)/,
  // Sending local files somewhere.
  /\bcurl\b[^\n]*(\s(-d|-F|--data(-binary|-raw|-urlencode)?|--form)\s*['"]?[^\s'"]*@|\s(-T|--upload-file)\s)/,
  /\bwget\b[^\n]*--post-file\b/,
  /\b(scp|sftp|rsync)\b[^\n]*\s[\w.-]+@[\w.-]+:/,
  // AppleScript drives other apps: Mail, Finder, System Settings.
  /\bosascript\b/,
  /\bchmod\s+-R\b/,
  // Deleting from a one-liner in another language.
  /\b(python3?|node|perl|ruby)\s+(-c|-e)\b[^\n]*(rmtree|os\.remove|unlink|rmSync|rmdirSync|rm_rf|remove_dir|fs\.rm)/
]

/** Paths a write to is harmless wherever the work folder is. */
const SCRATCH = /^(\/dev\/(null|stdout|stderr|tty)$|\/(private\/)?tmp\/|\$TMPDIR\b|\$\{TMPDIR\})/

/** Programs that change every path they are given. */
const CHANGES_EVERY_PATH = new Set(['rm', 'rmdir', 'mv', 'touch', 'truncate', 'mkdir', 'ln', 'chmod', 'chown', 'unlink'])

/** Splits one shell segment into words, keeping quoted strings whole. */
function words(segment: string): string[] {
  return [...segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3])
}

/**
 * The paths a command writes to, as far as a reading of it can tell:
 * redirection targets (`> f`, `>> f`, `&> f`), `tee` targets, every path
 * given to rm, mv, touch and kin, and `cp`'s destination. `$HOME` and `~`
 * are left for the caller to expand; scratch paths (/tmp, /dev/null) are
 * left out. Like the deny-list, this catches the usual forms, not every one.
 */
export function writtenPaths(command: string): string[] {
  const out: string[] = []
  for (const match of command.matchAll(/(?:^|[^<>&0-9-])(?:\d?>>?|&>>?)\s*("[^"]+"|'[^']+'|[^\s;&|()]+)/g)) {
    out.push(match[1].replace(/^["']|["']$/g, ''))
  }
  for (const segment of command.split(/\|\||&&|[|;\n]/)) {
    const [program, ...args] = words(segment.trim())
    if (!program) continue
    const name = program.split('/').pop() ?? program
    const paths = args.filter((arg) => !arg.startsWith('-'))
    if (name === 'tee') out.push(...paths)
    // chmod and chown take a mode or an owner first.
    else if (CHANGES_EVERY_PATH.has(name)) out.push(...(name === 'chmod' || name === 'chown' ? paths.slice(1) : paths))
    else if (name === 'cp' && paths.length >= 2) out.push(paths[paths.length - 1])
  }
  return out.filter((path) => path && !SCRATCH.test(path))
}

/**
 * The part of RISKY_COMMANDS nobody should run unattended even when trusted
 * to act alone: privilege, disks, the machine itself, credentials, piping the
 * internet into a shell, rewriting published history, publishing packages.
 * An autonomous worker runs other risky commands (`rm -rf build`, `git push`).
 */
const CATASTROPHIC_COMMANDS: RegExp[] = [
  /\bsudo\b/,
  /\bmkfs\b|\bdd\s+if=|\bdiskutil\s+(erase|partition)/,
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~|\$HOME|\/\*|~\/\*)(\s|$)/,
  /\bgit\s+push\b[^\n]*(--force|-f\b)/,
  /\bgit\s+filter-branch\b/,
  /(curl|wget)[^|\n]*\|\s*(sh|bash|zsh|python)/,
  /\b(shutdown|reboot|halt)\b/,
  /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/,
  /\bDROP\s+(TABLE|DATABASE)\b/i,
  />\s*\/dev\/(sd|disk)/,
  /\bsecurity\s+(delete|dump|find-(generic|internet)-password)|\bkeychain\b/
]

export function isCatastrophicCommand(command: string): boolean {
  return CREDENTIAL_PATHS.test(command) || CATASTROPHIC_COMMANDS.some((pattern) => pattern.test(command))
}

/**
 * The credential folders read_file and friends refuse outright (FORBIDDEN in
 * localTools.ts). `cat ~/.ssh/id_rsa` is the same read by another route, so a
 * command naming one always asks.
 */
export const CREDENTIAL_PATHS = /(^|[\s'"=:~/])\.(ssh|aws|gnupg|netrc)(\/|\b)|\.config\/gh\b|\.docker\/config\.json|Library\/(Keychains|Cookies)\b/

export function isRiskyCommand(command: string): boolean {
  return CREDENTIAL_PATHS.test(command) || RISKY_COMMANDS.some((pattern) => pattern.test(command))
}
