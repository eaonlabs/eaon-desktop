import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { llamaRuntime, LlamaServer } from '../src/main/llama/runtime'

/**
 * How Eaon stops llama-server. A real llama-server that gets a second SIGTERM
 * or SIGINT while it is already shutting down calls exit() from its signal
 * handler, Metal's teardown aborts, and macOS records a crash ("llama-server
 * quit unexpectedly"). That second signal came from the terminal Eaon was
 * started in: Ctrl+C, or closing it, signals the whole process group, and Eaon's
 * own quit then sent its SIGTERM too. So llama-server runs in its own process
 * group, is signalled once, and one left behind by a crash is reaped next launch.
 *
 * The stand-in records every signal it gets and takes a moment to shut down,
 * like the real one.
 */

const dir = mkdtempSync(join(tmpdir(), 'eaon-llama-signals-'))
const FAKE = `
const http = require('node:http')
const fs = require('node:fs')
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
const log = ${JSON.stringify(join(dir, 'signals-'))} + port + '.log'
fs.writeFileSync(log, 'pid ' + process.pid + '\\n')
let stopping = false
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    fs.appendFileSync(log, signal + '\\n')
    if (stopping) process.exit(134) // the real one aborts here
    stopping = true
    setTimeout(() => process.exit(0), 400)
  })
}
http.createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404); res.end('{}') }).listen(port, '127.0.0.1')
`
writeFileSync(join(dir, 'fake.cjs'), FAKE)
const bin = join(dir, 'llama-server')
// `exec -a` keeps the name, so `ps` sees a process called llama-server, as it would the real one.
writeFileSync(bin, `#!/bin/bash\nexec -a "$0" "${process.execPath}" "${join(dir, 'fake.cjs')}" "$@"\n`)
chmodSync(bin, 0o755)
process.env.EAON_LLAMA_SERVER = bin

test.after(async () => {
  await llamaRuntime.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const logOf = (port: number): string => readFileSync(join(dir, `signals-${port}.log`), 'utf8')
const pidOf = (port: number): number => Number(/^pid (\d+)/.exec(logOf(port))![1])
const groupOf = (pid: number): number => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)]).toString().trim())
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const portOf = (baseUrl: string): number => Number(/:(\d+)\/v1$/.exec(baseUrl)![1])

test('llama-server runs in its own process group, so a terminal’s Ctrl+C never reaches it', { skip: process.platform === 'win32' }, async () => {
  const target = await llamaRuntime.ensure({ id: 'fake:q4', path: '/models/a.gguf' })
  const pid = pidOf(portOf(target.baseUrl))
  assert.equal(groupOf(pid), pid, 'it leads its own process group')
  assert.notEqual(groupOf(pid), groupOf(process.pid), 'not the group of the app that started it')
  llamaRuntime.unload()
  await sleep(700)
  assert.equal(alive(pid), false)
  assert.equal(logOf(portOf(target.baseUrl)).match(/SIG/g)?.length, 1, 'stopped with exactly one signal')
})

test('stopping a server that is already stopping never sends a second signal', async () => {
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
  const server = new LlamaServer('fake:q4', 'k', port)
  server.start(bin, ['--port', String(port)])
  await server.ready
  server.stop()
  server.stop()
  await sleep(150)
  server.stop()
  await sleep(700)
  assert.equal(server.alive, false)
  assert.deepEqual(logOf(port).trim().split('\n').slice(1), ['SIGTERM'], 'one SIGTERM, however often stop() is called')
})

test('a llama-server left running by a crash is stopped on the next launch, and nothing else is', { skip: process.platform === 'win32' }, async () => {
  // A stand-in orphan, started the way Eaon starts one, and an unrelated process with a recorded pid.
  const port = 40000 + Math.floor(Math.random() * 10000)
  const orphan = spawn(bin, ['--port', String(port), '--api-key', 'k'], { detached: true, stdio: 'ignore' })
  orphan.unref()
  const bystander = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  bystander.unref()
  await sleep(500)
  writeFileSync(join(app.getPath('userData'), 'llama-servers.json'), JSON.stringify([orphan.pid, bystander.pid]))

  await llamaRuntime.reapOrphans()
  await sleep(700)
  assert.equal(alive(orphan.pid!), false, 'the orphaned llama-server was stopped')
  assert.equal(alive(bystander.pid!), true, 'a process that is not llama-server is left alone, even with a recorded pid')
  const record = join(app.getPath('userData'), 'llama-servers.json')
  assert.deepEqual(existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : [], [], 'the record is cleared')
  process.kill(bystander.pid!, 'SIGKILL')
})
