import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { store } from '../src/main/store'
import { jobCommands, repairToknJobs, reloadLaunchdJobs, toknRun, TOKN_SYNC_FLAG } from '../src/main/toknJobStart'
import { applyToknJob, jobRuns, JOB_LABEL, launchdPlist, resumeToknAutosync, systemdUnits, taskXml } from '../src/main/features/toknJob'

/**
 * tokn's background sync (features/toknJob.ts, toknJobStart.ts and
 * resources/tokn-job.cjs). Everything lands in a temp home
 * (EAON_TOKN_JOB_HOME) and tokn's config in a temp folder (TOKN_CONFIG_DIR);
 * launchctl and systemctl are stand-ins that only note what they were asked,
 * so nothing reaches this computer's own launchd or systemd. Nothing runs
 * tokn or reaches Tokn.
 */

const repo = process.cwd()
const jobScript = join(repo, 'resources', 'tokn-job.cjs')
const job = createRequire(import.meta.url)(jobScript) as {
  toknScript: () => string
  toknArgs: (now?: Date) => string[]
}

let root = ''
let calls: string[] = []
/** What the stand-in launchctl/systemctl answer: `print` and `is-enabled` say whether the job is loaded. */
let loaded = false
const real = { ...jobCommands }

const config = (): string => join(root, 'tokn', 'config.json')
const writeConfig = (value: unknown): void => {
  mkdirSync(join(root, 'tokn'), { recursive: true })
  writeFileSync(config(), JSON.stringify(value))
}
const linked = { host: 'https://toknhq.com', token: 'tok_secret', user: { handle: 'ada' }, lastSyncAt: '2026-10-30T10:00:00.000Z' }
const agentsDir = (): string => join(root, 'home', 'Library', 'LaunchAgents')
const unitsDir = (): string => join(root, 'home', '.config', 'systemd', 'user')
const eaonJobFile = (): string => (process.platform === 'darwin' ? join(agentsDir(), `${JOB_LABEL}.plist`) : join(unitsDir(), 'eaon-tokn.timer'))
const posix = process.platform === 'darwin' || process.platform === 'linux'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'eaon-tokn-job-'))
  calls = []
  loaded = false
  const answer = (file: string, args: string[]): boolean => {
    calls.push([file.split('/').pop(), ...args].join(' '))
    if (args.includes('print') || args.includes('is-enabled')) return loaded
    return true
  }
  jobCommands.run = answer
  jobCommands.runAsync = async (file, args) => answer(file, args)
  process.env.EAON_TOKN_JOB_HOME = join(root, 'home')
  process.env.TOKN_CONFIG_DIR = join(root, 'tokn')
  process.env.EAON_TOKN_JOB_SCRIPT = jobScript
  delete process.env.XDG_CONFIG_HOME
  delete process.env.APPIMAGE
  delete process.env.EAON_TOKN_JOB
  store.patchSettings({ toknCli: { install: true, sync: true, background: true } })
})

afterEach(() => {
  Object.assign(jobCommands, real)
  delete process.env.EAON_TOKN_JOB_HOME
  delete process.env.TOKN_CONFIG_DIR
  delete process.env.EAON_TOKN_JOB_SCRIPT
  rmSync(root, { recursive: true, force: true })
})

test('the job script runs the tokn next to it as `tokn autosync`, and closes the day at 23:59', () => {
  assert.deepEqual(job.toknArgs(new Date(2026, 9, 31, 14, 15)), ['autosync'])
  assert.deepEqual(job.toknArgs(new Date(2026, 9, 31, 23, 58)), ['autosync'])
  assert.deepEqual(job.toknArgs(new Date(2026, 9, 31, 23, 59, 40)), ['autosync', '--daily'])
  assert.deepEqual(job.toknArgs(new Date(2026, 10, 1, 0, 0)), ['autosync'])
  const saved = process.env.EAON_TOKN_CLI_DIR
  delete process.env.EAON_TOKN_CLI_DIR
  assert.equal(job.toknScript(), join(repo, 'resources', 'tokn-cli', 'dist', 'index.js'), 'packaged, tokn-cli sits next to it')
  process.env.EAON_TOKN_CLI_DIR = join(root, 'cli')
  assert.equal(job.toknScript(), join(root, 'cli', 'dist', 'index.js'))
  if (saved === undefined) delete process.env.EAON_TOKN_CLI_DIR
  else process.env.EAON_TOKN_CLI_DIR = saved
})

test('Eaon started only for tokn: the scheduled task’s flag, or a tokn job that names Eaon’s executable', () => {
  assert.equal(toknRun(['/Applications/Eaon.app/Contents/MacOS/Eaon']), null)
  assert.equal(toknRun(['/Applications/Eaon.app/Contents/MacOS/Eaon', '--background']), null)
  assert.equal(toknRun(['electron', '.', '--user-data-dir=/tmp/x']), null)
  assert.deepEqual(toknRun(['C:\\Eaon\\Eaon.exe', TOKN_SYNC_FLAG]), [jobScript])
  // Whatever tokn the job names (here where Eaon used to be), it's this Eaon's own that runs.
  const ours = join(repo, 'resources', 'tokn-cli', 'dist', 'index.js')
  const moved = '/Users/a/Downloads/Eaon.app/Contents/Resources/tokn-cli/dist/index.js'
  assert.deepEqual(toknRun(['/Applications/Eaon.app/Contents/MacOS/Eaon', moved, 'autosync', '--daily']), [ours, 'autosync', '--daily'])
  assert.deepEqual(toknRun(['C:\\Eaon\\Eaon.exe', 'C:\\Eaon\\resources\\tokn-cli\\dist\\index.js', 'autosync']), [ours, 'autosync'])
  // tokn from npm is never Eaon's business.
  assert.equal(toknRun(['/usr/local/bin/node', '/usr/local/lib/node_modules/toknhq/dist/index.js', 'autosync']), null)
})

test('tokn’s own job that runs Eaon’s tokn without ELECTRON_RUN_AS_NODE is repaired; one from npm is left alone', { skip: !posix }, () => {
  const mac = process.platform === 'darwin'
  const dir = mac ? agentsDir() : unitsDir()
  mkdirSync(dir, { recursive: true })
  const eaonTokn = '/Applications/Eaon.app/Contents/Resources/tokn-cli/dist/index.js'
  const npmTokn = '/opt/homebrew/lib/node_modules/toknhq/dist/index.js'
  const own = (program: string, script: string): string =>
    mac
      ? `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>dev.tokn.autosync</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${program}</string>\n    <string>${script}</string>\n    <string>autosync</string>\n  </array>\n</dict>\n</plist>\n`
      : `[Unit]\nDescription=tokn periodic sync\n\n[Service]\nType=oneshot\nNice=5\nExecStart=${program} ${script} autosync\n`
  const periodic = join(dir, mac ? 'dev.tokn.autosync.plist' : 'tokn-autosync.service')
  const daily = join(dir, mac ? 'dev.tokn.daily.plist' : 'tokn-daily.service')
  writeFileSync(periodic, own('/Applications/Eaon.app/Contents/MacOS/Eaon', eaonTokn))
  writeFileSync(daily, own('/opt/homebrew/bin/node', npmTokn))

  const repaired = repairToknJobs()
  assert.deepEqual(repaired, [periodic])
  const text = readFileSync(periodic, 'utf8')
  assert.ok(text.includes('ELECTRON_RUN_AS_NODE'))
  if (mac) {
    assert.equal(execFileSync('/usr/bin/plutil', ['-lint', periodic], { encoding: 'utf8' }).trim().endsWith('OK'), true, 'still a valid plist')
    reloadLaunchdJobs(repaired)
    assert.deepEqual(calls.slice(-2), [`launchctl bootout gui/${process.getuid?.()}/dev.tokn.autosync`, `launchctl bootstrap gui/${process.getuid?.()} ${periodic}`])
  } else {
    assert.match(text, /\[Service\]\nEnvironment=ELECTRON_RUN_AS_NODE=1\n/)
    assert.ok(calls.includes('systemctl --user daemon-reload'))
  }
  assert.ok(!readFileSync(daily, 'utf8').includes('ELECTRON_RUN_AS_NODE'), 'npm’s tokn needs nothing')
  assert.deepEqual(repairToknJobs(), [], 'a second pass finds nothing to do')
})

test('the development LaunchAgent: Eaon’s Node, the job script, every 15 minutes and at 23:59', { skip: process.platform !== 'darwin' }, () => {
  const text = launchdPlist(['/Apps/E & Co.app/Contents/MacOS/Eaon', jobScript], { ELECTRON_RUN_AS_NODE: '1', TOKN_CONFIG_DIR: '/x' })
  const file = join(root, 'job.plist')
  writeFileSync(file, text)
  const parsed = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' })) as Record<string, unknown>
  assert.deepEqual(parsed.ProgramArguments, ['/Apps/E & Co.app/Contents/MacOS/Eaon', jobScript])
  assert.deepEqual(parsed.EnvironmentVariables, { ELECTRON_RUN_AS_NODE: '1', TOKN_CONFIG_DIR: '/x' })
  assert.equal(parsed.StartInterval, 900)
  assert.deepEqual(parsed.StartCalendarInterval, { Hour: 23, Minute: 59 })
  assert.equal(parsed.Label, JOB_LABEL)
})

test('the bundled LaunchAgent is valid and finds the job script from Eaon’s own executable', { skip: process.platform !== 'darwin' }, () => {
  const file = join(repo, 'resources', 'mac', 'LaunchAgents', `${JOB_LABEL}.plist`)
  const parsed = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' })) as {
    Label: string
    BundleProgram: string
    ProgramArguments: string[]
    EnvironmentVariables: Record<string, string>
  }
  assert.equal(parsed.Label, JOB_LABEL)
  assert.equal(parsed.BundleProgram, 'Contents/MacOS/Eaon')
  assert.deepEqual(parsed.EnvironmentVariables, { ELECTRON_RUN_AS_NODE: '1' })
  assert.equal(parsed.ProgramArguments[1], '-e')
  // The code it runs, with process.execPath where launchd puts Eaon.
  const found: string[] = []
  const fakeRequire = Object.assign((path: string) => (path === 'path' ? { join } : (found.push(path), { run: () => {} })), {})
  new Function('require', 'process', parsed.ProgramArguments[2])(fakeRequire, { execPath: '/Applications/Eaon.app/Contents/MacOS/Eaon' })
  assert.deepEqual(found, ['/Applications/Eaon.app/Contents/Resources/tokn-job.cjs'])
})

test('systemd units: one word per argument, % doubled, and the job skipped once Eaon is gone', () => {
  const { service, timer } = systemdUnits(['/opt/Eaon 2/eaon', '/opt/Eaon 2/resources/tokn-job.cjs'], { ELECTRON_RUN_AS_NODE: '1', TOKN_CONFIG_DIR: '/home/a/100%/"t"' })
  assert.match(service, /^ExecStart="\/opt\/Eaon 2\/eaon" "\/opt\/Eaon 2\/resources\/tokn-job\.cjs"$/m)
  assert.match(service, /^Environment="ELECTRON_RUN_AS_NODE=1"$/m)
  assert.ok(service.includes('Environment="TOKN_CONFIG_DIR=/home/a/100%%/\\"t\\""'))
  assert.match(service, /^ConditionPathExists=\/opt\/Eaon 2\/eaon$/m)
  assert.match(timer, /^OnUnitActiveSec=15min$/m)
  assert.match(timer, /^OnCalendar=\*-\*-\* 23:59:00$/m)
  assert.match(timer, /^OnActiveSec=1min$/m, 'it starts once soon after it is turned on')
})

test('the Windows task: `Eaon --tokn-sync` as the person, on battery too, every 15 minutes and at 23:59', () => {
  const text = taskXml(['C:\\Users\\Ada & Co\\AppData\\Local\\Programs\\Eaon\\Eaon.exe', TOKN_SYNC_FLAG], 'PC\\Ada')
  assert.ok(text.includes('<Command>C:\\Users\\Ada &amp; Co\\AppData\\Local\\Programs\\Eaon\\Eaon.exe</Command>'))
  assert.ok(text.includes(`<Arguments>${TOKN_SYNC_FLAG}</Arguments>`))
  assert.ok(text.includes('<UserId>PC\\Ada</UserId>'))
  assert.ok(text.includes('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>'))
  assert.ok(text.includes('<Interval>PT15M</Interval>'))
  assert.ok(text.includes('<StartBoundary>2026-01-01T23:59:00</StartBoundary>'))
  assert.ok(text.includes('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'))
  // A development build passes its app folder, quoted when it has a space.
  assert.ok(taskXml(['C:\\electron.exe', 'C:\\My Eaon', TOKN_SYNC_FLAG], 'Ada').includes(`<Arguments>&quot;C:\\My Eaon&quot; ${TOKN_SYNC_FLAG}</Arguments>`))
})

test('the job goes in once tokn is linked, is written once, and comes out when the switch goes off', { skip: !posix }, async () => {
  assert.equal((await applyToknJob()).state, 'off', 'not linked yet: nothing to run')
  assert.equal(existsSync(eaonJobFile()), false)

  writeConfig(linked)
  assert.deepEqual(await applyToknJob(), { state: 'on', error: null })
  assert.ok(jobRuns())
  assert.ok(existsSync(eaonJobFile()))
  if (process.platform === 'darwin') {
    const text = readFileSync(eaonJobFile(), 'utf8')
    assert.ok(text.includes(jobScript) && text.includes(process.execPath))
    assert.ok(text.includes(`<string>${join(root, 'tokn')}</string>`), 'it reaches the same tokn config as this Eaon')
    assert.ok(calls.some((call) => call.startsWith('launchctl bootstrap')))
  } else {
    assert.ok(calls.includes('systemctl --user enable --now eaon-tokn.timer'))
  }

  // Unchanged and loaded: left alone.
  loaded = true
  calls = []
  const before = statSync(eaonJobFile()).mtimeMs
  assert.equal((await applyToknJob()).state, 'on')
  assert.equal(statSync(eaonJobFile()).mtimeMs, before)
  assert.ok(!calls.some((call) => call.includes('bootstrap') || call.includes('enable --now')), calls.join('\n'))

  store.patchSettings({ toknCli: { background: false } })
  assert.equal((await applyToknJob()).state, 'off')
  assert.equal(existsSync(eaonJobFile()), false)
  assert.ok(!jobRuns())

  // Tracking the CLIs off takes it out too.
  store.patchSettings({ toknCli: { background: true, sync: false } })
  assert.equal((await applyToknJob()).state, 'off')
  assert.equal(existsSync(eaonJobFile()), false)
})

test('Eaon steps back for tokn’s own schedule and for `tokn autosync off`, until the switch is turned on again', { skip: !posix }, async () => {
  writeConfig({ ...linked, autosync: { enabled: false, intervalMinutes: 120 } })
  assert.equal((await applyToknJob()).state, 'paused')
  assert.equal(existsSync(eaonJobFile()), false)

  resumeToknAutosync()
  const saved = JSON.parse(readFileSync(config(), 'utf8')) as typeof linked & { autosync: unknown }
  assert.deepEqual(saved.autosync, { enabled: true, intervalMinutes: 120 }, 'its interval is kept')
  assert.equal(saved.token, 'tok_secret', 'and the rest of its config')
  assert.equal(statSync(config()).mode & 0o777, 0o600)
  assert.equal((await applyToknJob()).state, 'on')

  // `tokn autosync on` with tokn from npm: its own job does it.
  const own = process.platform === 'darwin' ? join(agentsDir(), 'dev.tokn.autosync.plist') : join(unitsDir(), 'tokn-autosync.service')
  mkdirSync(join(own, '..'), { recursive: true })
  writeFileSync(own, process.platform === 'darwin' ? '<plist><dict><string>/opt/homebrew/bin/node</string></dict></plist>' : '[Service]\nExecStart=/usr/bin/node /usr/lib/node_modules/toknhq/dist/index.js autosync\n')
  assert.equal((await applyToknJob()).state, 'tokn')
  assert.equal(existsSync(eaonJobFile()), false)
  assert.ok(existsSync(own), 'tokn’s own job is never Eaon’s to remove')
})

test('the Linux AppImage can’t keep a job, and EAON_TOKN_JOB=off leaves everything alone', { skip: !posix }, async () => {
  writeConfig(linked)
  process.env.EAON_TOKN_JOB = 'off'
  assert.equal((await applyToknJob()).state, 'off')
  assert.equal(existsSync(eaonJobFile()), false)
  assert.deepEqual(calls, [])
  delete process.env.EAON_TOKN_JOB
  if (process.platform !== 'linux') return
  process.env.APPIMAGE = '/home/a/Eaon.AppImage'
  assert.equal((await applyToknJob()).state, 'unavailable')
  delete process.env.APPIMAGE
})
