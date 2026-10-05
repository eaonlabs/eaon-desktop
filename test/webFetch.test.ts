import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { fetchPage } from '../src/main/webSearch'
import { isPrivateAddress, privateAddressOf, targetsPrivateNetwork } from '../src/main/netGuard'

/**
 * web_fetch and the local network: a URL that names this computer or the
 * LAN is a call the user approves; a public page can't get the agent there
 * by redirecting, or through a name that resolves to a private address.
 */

async function server(handle: (path: string) => { status: number; headers?: Record<string, string>; body?: string }): Promise<{ port: number; hits: string[]; close: () => void; srv: Server }> {
  const hits: string[] = []
  const srv = createServer((req, res) => {
    hits.push(req.url ?? '')
    const reply = handle(req.url ?? '')
    res.writeHead(reply.status, { 'Content-Type': 'text/plain', ...reply.headers })
    res.end(reply.body ?? '')
  })
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()))
  return { port: (srv.address() as { port: number }).port, hits, close: () => srv.close(), srv }
}

test('which URLs are this computer or the local network, however they are spelled', () => {
  for (const url of [
    'http://localhost:3000/',
    'http://LOCALHOST./',
    'http://127.0.0.1/',
    'http://127.1/',
    'http://0x7f000001/',
    'http://2130706433/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://10.1.2.3/',
    'http://172.20.0.1/',
    'http://192.168.1.1/admin',
    'http://169.254.169.254/latest/meta-data',
    'http://100.100.1.1/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://printer/',
    'http://nas.local/',
    'http://db.internal:5432/',
    'http://0.0.0.0:8080/'
  ]) {
    assert.ok(targetsPrivateNetwork(url), url)
  }
  for (const url of ['https://example.com/', 'http://8.8.8.8/', 'https://[2606:4700:4700::1111]/', 'https://docs.local-first.dev/', 'not a url']) {
    assert.ok(!targetsPrivateNetwork(url), url)
  }
  assert.ok(isPrivateAddress('::ffff:10.0.0.1') && !isPrivateAddress('93.184.216.34'))
})

test('a URL naming a local address is read: that call was approved as one', { timeout: 10_000 }, async () => {
  const local = await server(() => ({ status: 200, body: 'dev server says hi' }))
  try {
    const text = await fetchPage({ url: `http://127.0.0.1:${local.port}/` })
    assert.match(text, /dev server says hi/)
  } finally {
    local.close()
  }
})

test('a redirect to another local address is refused before anything is sent there', { timeout: 10_000 }, async () => {
  const target = await server(() => ({ status: 200, body: 'router admin' }))
  const first = await server(() => ({ status: 302, headers: { Location: `http://127.0.0.1:${target.port}/admin` } }))
  try {
    const text = await fetchPage({ url: `http://127.0.0.1:${first.port}/` })
    assert.match(text, /on this computer or the local network/)
    assert.doesNotMatch(text, /router admin/)
    assert.deepEqual(target.hits, [], 'nothing reached the other service')
  } finally {
    target.close()
    first.close()
  }
})

test('a public page redirecting to localhost is refused (the guest-turn bypass)', { timeout: 10_000 }, async () => {
  const secret = await server(() => ({ status: 200, body: 'local secrets' }))
  // The test's "public" site is on loopback too; tell fetchPage only `localhost` is private.
  const publicSite = await server(() => ({ status: 301, headers: { Location: `http://localhost:${secret.port}/secret` } }))
  try {
    const text = await fetchPage({ url: `http://127.0.0.1:${publicSite.port}/innocent` }, undefined, { isPrivateHost: (host) => host === 'localhost' })
    assert.match(text, /localhost:\d+ is on this computer or the local network/)
    assert.deepEqual(secret.hits, [])
  } finally {
    secret.close()
    publicSite.close()
  }
})

test('a public-looking name that resolves to a private address is refused', async () => {
  const text = await fetchPage({ url: 'http://intranet.example.com/' }, undefined, { resolve: async () => ['93.184.216.34', '10.0.0.5'] })
  assert.match(text, /points to 10\.0\.0\.5/)
  assert.equal(await privateAddressOf('example.com', async () => ['93.184.216.34']), null)
  assert.equal(await privateAddressOf('broken.example', async () => Promise.reject(new Error('ENOTFOUND'))), null, 'a name that does not resolve fails in the request')
})

test('redirects stop after ten, and credentials in a URL are never sent', { timeout: 10_000 }, async () => {
  let port = 0
  const loop = await server((path) => ({ status: 302, headers: { Location: `http://127.0.0.1:${port}${path}x` } }))
  port = loop.port
  try {
    const text = await fetchPage({ url: `http://127.0.0.1:${port}/` })
    assert.match(text, /redirected more than 10 times/)
    assert.ok(loop.hits.length <= 11)
  } finally {
    loop.close()
  }
  assert.match(await fetchPage({ url: 'https://user:pass@example.com/' }), /credentials/)
})
