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

/**
 * The same for Windows, where run_command goes through cmd.exe and models
 * reach for PowerShell too. Both ignore case, so these do as well. They key
 * on what makes a command destructive (`/s`, `-Recurse`, a drive letter)
 * rather than on bare words like `del` or `format`, which are also ordinary
 * text — and text typed by computer use is judged by this list too.
 */
const WINDOWS_RISKY_COMMANDS: RegExp[] = [
  // Deleting a tree, or without asking: rd /s, del /s /q /f, Remove-Item -Recurse -Force.
  /\b(rd|rmdir)\b[^\n|&;]*\s\/s\b/i,
  /\b(del|erase)\b[^\n|&;]*\s\/[sfq]\b/i,
  /\b(Remove-Item|ri|rd|rmdir|del|erase)\b[^\n|;]*\s-(r\w*|fo\w*)\b/i,
  // Mirroring deletes whatever the source does not have.
  /\brobocopy\b[^\n|&;]*\s\/(mir|purge|move|mov)\b/i,
  // Disks, boot and the machine itself.
  /(^|[\s;&|"'(])format(\.com)?\s+[a-z]:/i,
  /\b(diskpart|bcdedit|bootrec)\b|\b(Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\b/i,
  /\bcipher(\.exe)?\b[^\n|&;]*\s\/w\b/i,
  /\b(vssadmin|wbadmin)\b[^\n|&;]*\bdelete\b/i,
  /\bshutdown(\.exe)?\s+[/-]|\b(Stop|Restart)-Computer\b/i,
  // The registry, services, scheduled tasks and lasting settings — Windows'
  // `defaults write`, `launchctl` and `crontab`.
  /\breg(\.exe)?\s+(delete|add|import|restore|load|unload|copy)\b|\b(Set|New|Remove|Rename|Clear)-ItemProperty\b/i,
  /\bsc(\.exe)?\s+(create|delete|config|stop|failure)\b|\b(New|Set|Remove|Stop)-Service\b/i,
  /\bschtasks(\.exe)?\b[^\n|&;]*\s\/(create|delete|change|run)\b|\b(Register|Unregister|Set)-ScheduledTask\b/i,
  /\bsetx\b|\bSet-ExecutionPolicy\b|\bnetsh\b[^\n|&;]*\b(set|add|delete|reset)\b/i,
  /\btakeown\b|\bicacls\b[^\n|&;]*\s\/(grant|setowner|reset|remove|deny|inheritance)\b/i,
  // Elevation (Windows 11's own `sudo` is caught above).
  /\brunas(\.exe)?\s+\/|-Verb\s+['"]?RunAs\b/i,
  // Killing every process of a name, as pkill does.
  /\btaskkill(\.exe)?\b[^\n|&;]*\s\/im\b|\bStop-Process\b[^\n|;]*\s-(Name|ProcessName)\b/i,
  // Running what was downloaded or encoded: iwr … | iex, Invoke-Expression,
  // powershell -enc, and the script hosts malware leans on. A bare `iex` is
  // also Elixir's shell, so only the PowerShell forms count.
  /\bInvoke-Expression\b|\|\s*iex\b|\biex\s*[($'"]/i,
  /\b(powershell|pwsh)(\.exe)?\b[^\n]*\s-(e|ec|en\w*)\b/i,
  /\|\s*(powershell|pwsh|cmd)(\.exe)?\b/i,
  /\b(mshta|regsvr32|rundll32)(\.exe)?\b/i,
  // Sending local files somewhere, and certutil's download-and-decode.
  /\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\s-InFile\b/i,
  /\bcertutil(\.exe)?\b[^\n|&;]*\s[-/](urlcache|decode|decodehex|encode)\b/i,
  // Credential Manager, Windows' keychain.
  /\b(cmdkey|vaultcmd)\b/i
]

/** Paths a write to is harmless wherever the work folder is. */
const SCRATCH = /^(\/dev\/(null|stdout|stderr|tty)$|\/(private\/)?tmp\/|\$TMPDIR\b|\$\{TMPDIR\})/
/** cmd's and PowerShell's: `nul`, and the temp folder by its variable. */
const WINDOWS_SCRATCH = /^(nul:?$|%(TEMP|TMP)%|\$env:(TEMP|TMP)\b)/i

/** Programs that change every path they are given, with cmd's and PowerShell's names for the same. */
const CHANGES_EVERY_PATH = new Set([
  'rm', 'rmdir', 'mv', 'touch', 'truncate', 'mkdir', 'ln', 'chmod', 'chown', 'unlink',
  'del', 'erase', 'rd', 'md', 'move', 'remove-item', 'ri', 'move-item', 'mi', 'new-item', 'ni',
  'set-content', 'add-content', 'ac', 'clear-content', 'clc', 'out-file', 'tee-object'
])
/** Programs that write only their destination: the last path, except robocopy's (source, destination, files). */
const COPIES = new Set(['cp', 'copy', 'xcopy', 'copy-item', 'cpi', 'robocopy'])
/** Renaming changes the first path; the new name is in the same folder. */
const RENAMES = new Set(['ren', 'rename', 'rename-item', 'rni'])
/** cmd's own commands, whose switches (`/s`, `/y`) would otherwise read as paths. */
const CMD_PROGRAMS = new Set(['del', 'erase', 'rd', 'md', 'move', 'copy', 'xcopy', 'robocopy', 'ren', 'rename'])
/** PowerShell parameters whose value is not a path: `Set-Content log.txt -Value x`. */
const VALUE_PARAMETERS = /^-(value|encoding|itemtype|type|filter|include|exclude|width|stream|credential|newname|delimiter|inputobject)$/i

/**
 * The name a program is known by, whatever path or extension it is typed
 * with: `C:\Windows\System32\Robocopy.EXE` is `robocopy`. Lower case, since
 * Windows and macOS find `LS` and `ls` alike.
 */
export function programName(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).toLowerCase().replace(/\.(exe|com|cmd|bat|ps1)$/, '')
}

/** Splits one shell segment into words, keeping quoted strings whole. */
function words(segment: string): string[] {
  return [...segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3])
}

/** A program's operands: no options, no cmd switches, no values of PowerShell's non-path parameters. */
function operands(name: string, args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (VALUE_PARAMETERS.test(arg)) i++
    else if (arg.startsWith('-')) continue
    // rmdir and mkdir are cmd's as well, with one-letter switches (`rmdir /s /q build`).
    else if (CMD_PROGRAMS.has(name) ? arg.startsWith('/') : (name === 'rmdir' || name === 'mkdir') && /^\/[a-z]$/i.test(arg)) continue
    else out.push(arg)
  }
  return out
}

/**
 * The paths a command writes to, as far as a reading of it can tell:
 * redirection targets (`> f`, `>> f`, `&> f`), `tee` targets, every path
 * given to rm, mv, touch and kin, and `cp`'s destination — and on Windows
 * the same for del, rd, move, copy, xcopy, robocopy, Set-Content, Out-File
 * and kin, including inside `cmd /c "…"` and `powershell -Command "…"`.
 * `$HOME`, `%USERPROFILE%` and `~` are left for the caller to expand;
 * scratch paths (/tmp, /dev/null, nul) are left out. Like the deny-list,
 * this catches the usual forms, not every one.
 */
export function writtenPaths(command: string): string[] {
  const out: string[] = []
  for (const match of command.matchAll(/(?:^|[^<>&0-9-])(?:\d?>>?|&>>?)\s*("[^"]+"|'[^']+'|[^\s;&|()]+)/g)) {
    out.push(match[1].replace(/^["']|["']$/g, ''))
  }
  // A lone `&` chains commands in cmd as `;` does in sh.
  for (const segment of command.split(/\|\||&&|[|;&\n\r]/)) {
    const [program, ...args] = words(segment.trim())
    if (!program) continue
    const name = programName(program)
    // The command a shell is handed to run is read like any other.
    const script = args.findIndex((arg) =>
      name === 'cmd' ? /^\/[ck]$/i.test(arg) : (name === 'powershell' || name === 'pwsh') && /^-(c|command)$/i.test(arg)
    )
    if (script >= 0) {
      out.push(...writtenPaths(args.slice(script + 1).join(' ')))
      continue
    }
    const paths = operands(name, args)
    if (name === 'tee') out.push(...paths)
    // chmod and chown take a mode or an owner first.
    else if (CHANGES_EVERY_PATH.has(name)) out.push(...(name === 'chmod' || name === 'chown' ? paths.slice(1) : paths))
    else if (name === 'robocopy' && paths.length >= 2) out.push(paths[1])
    else if (COPIES.has(name) && paths.length >= 2) out.push(paths[paths.length - 1])
    else if (RENAMES.has(name) && paths.length >= 1) out.push(paths[0])
  }
  return [...new Set(out)].filter((path) => path && !SCRATCH.test(path) && !WINDOWS_SCRATCH.test(path))
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

/** CATASTROPHIC_COMMANDS' Windows half, case-insensitive like WINDOWS_RISKY_COMMANDS. */
const WINDOWS_CATASTROPHIC_COMMANDS: RegExp[] = [
  /\brunas(\.exe)?\s+\/|-Verb\s+['"]?RunAs\b/i,
  /(^|[\s;&|"'(])format(\.com)?\s+[a-z]:/i,
  /\b(diskpart|bcdedit|bootrec)\b|\b(Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\b/i,
  /\bcipher(\.exe)?\b[^\n|&;]*\s\/w\b/i,
  /\b(vssadmin|wbadmin)\b[^\n|&;]*\bdelete\b/i,
  /\bshutdown(\.exe)?\s+[/-]|\b(Stop|Restart)-Computer\b/i,
  // Deleting a whole drive or the profile folder: rd /s /q C:\, Remove-Item -Recurse $env:USERPROFILE.
  /\b(rd|rmdir|del|erase|Remove-Item|ri)\b[^\n|&;]*\s["']?([a-z]:\\?\*?|\\|~(\\\*?)?|%(USERPROFILE|HOMEDRIVE|SystemDrive|SystemRoot)%\\?\*?|\$env:(USERPROFILE|HOMEDRIVE|SystemDrive|SystemRoot)\\?\*?)["']?(\s|$)/i,
  // The internet into PowerShell: iwr … | iex, iex (New-Object Net.WebClient).DownloadString(…).
  /\b(iwr|irm|curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(iex|Invoke-Expression)\b/i,
  /(\biex\s*[($'"]|\bInvoke-Expression\b)[^\n]*(DownloadString|DownloadFile|\biwr\b|\birm\b|Invoke-WebRequest|Invoke-RestMethod)/i,
  /\b(cmdkey|vaultcmd)\b/i
]

export function isCatastrophicCommand(command: string): boolean {
  return (
    CREDENTIAL_PATHS.test(command) ||
    CATASTROPHIC_COMMANDS.some((pattern) => pattern.test(command)) ||
    WINDOWS_CATASTROPHIC_COMMANDS.some((pattern) => pattern.test(command))
  )
}

/**
 * The credential folders read_file and friends refuse outright (FORBIDDEN in
 * localTools.ts). `cat ~/.ssh/id_rsa` is the same read by another route, so a
 * command naming one always asks — `type C:\Users\me\.ssh\id_ed25519` and
 * `~/.SSH` too, since Windows and macOS ignore case in paths.
 */
export const CREDENTIAL_PATHS =
  /(^|[\s'"=:~/\\])\.(ssh|aws|gnupg|netrc)([\\/]|\b)|\.config[\\/]gh\b|\.docker[\\/]config\.json|Library[\\/](Keychains|Cookies)\b|[\\/]GitHub CLI\b|Microsoft[\\/](Credentials|Protect|Vault)\b/i

export function isRiskyCommand(command: string): boolean {
  return (
    CREDENTIAL_PATHS.test(command) ||
    RISKY_COMMANDS.some((pattern) => pattern.test(command)) ||
    WINDOWS_RISKY_COMMANDS.some((pattern) => pattern.test(command))
  )
}
