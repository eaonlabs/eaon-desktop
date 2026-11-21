import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SshHost } from '../src/shared/adeRemote'
import { environmentSummary, environmentsOf, exeHost, exeHostId, isVmName, slugOf, vmNameFor, type CloudEnvironment } from '../src/shared/environments'
import { accountProblem, newVmArgs, vmsFrom, whoamiFrom } from '../src/main/features/environments/exe'
import { bringBackBranch } from '../src/main/features/environments/bringBack'
import { remotePaneCommand, sshArgv, tmuxName } from '../src/main/features/ade/ssh'
import { remoteLine } from '../src/main/engines/remote'
import { forwarded } from '../src/main/engines/claude'
import { KeptProcess, runState, stopRun } from '../src/main/engines/kept'

/**
 * Cloud environments (shared/environments.ts): exe.dev's answers read, the
 * flags sent to make a VM, names, the tmux session a pane on another machine
 * lives in, and the keeper that keeps an agent running there while this
 * computer is away (engines/kept.ts). The keeper runs for real here: the
 * "ssh" is a stand-in that runs the remote command line on this computer.
 */

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'eaon-env-')))
test.after(() => rmSync(scratch, { recursive: true, force: true }))

/* ------------------------------------------------------------- exe.dev */

const LISTING = JSON.stringify({
  vms: [
    {
      vm_name: 'eaon-app-x2k4p',
      status: 'running',
      ssh_host: 'eaon-app-x2k4p.exe.xyz',
      ssh_dest: 'eaon-app-x2k4p.exe.xyz',
      allocated_cpus: 2,
      memory_capacity_bytes: 8589934592,
      disk_capacity_bytes: 26843545600,
      image: 'boldsoftware/exeuntu',
      https_url: 'https://eaon-app-x2k4p.exe.xyz',
      created_at: '2026-11-21T22:06:21Z',
      tags: ['eaon']
    },
    { vm_name: 'mine', status: 'paused' },
    { status: 'running' }
  ]
})

test('exe.dev’s VM listing is read into what Eaon shows and dials', () => {
  const vms = vmsFrom(LISTING)
  assert.equal(vms.length, 2, 'an entry without a name is not a VM')
  assert.deepEqual(vms[0], {
    name: 'eaon-app-x2k4p',
    status: 'running',
    host: 'eaon-app-x2k4p.exe.xyz',
    dest: 'eaon-app-x2k4p.exe.xyz',
    user: null,
    cpus: 2,
    memoryGb: 8,
    diskGb: 25,
    image: 'boldsoftware/exeuntu',
    httpsUrl: 'https://eaon-app-x2k4p.exe.xyz',
    createdAt: '2026-11-21T22:06:21Z',
    tags: ['eaon']
  })
  assert.equal(vms[1].host, 'mine.exe.xyz', 'a VM with no host given is reached at its name')
  assert.deepEqual(vmsFrom('not json'), [])
  assert.deepEqual(vmsFrom(`Welcome!\n${LISTING}`).length, 2, 'a banner before the JSON is skipped')
})

test('who the key is on exe.dev, and why it can’t be used', () => {
  assert.deepEqual(whoamiFrom('Email Address: me@example.com\nRegion: lax (Los Angeles, USA)\nSSH Keys:\n'), { email: 'me@example.com', region: 'lax (Los Angeles, USA)' })
  const said = (stdout: string, stderr = '') => accountProblem({ ok: false, code: 1, stdout, stderr })
  assert.equal(said('Please complete registration by running: ssh exe.dev').reason, 'not-registered')
  assert.equal(said('', 'me@exe.dev: Permission denied (publickey).').reason, 'not-registered')
  assert.equal(said('{"error":"Choose a plan to start creating VMs.\\nGet started at https://exe.dev/billing/update"}').reason, 'no-plan')
  assert.equal(said('', 'ssh: Could not resolve hostname exe.dev').reason, 'unreachable')
  assert.equal(accountProblem({ ok: false, code: null, stdout: '', stderr: 'ssh isn’t installed on this computer.' }).reason, 'no-ssh')
})

test('the flags for a new VM: checked values only, the setup script on stdin', () => {
  assert.deepEqual(newVmArgs({ name: 'eaon-app-x2k4p' }), ['new', '--name=eaon-app-x2k4p', '--json', '--no-email', '--tag=eaon'])
  assert.deepEqual(newVmArgs({ name: 'b', cpu: 4, memory: 16, disk: 50, image: 'ubuntu:24.04', setup: 'apt-get install -y nodejs' }).slice(5), [
    '--cpu=4',
    '--memory=16GB',
    '--disk=50GB',
    '--image=ubuntu:24.04',
    '--setup-script=/dev/stdin'
  ])
  assert.throws(() => newVmArgs({ name: 'Bad Name' }), /isn’t a name/)
  assert.throws(() => newVmArgs({ name: 'ok', cpu: 0 }), /whole number/)
  assert.throws(() => newVmArgs({ name: 'ok', image: 'x --cpu=99' }), /image/)
  assert.throws(() => newVmArgs({ name: '--json' }), /isn’t a name/)
})

/* ----------------------------------------------------------------- names */

test('names: VMs, slugs, branches brought back, and an exe.dev VM as an SSH host', () => {
  const name = vmNameFor('My App!', () => 0)
  assert.equal(name, 'eaon-my-app-aaaaa')
  assert.ok(isVmName(name))
  assert.ok(!isVmName('-x') && !isVmName('UPPER') && !isVmName('a.b'))
  assert.equal(slugOf('  Fix the CI checks, now!  '), 'fix-the-ci-checks-now')
  assert.equal(slugOf('???'), 'session')
  assert.equal(bringBackBranch('Look around and leave a file'), 'eaon/look-around-and-leave-a-file')
  assert.equal(bringBackBranch('..weird..//name..'), 'eaon/weird-name')
  const host = exeHost(exeHostId('eaon-app-x2k4p'))
  assert.equal(host?.hostname, 'eaon-app-x2k4p.exe.xyz')
  assert.equal(host?.trustNew, true)
  assert.ok(sshArgv(host!, { interactive: false }).includes('StrictHostKeyChecking=accept-new'), 'a VM made a moment ago has its key taken the first time')
  assert.equal(exeHost('exe:../../etc'), null)
  assert.equal(exeHost('cfg:box'), null)
})

test('environments: the broken ones left out, and each said in a line', () => {
  const list = environmentsOf([
    { id: 'a', name: 'exe.dev', kind: 'exe', exe: { vm: null, cpu: 4, memory: 16 }, createdAt: 1 },
    { id: 'b', name: 'Box', kind: 'ssh', ssh: { hostId: 'cfg:box', folder: '~/eaon' }, createdAt: 1 },
    { id: 'c', name: 'Broken', kind: 'ssh', createdAt: 1 } as CloudEnvironment
  ])
  assert.deepEqual(list.map((e) => e.id), ['a', 'b'])
  assert.equal(environmentSummary(list[0]), 'A new exe.dev VM for each session (4 CPU, 16 GB)')
  assert.equal(environmentSummary(list[1]), 'box · ~/eaon')
  assert.equal(environmentSummary({ ...list[0], exe: { vm: 'mine' } }), 'Each session in ~/eaon on mine')
})

/* ------------------------------------------------------- panes and agents */

test('a pane on another machine lives in a tmux session there, its agent started inside it', () => {
  assert.equal(tmuxName('pane:1/2'), 'eaon-pane-1-2')
  const line = remotePaneCommand('/home/me/app', 'p1', 'claude --resume x')
  assert.match(line, /^cd '\/home\/me\/app' 2>\/dev\/null; if command -v tmux/)
  assert.ok(line.includes(`tmux new-session -A -s 'eaon-p1' -c '/home/me/app' 'claude --resume x; exec "$SHELL" -l' ';' set-option status off`))
  // Without tmux there, the shell and the agent as before.
  assert.ok(line.endsWith(`exec "$SHELL" -lc 'claude --resume x; exec "$SHELL" -l'`))
  assert.ok(remotePaneCommand('/a', 'p', null).endsWith('exec "$SHELL" -l'))
})

test('an agent there starts in the folder, through a login shell, every word as it was', () => {
  const dir = join(scratch, "it's here")
  mkdirSync(dir, { recursive: true })
  const line = remoteLine(dir, 'sh', ['-c', 'printf "%s|%s|%s" "$A" "$(pwd)" "$0"', 'zero $x'], { A: "it's $HOME", 'BAD NAME': 'x' })
  const ran = spawnSync('/bin/sh', ['-c', line], { env: { PATH: process.env.PATH, SHELL: '/bin/sh', HOME: scratch }, encoding: 'utf8' })
  assert.equal(ran.stdout, `it's $HOME|${dir}|zero $x`)
})

test('Claude Code on another machine gets its own settings, never this computer’s keys or PATH', () => {
  const env = forwarded({ PATH: '/usr/bin', HOME: '/Users/me', ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_CLIENT_APP: 'eaon/1', CLAUDE_CONFIG_DIR: '/x', MAX_THINKING_TOKENS: '9' })
  assert.deepEqual(env, { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_CLIENT_APP: 'eaon/1', MAX_THINKING_TOKENS: '9' })
})

/* -------------------------------------------------------------- the keeper */

// The stand-in ssh: the last argument is the remote command line, run here with stdin passed through.
const fakeSsh = join(scratch, 'fake-ssh')
writeFileSync(fakeSsh, '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n')
chmodSync(fakeSsh, 0o755)
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
const project = join(scratch, 'project')
mkdirSync(project, { recursive: true })

const host: SshHost = { id: 'cfg:box', label: 'box', hostname: 'box', user: null, port: null, identityFile: null, source: 'config', alias: 'box' }
const place = { host, root: project, where: 'box' }

/** Waits for `stream` to have said `text`, collecting what it says. */
function said(proc: KeptProcess): { text: () => string; until: (pattern: RegExp, ms?: number) => Promise<void> } {
  let all = ''
  proc.stdout.on('data', (chunk: Buffer) => (all += chunk.toString('utf8')))
  return {
    text: () => all,
    until: async (pattern, ms = 10_000) => {
      const end = Date.now() + ms
      while (!pattern.test(all)) {
        if (Date.now() > end) assert.fail(`never said ${pattern}; said ${JSON.stringify(all)}`)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  }
}

const exited = (proc: KeptProcess): Promise<number | null> => new Promise((resolve) => proc.once('exit', (code: number | null) => resolve(code)))

test('the keeper: an agent there gets what is sent, its output comes back, and a dropped connection loses nothing', { timeout: 60_000 }, async () => {
  const before = { ssh: process.env.EAON_SSH_BIN, home: process.env.HOME, shell: process.env.SHELL }
  process.env.EAON_SSH_BIN = fakeSsh
  process.env.HOME = home
  process.env.SHELL = '/bin/sh'
  try {
    const proc = new KeptProcess({ place, program: 'sh', args: ['-c', 'echo "in $(pwd)"; cat'], endInput: true })
    const out = said(proc)
    await out.until(new RegExp(`in ${project}`))
    proc.stdin.write('hello\n')
    await out.until(/hello\n/)

    // The connection drops (the laptop shut): the run goes on, and the reader picks up where it was.
    ;(proc as unknown as { reader: { kill: () => void } }).reader.kill()
    proc.stdin.write('again\n')
    await out.until(/again\n/)
    assert.equal(out.text().match(/hello/g)?.length, 1, 'nothing read twice after reconnecting')

    // Its input ends: the agent ends there, and so does the process here.
    const done = exited(proc)
    proc.stdin.end()
    assert.equal(await done, 0)

    // Let go of (Eaon quitting, or a server between turns): it goes on there, and is picked up again.
    const server = new KeptProcess({ place, program: 'cat', args: [] })
    const first = said(server)
    server.stdin.write('one\n')
    await first.until(/one\n/)
    server.release()
    const state = await runState(host, server.dir)
    assert.equal(state?.state, 'running', 'still running there after this side let go')
    const again = new KeptProcess({ place, program: 'cat', args: [], attach: { dir: server.dir, from: state?.state === 'running' ? state.size : 0 } })
    const second = said(again)
    again.stdin.write('two\n')
    await second.until(/two\n/)
    assert.equal(second.text(), 'two\n', 'only what it says from then on')

    // Ended on purpose: gone there too.
    await stopRun(host, server.dir)
    const end = Date.now() + 10_000
    let last = await runState(host, server.dir)
    while (last?.state !== 'done' && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      last = await runState(host, server.dir)
    }
    assert.deepEqual(last, { state: 'done', code: 143 })

    // An agent that isn't installed there says so, and ends.
    const missing = new KeptProcess({ place, program: 'no-such-agent', args: [] })
    let err = ''
    missing.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')))
    assert.equal(await exited(missing), 127)
    assert.match(err, /no-such-agent/)
  } finally {
    process.env.EAON_SSH_BIN = before.ssh
    process.env.HOME = before.home
    process.env.SHELL = before.shell
  }
})
