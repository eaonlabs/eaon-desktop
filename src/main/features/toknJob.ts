import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, release, tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { app } from 'electron'
import type { ToknCliStatus } from '@shared/toknCli'
import { store } from '../store'
import { jobCommands, reloadLaunchdJobs, repairToknJobs, TOKN_SYNC_FLAG, toknJobScript, toknOwnJobFiles } from '../toknJobStart'
import { toknHost } from './usage/tokn'

/**
 * "Keep syncing when Eaon is closed" (Settings → Usage → The tokn command):
 * a job the operating system runs, also while Eaon is closed, that publishes
 * what the coding CLIs used with the tokn command that ships inside Eaon.
 * It runs resources/tokn-job.cjs on Eaon's own Node, which is
 * `tokn autosync`: tokn decides whether anything is due (at most every 90
 * minutes, and only when a CLI wrote something), and at 23:59 closes the day.
 *
 * - macOS: a LaunchAgent that ships inside the app
 *   (resources/mac/LaunchAgents/dev.eaon.tokn.plist) and is registered
 *   through SMAppService, so macOS lists it as Eaon's, as main/background.ts
 *   does for the login agent. A development build has no bundle, and macOS
 *   12 no SMAppService: they write it to ~/Library/LaunchAgents instead.
 * - Linux: a systemd user timer. Not the AppImage: everything in it,
 *   Eaon's own executable included, is only there while it runs.
 * - Windows: a scheduled task that starts `Eaon --tokn-sync`
 *   (main/toknJobStart.ts), since Task Scheduler can't set
 *   ELECTRON_RUN_AS_NODE.
 *
 * It's on when the coding CLIs are tracked, this is on and tokn is linked.
 * Eaon steps back when tokn already syncs on its own schedule (`tokn autosync
 * on` with tokn from npm), and when automatic syncing was turned off in a
 * terminal (`tokn autosync off`) until this switch is turned on again. While
 * the job is on, Eaon's own hourly `tokn sync` doesn't run (toknCli.ts).
 */

export type ToknJobStatus = Omit<ToknCliStatus['background'], 'everyMinutes'>

/** One label everywhere: the bundled plist's name, the development plist, and the systemd units' stem. */
export const JOB_LABEL = 'dev.eaon.tokn'
const AGENT_SERVICE = `${JOB_LABEL}.plist`
const UNIT = 'eaon-tokn'
export const TASK_NAME = 'Eaon Tokn sync'
/** How often the job starts. tokn's throttle decides whether that start publishes anything. */
export const EVERY_MINUTES = 15
const MARKER = 'Installed by Eaon Desktop'

type JobKind = 'agent' | 'launchd' | 'systemd' | 'task'

let status: ToknJobStatus = { state: 'off', error: null }
let applying: Promise<ToknJobStatus> = Promise.resolve(status)

export const toknJobStatus = (): ToknJobStatus => status

const home = (): string => process.env.EAON_TOKN_JOB_HOME || homedir()
const uid = (): number => process.getuid?.() ?? 0

/* ---------------------------------------------------------------- tokn's config */

interface ToknConfig {
  token?: unknown
  autosync?: { enabled?: unknown; intervalMinutes?: unknown }
  [key: string]: unknown
}

const configFile = (): string => join(process.env.TOKN_CONFIG_DIR || join(homedir(), '.tokn'), 'config.json')

function readConfig(): ToknConfig | null {
  try {
    const config = JSON.parse(readFileSync(configFile(), 'utf8')) as unknown
    return config && typeof config === 'object' && !Array.isArray(config) ? (config as ToknConfig) : null
  } catch {
    return null
  }
}

/**
 * The switch was turned on while `tokn autosync off` had turned automatic
 * syncing off: that is a yes, so tokn's own flag goes back on. Written the
 * way tokn writes its config (whole, private to the user), with everything
 * else in it kept.
 */
export function resumeToknAutosync(): void {
  const config = readConfig()
  if (!config || config.autosync?.enabled !== false) return
  const file = configFile()
  const next = { ...config, autosync: { ...config.autosync, enabled: true } }
  const temp = `${file}.eaon-${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

/* ------------------------------------------------------------------- the job */

/** Where this Eaon can run the job, if anywhere. */
function jobKind(): JobKind | null {
  // SMAppService is macOS 13 (Darwin 22) and later; before it, macOS didn't announce background items either.
  if (process.platform === 'darwin') return bundledAgent() && Number(release().split('.')[0]) >= 22 ? 'agent' : 'launchd'
  if (process.platform === 'win32') return 'task'
  if (process.platform === 'linux') return process.env.APPIMAGE ? null : 'systemd'
  return null
}

/** The packaged app's own copy of the agent (electron-builder.yml's extraFiles), for SMAppService. */
function bundledAgent(): boolean {
  if (!app.isPackaged) return false
  return existsSync(join(dirname(process.execPath), '..', 'Library', 'LaunchAgents', AGENT_SERVICE))
}

/** What the job runs where it can name files by their full path: Eaon's Node, and the job script. */
function jobCommand(script: string): string[] {
  return [process.execPath, script]
}

/** Settings a development build or a test runs with, so its job reaches the same tokn and Tokn. */
function jobEnv(): Record<string, string> {
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' }
  for (const name of ['TOKN_CONFIG_DIR', 'EAON_TOKN_CLI_DIR'] as const) {
    const value = process.env[name]
    if (value) env[name] = value
  }
  if (process.env.EAON_TOKN_HOST) env.TOKN_HOST = toknHost()
  return env
}

const xml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

/** A development build's LaunchAgent: the bundled one, with full paths. */
export function launchdPlist(command: string[], env: Record<string, string>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${MARKER}. Turn it off in Eaon → Settings → Usage. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${JOB_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${command.map((arg) => `    <string>${xml(arg)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([name, value]) => `    <key>${xml(name)}</key>\n    <string>${xml(value)}</string>`)
  .join('\n')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${EVERY_MINUTES * 60}</integer>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>23</integer>
    <key>Minute</key>
    <integer>59</integer>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`
}

const launchdPath = (): string => join(home(), 'Library', 'LaunchAgents', `${JOB_LABEL}.plist`)

/** A value systemd reads as one word, as written: quoted, with its own escapes and % doubled. */
const unitWord = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`

/** The systemd user service and the timer that starts it. */
export function systemdUnits(command: string[], env: Record<string, string>): { service: string; timer: string } {
  const service = `# ${MARKER}. Turn it off in Eaon → Settings → Usage.
[Unit]
Description=Eaon: publish the coding CLIs' usage to Tokn
# Eaon was removed: nothing to run.
ConditionPathExists=${command[0].replace(/%/g, '%%')}

[Service]
Type=oneshot
Nice=5
IOSchedulingClass=idle
${Object.entries(env)
  .map(([name, value]) => `Environment=${unitWord(`${name}=${value}`)}`)
  .join('\n')}
ExecStart=${command.map(unitWord).join(' ')}
`
  const timer = `# ${MARKER}. Turn it off in Eaon → Settings → Usage.
[Unit]
Description=Eaon: publish the coding CLIs' usage to Tokn

[Timer]
OnActiveSec=1min
OnUnitActiveSec=${EVERY_MINUTES}min
OnCalendar=*-*-* 23:59:00
Persistent=true

[Install]
WantedBy=timers.target
`
  return { service, timer }
}

const systemdDir = (): string => join(process.env.XDG_CONFIG_HOME || join(home(), '.config'), 'systemd', 'user')

/** The scheduled task: `Eaon --tokn-sync` every 15 minutes and at 23:59, on battery too. */
export function taskXml(command: string[], user: string): string {
  const [exe, ...args] = command
  const quoted = args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(' ')
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xml(`${MARKER}: publishes the coding CLIs' usage to Tokn with the tokn command that comes with Eaon, also while Eaon is closed. Turn it off in Eaon → Settings → Usage.`)}</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT${EVERY_MINUTES}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T23:59:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT20M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(exe)}</Command>
      <Arguments>${xml(quoted)}</Arguments>
    </Exec>
  </Actions>
</Task>
`
}

/** The task as last registered, kept to know when it needs registering again. */
const taskCopy = (): string => join(app.getPath('userData'), 'tokn-task.xml')

/** `Eaon --tokn-sync`; a development build is Electron and its app folder. */
function taskCommand(): string[] {
  const base = app.isPackaged ? [process.execPath] : [process.execPath, resolve(process.argv[1] ?? '.')]
  return [...base, TOKN_SYNC_FLAG]
}

function windowsUser(): string {
  const { USERDOMAIN, USERNAME } = process.env
  if (USERDOMAIN && USERNAME) return `${USERDOMAIN}\\${USERNAME}`
  return userInfo().username
}

/** Writes `text` to `path` unless it is already there. True when it wrote. */
function writeIfChanged(path: string, text: string): boolean {
  try {
    if (readFileSync(path, 'utf8') === text) return false
  } catch {
    // Not there yet.
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return true
}

/** Runs an OS command off the main thread; tests swap jobCommands.runAsync. */
function command(file: string, args: string[]): Promise<boolean> {
  return jobCommands.runAsync(file, args)
}

async function install(kind: JobKind, script: string): Promise<ToknJobStatus> {
  if (kind === 'agent') {
    // A development build's plist under the same label goes, so launchd doesn't hold two.
    if (existsSync(launchdPath())) {
      await command('/bin/launchctl', ['bootout', `gui/${uid()}/${JOB_LABEL}`])
      rmSync(launchdPath(), { force: true })
    }
    const service = { type: 'agentService' as const, serviceName: AGENT_SERVICE }
    let state = app.getLoginItemSettings(service).status
    // Registering again announces it again: only when it isn't.
    if (state !== 'enabled' && state !== 'requires-approval') {
      app.setLoginItemSettings({ ...service, openAtLogin: true })
      state = app.getLoginItemSettings(service).status
    }
    if (state === 'enabled') return { state: 'on', error: null }
    if (state === 'requires-approval') return { state: 'approval', error: null }
    return { state: 'failed', error: 'macOS didn’t take Eaon’s background item.' }
  }
  if (kind === 'launchd') {
    const path = launchdPath()
    const changed = writeIfChanged(path, launchdPlist(jobCommand(script), jobEnv()))
    const loaded = !changed && (await command('/bin/launchctl', ['print', `gui/${uid()}/${JOB_LABEL}`]))
    if (!loaded) {
      await command('/bin/launchctl', ['bootout', `gui/${uid()}/${JOB_LABEL}`])
      if (!(await command('/bin/launchctl', ['bootstrap', `gui/${uid()}`, path]))) {
        return { state: 'failed', error: 'launchd didn’t load the job.' }
      }
    }
    return { state: 'on', error: null }
  }
  if (kind === 'systemd') {
    const units = systemdUnits(jobCommand(script), jobEnv())
    const changed = [writeIfChanged(join(systemdDir(), `${UNIT}.service`), units.service), writeIfChanged(join(systemdDir(), `${UNIT}.timer`), units.timer)].some(Boolean)
    const enabled = !changed && (await command('systemctl', ['--user', 'is-enabled', '--quiet', `${UNIT}.timer`]))
    if (!enabled) {
      await command('systemctl', ['--user', 'daemon-reload'])
      if (!(await command('systemctl', ['--user', 'enable', '--now', `${UNIT}.timer`]))) {
        return { state: 'failed', error: 'systemd’s user manager isn’t running here.' }
      }
    }
    return { state: 'on', error: null }
  }
  const text = taskXml(taskCommand(), windowsUser())
  let registered = false
  try {
    registered = readFileSync(taskCopy(), 'utf8') === text && (await command('schtasks', ['/Query', '/TN', TASK_NAME]))
  } catch {
    // Never registered from here.
  }
  if (!registered) {
    // Task Scheduler reads the file as UTF-16, as the XML says.
    const file = join(tmpdir(), `eaon-tokn-task-${process.pid}.xml`)
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
    const ok = await command('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', file, '/F'])
    rmSync(file, { force: true })
    if (!ok) return { state: 'failed', error: 'Task Scheduler didn’t take the task.' }
    writeIfChanged(taskCopy(), text)
  }
  return { state: 'on', error: null }
}

/** Removes Eaon's job, and only Eaon's. */
async function uninstall(kind: JobKind): Promise<void> {
  if (kind === 'agent' || kind === 'launchd') {
    if (kind === 'agent') {
      const service = { type: 'agentService' as const, serviceName: AGENT_SERVICE }
      const state = app.getLoginItemSettings(service).status
      if (state === 'enabled' || state === 'requires-approval') app.setLoginItemSettings({ ...service, openAtLogin: false })
    }
    if (existsSync(launchdPath())) {
      await command('/bin/launchctl', ['bootout', `gui/${uid()}/${JOB_LABEL}`])
      rmSync(launchdPath(), { force: true })
    }
    return
  }
  if (kind === 'systemd') {
    const files = [`${UNIT}.service`, `${UNIT}.timer`].map((name) => join(systemdDir(), name))
    if (!files.some((file) => existsSync(file))) return
    await command('systemctl', ['--user', 'disable', '--now', `${UNIT}.timer`])
    for (const file of files) rmSync(file, { force: true })
    await command('systemctl', ['--user', 'daemon-reload'])
    return
  }
  if (!existsSync(taskCopy())) return
  await command('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'])
  rmSync(taskCopy(), { force: true })
}

async function apply(): Promise<ToknJobStatus> {
  if (process.env.EAON_TOKN_JOB === 'off') return { state: 'off', error: null }
  // tokn's own jobs that would open Eaon instead of running tokn (toknJobStart.ts).
  reloadLaunchdJobs(repairToknJobs())
  const kind = jobKind()
  const script = toknJobScript()
  if (!kind || !script) return { state: 'unavailable', error: null }
  const { sync, background } = store.getSettings().toknCli
  const config = readConfig()
  const linked = typeof config?.token === 'string' && config.token.length > 0
  const elsewhere: ToknJobStatus['state'] | null =
    !sync || !background || !linked
      ? 'off'
      : config?.autosync?.enabled === false
        ? 'paused'
        : toknOwnJobFiles().some((file) => existsSync(file))
          ? 'tokn'
          : null
  try {
    if (elsewhere) {
      await uninstall(kind)
      return { state: elsewhere, error: null }
    }
    return await install(kind, script)
  } catch (error) {
    return { state: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Brings the job in line with the settings and tokn's own state: puts it in
 * place, brings it up to date (Eaon moved), or removes it. One at a time.
 */
export function applyToknJob(): Promise<ToknJobStatus> {
  applying = applying.then(apply, apply).then((next) => (status = next))
  return applying
}

/** Eaon's job is in place, so Eaon's own hourly sync would only run it twice. */
export function jobRuns(): boolean {
  return status.state === 'on'
}
