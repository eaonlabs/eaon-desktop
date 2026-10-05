import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

/**
 * The agent's own browser for real: test/fixtures/browser-harness.ts runs in
 * the repo's Electron with real BetterWright against a local site of
 * difficult pages (test/fixtures/browser-site.mjs) — new tabs, file pickers,
 * downloads, sign-ins, stale refs, banners, bot walls, a silent server, a
 * killed renderer — and this checks what the agent was told each time.
 *
 * Opt-in (EAON_LIVE=1): it starts Electron and takes about a minute. Needs a
 * display (macOS, or Linux with DISPLAY). Uses a throwaway profile only.
 */

const root = resolve(import.meta.dirname, '../..')
const live = Boolean(process.env.EAON_LIVE) && (process.platform === 'darwin' || Boolean(process.env.DISPLAY))

test('the agent browser copes with difficult pages', { skip: !live, timeout: 600_000 }, async () => {
  const out = join(root, 'out', process.env.EAON_TEST_OUT || 'test', 'browser-harness')
  mkdirSync(out, { recursive: true })
  await build({
    entryPoints: [join(root, 'test/fixtures/browser-harness.ts')],
    outfile: join(out, 'harness.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['electron', 'betterwright', 'betterwright/*'],
    alias: { '@shared': join(root, 'src/shared') },
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
    logLevel: 'warning'
  })
  // The bundle loads BetterWright the way the app does, from node_modules.
  if (!existsSync(join(out, 'node_modules'))) {
    mkdirSync(join(out, 'node_modules'), { recursive: true })
    symlinkSync(join(root, 'node_modules/betterwright'), join(out, 'node_modules/betterwright'))
  }
  const electron = createRequire(join(root, 'package.json'))('electron') as string
  const profile = mkdtempSync(join(tmpdir(), 'eaon-browser-live-'))
  const results = join(profile, 'results.json')
  try {
    const child = spawn(electron, [join(out, 'harness.mjs')], { env: { ...process.env, HARNESS_PROFILE: profile, HARNESS_OUT: results }, stdio: 'ignore' })
    const code = await new Promise<number | null>((done) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 540_000)
      child.on('exit', (exit) => {
        clearTimeout(timer)
        done(exit)
      })
    })
    assert.equal(code, 0, 'the harness exited cleanly')
    const r = JSON.parse(readFileSync(results, 'utf8')) as Record<string, { ok: boolean; ms: number; text: string; extra?: { visible?: number; all?: number } }>
    assert.equal(r.harness, undefined, r.harness?.text)

    // New tabs: opened in place, no window on the user's screen.
    assert.match(r['newtab.blank'].text, /opens .*\/landing in a new tab\. There are no tabs here, so it opened in this one/)
    assert.match(r['newtab.popup'].text, /opens .*\/about in a new tab/)
    assert.deepEqual(r['newtab.windows'].extra, { visible: 0, all: 1 })

    // File picker: intercepted (no dialog, window stays hidden), then filled.
    assert.match(r['upload.click'].text, /opened a file picker/)
    assert.equal(r['upload.windows'].extra?.visible, 0)
    assert.match(r['upload.choose'].text, /^Chose cv\.txt/)
    assert.match(r['upload.read'].text, /Chosen: cv\.txt 12/)

    // Downloads: described, saved; a file behind a sign-in needs the sign-in.
    assert.match(r['download.click'].text, /file download \(report\.pdf/)
    assert.match(r['download.save'].text, /^Downloaded .*file\.pdf to .*downloads[\\/]report\.pdf/)
    assert.equal(r['download.private'].ok, false)
    assert.match(r['download.private'].text, /HTTP 403/)
    assert.match(r['login.privateAfter'].text, /files[\\/]statement\.pdf/)

    // Sign-ins persist across a close, and stay in their own browser.
    assert.match(r['login.readAfterClose'].text, /sid=nova/)
    assert.match(r['login.otherRead'].text, /sid=\(none\)/)

    // Failures: fast and specific.
    assert.match(r['stale.click'].text, /no longer on the page/)
    assert.ok(r['stale.click'].ms < 5000, `stale ref took ${r['stale.click'].ms} ms`)
    assert.match(r['overlay.click'].text, /something is covering it.*Accept cookies/)
    assert.ok(r['overlay.click'].ms < 5000, `covered click took ${r['overlay.click'].ms} ms`)
    assert.match(r['disabled.click'].text, /is disabled/)
    assert.match(r['blocked.open'].text, /anti-bot check/)
    assert.match(r['notfound.open'].text, /^HTTP 404/)
    assert.match(r['dns.open'].text, /no site at does-not-exist\.invalid/)
    assert.equal(r['slow.open'].ok, false)
    assert.match(r['slow.open'].text, /didn't start loading within 6 s/)
    assert.match(r['shadow.find'].text, /button "Shadow button" \[ref=find-0\]/)
    assert.equal(r['iframe.clickWords'].ok, true, r['iframe.clickWords'].text)
    assert.match(r['hydrate.click'].text, /Nothing on the page changed after this click/)

    // The fourth identical failure on the same page is refused, reopened page or not.
    assert.match(r['loop.click3'].text, /has failed 3 times/)

    // Crash: reopened with a note; the other worker never noticed.
    assert.match(r['crash.next'].text, /crashed \(killed\) and was reopened on .*\/landing/)
    assert.equal(r['crash.after'].ok, true)
    assert.equal(r['crash.other'].ok, true)
    assert.doesNotMatch(r['crash.other'].text, /crashed/)

    assert.match(r['abort.open'].text, /Stopped by the user/)
    assert.ok(r['abort.open'].ms < 4000)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})
