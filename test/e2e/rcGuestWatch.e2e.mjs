/**
 * Watching a friend's terminal, end to end: the real relay (cloud/rc under
 * `wrangler dev`) and the real app. Alice shares a locked terminal with Bob;
 * the test plays Bob in the browser. When he opens it, it pops up beside
 * Alice's work with what he types; closed, a pill brings it back; Alice can
 * stop it; and a friend's pane id never starts as one of her own shells.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import http from 'node:http'
import WebSocket from 'ws'
import { isMac, scenario } from './fixtures.mjs'

const PORT = 8797
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
function call(method, path, cookie, body) {
  return new Promise((done, fail) => {
    const data = body === undefined ? '' : JSON.stringify(body)
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), Cookie: cookie, Origin: SITE }
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

/** Bob in the browser: a guest socket on Alice's relay, with a way to wait for a message. */
function guest(cookie, owner) {
  return new Promise((resolveWs, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/relay/guest?owner=${owner}`, { headers: { Cookie: cookie, Origin: SITE } })
    const inbox = []
    const waiters = []
    ws.on('message', (raw) => {
      const text = raw.toString()
      if (text === 'pong') return
      const m = JSON.parse(text)
      inbox.push(m)
      for (const w of [...waiters]) if (w.test(m)) (waiters.splice(waiters.indexOf(w), 1), w.done(m))
    })
    ws.on('unexpected-response', (_req, res) => reject(new Error(`refused: ${res.statusCode}`)))
    ws.on('error', reject)
    ws.on('open', () =>
      resolveWs({
        ws,
        next(test, ms = 20_000) {
          const hit = inbox.find(test)
          if (hit) return Promise.resolve(hit)
          return new Promise((done, fail) => {
            waiters.push({ test, done })
            setTimeout(() => fail(new Error(`no message matched in ${ms} ms; last: ${JSON.stringify(inbox.slice(-4)).slice(0, 600)}`)), ms)
          })
        },
        send: (m) => ws.send(JSON.stringify(m)),
        inboxHas: (pattern) => inbox.some((m) => m.t === 'term' && pattern.test(m.data))
      })
    )
  })
}

/** Waits until an element's text matches `pattern`. */
const shows = (page, selector, pattern, message) =>
  page.waitFor((sel, source) => new RegExp(source).test(document.querySelector(sel)?.textContent ?? ''), { args: [selector, pattern.source], message, timeout: 10_000 })

scenario(
  'Eaon Remote: a friend’s locked terminal pops up beside your work, live and watch only',
  { timeout: 240_000, skip: !hasWrangler ? 'needs wrangler on PATH (npm i -g wrangler)' : !isMac ? 'runs the macOS sandbox' : false },
  async (s) => {
    mkdirSync(s.homeDir, { recursive: true })
    const relay = await startRelay(join(s.homeDir, '..', 'relay-state'))
    let bob = null
    try {
      const app = await s.launch({ env: { EAON_RC_URL: SITE, EAON_RC_NO_BROWSER: '1' } })
      const page = app.page
      const shared = join(realpathSync(s.homeDir), 'projects', 'shared-app')
      mkdirSync(shared, { recursive: true })

      // Alice links this computer.
      const linking = await page.eval(() => window.api.rc.link())
      const alice = await signIn('alice')
      const confirmed = await call('POST', '/api/link/confirm', alice, { code: linking.linking.code })
      assert.equal(confirmed.status, 200, confirmed.text)
      await page.waitFor(async () => (await window.api.rc.info()).connection === 'connected', { message: 'Eaon connected to the relay', timeout: 20_000 })

      // And shares a locked shell with Bob, who accepts.
      const made = await page.eval((folder) => window.api.rc.lockedCreate({ folder, mode: 'shell', network: false, login: 'bob', hours: 0 }), shared)
      const paneId = `guest-${made.terminal.id}`
      const bobCookie = await signIn('bob')
      const accepted = await call('POST', '/api/share/open', bobCookie, { token: made.url.split('/share/')[1], accept: true })
      assert.equal(accepted.status, 200, accepted.text)
      // Nothing of his runs yet: nothing to watch.
      assert.equal(await page.eval(() => document.querySelector('.guest-watch, .guest-watch-pill') === null), true)

      // Bob opens it: his terminal starts, and pops up beside Alice's work.
      bob = await guest(bobCookie, 'dev-alice')
      const dev = (await bob.next((m) => m.t === 'hello')).devices[0].id
      bob.send({ t: 'sub', dev, pane: paneId })
      await bob.next((m) => m.t === 'snap' && m.pane === paneId)
      await page.find('.guest-watch')
      await shows(page, '.guest-watch__who', /@bob[\s\S]*Live/, 'Bob, live, in the panel')

      // What he types, she sees.
      await bob.next((m) => m.t === 'term' && m.pane === paneId && /shared with you through Eaon/.test(m.data))
      bob.send({ t: 'input', dev, pane: paneId, data: 'echo hello-from-bob-$((6*7))\r' })
      await bob.next((m) => m.t === 'term' && m.pane === paneId && /hello-from-bob-42/.test(m.data))
      await shows(page, '.guest-watch .xterm-rows', /hello-from-bob-42/, 'Bob’s output in Alice’s panel')
      await s.shot(page, 'friend-terminal-beside-work')

      // Watching only: keys typed in the panel go nowhere.
      await page.eval(() => document.querySelector('.guest-watch .xterm-helper-textarea')?.focus())
      await page.eval(() => {
        const box = document.querySelector('.guest-watch .xterm-helper-textarea')
        for (const key of 'echo typed-by-alice\r') box?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
        box?.dispatchEvent(new InputEvent('input', { data: 'echo typed-by-alice', bubbles: true }))
      })
      await sleep(800)
      assert.equal(bob.inboxHas(/typed-by-alice/), false, 'nothing typed in the panel reached his terminal')

      // Closed, it leaves a pill that brings it back.
      await page.click('.guest-watch .browser__tabs .icon-btn')
      await page.find('.guest-watch-pill')
      await shows(page, '.guest-watch-pill', /@bob is in shared-app/, 'the pill says who is in')
      await s.shot(page, 'pill-while-closed')
      await page.click('.guest-watch-pill .btn')
      await page.find('.guest-watch')
      // Reopened, it shows what he did meanwhile too.
      await shows(page, '.guest-watch .xterm-rows', /hello-from-bob-42/, 'what he typed, after reopening')

      // Alice stops his terminal: it ends, and the share stays for him to start again.
      await page.click('.guest-watch__foot .btn', { text: /Stop their terminal/ })
      await shows(page, '.guest-watch__who', /Ended/, 'his terminal ended')
      assert.equal((await page.eval(() => window.api.rc.lockedList())).length, 1)

      // A friend's pane id never starts as one of Alice's own shells.
      const refused = await page.eval((id) => window.api.terminals.spawn({ paneId: id, cwd: '/', cols: 80, rows: 24, command: null }), paneId)
      assert.equal(refused.ok, false)
      assert.match(refused.error, /friend’s/)

      await page.eval(() => window.api.rc.unlink())
    } finally {
      bob?.ws.close()
      relay.proc.kill()
    }
  }
)
