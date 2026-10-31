import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'

/**
 * Eaon started only to run tokn, not to open. Imported first by
 * main/index.ts, so this runs before any other module of Eaon's loads.
 *
 * - `Eaon --tokn-sync`: the Windows scheduled task behind "Keep syncing when
 *   Eaon is closed" (features/toknJob.ts). Task Scheduler can't set
 *   ELECTRON_RUN_AS_NODE, so Eaon starts as an app and runs tokn on its own
 *   Node from here.
 * - `Eaon <…>/tokn-cli/dist/index.js autosync`: a background job that
 *   `tokn autosync on` (or `tokn setup`) wrote through Eaon's `tokn`
 *   launcher. tokn names the program running it, which is Eaon's executable,
 *   but not ELECTRON_RUN_AS_NODE, so every run opened Eaon. The job is
 *   repaired on the way, and this run does what it was for.
 *
 * Either way tokn runs out of sight, this process waits for it and exits:
 * no window, and no hand-over to an Eaon that's already open.
 */

export const TOKN_SYNC_FLAG = '--tokn-sync'

/** The script the background job runs: resources/tokn-job.cjs, next to the bundled tokn. */
export function toknJobScript(): string | null {
  const candidates = [
    process.env.EAON_TOKN_JOB_SCRIPT || null,
    app.isPackaged ? join(process.resourcesPath, 'tokn-job.cjs') : null,
    fileURLToPath(new URL('../../resources/tokn-job.cjs', import.meta.url))
  ]
  return candidates.find((path): path is string => Boolean(path && existsSync(path))) ?? null
}

/** The bundled tokn's entry, as it appears in a job's command line. */
const BUNDLED_TOKN = /[\\/]tokn-cli[\\/]dist[\\/]index\.js$/

/** This Eaon's own tokn, next to the job script (EAON_TOKN_CLI_DIR while developing and testing). */
function bundledTokn(): string | null {
  const job = toknJobScript()
  const dir = process.env.EAON_TOKN_CLI_DIR || (job ? join(dirname(job), 'tokn-cli') : null)
  const script = dir ? join(dir, 'dist', 'index.js') : null
  return script && existsSync(script) ? script : null
}

/**
 * What to run on Eaon's own Node when Eaon was started only for tokn; null
 * for a normal start, and empty when there is nothing to run. A job's tokn
 * is always this Eaon's own, whichever path the job names: it may be where
 * Eaon used to be.
 */
export function toknRun(argv: string[] = process.argv): string[] | null {
  if (argv.includes(TOKN_SYNC_FLAG)) {
    const script = toknJobScript()
    return script ? [script] : []
  }
  const at = argv.findIndex((arg, index) => index > 0 && BUNDLED_TOKN.test(arg))
  if (at < 0) return null
  const tokn = bundledTokn()
  return tokn ? [tokn, ...argv.slice(at + 1)] : []
}

/**
 * The OS commands here and in features/toknJob.ts (launchctl, systemctl,
 * schtasks): true when one succeeded. Tests swap these so nothing reaches
 * the computer's own launchd, systemd or Task Scheduler.
 */
export const jobCommands = {
  run(file: string, args: string[]): boolean {
    try {
      execFileSync(file, args, { stdio: 'ignore', timeout: 30_000, windowsHide: true })
      return true
    } catch {
      return false
    }
  },
  runAsync(file: string, args: string[]): Promise<boolean> {
    return new Promise((done) => {
      execFile(file, args, { timeout: 30_000, windowsHide: true }, (error) => done(!error))
    })
  }
}

const home = (): string => process.env.EAON_TOKN_JOB_HOME || homedir()
const uid = (): number => process.getuid?.() ?? 0

/** tokn's own scheduled jobs (tokn's core/scheduler.ts), where `tokn autosync on` puts them. */
export function toknOwnJobFiles(): string[] {
  if (process.platform === 'darwin') {
    return ['dev.tokn.autosync', 'dev.tokn.daily'].map((label) => join(home(), 'Library', 'LaunchAgents', `${label}.plist`))
  }
  if (process.platform === 'linux') {
    const dir = join(process.env.XDG_CONFIG_HOME || join(home(), '.config'), 'systemd', 'user')
    return ['tokn-autosync.service', 'tokn-daily.service'].map((name) => join(dir, name))
  }
  return []
}

/**
 * Adds ELECTRON_RUN_AS_NODE to tokn's own jobs that run Eaon's bundled tokn
 * without it. A job that runs tokn from npm, or already has it, is left as it
 * is. Returns the files it changed; systemd is told at once, while launchd
 * goes on with the definition it loaded until the caller reloads it
 * (reloadLaunchdJobs).
 */
export function repairToknJobs(): string[] {
  const repaired: string[] = []
  for (const file of toknOwnJobFiles()) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (!/[\\/]tokn-cli[\\/]dist[\\/]index\.js/.test(text) || text.includes('ELECTRON_RUN_AS_NODE')) continue
    const fixed = file.endsWith('.plist')
      ? text.replace('<dict>', '<dict>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>ELECTRON_RUN_AS_NODE</key>\n    <string>1</string>\n  </dict>')
      : text.replace('[Service]\n', '[Service]\nEnvironment=ELECTRON_RUN_AS_NODE=1\n')
    if (fixed === text) continue
    try {
      writeFileSync(file, fixed)
      repaired.push(file)
    } catch {
      // Not ours to force; it stays as tokn wrote it.
    }
  }
  if (repaired.length > 0 && process.platform === 'linux') jobCommands.run('systemctl', ['--user', 'daemon-reload'])
  return repaired
}

const plistLabel = (file: string): string => file.slice(file.lastIndexOf('/') + 1, -'.plist'.length)

/** Has launchd load these plists again, so a repair takes effect now rather than at the next login. */
export function reloadLaunchdJobs(files: string[]): void {
  for (const file of files.filter((path) => path.endsWith('.plist'))) {
    jobCommands.run('/bin/launchctl', ['bootout', `gui/${uid()}/${plistLabel(file)}`])
    jobCommands.run('/bin/launchctl', ['bootstrap', `gui/${uid()}`, file])
  }
}

const run = toknRun()
if (run) {
  let repaired: string[] = []
  try {
    repaired = repairToknJobs()
  } catch {
    // Repairing is a courtesy; the run below is what this start is for.
  }
  if (run.length > 0) {
    spawnSync(process.execPath, run, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore',
      windowsHide: true,
      timeout: 15 * 60_000
    })
  }
  // This process is the job launchd started, and booting a job out stops
  // its process: the reload waits, in a session of its own, until this one
  // has gone.
  const plists = repaired.filter((file) => file.endsWith('.plist'))
  if (plists.length > 0) {
    const steps = plists.map((file) => `/bin/launchctl bootout gui/${uid()}/${plistLabel(file)}; /bin/launchctl bootstrap gui/${uid()} '${file.replace(/'/g, `'\\''`)}'`)
    spawn('/bin/sh', ['-c', `sleep 2; ${steps.join('; ')}`], { detached: true, stdio: 'ignore' }).unref()
  }
  process.exit(0)
}
