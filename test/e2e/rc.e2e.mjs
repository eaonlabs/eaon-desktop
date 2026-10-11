/**
 * Eaon Remote end to end: the real relay (cloud/rc under `wrangler dev`, with
 * its dev sign-in) and the real app. The test plays the browser: signs in,
 * approves the link code Eaon shows, then over the relay lists the ADE's
 * sessions, watches a live terminal and types into it, starts a terminal that
 * appears in Eaon's window, reads the Workers, and unlinks.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import http from 'node:http'
import WebSocket from 'ws'
import { scenario } from './fixtures.mjs'

const PORT = 8799
const SITE = `http://localhost:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com' }

/** A POST with exactly these headers: Node's fetch drops Origin, which is the header under test. */
function postRaw(path, body, headers) {
  return new Promise((done, fail) => {
    const data = JSON.stringify(body)
    const req = http.request(`${SITE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => done({ status: res.statusCode, text }))
    })
    req.on('error', fail)
    req.end(data)
  })
}

async function startRelay(stateDir) {
  const dir = resolve(import.meta.dirname, '../../cloud/rc')
  const proc = spawn(
    'wrangler',
    // --local-upstream: otherwise wrangler dev rewrites Origin to the production route's host.
    // Its own storage: wrangler dev otherwise keeps every earlier run's devices.
    ['dev', '--port', String(PORT), '--local-upstream', `localhost:${PORT}`, '--persist-to', stateDir, '--var', 'DEV_LOGIN:1', '--var', `PUBLIC_URL:${SITE}`, '--var', 'SESSION_SECRET:e2e-only', '--var', 'GITHUB_CLIENT_ID:', '--var', 'GITHUB_CLIENT_SECRET:'],
    { cwd: dir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let log = ''
  proc.stdout.on('data', (d) => (log += d))
  proc.stderr.on('data', (d) => (log += d))
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${SITE}/api/me`)
      if (res.status === 401) return { proc, log: () => log }
    } catch {}
    await sleep(500)
  }
  proc.kill()
  throw new Error(`wrangler dev didn’t start:\n${log.slice(-3000)}`)
}

/** Signs in as `login` through the dev route; returns the cookie header. */
async function signIn(login) {
  const res = await fetch(`${SITE}/auth/dev?login=${login}`, { redirect: 'manual' })
  const set = res.headers.get('set-cookie') ?? ''
  const m = /rc_session=([^;]+)/.exec(set)
  assert.ok(m, `a session cookie, got ${set}`)
  return `rc_session=${m[1]}`
}

function webSocket(cookie) {
  return new Promise((resolveWs, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/relay/web`, { headers: { Cookie: cookie, Origin: SITE } })
    const inbox = []
    const waiters = []
    ws.on('message', (raw) => {
      const text = raw.toString()
      if (text === 'pong') return
      const m = JSON.parse(text)
      inbox.push(m)
      for (const w of [...waiters]) if (w.test(m)) (waiters.splice(waiters.indexOf(w), 1), w.done(m))
    })
    ws.on('open', () => {
      let seq = 0
      const client = {
        ws,
        inbox,
        next(test, ms = 20_000) {
          const hit = inbox.find(test)
          if (hit) return Promise.resolve(hit)
          return new Promise((done, fail) => {
            const w = { test, done }
            waiters.push(w)
            setTimeout(() => fail(new Error(`no message matched in ${ms} ms; got ${JSON.stringify(inbox.slice(-5))}`)), ms)
          })
        },
        async req(dev, method, path, body) {
          const id = `t${++seq}`
          ws.send(JSON.stringify({ t: 'req', dev, id, method, path, body }))
          return client.next((m) => m.t === 'res' && m.id === id)
        },
        send: (m) => ws.send(JSON.stringify(m))
      }
      resolveWs(client)
    })
    ws.on('unexpected-response', (_req, res) => reject(new Error(`web socket refused: ${res.statusCode}`)))
    ws.on('error', reject)
  })
}

scenario('Eaon Remote: link with the website, then sessions, a live terminal and Workers over the relay', { timeout: 240_000 }, async (s) => {
  mkdirSync(s.homeDir, { recursive: true })
  const relay = await startRelay(join(s.homeDir, '..', 'relay-state'))
  try {
    const app = await s.launch({ env: { EAON_RC_URL: SITE, EAON_RC_NO_BROWSER: '1' } })
    const page = app.page
    const home = realpathSync(s.homeDir)
    const repo = join(home, 'projects', 'acme')
    mkdirSync(repo, { recursive: true })
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { env: gitEnv })
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    execFileSync('git', ['-C', repo, 'add', '.'], { env: gitEnv })
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'first'], { env: gitEnv })
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')

    const settings = await page.eval(() => window.api.settings.get())
    const ade = (await page.eval(() => window.api.workspaces.get())).find((w) => w.kind === 'code')
    await page.eval((id, folder, eaonCode) => window.api.settings.patch({ activeWorkspaceId: id, eaonCode: { ...eaonCode, lastCwd: folder } }), ade.id, repo, settings.eaonCode)
    await page.reload()
    await page.click('.code-header .header-btn', { text: /New terminal/ })
    await page.click('.menu [role="menuitem"], .menu button', { text: /^Shell/ })
    await page.find('.term-pane')

    // Refused without our Origin, and with a token that isn't one.
    const fake = await new Promise((r) => {
      const ws = new WebSocket(`ws://localhost:${PORT}/relay/device`, { headers: { Authorization: 'Bearer eaonrc1.dev-x.abcdefgh.aaaaaaaaaaaaaaaaaaaaaaaaaa' } })
      ws.on('unexpected-response', (_q, res) => r(res.statusCode))
      ws.on('open', () => r('opened'))
      ws.on('error', () => r('error'))
    })
    assert.equal(fake, 401)

    // Link: Eaon asks for a code; "the browser" signs in and approves it.
    const linking = await page.eval(() => window.api.rc.link())
    s.t.diagnostic(`link code: ${linking.linking?.code}`)
    assert.match(linking.linking.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    const cookie = await signIn('tester')
    // A page on another site can't open the relay with your cookie: no Origin of ours, no socket.
    const noOrigin = await new Promise((r) => {
      const ws = new WebSocket(`ws://localhost:${PORT}/relay/web`, { headers: { Cookie: cookie } })
      ws.on('unexpected-response', (_q, res) => r(res.statusCode))
      ws.on('open', () => r('opened'))
      ws.on('error', () => r('error'))
    })
    assert.equal(noOrigin, 403)
    const info = await (await fetch(`${SITE}/api/link/info?code=${linking.linking.code}`, { headers: { Cookie: cookie } })).json()
    assert.ok(info.name, 'the computer’s name, to check on the website')
    // A cross-site request can't approve it.
    const csrf = await postRaw('/api/link/confirm', { code: linking.linking.code }, { Cookie: cookie, Origin: 'https://evil.example' })
    assert.equal(csrf.status, 403)
    const confirmed = await postRaw('/api/link/confirm', { code: linking.linking.code }, { Cookie: cookie, Origin: SITE })
    assert.equal(confirmed.status, 200, confirmed.text)

    await page.waitFor(async () => (await window.api.rc.info()).connection === 'connected', { message: 'Eaon connected to the relay', timeout: 20_000 })
    const linked = await page.eval(() => window.api.rc.info())
    assert.equal(linked.login, 'tester')
    assert.equal(linked.linked, true)
    await page.click('.sidebar .nav-item', { text: /^Settings$/ })
    await page.click('.settings__nav-item, .settings-nav button, nav button', { text: /Remote devices/ }).catch(() => undefined)
    await s.shot(page, 'settings-linked')
    await page.click('button, a', { text: /Back to app/ })
    await page.find('.term-pane')

    // The browser: the computer is online; its sessions, a live terminal, typing.
    const web = await webSocket(cookie)
    const hello = await web.next((m) => m.t === 'hello')
    const device = hello.devices[0]
    assert.equal(hello.devices.length, 1)
    if (!device.online) await web.next((m) => m.t === 'presence' && m.online)
    const sessions = await web.req(device.id, 'GET', '/ade/sessions')
    assert.equal(sessions.status, 200, JSON.stringify(sessions.body))
    s.t.diagnostic(`sessions: ${JSON.stringify(sessions.body.sessions.map((x) => [x.title, x.subtitle, x.state, x.changes, x.panes.map((p) => [p.name, p.status])]))}`)
    const session = sessions.body.sessions.find((x) => x.title === 'acme')
    assert.ok(session, 'the acme session')
    assert.deepEqual(session.changes, { added: 1, removed: 0, files: 1 })
    const pane = session.panes[0]
    assert.ok(pane && pane.status !== 'stopped', 'its running shell')

    web.send({ t: 'sub', dev: device.id, pane: pane.id })
    const snap = await web.next((m) => m.t === 'snap' && m.pane === pane.id)
    assert.ok(snap.cols >= 20 && snap.running)
    web.send({ t: 'input', dev: device.id, pane: pane.id, data: 'echo rc-ok-$((6*7))\r' })
    await web.next((m) => m.t === 'term' && m.pane === pane.id && /rc-ok-42/.test(m.data))
    // Input only reaches panes the ADE has.
    web.send({ t: 'input', dev: device.id, pane: 'pane-not-real', data: 'x' })

    // A terminal started from the web shows up in Eaon's window.
    const made = await web.req(device.id, 'POST', `/ade/sessions/${session.id}/panes`, { agent: 'shell' })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    await page.waitFor(() => document.querySelectorAll('.term-pane').length === 2, { message: 'the new terminal in the window', timeout: 15_000 })
    await s.shot(page, 'pane-from-web')

    // Workers, through the phone API's own routes.
    const workers = await web.req(device.id, 'GET', '/remote/v1/workers')
    assert.equal(workers.status, 200)
    assert.ok(Array.isArray(workers.body.workers))

    // What the website looks like, at desktop and phone sizes.
    const shots = join(s.homeDir, '..', '..', '..', 'screens', 'rc-web')
    const value = cookie.slice('rc_session='.length)
    const term = session.panes[0].id
    execFileSync(
      resolve(import.meta.dirname, '../../node_modules/.bin/electron'),
      [
        resolve(import.meta.dirname, 'captureWeb.cjs'),
        SITE,
        value,
        shots,
        'home|/|1100|700',
        `sessions|/d/${device.id}|1100|700`,
        `session|/d/${device.id}/s/${session.id}|1100|760`,
        `terminal|/d/${device.id}/t/${term}|1100|760`,
        `terminal-phone|/d/${device.id}/t/${term}|390|844`,
        `workers|/d/${device.id}/w|390|844`
      ],
      { timeout: 90_000, stdio: 'ignore' }
    )
    execFileSync(resolve(import.meta.dirname, '../../node_modules/.bin/electron'), [resolve(import.meta.dirname, 'captureWeb.cjs'), SITE, '-', shots, 'signed-out|/|1100|700'], { timeout: 60_000, stdio: 'ignore' })
    s.t.diagnostic(`web screenshots: ${shots}`)

    // Unlink in Eaon: the website sees it go, and the device list is empty.
    await page.eval(() => window.api.rc.unlink())
    await web.next((m) => m.t === 'presence' && m.removed)
    const after = await (await fetch(`${SITE}/api/devices`, { headers: { Cookie: cookie } })).json()
    assert.deepEqual(after.devices, [])
    web.ws.close()
  } finally {
    relay.proc.kill()
  }
})
