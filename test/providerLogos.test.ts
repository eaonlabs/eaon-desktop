import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkImage,
  checkSvg,
  clearUserLogo,
  discoverLogo,
  lookUpLogo,
  lookupDue,
  lookupOrigins,
  manifestIcons,
  pageIcons,
  readLogos,
  readManifest,
  setUserLogo,
  sniffImage,
  type LookupDeps
} from '../src/main/providers/logos'
import { removeProvider, updateProvider } from '../src/main/providers'
import { chosenLogo } from '@shared/providerLogos'

/**
 * Provider logos (main/providers/logos.ts): what counts as a logo, where one
 * is looked for, and what's kept. The network is a fake: a table of URLs.
 */

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}
const png = (width: number, height: number, padTo = 64): Buffer => {
  const head = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from('IHDR'), u32(width), u32(height)])
  return Buffer.concat([head, Buffer.alloc(Math.max(0, padTo - head.length))])
}
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>'

type Route = { status?: number; headers?: Record<string, string>; body?: string | Buffer }

/** A fetch that answers from a table, and remembers what was asked. */
function fakeNet(routes: Record<string, Route>, dns: Record<string, string[]> = {}): LookupDeps & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    now: () => 1_000_000,
    resolve: async (host) => dns[host] ?? ['93.184.216.34'],
    fetch: async (url) => {
      asked.push(url)
      const route = routes[url]
      if (!route) return new Response('nope', { status: 404 })
      return new Response(route.body ?? null, { status: route.status ?? 200, headers: route.headers })
    }
  }
}

/* --------------------------------------------------------------- images */

test('images are told apart by their bytes, with their size', () => {
  assert.deepEqual(sniffImage(png(512, 256)), { mime: 'image/png', width: 512, height: 256 })
  assert.deepEqual(sniffImage(Buffer.concat([Buffer.from('GIF89a'), Buffer.from([64, 0, 32, 0]), Buffer.alloc(8)])), { mime: 'image/gif', width: 64, height: 32 })
  // JPEG: an APP0 segment, then the frame header with 300 high, 400 wide.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, 0, 0, 0, 0, 0, 0])
  assert.deepEqual(sniffImage(jpeg), { mime: 'image/jpeg', width: 400, height: 300 })
  // WebP (extended): width-1 and height-1 in 24 bits.
  const webp = Buffer.alloc(32)
  webp.write('RIFF', 0)
  webp.write('WEBP', 8)
  webp.write('VP8X', 12)
  webp.writeUIntLE(127, 24, 3)
  webp.writeUIntLE(63, 27, 3)
  assert.deepEqual(sniffImage(webp), { mime: 'image/webp', width: 128, height: 64 })
  // An icon file with 16, 32 and 256 (written as 0).
  const ico = Buffer.alloc(6 + 3 * 16)
  ico.writeUInt16LE(1, 2)
  ico.writeUInt16LE(3, 4)
  ico[6] = 16
  ico[7] = 16
  ico[22] = 32
  ico[23] = 32
  ico[38] = 0
  ico[39] = 0
  assert.deepEqual(sniffImage(ico), { mime: 'image/x-icon', width: 256, height: 256 })
  assert.deepEqual(sniffImage(Buffer.from(`﻿<?xml version="1.0"?>\n<!-- logo -->\n${SVG}`)), { mime: 'image/svg+xml', width: null, height: null })
  assert.equal(sniffImage(Buffer.from('<!doctype html><html><body>404</body></html>')), null)
  assert.equal(sniffImage(Buffer.from('{"error":"not found"}')), null)
})

test('a logo is checked: size, kind, and an SVG that can’t do anything', () => {
  const ok = checkImage(png(256, 256))
  assert.ok(ok.ok && ok.src.startsWith('data:image/png;base64,'))
  const tiny = checkImage(png(12, 12))
  assert.ok(!tiny.ok && /12×12 pixels/.test(tiny.reason))
  const huge = checkImage(Buffer.concat([png(512, 512), Buffer.alloc(1024 * 1024)]))
  assert.ok(!huge.ok && /at most 1 MB/.test(huge.reason))
  const text = checkImage(Buffer.from('hello'))
  assert.ok(!text.ok && /isn’t an image/.test(text.reason))

  assert.ok('problem' in checkSvg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))
  assert.ok('problem' in checkSvg('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>'))
  assert.ok('problem' in checkSvg('<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>'))
  assert.ok('problem' in checkSvg('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://cdn.example/logo.png"/></svg>'))
  // The commonest export mistake, fixed rather than refused.
  const fixed = checkSvg('<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>')
  assert.ok('svg' in fixed && fixed.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox'))
  const svg = checkImage(Buffer.from(SVG))
  assert.ok(svg.ok && svg.src.startsWith('data:image/svg+xml;base64,'))
})

/* ----------------------------------------------------- where to look */

test('it looks on the API host, then on the website at the registrable domain', () => {
  assert.deepEqual(lookupOrigins('https://api.acme.ai/v1'), ['https://api.acme.ai', 'https://acme.ai'])
  assert.deepEqual(lookupOrigins('https://api.acme.co.uk/openai/v1'), ['https://api.acme.co.uk', 'https://acme.co.uk'])
  assert.deepEqual(lookupOrigins('https://acme.ai/api/v1'), ['https://acme.ai'])
  // A host under a shared domain (the public suffix list) never borrows that domain's logo.
  assert.deepEqual(lookupOrigins('https://acme.github.io/v1'), ['https://acme.github.io'])
  assert.deepEqual(lookupOrigins('http://localhost:4000/v1'), ['http://localhost:4000'])
  assert.deepEqual(lookupOrigins('http://192.168.1.20:8080/v1'), ['http://192.168.1.20:8080'])
  assert.deepEqual(lookupOrigins('not a url'), [])
  assert.deepEqual(lookupOrigins('ftp://acme.ai'), [])
})

test('a home page’s icons, best first', () => {
  const html = `<html><head>
    <link rel="icon" href="/favicon-16.png" sizes="16x16">
    <link rel="icon" type="image/png" href="/favicon-96.png" sizes="96x96">
    <link rel="apple-touch-icon" href="/apple.png">
    <link rel='icon' href='/brand/mark.svg'>
    <link rel="manifest" href="/site.webmanifest">
    <link rel="stylesheet" href="/app.css">
  </head></html>`
  const { icons, manifest } = pageIcons(html, 'https://acme.ai/')
  assert.deepEqual(
    icons.map((icon) => icon.url),
    ['https://acme.ai/brand/mark.svg', 'https://acme.ai/apple.png', 'https://acme.ai/favicon-96.png', 'https://acme.ai/favicon-16.png']
  )
  assert.equal(manifest, 'https://acme.ai/site.webmanifest')
  // <base href> moves relative links.
  assert.equal(pageIcons('<base href="https://cdn.acme.ai/s/"><link rel="icon" href="i.png" sizes="64x64">', 'https://acme.ai/').icons[0].url, 'https://cdn.acme.ai/s/i.png')
  const web = manifestIcons(
    JSON.stringify({
      icons: [
        { src: '/m-192.png', sizes: '192x192', purpose: 'maskable' },
        { src: '/a-512.png', sizes: '512x512' },
        { src: '/mono.svg', type: 'image/svg+xml', purpose: 'monochrome' }
      ]
    }),
    'https://acme.ai/site.webmanifest'
  )
  assert.deepEqual(
    web.map((icon) => icon.url),
    ['https://acme.ai/a-512.png', 'https://acme.ai/m-192.png']
  )
})

test('the provider manifest: the documented form, and near misses', () => {
  const url = 'https://api.acme.ai/.well-known/eaon-provider.json'
  assert.deepEqual(readManifest('{"name":"Acme AI","logo":"/brand/acme.svg","logo_dark":"https://cdn.acme.ai/acme-white.svg"}', url), {
    name: 'Acme AI',
    logo: 'https://api.acme.ai/brand/acme.svg',
    dark: 'https://cdn.acme.ai/acme-white.svg'
  })
  assert.deepEqual(readManifest('{"icon":"logo.png","iconDark":"logo-dark.png"}', url), {
    logo: 'https://api.acme.ai/.well-known/logo.png',
    dark: 'https://api.acme.ai/.well-known/logo-dark.png'
  })
  assert.deepEqual(readManifest('{"logo":{"light":"/l.svg","dark":"/d.svg"}}', url), { logo: 'https://api.acme.ai/l.svg', dark: 'https://api.acme.ai/d.svg' })
  assert.deepEqual(readManifest('{"name":"Acme"}', url), { problem: 'It has no "logo".' })
  assert.deepEqual(readManifest('{name: "Acme"}', url), { problem: 'Not valid JSON.' })
  assert.deepEqual(readManifest('["logo"]', url), { problem: 'Not a JSON object.' })
  assert.ok('problem' in readManifest('{"logo":"javascript:alert(1)"}', url))
})

/* -------------------------------------------------------- the look-up */

test('the manifest on the API host wins, with its dark-mode logo', async () => {
  const net = fakeNet({
    'https://api.acme.ai/.well-known/eaon-provider.json': { body: '{"name":"Acme AI","logo":"/brand/acme.svg","logo_dark":"/brand/acme-white.svg"}' },
    'https://api.acme.ai/brand/acme.svg': { body: SVG, headers: { 'content-type': 'image/svg+xml' } },
    'https://api.acme.ai/brand/acme-white.svg': { body: SVG.replace('<circle', '<circle fill="#fff"') }
  })
  const { logo, steps } = await discoverLogo('https://api.acme.ai/v1', net)
  assert.ok(logo)
  assert.equal(logo.name, 'Acme AI')
  assert.equal(logo.from, 'https://api.acme.ai/.well-known/eaon-provider.json')
  assert.ok(logo.src.startsWith('data:image/svg+xml;base64,') && logo.dark?.startsWith('data:image/svg+xml;base64,'))
  assert.deepEqual(
    steps.map((step) => step.result),
    ['Manifest for Acme AI', 'Found', 'Found']
  )
  // Nothing sent but the request itself: no key, no cookies.
  assert.ok(net.asked.every((url) => url.startsWith('https://api.acme.ai/')))
})

test('then the website’s manifest, then the home page’s icons, then the favicon', async () => {
  const site = fakeNet({
    'https://acme.ai/.well-known/eaon-provider.json': { status: 301, headers: { location: '/brand/eaon.json' } },
    'https://acme.ai/brand/eaon.json': { body: '{"logo":"https://acme.ai/logo.png"}' },
    'https://acme.ai/logo.png': { body: png(256, 256) }
  })
  const fromSite = await discoverLogo('https://api.acme.ai/v1', site)
  assert.equal(fromSite.logo?.from, 'https://acme.ai/.well-known/eaon-provider.json')
  assert.deepEqual(fromSite.steps[0], { url: 'https://api.acme.ai/.well-known/eaon-provider.json', result: 'Not found (404)' })

  const page = fakeNet({
    'https://api.acme.ai/': { body: '{"message":"Acme API"}', headers: { 'content-type': 'application/json' } },
    'https://acme.ai/': { body: '<link rel="icon" href="/fav.svg"><link rel="apple-touch-icon" href="/touch.png">' },
    'https://acme.ai/fav.svg': { body: '<html>not really</html>' },
    'https://acme.ai/touch.png': { body: png(180, 180) }
  })
  const fromPage = await discoverLogo('https://api.acme.ai/v1', page)
  assert.equal(fromPage.logo?.from, 'https://acme.ai/touch.png')
  assert.ok(fromPage.steps.some((step) => step.url === 'https://acme.ai/fav.svg' && /isn’t an image/.test(step.result)))

  const favicon = fakeNet({ 'https://acme.ai/favicon.ico': { body: png(32, 32) } })
  const fromFavicon = await discoverLogo('https://api.acme.ai/v1', favicon)
  assert.equal(fromFavicon.logo?.from, 'https://acme.ai/favicon.ico')

  const nothing = await discoverLogo('https://api.acme.ai/v1', fakeNet({}))
  assert.equal(nothing.logo, null)
  assert.deepEqual(
    nothing.steps.map((step) => step.url),
    [
      'https://api.acme.ai/.well-known/eaon-provider.json',
      'https://acme.ai/.well-known/eaon-provider.json',
      'https://api.acme.ai/',
      'https://acme.ai/',
      'https://api.acme.ai/favicon.ico',
      'https://acme.ai/favicon.ico'
    ]
  )
})

test('a provider on the internet can’t point Eaon at this computer or the local network', async () => {
  const net = fakeNet(
    {
      'https://api.acme.ai/.well-known/eaon-provider.json': { body: '{"logo":"http://127.0.0.1:9000/logo.png"}' },
      'https://acme.ai/.well-known/eaon-provider.json': { body: '{"logo":"https://sneaky.acme.ai/logo.png"}' },
      'https://api.acme.ai/favicon.ico': { status: 302, headers: { location: 'http://192.168.0.1/admin.png' } },
      'https://acme.ai/favicon.ico': { body: png(64, 64) }
    },
    { 'sneaky.acme.ai': ['10.0.0.5'] }
  )
  const { logo, steps } = await discoverLogo('https://api.acme.ai/v1', net)
  assert.equal(logo?.from, 'https://acme.ai/favicon.ico')
  assert.ok(!net.asked.some((url) => url.includes('127.0.0.1') || url.includes('sneaky') || url.includes('192.168')), net.asked.join(', '))
  assert.equal(steps.filter((step) => /local network/.test(step.result)).length, 3)
})

test('a provider on this computer can serve its own logo', async () => {
  const net = fakeNet({
    'http://localhost:4000/.well-known/eaon-provider.json': { body: '{"logo":"/logo.png"}' },
    'http://localhost:4000/logo.png': { body: png(64, 64) }
  })
  const { logo } = await discoverLogo('http://localhost:4000/v1', net)
  assert.equal(logo?.from, 'http://localhost:4000/.well-known/eaon-provider.json')
})

test('a file that says it’s too big isn’t downloaded', async () => {
  const net = fakeNet({
    'https://acme.ai/.well-known/eaon-provider.json': { body: '{"logo":"/big.png"}' },
    'https://acme.ai/big.png': { body: png(64, 64), headers: { 'content-length': String(5 * 1024 * 1024) } }
  })
  const { logo, steps } = await discoverLogo('https://acme.ai/v1', net)
  assert.equal(logo, null)
  assert.ok(steps.some((step) => step.url === 'https://acme.ai/big.png' && /Larger than 1 MB/.test(step.result)))
})

/* ------------------------------------------------------------- stored */

test('the person’s own logo shows over the one found, and resetting brings that back', async () => {
  updateProvider('acme-ai', { name: 'Acme AI', kind: 'openai-compatible', baseUrl: 'https://api.acme.ai/v1' })
  const net = fakeNet({
    'https://api.acme.ai/.well-known/eaon-provider.json': { body: '{"logo":"/l.png"}' },
    'https://api.acme.ai/l.png': { body: png(128, 128) }
  })
  await lookUpLogo('acme-ai', net)
  const found = readLogos()['acme-ai']
  assert.ok(found.site && found.lookup?.found)
  assert.equal(chosenLogo(found)?.src, found.site.src)

  const picked = setUserLogo('acme-ai', Buffer.from(SVG))
  assert.ok(picked.ok)
  assert.ok(chosenLogo(readLogos()['acme-ai'])?.src.startsWith('data:image/svg+xml'))
  assert.ok(!setUserLogo('acme-ai', Buffer.from('nope')).ok)

  clearUserLogo('acme-ai')
  assert.equal(chosenLogo(readLogos()['acme-ai'])?.src, found.site.src)

  // The site down for a moment: the logo stays. A new base URL: it goes.
  await lookUpLogo('acme-ai', fakeNet({}))
  assert.equal(readLogos()['acme-ai'].site?.src, found.site.src)
  assert.equal(readLogos()['acme-ai'].lookup?.found, false)
  updateProvider('acme-ai', { baseUrl: 'https://other.example/v1' })
  await lookUpLogo('acme-ai', fakeNet({}))
  assert.equal(readLogos()['acme-ai'].site, undefined)
  removeProvider('acme-ai')
})

test('when a custom provider is due another look', () => {
  const now = 100 * 24 * 3_600_000
  const day = 24 * 3_600_000
  assert.equal(lookupDue(undefined, 'https://a/v1', now), true)
  assert.equal(lookupDue({ lookup: { baseUrl: 'https://a/v1', at: now - day, found: true, steps: [] } }, 'https://a/v1', now), false)
  assert.equal(lookupDue({ lookup: { baseUrl: 'https://a/v1', at: now - day, found: true, steps: [] } }, 'https://b/v1', now), true)
  assert.equal(lookupDue({ lookup: { baseUrl: 'https://a/v1', at: now - 8 * day, found: false, steps: [] } }, 'https://a/v1', now), true)
  assert.equal(lookupDue({ lookup: { baseUrl: 'https://a/v1', at: now - 8 * day, found: true, steps: [] } }, 'https://a/v1', now), false)
  assert.equal(lookupDue({ lookup: { baseUrl: 'https://a/v1', at: now - 31 * day, found: true, steps: [] } }, 'https://a/v1', now), true)
})
