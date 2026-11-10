import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import '../src/main/agent/sources'
import { seatbeltProfile, normalizeSandbox, quote, SECRET_DIRS } from '../src/shared/sandbox'
import { sandboxAvailable, sandboxedSpawn, SANDBOX_UNAVAILABLE } from '../src/main/sandbox'
import { toolsFor, type ToolContext } from '../src/main/agent/tools'
import { defaultSettings } from '../src/main/store'
import type { Settings, StreamRequest } from '../src/shared/types'

/**
 * Sandboxed command execution: the profile as text, then, where the sandbox
 * exists (macOS), commands really run inside it, directly and through the
 * agent's run_command tool.
 */

const mac = sandboxAvailable()
let root = ''
let home = ''
let work = ''
const priorHome = process.env.HOME

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.sandbox-test-')))
  home = path.join(root, 'home')
  work = path.join(home, 'project')
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
  fs.mkdirSync(work, { recursive: true })
  fs.writeFileSync(path.join(home, '.ssh', 'id_test'), 'PRIVATE KEY')
  fs.writeFileSync(path.join(home, 'notes.txt'), 'readable')
  process.env.HOME = home
})
after(() => {
  process.env.HOME = priorHome
  fs.rmSync(root, { recursive: true, force: true })
})

const on = (network = false): Settings => ({ ...defaultSettings, general: { ...defaultSettings.general, sandbox: { enabled: true, network } } })

test('the setting is read as a plain on or off, and quoting keeps a path from ending its own string', () => {
  assert.deepEqual(normalizeSandbox(undefined), { enabled: false, network: false })
  assert.deepEqual(normalizeSandbox({ enabled: 'yes', network: 1 }), { enabled: false, network: false })
  assert.deepEqual(normalizeSandbox({ enabled: true, network: true }), { enabled: true, network: true })
  assert.equal(quote('/a/b "c"\\d'), '"/a/b \\"c\\"\\\\d"')
})

test('the profile lets the work folder be written, keeps the keys unreadable, and says what the network may do', () => {
  const p = seatbeltProfile({ cwd: '/Users/me/proj', home: '/Users/me', tmp: ['/private/tmp'], writable: ['/Users/me/repo/.git'], network: false })
  assert.match(p, /^\(version 1\)\n\(deny default\)/)
  assert.match(p, /\(allow file-write\* \(subpath "\/Users\/me\/proj"\) \(subpath "\/private\/tmp"\) \(subpath "\/Users\/me\/repo\/\.git"\) \(subpath "\/Users\/me\/\.npm"\)/)
  for (const d of SECRET_DIRS) assert.ok(p.includes(`(deny file-read* (subpath "/Users/me/${d}"))`), d)
  assert.match(p, /\(allow network-outbound \(remote ip "localhost:\*"\)\)/)
  assert.doesNotMatch(p, /network\* \(local ip/, 'that form lets every connection out')
  assert.doesNotMatch(p, /\(allow network\*\)\n/, 'no blanket network without the setting')
  assert.doesNotMatch(p, /\(deny network/, 'a deny after the loopback rules would cancel them')
  assert.match(seatbeltProfile({ cwd: '/p', home: '/h', tmp: [], network: true }), /\(allow network\*\)\n$/)
  // The secrets are denied after the broad read, so they win.
  assert.ok(p.indexOf('(allow file-read*)') < p.indexOf('(deny file-read* (subpath "/Users/me/.ssh"))'))
  // No place outside the list is writable, and the home folder itself isn't.
  assert.doesNotMatch(p, /subpath "\/Users\/me"\)/)
})

test('off does nothing; on elsewhere than macOS refuses rather than run unprotected', async () => {
  assert.equal(await sandboxedSpawn('ls', work, '/bin/bash', defaultSettings), null)
  assert.equal(sandboxAvailable('linux'), false)
  assert.equal(sandboxAvailable('win32'), false)
  if (!mac) await assert.rejects(sandboxedSpawn('ls', work, '/bin/bash', on()), (e: Error) => e.message === SANDBOX_UNAVAILABLE)
})

test('a command in the sandbox writes in the work folder and not beside it, and cannot read the keys', { skip: !mac }, async () => {
  const run = async (command: string, network = false): Promise<{ code: number | null; out: string }> => {
    const box = (await sandboxedSpawn(command, work, '/bin/bash', on(network)))!
    const res = spawnSync(box.file, box.args, { cwd: work, encoding: 'utf8', timeout: 20_000, env: { ...process.env, HOME: home } })
    return { code: res.status, out: `${res.stdout}${res.stderr}` }
  }
  const inside = await run('echo hi > inside.txt && cat inside.txt')
  assert.equal(inside.code, 0, inside.out)
  assert.equal(fs.readFileSync(path.join(work, 'inside.txt'), 'utf8').trim(), 'hi')

  const outside = await run(`echo no > ${JSON.stringify(path.join(home, 'outside.txt'))}`)
  assert.notEqual(outside.code, 0)
  assert.match(outside.out, /Operation not permitted/)
  assert.equal(fs.existsSync(path.join(home, 'outside.txt')), false)
  assert.equal((await run(`rm ${JSON.stringify(path.join(home, 'notes.txt'))}`)).code !== 0, true, 'nor delete')
  assert.equal(fs.existsSync(path.join(home, 'notes.txt')), true)

  assert.equal((await run(`cat ${JSON.stringify(path.join(home, 'notes.txt'))}`)).out.trim(), 'readable', 'reading the rest of the disk works')
  const key = await run(`cat ${JSON.stringify(path.join(home, '.ssh', 'id_test'))}`)
  assert.notEqual(key.code, 0)
  assert.doesNotMatch(key.out, /PRIVATE KEY/)

  const temp = await run('echo t > "$(mktemp)" && echo temp-ok')
  assert.match(temp.out, /temp-ok/, 'temp files still work')
  const tools = await run('git --version && node --version')
  assert.equal(tools.code, 0, tools.out)
})

test('this computer’s own servers can be reached from the sandbox, with the internet off', { skip: !mac }, async () => {
  const server = http.createServer((_req, res) => res.end('hello from loopback'))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  try {
    const box = (await sandboxedSpawn(`curl -s -m 5 http://127.0.0.1:${port}/`, work, '/bin/bash', on(false)))!
    // spawnSync would block the server's own event loop: ask asynchronously.
    const { spawn } = await import('node:child_process')
    const out = await new Promise<string>((resolve) => {
      const child = spawn(box.file, box.args, { cwd: work, env: { ...process.env, HOME: home } })
      let text = ''
      child.stdout.on('data', (d) => (text += d))
      child.on('close', () => resolve(text))
    })
    assert.equal(out, 'hello from loopback')
  } finally {
    server.close()
  }
})

test('run_command goes through the sandbox when it is on, and says why a write failed', { skip: !mac }, async () => {
  const request = { chatId: 'sb', messageId: 'm', providerId: 'x', modelId: 'x', effort: 'medium', mode: 'work', history: [], summary: null, projectInstructions: '', cwd: work, work: { swarm: false, plan: false }, goal: null } as unknown as StreamRequest
  const settings = on()
  const tool = toolsFor({ mode: 'work', cwd: work, depth: 0, readOnly: false, settings, request }).find((t) => t.name === 'run_command')!
  const ctx = { request, turn: { notes: [] }, cwd: work, signal: new AbortController().signal, emit: () => {}, toolId: 't', depth: 0, readOnly: false, settings, progress: () => {}, confirm: async () => false } as unknown as ToolContext
  const result = await tool.run({ command: `echo ok > made.txt; echo bad > ${JSON.stringify(path.join(home, 'escape.txt'))}; cat made.txt` }, ctx)
  const text = typeof result === 'string' ? result : result.text
  assert.match(text, /Operation not permitted/)
  assert.match(text, /ok/)
  assert.equal(fs.existsSync(path.join(home, 'escape.txt')), false)
  // The same command with the sandbox off writes where it likes.
  const off = { ...ctx, settings: defaultSettings } as ToolContext
  await tool.run({ command: `echo bad > ${JSON.stringify(path.join(home, 'escape.txt'))}` }, off)
  assert.equal(fs.existsSync(path.join(home, 'escape.txt')), true)
})

test('the internet is cut off in the sandbox unless the setting lets it through (checked wherever this computer has any)', { skip: !mac, timeout: 60_000 }, async () => {
  const probe = 'curl -s -m 6 -o /dev/null -w "%{http_code}" https://example.com'
  const direct = spawnSync('/bin/bash', ['-c', probe], { encoding: 'utf8', timeout: 20_000 })
  const reachable = direct.stdout.trim() === '200'
  const through = async (network: boolean): Promise<string> => {
    const box = (await sandboxedSpawn(probe, work, '/bin/bash', on(network)))!
    return spawnSync(box.file, box.args, { cwd: work, encoding: 'utf8', timeout: 20_000, env: { ...process.env, HOME: home } }).stdout.trim()
  }
  assert.notEqual(await through(false), '200', 'off: the page does not load')
  if (reachable) assert.equal(await through(true), '200', 'on: it does')
})

test('a server started inside the sandbox can be reached from inside it, the way a dev server and its tests are', { skip: !mac, timeout: 30_000 }, async () => {
  const script = `const http=require('http');const s=http.createServer((q,r)=>r.end('served'));s.listen(0,'127.0.0.1',()=>{http.get({host:'127.0.0.1',port:s.address().port},(r)=>{let t='';r.on('data',d=>t+=d);r.on('end',()=>{console.log('got:'+t);s.close()})})})`
  const box = (await sandboxedSpawn(`node -e ${JSON.stringify(script)}`, work, '/bin/bash', on(false)))!
  const res = spawnSync(box.file, box.args, { cwd: work, encoding: 'utf8', timeout: 20_000, env: { ...process.env, HOME: home } })
  assert.match(res.stdout, /got:served/, res.stderr)
})

test('a project’s other folders are writable in the sandbox too, and nothing else beside them', { skip: !mac }, async () => {
  const extra = path.join(root, 'api')
  const stranger = path.join(root, 'stranger')
  fs.mkdirSync(extra)
  fs.mkdirSync(stranger)
  const box = (await sandboxedSpawn(`echo a > ${JSON.stringify(path.join(extra, 'a.txt'))}; echo b > ${JSON.stringify(path.join(stranger, 'b.txt'))}`, work, '/bin/bash', on(), [extra]))!
  spawnSync(box.file, box.args, { cwd: work, encoding: 'utf8', timeout: 20_000, env: { ...process.env, HOME: home } })
  assert.equal(fs.existsSync(path.join(extra, 'a.txt')), true)
  assert.equal(fs.existsSync(path.join(stranger, 'b.txt')), false)
})
