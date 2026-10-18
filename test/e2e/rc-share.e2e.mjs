/**
 * Eaon Remote sharing, against the real relay (cloud/rc under `wrangler dev`)
 * with a stand-in computer: a socket holding a real device token that answers
 * what reaches it. Alice shares one terminal with Bob, watch only; the invite
 * works once and only for Bob; Bob's messages reach the computer only when
 * what was shared covers them; sharing the whole computer lets him do more;
 * revoking (on the website, from the computer, or by unlinking it) cuts him
 * off at once and tells the computer to stop streaming to him.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import http from 'node:http'
import WebSocket from 'ws'

const PORT = 8798
const SITE = `http://localhost:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hasWrangler = (() => {
  try {
    execFileSync('wrangler', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

async function startRelay(stateDir) {
  const proc = spawn(
    'wrangler',
    ['dev', '--port', String(PORT), '--local-upstream', `localhost:${PORT}`, '--persist-to', stateDir, '--var', 'DEV_LOGIN:1', '--var', `PUBLIC_URL:${SITE}`, '--var', 'SESSION_SECRET:e2e-only', '--var', 'GITHUB_CLIENT_ID:', '--var', 'GITHUB_CLIENT_SECRET:'],
    { cwd: resolve(import.meta.dirname, '../../cloud/rc'), env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let log = ''
  proc.stdout.on('data', (d) => (log += d))
  proc.stderr.on('data', (d) => (log += d))
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${SITE}/api/me`)).status === 401) return { proc, log: () => log }
    } catch {}
    await sleep(500)
  }
  proc.kill()
  throw new Error(`wrangler dev didn’t start:\n${log.slice(-3000)}`)
}

async function signIn(login) {
  const res = await fetch(`${SITE}/auth/dev?login=${login}`, { redirect: 'manual' })
  const m = /rc_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')
  assert.ok(m, 'a session cookie')
  return `rc_session=${m[1]}`
}

/** A request as the web app makes it: our Origin, your cookie. Node's fetch drops Origin, so this is raw. */
function call(method, path, cookie, body, origin = SITE) {
  return new Promise((done, fail) => {
    const data = body === undefined ? '' : JSON.stringify(body)
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) }
    const req = http.request(`${SITE}${path}`, { method, headers }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => {
        let json = null
        try {
          json = JSON.parse(text)
        } catch {}
        done({ status: res.statusCode, body: json, text })
      })
    })
    req.on('error', fail)
    req.end(data)
  })
}

/** A socket and its inbox, with a way to wait for a message. */
function socket(url, headers) {
  return new Promise((resolveWs, reject) => {
    const ws = new WebSocket(url, { headers })
    const inbox = []
    const waiters = []
    let closed = null
    const closers = []
    ws.on('message', (raw) => {
      const text = raw.toString()
      if (text === 'pong') return
      const m = JSON.parse(text)
      inbox.push(m)
      for (const w of [...waiters]) if (w.test(m)) (waiters.splice(waiters.indexOf(w), 1), w.done(m))
    })
    ws.on('close', (code) => {
      closed = code
      for (const c of closers.splice(0)) c(code)
    })
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error(`refused: ${res.statusCode}`), { status: res.statusCode })))
    ws.on('error', reject)
    ws.on('open', () => {
      let seq = 0
      const client = {
        ws,
        inbox,
        next(test, ms = 10_000) {
          const hit = inbox.find(test)
          if (hit) return Promise.resolve(hit)
          return new Promise((done, fail) => {
            const w = { test, done }
            waiters.push(w)
            setTimeout(() => fail(new Error(`no message matched in ${ms} ms; last: ${JSON.stringify(inbox.slice(-4))}`)), ms)
          })
        },
        closed: () => (closed !== null ? Promise.resolve(closed) : new Promise((done) => closers.push(done))),
        send: (m) => ws.send(JSON.stringify(m)),
        async req(dev, method, path, body) {
          const id = `q${++seq}`
          ws.send(JSON.stringify({ t: 'req', dev, id, method, path, body }))
          return client.next((m) => m.t === 'res' && m.id === id)
        }
      }
      resolveWs(client)
    })
  })
}

const web = (cookie) => socket(`ws://localhost:${PORT}/relay/web`, { Cookie: cookie, Origin: SITE })
const guest = (cookie, owner, origin = SITE) => socket(`ws://localhost:${PORT}/relay/guest?owner=${owner}`, { Cookie: cookie, ...(origin ? { Origin: origin } : {}) })
const refusal = (promise) => promise.then(() => 'opened', (e) => e.status ?? 'error')

/** Links a stand-in computer to `cookie`'s account the way Eaon does; returns its token and id. */
async function linkComputer(cookie, name) {
  const started = (await call('POST', '/api/link/start', null, { name, platform: 'darwin' }, null)).body
  const confirmed = await call('POST', '/api/link/confirm', cookie, { code: started.code })
  assert.equal(confirmed.status, 200, confirmed.text)
  const polled = (await call('POST', '/api/link/poll', null, { poll: started.poll }, null)).body
  assert.equal(polled.status, 'approved')
  return { token: polled.token, id: polled.deviceId }
}

/** The computer: answers each request with what it was asked and who asked, and keeps everything it was sent. */
async function computer(token) {
  const dev = await socket(`ws://localhost:${PORT}/relay/device`, { Authorization: `Bearer ${token}` })
  dev.ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.t === 'req') dev.send({ t: 'res', to: m.from, id: m.id, status: 200, body: { path: m.path, method: m.method, guest: m.guest ?? null } })
    if (m.t === 'sub') dev.send({ t: 'snap', to: m.from, pane: m.pane, name: 'zsh', cols: 80, rows: 24, running: true, data: '$ ' })
  })
  return dev
}

test('Sharing on Eaon Remote: a terminal or a whole computer, with one GitHub account, until revoked', { timeout: 180_000, skip: hasWrangler ? false : 'needs wrangler on PATH' }, async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'rc-share-'))
  const relay = await startRelay(state)
  const sockets = []
  const keep = (s) => (sockets.push(s), s)
  try {
    const alice = await signIn('alice')
    const bob = await signIn('bob')
    const carol = await signIn('carol')
    const linked = await linkComputer(alice, 'Studio')
    const device = keep(await computer(linked.token))
    const owner = keep(await web(alice))
    await owner.next((m) => m.t === 'hello')

    // ---- Making a share: only from our pages, only for someone else, only for a real username.
    assert.equal((await call('POST', '/api/shares', alice, { dev: linked.id, pane: 'p1', access: 'watch', login: 'bob' }, 'https://evil.example')).status, 403)
    assert.equal((await call('POST', '/api/shares', alice, { dev: linked.id, pane: 'p1', access: 'watch', login: 'alice' })).status, 400)
    assert.equal((await call('POST', '/api/shares', alice, { dev: linked.id, pane: 'p1', access: 'watch', login: 'not a login!' })).status, 400)
    assert.equal((await call('POST', '/api/shares', bob, { dev: linked.id, pane: 'p1', access: 'watch', login: 'carol' })).status, 404, 'a computer that isn’t yours')
    const made = await call('POST', '/api/shares', alice, { dev: linked.id, pane: 'p1', paneLabel: 'Fix the gateway', access: 'watch', login: 'Bob' })
    assert.equal(made.status, 200, made.text)
    const token = made.body.url.split('/share/')[1]
    assert.ok(token.startsWith('dev-alice.'), made.body.url)
    assert.equal(made.body.share.pending, true)
    assert.equal(made.body.share.hash, undefined, 'the invite secret’s hash never leaves the server')

    // ---- The invite: only Bob, and only once.
    const asCarol = await call('POST', '/api/share/open', carol, { token })
    assert.equal(asCarol.status, 403)
    assert.match(asCarol.body.error, /for @Bob/)
    assert.equal((await call('POST', '/api/share/open', carol, { token, accept: true })).status, 403)
    assert.equal((await call('POST', '/api/share/open', bob, { token: token.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')) })).status, 404, 'a wrong secret')
    const preview = await call('POST', '/api/share/open', bob, { token })
    assert.equal(preview.status, 200, preview.text)
    assert.deepEqual([preview.body.ownerLogin, preview.body.device, preview.body.paneLabel, preview.body.access], ['alice', 'Studio', 'Fix the gateway', 'watch'])
    // Nothing is shared until Bob accepts.
    assert.equal(await refusal(guest(bob, 'dev-alice')), 403)
    const accepted = await call('POST', '/api/share/open', bob, { token, accept: true })
    assert.equal(accepted.status, 200, accepted.text)
    assert.deepEqual([accepted.body.dev, accepted.body.pane], [linked.id, 'p1'])
    assert.equal((await call('POST', '/api/share/open', bob, { token })).body.accepted, true, 'opening it again just goes there')
    assert.equal((await call('POST', '/api/share/open', carol, { token })).status, 404, 'used up for anyone else')

    // Bob's own relay says whose to join.
    assert.deepEqual((await call('GET', '/api/shared', bob)).body.owners, [{ owner: 'dev-alice', login: 'alice' }])
    const bobsOwn = keep(await web(bob))
    assert.deepEqual((await bobsOwn.next((m) => m.t === 'hello')).shared, [{ owner: 'dev-alice', login: 'alice' }])

    // ---- Joining Alice's relay as a guest: our Origin only, and only what's shared.
    assert.equal(await refusal(guest(bob, 'dev-alice', null)), 403)
    assert.equal(await refusal(guest(bob, 'dev-carol')), 403, 'nothing shared there')
    let g = keep(await guest(bob, 'dev-alice'))
    const hello = await g.next((m) => m.t === 'hello')
    assert.equal(hello.devices.length, 1)
    assert.deepEqual(hello.devices[0].grants, [{ pane: 'p1', paneLabel: 'Fix the gateway', access: 'watch' }])
    assert.equal(hello.devices[0].owner, 'alice')

    // One terminal, watch only.
    const pane = await g.req(linked.id, 'GET', '/ade/panes/p1')
    assert.equal(pane.status, 200)
    assert.equal(pane.body.guest, 'bob', 'the computer hears who it is')
    for (const [method, path] of [
      ['GET', '/ade/sessions'],
      ['GET', '/ade/panes/p2'],
      ['POST', '/ade/panes/p1/start'],
      ['GET', '/remote/v1/workers'],
      ['GET', '/browsers']
    ]) {
      const res = await g.req(linked.id, method, path)
      assert.equal(res.status, 403, `${method} ${path}`)
    }
    g.send({ t: 'sub', dev: linked.id, pane: 'p1' })
    assert.equal((await g.next((m) => m.t === 'snap')).pane, 'p1')
    g.send({ t: 'sub', dev: linked.id, pane: 'p2' })
    g.send({ t: 'input', dev: linked.id, pane: 'p1', data: 'rm -rf /\r' })
    g.send({ t: 'bsub', dev: linked.id, target: 'agent' })
    await sleep(400)
    const reached = device.inbox.filter((m) => m.guest === 'bob')
    assert.deepEqual(
      reached.map((m) => [m.t, m.path ?? m.pane ?? m.target]),
      [
        ['req', '/ade/panes/p1'],
        ['sub', 'p1']
      ],
      'nothing else reached the computer'
    )

    // ---- The whole computer, with typing: the same socket can do more at once.
    const whole = await call('POST', '/api/shares', alice, { dev: linked.id, pane: null, access: 'control', login: 'bob' })
    const wholeToken = whole.body.url.split('/share/')[1]
    assert.equal((await call('POST', '/api/share/open', bob, { token: wholeToken, accept: true })).status, 200)
    assert.equal((await g.req(linked.id, 'GET', '/ade/sessions')).status, 200)
    assert.equal((await g.req(linked.id, 'POST', '/remote/v1/workers/w1/send', { text: 'hi' })).status, 200)
    g.send({ t: 'input', dev: linked.id, pane: 'p2', data: 'ls\r' })
    g.send({ t: 'bsub', dev: linked.id, target: 'agent' })
    await device.next((m) => m.t === 'input' && m.pane === 'p2' && m.guest === 'bob')
    await device.next((m) => m.t === 'bsub' && m.guest === 'bob')
    // Alice sees both shares, and never a hash.
    const listed = (await call('GET', '/api/shares', alice)).body.shares
    assert.equal(listed.length, 2)
    assert.ok(listed.every((x) => !x.pending && x.hash === undefined))

    // ---- Revoked on the website: Bob is cut off now, and the computer stops streaming to him.
    const conn = hello.conn
    assert.equal((await call('DELETE', `/api/shares/${whole.body.share.id}`, alice)).status, 200)
    assert.equal(await g.closed(), 4003)
    await device.next((m) => m.t === 'gone' && m.from === conn)
    // The terminal share is still his: back in, with only that.
    g = keep(await guest(bob, 'dev-alice'))
    assert.deepEqual((await g.next((m) => m.t === 'hello')).devices[0].grants.map((x) => x.pane), ['p1'])
    assert.equal((await g.req(linked.id, 'GET', '/ade/sessions')).status, 403)

    // ---- Revoked from the computer itself (Settings → Remote devices).
    const fromDevice = await fetch(`${SITE}/api/device/shares`, { headers: { Authorization: `Bearer ${linked.token}` } }).then((r) => r.json())
    assert.deepEqual(fromDevice.shares.map((x) => [x.login, x.pane, x.access]), [['Bob', 'p1', 'watch']])
    assert.equal((await fetch(`${SITE}/api/device/shares/${fromDevice.shares[0].id}`, { method: 'DELETE', headers: { Authorization: 'Bearer eaonrc1.dev-alice.zzzzzzzzz.aaaaaaaaaaaaaaaaaaaaaaaaaaaa' } })).status, 401)
    assert.equal((await fetch(`${SITE}/api/device/shares/${fromDevice.shares[0].id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${linked.token}` } })).status, 200)
    assert.equal(await g.closed(), 4003)
    assert.deepEqual((await call('GET', '/api/shared', bob)).body.owners, [])
    assert.equal(await refusal(guest(bob, 'dev-alice')), 403)

    // ---- Unlinking the computer takes its shares with it.
    const again = await call('POST', '/api/shares', alice, { dev: linked.id, pane: null, access: 'watch', login: 'carol' })
    assert.equal((await call('POST', '/api/share/open', carol, { token: again.body.url.split('/share/')[1], accept: true })).status, 200)
    assert.equal((await call('GET', '/api/shared', carol)).body.owners.length, 1)
    const c = keep(await guest(carol, 'dev-alice'))
    await c.next((m) => m.t === 'hello')
    assert.equal((await call('DELETE', `/api/devices/${linked.id}`, alice)).status, 200)
    assert.equal(await c.closed(), 4003)
    assert.deepEqual((await call('GET', '/api/shared', carol)).body.owners, [])
    assert.deepEqual((await call('GET', '/api/shares', alice)).body.shares, [])
    t.diagnostic('sharing: invite, scoped access, upgrade, and three ways to revoke all held')
  } catch (error) {
    t.diagnostic(relay.log().slice(-4000))
    throw error
  } finally {
    for (const s of sockets) s.ws.terminate()
    relay.proc.kill()
    rmSync(state, { recursive: true, force: true })
  }
})
