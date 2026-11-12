import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { remoteCwd, type SshHost } from '../src/shared/adeRemote'
import { posixNormalize, remoteInside, remoteShown, remoteSpot } from '../src/shared/remotePath'
import { toolsFor, type ToolContext } from '../src/main/agent/tools'
import { remoteBackground, remoteList, remoteRead, remoteWrite, setHostFinder, sshCallArgv, openRemote } from '../src/main/remoteWork'
import { store } from '../src/main/store'
import type { Settings, StreamRequest } from '@shared/types'
import '../src/main/localTools'

/**
 * A project on another machine (main/remoteTools.ts, main/remoteWork.ts). The
 * "ssh" here is a stand-in that runs the command line it is given on this
 * computer (EAON_SSH_BIN), so the real scripts run for real against a temp
 * folder, spawn and quoting included; only the network is missing.
 */

const scratch = mkdtempSync(join(tmpdir(), 'eaon-remote-'))
test.after(() => rmSync(scratch, { recursive: true, force: true }))

const standIn = join(scratch, 'fake-ssh')
writeFileSync(standIn, '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n')
chmodSync(standIn, 0o755)
process.env.EAON_SSH_BIN = standIn

const host: SshHost = { id: 'cfg:box', label: 'box', hostname: 'box', user: null, port: null, identityFile: null, source: 'config', alias: 'box' }
setHostFinder(async (id) => (id === host.id ? host : null))
test.after(() => setHostFinder(null))

const project = (): string => {
  const dir = realpathSync(mkdtempSync(join(scratch, 'proj-')))
  return dir
}

function tools(dir: string, patch: (s: Settings) => void = () => undefined) {
  const settings = structuredClone(store.getSettings())
  patch(settings)
  const cwd = remoteCwd(host.id, dir)
  const request = { mode: 'work', work: { swarm: false, plan: false }, goal: null } as unknown as StreamRequest
  const list = toolsFor({ mode: 'work', cwd, depth: 0, readOnly: false, settings, request })
  const controller = new AbortController()
  const ctx = { cwd, settings, signal: controller.signal, progress: () => {} } as unknown as ToolContext
  return { get: (name: string) => list.find((t) => t.name === name)!, names: list.map((t) => t.name), ctx, controller, cwd }
}

test('a remote path is judged by its words: inside the project, or not', () => {
  const cwd = remoteCwd('cfg:box', '/srv/app')
  assert.equal(posixNormalize('/a/./b//c/../d'), '/a/b/d')
  assert.equal(posixNormalize('/../..'), '/')
  assert.deepEqual(remoteSpot(cwd, 'src/a.ts'), { hostId: 'cfg:box', root: '/srv/app', path: '/srv/app/src/a.ts', inside: true })
  assert.equal(remoteSpot(cwd, '')?.path, '/srv/app')
  assert.equal(remoteSpot(cwd, '/srv/app/x')?.inside, true)
  assert.equal(remoteSpot(cwd, '/srv/app2/x')?.inside, false)
  assert.equal(remoteSpot(cwd, '../x')?.inside, false)
  assert.equal(remoteSpot(cwd, 'a/../../x')?.inside, false)
  assert.equal(remoteSpot(cwd, '~/x')?.inside, false)
  assert.equal(remoteSpot('/local/folder', 'x'), null)
  assert.equal(remoteShown('/srv/app', '/srv/app/src/a.ts'), 'src/a.ts')
  assert.equal(remoteInside(cwd, remoteCwd('cfg:box', '/srv/app/sub')), true)
  assert.equal(remoteInside(cwd, remoteCwd('cfg:other', '/srv/app/sub')), false)
  assert.equal(remoteInside(cwd, remoteCwd('cfg:box', '/srv/app/../etc')), false)
})

test('background calls share one connection where the system allows', () => {
  const args = sshCallArgv(host, '/tmp/eaon-ssh-1')
  assert.deepEqual(args.slice(0, 6), ['-o', 'ControlMaster=auto', '-o', 'ControlPath=/tmp/eaon-ssh-1/%C', '-o', 'ControlPersist=120'])
  assert.ok(args.includes('BatchMode=yes'))
  assert.equal(args.at(-1), 'box')
  assert.ok(!sshCallArgv(host, null).includes('ControlMaster=auto'))
})

test('a project on another machine gets the file and shell tools, not the code index', () => {
  const dir = project()
  const { names } = tools(dir)
  for (const name of ['list_dir', 'read_file', 'grep', 'find_file', 'edit_file', 'write_file', 'delete_file', 'move_file', 'run_command']) assert.ok(names.includes(name), name)
  assert.ok(!names.includes('codebase_search') && !names.includes('find_symbol'))
})

test('write, read, edit, list, search and find work on the host, whatever the file is called', async () => {
  const dir = project()
  const { get, ctx } = tools(dir)
  const odd = `it's a "weird" $(touch pwned) name; x.txt`
  const wrote = await get('write_file').run({ path: `src/${odd}`, content: 'alpha\nbeta\ngamma\n' }, ctx)
  assert.match(typeof wrote === 'string' ? wrote : wrote.text, /Wrote 3 lines/)
  assert.equal(readFileSync(join(dir, 'src', odd), 'utf8'), 'alpha\nbeta\ngamma\n')
  assert.ok(!existsSync(join(dir, 'pwned')) && !existsSync(join(dir, 'src', 'pwned')), 'a file name never runs')

  assert.equal(await get('read_file').run({ path: `src/${odd}`, start_line: 2, end_line: 2 }, ctx), '2\tbeta\n…(1 more lines; read from 3 to continue)')
  assert.match(String(await get('edit_file').run({ path: `src/${odd}`, old_text: 'beta', new_text: 'BETA' }, ctx)), /Edited/)
  assert.equal(readFileSync(join(dir, 'src', odd), 'utf8'), 'alpha\nBETA\ngamma\n')
  await assert.rejects(get('edit_file').run({ path: `src/${odd}`, old_text: 'nope', new_text: 'x' }, ctx), /not found/)

  writeFileSync(join(dir, 'big.bin'), Buffer.from([1, 2, 0, 3]))
  assert.match(String(await get('read_file').run({ path: 'big.bin' }, ctx)), /binary file/)

  const listing = String(await get('list_dir').run({}, ctx))
  assert.match(listing, /src\//)
  assert.match(listing, /big\.bin 4B/)
  assert.equal(await get('read_file').run({ path: 'src' }, ctx), `${odd} 17B`)

  mkdirSync(join(dir, 'node_modules'))
  writeFileSync(join(dir, 'node_modules', 'dep.js'), 'BETA in a dependency')
  const found = String(await get('grep').run({ pattern: 'beta' }, ctx))
  assert.match(found, /src\/.*:2: BETA/)
  assert.ok(!found.includes('node_modules'), 'dependencies are skipped')
  assert.match(String(await get('grep').run({ pattern: 'beta', case_sensitive: true }, ctx)), /No matches/)
  assert.match(String(await get('grep').run({ pattern: 'BETA', include: '*.ts' }, ctx)), /No matches/)
  assert.match(String(await get('find_file').run({ query: 'weird' }, ctx)), /weird/)
})

test('the project’s folder is a boundary: other paths, .. and links out are refused, nothing is read or written', async () => {
  const dir = project()
  const outside = project()
  writeFileSync(join(outside, 'secret.txt'), 'top secret')
  symlinkSync(outside, join(dir, 'linked'))
  symlinkSync(join(outside, 'secret.txt'), join(dir, 'peek.txt'))
  writeFileSync(join(dir, 'ok.txt'), 'fine')
  const { get, ctx } = tools(dir)

  await assert.rejects(get('read_file').run({ path: join(outside, 'secret.txt') }, ctx), /outside the project/)
  await assert.rejects(get('read_file').run({ path: '../' + outside.split('/').pop() + '/secret.txt' }, ctx), /outside the project/)
  await assert.rejects(get('read_file').run({ path: '~/.ssh/id_rsa' }, ctx), /outside the project/)
  // Inside by its words, outside by where it leads.
  await assert.rejects(get('read_file').run({ path: 'peek.txt' }, ctx), /outside the project/)
  await assert.rejects(get('read_file').run({ path: 'linked/secret.txt' }, ctx), /outside the project/)
  await assert.rejects(get('write_file').run({ path: 'linked/new.txt', content: 'x' }, ctx), /outside the project/)
  await assert.rejects(get('write_file').run({ path: 'peek.txt', content: 'overwritten' }, ctx), /outside the project/)
  await assert.rejects(get('list_dir').run({ path: 'linked' }, ctx), /outside the project/)
  await assert.rejects(get('delete_file').run({ path: 'linked' }, ctx), /outside the project|outside/)
  await assert.rejects(get('move_file').run({ from: 'ok.txt', to: '../moved.txt' }, ctx), /outside the project/)
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'top secret')
  assert.ok(!existsSync(join(outside, 'new.txt')))
  assert.equal(readFileSync(join(dir, 'ok.txt'), 'utf8'), 'fine')
})

test('move and delete work inside the folder; delete goes to the host’s trash, never the project itself', async () => {
  const dir = project()
  const fakeHome = project()
  const home = process.env.HOME
  process.env.HOME = fakeHome
  try {
    writeFileSync(join(dir, 'a.txt'), 'a')
    writeFileSync(join(dir, 'b.txt'), 'b')
    const { get, ctx } = tools(dir)
    await get('move_file').run({ from: 'a.txt', to: 'deep/er/a2.txt' }, ctx)
    assert.equal(readFileSync(join(dir, 'deep', 'er', 'a2.txt'), 'utf8'), 'a')
    await assert.rejects(get('move_file').run({ from: 'b.txt', to: 'deep/er/a2.txt' }, ctx), /already exists/)
    const said = String(await get('delete_file').run({ path: 'b.txt' }, ctx))
    assert.match(said, /\.eaon-trash/)
    assert.ok(!existsSync(join(dir, 'b.txt')))
    const trash = join(fakeHome, '.eaon-trash')
    assert.equal(readdirSync(trash).length, 1)
    await assert.rejects(get('delete_file').run({ path: '.' }, ctx), /project’s own folder/)
    assert.ok(existsSync(dir))
  } finally {
    process.env.HOME = home
  }
})

test('run_command runs on the host in the project folder, with its exit code and output', async () => {
  const dir = project()
  writeFileSync(join(dir, 'hello.txt'), 'hi')
  const { get, ctx } = tools(dir)
  const ok = String(await get('run_command').run({ command: 'pwd; cat hello.txt; echo "to stderr" >&2; exit 3' }, ctx))
  assert.match(ok, /^exit code 3\n/)
  assert.ok(ok.includes(dir) && ok.includes('hi') && ok.includes('to stderr'))
  const quiet = String(await get('run_command').run({ command: 'true' }, ctx))
  assert.equal(quiet, 'exit code 0\n(no output)')
  await assert.rejects(async () => get('run_command').run({ command: '   ' }, ctx), /empty/)
})

test('stopping the turn stops the command on the way', async () => {
  const dir = project()
  const { get, ctx, controller } = tools(dir)
  const started = Date.now()
  const pending = get('run_command').run({ command: 'sleep 20' }, ctx)
  setTimeout(() => controller.abort(), 300)
  await assert.rejects(pending, /aborted/)
  assert.ok(Date.now() - started < 8000)
})

test('a server started in the background reports its pid and log, and keeps running', async () => {
  const dir = project()
  const fakeHome = project()
  const home = process.env.HOME
  process.env.HOME = fakeHome
  try {
    const started = await remoteBackground(await openRemote(remoteCwd(host.id, dir)), 'echo up; sleep 30')
    assert.equal(started.alive, true)
    assert.ok(started.pid > 0 && started.log.startsWith(fakeHome))
    assert.match(started.early, /up/)
    process.kill(started.pid, 'SIGTERM')
  } finally {
    process.env.HOME = home
  }
})

test('a file bigger than what is read is reported by its real size', async () => {
  const dir = project()
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(5000))
  const proj = await openRemote(remoteCwd(host.id, dir))
  const file = await remoteRead(proj, join(dir, 'big.txt'), 100)
  assert.equal(file.size, 5000)
  assert.equal(file.bytes.length, 100)
  const { entries, total } = await remoteList(proj, dir, 1)
  assert.equal(entries.length, 1)
  assert.equal(total, 1)
  assert.ok((await remoteWrite(proj, join(dir, 'w.txt'), Buffer.from([0, 255, 1, 2]))) > 0)
  assert.deepEqual([...readFileSync(join(dir, 'w.txt'))], [0, 255, 1, 2])
})

test('the person’s command lists still decide a remote command', () => {
  const dir = project()
  const { get, ctx } = tools(dir, (s) => {
    s.general.commandRules = { allow: ['npm test'], deny: ['rm *'] }
  })
  const run = get('run_command')
  assert.match(run.denied!({ command: 'echo hi && rm -rf build' }, ctx) ?? '', /denylist/)
  assert.equal(run.denied!({ command: 'ls' }, ctx), null)
  assert.equal(run.allowed!({ command: 'npm test' }, ctx), true)
  assert.equal(run.allowed!({ command: 'npm install' }, ctx), false)
  // Writing somewhere the project isn't still asks, as it does on this computer.
  assert.equal(run.risky!({ command: 'echo x > /etc/motd' }, ctx), true)
  assert.equal(get('edit_file').risky!({ path: '../x' }, ctx), true)
  assert.equal(get('edit_file').risky!({ path: 'x' }, ctx), false)
})

test('a host that has gone from the list is said so, not guessed at', async () => {
  setHostFinder(async () => null)
  try {
    await assert.rejects(openRemote(remoteCwd('cfg:gone', '/srv')), /isn’t in ~\/.ssh\/config/)
  } finally {
    setHostFinder(async (id) => (id === host.id ? host : null))
  }
})

test('a host without ripgrep or git is searched with plain grep, same answers', async () => {
  const dir = project()
  mkdirSync(join(dir, 'node_modules'))
  writeFileSync(join(dir, 'node_modules', 'dep.js'), 'needle in a dependency')
  writeFileSync(join(dir, 'a.txt'), 'one\nNeedle here 42\n')
  const { get, ctx } = tools(dir)
  const path = process.env.PATH
  process.env.PATH = '/usr/bin:/bin'
  try {
    const found = String(await get('grep').run({ pattern: 'needle \\w+ \\d+' }, ctx))
    assert.equal(found, 'a.txt:2: Needle here 42')
    assert.match(String(await get('find_file').run({ query: 'a.txt' }, ctx)), /^a\.txt/)
  } finally {
    process.env.PATH = path
  }
})
