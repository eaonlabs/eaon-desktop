#!/usr/bin/env node
/**
 * The UI sweep: the built app, walked through every screen it can reach by
 * its own navigation and checked on each one (audit.mjs). Nothing is listed
 * by hand: each mode's sidebar places and every Settings page are read from
 * the app as it is, so a screen added tomorrow is swept tomorrow.
 *
 * Each screen is visited in several looks ("combos"): dark and light at the
 * default window size, dark at the smallest size the window allows, and
 * See-through over a bright wallpaper. On each it records the audit's
 * findings, the page's errors and failed loads, what the main process
 * logged as an error, main-thread stalls, how long the screen took to
 * settle, and a screenshot. A few flows go further than looking: a chat
 * reply with every kind of markdown, the / menu, the command palette, the
 * model menu and Settings search.
 *
 *   node test/sweep/ui-sweep.mjs            every combo (about 10 minutes)
 *   node test/sweep/ui-sweep.mjs --quick    dark at the default size only
 *   --out <dir>    where sweep.json and screens/ go (default out/sweep)
 *   --visible      put the window on screen (hidden by default: test/e2e/hidden.cjs)
 *
 * Like the end-to-end suite it runs on its own profile and HOME, against the
 * fake model server, with stand-ins for the coding CLIs (test/e2e/standins.mjs).
 * It never opens the Trading desk. Build first: `npx electron-vite build`.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '../..')
const args = process.argv.slice(2)
const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
const outDir = resolve(valueOf('--out') ?? join(root, 'out', 'sweep'))
const quick = args.includes('--quick')

// The harness reads these when it loads.
rmSync(outDir, { recursive: true, force: true })
process.env.EAON_E2E_ARTIFACTS = join(outDir, 'run')
process.env.EAON_E2E_SCREENS = join(outDir, 'screens')
if (!args.includes('--visible')) process.env.EAON_E2E_HIDDEN = '1'

const { launchApp } = await import('../e2e/harness.mjs')
const { startFakeProvider, reply } = await import('../e2e/fakeProvider.mjs')
const { useFakeModel, sendMessage, waitForReply } = await import('../e2e/fixtures.mjs')
const { writeStandIns } = await import('../e2e/standins.mjs')
const { auditPage, settlePage, watchLongTasks, takeLongTasks } = await import('./audit.mjs')

/** Places never opened: the Trading desk starts Claude Code on its own, and sidebar toggles hide what is being swept. */
const NEVER = /trading|sidebar|collapse|archive|delete|remove|sign out|log out|quit/i
/** Menus, dialogs and popovers: when one is open, the audit looks only inside it. */
const OVERLAY = '[role="menu"], [role="dialog"], [role="listbox"], .popover, .palette, .suggest-menu'
/** A main-process line worth reporting. */
const MAIN_ERROR = /\b(Error|TypeError|ReferenceError|RangeError|SyntaxError|Unhandled\w*|uncaught|EADDRINUSE|ENOENT|EACCES)\b/

/** A reply with every kind of markdown the chat draws. */
const RICH = [
  '# Release check',
  'Some **bold**, *italic*, `inline code` and a [link](https://eaon.dev).',
  '',
  '- One',
  '- Two',
  '  - Nested',
  '',
  '1. First',
  '2. Second',
  '',
  '| Feature | Status | Notes |',
  '| --- | --- | --- |',
  '| Chat | Ready | Streams, edits and branches |',
  '| Workers | Ready | Run in the background |',
  '',
  '```ts',
  'const answer: number = 42',
  'console.log(`The answer is ${answer}`)',
  '```',
  '',
  'Inline math $E = mc^2$ and a block:',
  '',
  '$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$',
  '',
  '```mermaid',
  'graph LR',
  '  A[Start] --> B{Ready?}',
  '  B -->|yes| C[Ship]',
  '  B -->|no| D[Fix]',
  '```',
  '',
  '> A quoted line.',
  '',
  `A long unbroken word: ${'x'.repeat(240)}`,
  '',
  'All done.'
].join('\n')

/** @type {any[]} */
const views = []
/** @type {{ name: string, ok: boolean, detail: string, screenshot?: string | null }[]} */
const flows = []
const started = Date.now()
const commit = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
})()

const standIns = writeStandIns(join(outDir, 'run', 'standins'))
process.env.PATH = `${standIns.bin}:${process.env.PATH}`
const fake = await startFakeProvider()
fake.route(() => reply.text(RICH, { delayMs: 1 }))

const profileDir = join(outDir, 'run', 'profile')
const homeDir = join(outDir, 'run', 'home')
const app = await launchApp({ name: 'sweep', profileDir, homeDir, env: standIns.env })
const page = app.page
/** Failed loads (a missing font, image or script), as the page's console reports them. */
const loadErrors = []
page.cdp.on('Log.entryAdded', ({ entry }) => {
  if (entry.level === 'error') loadErrors.push(`${entry.source}: ${entry.text}${entry.url ? ` (${entry.url})` : ''}`.slice(0, 400))
})
await page.cdp.send('Log.enable').catch(() => undefined)

let errorMark = 0
let loadMark = 0
let logMark = 0
/** What went wrong since the last call: page errors, failed loads, main-process errors. */
function takeErrors() {
  const page_ = page.errors.slice(errorMark)
  errorMark = page.errors.length
  const loads = loadErrors.slice(loadMark)
  loadMark = loadErrors.length
  const main = app.log
    .slice(logMark)
    .split('\n')
    .filter((line) => MAIN_ERROR.test(line) && !/DevTools listening|Debugger listening|\[e2e\]/.test(line))
    .map((line) => line.trim().slice(0, 400))
  logMark = app.log.length
  return { page: page_, loads, main }
}

const settle = (quiet = 350, max = 3500) => page.eval(settlePage, quiet, max)
const closeOverlays = async () => {
  for (let i = 0; i < 2; i++) await page.press('Escape').catch(() => undefined)
}

/**
 * Looks at the screen as it is now: audit, errors, stalls, screenshot.
 * @param {{ combo: string, area: string, label: string, kind: string, overlay?: string | null, skipContrast?: boolean, ms?: number, settled?: boolean }} view
 */
async function look(view) {
  const result = await page.eval(auditPage, { skipContrast: view.skipContrast ?? false, overlay: view.overlay ?? null }).catch((error) => ({
    issues: [{ kind: 'sweep', severity: 'warn', message: `The audit itself failed: ${error.message.split('\n')[0]}`, where: '' }],
    stats: null,
    heading: ''
  }))
  const errors = takeErrors()
  const stalls = (await page.eval(takeLongTasks).catch(() => [])).filter((t) => t.ms >= 200)
  const issues = [...result.issues]
  for (const error of errors.page) issues.push({ kind: 'js-error', severity: /^exception/.test(error) ? 'error' : 'warn', message: error.slice(0, 400), where: '' })
  for (const error of errors.loads) issues.push({ kind: 'load-error', severity: 'warn', message: error, where: '' })
  for (const line of errors.main) issues.push({ kind: 'main-error', severity: 'warn', message: line, where: '' })
  for (const stall of stalls) issues.push({ kind: 'stall', severity: stall.ms >= 1000 ? 'error' : 'warn', message: `The window froze for ${stall.ms} ms`, where: '' })
  if (view.settled === false) issues.push({ kind: 'busy', severity: 'info', message: `The screen kept changing for ${view.ms} ms (an animation or a poll that never stops)`, where: '' })
  const id = `${view.combo}--${view.area}--${view.label}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const screenshot = await page.screenshot(id).catch(() => null)
  views.push({ id, ...view, heading: result.heading, stats: result.stats, issues, screenshot: screenshot ? `screens/${id}.png` : null })
  const counts = ['error', 'warn'].map((s) => issues.filter((i) => i.severity === s).length)
  console.log(`  ${counts[0] ? '✗' : counts[1] ? '!' : '✓'} ${view.area} › ${view.label}${counts[0] || counts[1] ? `  (${counts[0]} errors, ${counts[1]} warnings)` : ''}`)
}

/** A step that couldn't be done, kept with a screenshot of where it got stuck. */
async function stuck(view, error, what) {
  const id = `${view.combo}--${view.area}--${view.label}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const shot = await page.screenshot(`${id}-stuck`).catch(() => null)
  views.push({ id, ...view, screenshot: shot ? `screens/${id}-stuck.png` : null, issues: [{ kind: 'sweep', severity: 'warn', message: `${what}: ${error.message.split('\n')[0]}`, where: '' }] })
}

/** Clicks a place in the sidebar by the name it shows (text, aria-label or title). */
async function clickPlace(label) {
  const point = await page.eval((label) => {
    for (const el of document.querySelectorAll('.sidebar .nav-item, .sidebar .foot-bar__btn, .sidebar .icon-btn')) {
      const name = (el.querySelector('.nav-item__label, .foot-bar__label')?.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '').trim()
      if (name !== label) continue
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      if (r.width === 0) continue
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }
    return null
  }, label)
  if (!point) throw new Error(`no sidebar place named "${label}"`)
  await page.mouse(point.x, point.y)
}

/** The places in the open mode's sidebar, by name. */
function places() {
  return page.eval(() => {
    const names = []
    for (const el of document.querySelectorAll('.sidebar .nav-item, .sidebar .foot-bar__btn, .sidebar .icon-btn')) {
      if (el.matches('.nav-item--project, .nav-item--sub, .nav-item--staggered, .nav-item--worker, .chat-thread, .nav-item__action')) continue
      if (el.closest('.nav-item--project, .chat-thread')) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const name = (el.querySelector('.nav-item__label, .foot-bar__label')?.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '').trim()
      if (name) names.push(name)
    }
    return [...new Set(names)]
  })
}

/** Back to a mode's home: its tab, the chat view, nothing open. */
async function home(tab) {
  await closeOverlays()
  // Settings takes the whole window; its way out is "Back to app".
  if (await page.eval(() => Boolean(document.querySelector('.settings__back')?.checkVisibility()))) await page.click('.settings__back')
  await page.click('.mode-switch__option', { text: tab })
  // A second click from a full-page view lands on the mode's home.
  await page.eval(() => document.querySelector('.mode-switch__option[aria-selected="true"]')?.click())
  return settle()
}

/**
 * Loads the window again, as after a settings change made behind its back:
 * a window hears about changes other windows make, not ones made through
 * window.api directly from inside it, so its own store would keep the old ones.
 */
async function reloadApp() {
  await page.reload()
  await page.waitFor(() => !document.querySelector('.splash'), { timeout: 15_000, message: 'the launch splash to go' })
  await page.eval(watchLongTasks)
  // Loading the page is its own long task; it isn't the next screen's.
  await settle()
  await page.eval(takeLongTasks)
}

async function setLook({ mode, size, seeThrough }) {
  await page.eval(
    async (mode, seeThrough) => {
      const current = await window.api.settings.get()
      const see = seeThrough ? { ...current.appearance.seeThrough, enabled: true, source: 'eaon', wallpaper: seeThrough } : { ...current.appearance.seeThrough, enabled: false }
      await window.api.settings.patch({ appearance: { ...current.appearance, mode, seeThrough: see } })
    },
    mode,
    seeThrough ?? null
  )
  await reloadApp()
  const actual = await page.resize(size[0], size[1])
  // The look really is what was asked for: the theme, and the wallpaper behind the window.
  const shown = await page.waitFor(
    (mode, see) => {
      const theme = document.documentElement.dataset.theme
      const seeing = document.body.dataset.seeThrough === 'on'
      return theme === mode && seeing === see ? { theme, seeing } : null
    },
    { args: [mode, Boolean(seeThrough)], timeout: 8000, message: `the window to show ${mode}${seeThrough ? ' with See-through' : ''}` }
  )
  await sleep(600)
  await settle()
  return { ...actual, ...shown }
}

/** Every screen in one look. */
async function sweep(combo, { settingsPages = true, overlays = true, placesToo = true, skipContrast = false } = {}) {
  for (const tab of ['Chat', 'Workers', 'ADE']) {
    const at = await home(tab)
    await look({ combo, area: tab, label: 'Home', kind: 'place', ms: at.ms, settled: at.settled, skipContrast })
    if (!placesToo) continue
    for (const label of await places()) {
      if (NEVER.test(label)) continue
      try {
        await home(tab)
        await clickPlace(label)
        const at = await settle()
        const overlay = (await openOverlay()) ? OVERLAY : null
        const view = { combo, area: tab, label, kind: 'place', ms: at.ms, settled: at.settled, skipContrast, overlay }
        await look(view)
        if (!overlay) await sweepTabs(view)
      } catch (error) {
        await stuck({ combo, area: tab, label, kind: 'place' }, error, "Couldn't open it")
      }
    }
    if (tab === 'Workers') {
      // The seeded worker's own screen.
      try {
        await home(tab)
        await page.click('.nav-item--worker', { text: 'Release checker' })
        const at = await settle()
        const view = { combo, area: tab, label: 'A worker', kind: 'place', ms: at.ms, settled: at.settled, skipContrast }
        await look(view)
        await sweepTabs(view)
      } catch (error) {
        await stuck({ combo, area: tab, label: 'A worker', kind: 'place' }, error, "Couldn't open the worker")
      }
    }
  }

  // The chat with the rich reply, as people will see it most.
  try {
    await home('Chat')
    await page.click('.sidebar .nav-item--staggered, .sidebar .chat-thread', { text: /./ })
    const at = await settle()
    await look({ combo, area: 'Chat', label: 'A conversation', kind: 'place', ms: at.ms, settled: at.settled, skipContrast })
  } catch (error) {
    await stuck({ combo, area: 'Chat', label: 'A conversation', kind: 'place' }, error, "Couldn't open the chat")
  }

  if (settingsPages) {
    await home('Chat')
    await clickPlace('Settings')
    await page.find('.settings__nav')
    // Read again after every page: a page can open sub-pages of its own under it (Workers' tabs).
    const visited = new Set()
    for (;;) {
      // A reload (after a tab changed a setting) lands back in the app: open Settings again.
      if (!(await page.eval(() => Boolean(document.querySelector('.settings__nav'))))) {
        await home('Chat')
        await clickPlace('Settings')
        await page.find('.settings__nav')
      }
      // A narrow window shows the list as icons: the names are in their labels and tooltips.
      const labels = await page.eval(() =>
        [...document.querySelectorAll('.settings__nav .nav-item')].map((el) => ((el.innerText || '').trim() || el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim()).filter(Boolean)
      )
      const label = labels.find((l) => !visited.has(l) && !/trading/i.test(l))
      if (label === undefined) break
      visited.add(label)
      try {
        await closeOverlays()
        if (!(await page.eval(() => Boolean(document.querySelector('.settings__nav'))))) {
          await home('Chat')
          await clickPlace('Settings')
        }
        await page.click('.settings__nav .nav-item', { text: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
        const titled = await page
          .waitFor((label) => document.querySelector('.settings__h1')?.textContent?.trim() === label, { args: [label], timeout: 4000, message: `Settings → ${label}` })
          .then(() => true)
          .catch(() => false)
        const at = await settle()
        await look({ combo, area: 'Settings', label, kind: 'settings', ms: at.ms, settled: at.settled, skipContrast })
        if (!titled) {
          const heading = await page.eval(() => document.querySelector('.settings__h1')?.textContent?.trim() ?? '(none)')
          views.at(-1).issues.push({ kind: 'nav', severity: 'info', message: `The page's heading is "${heading}", not its name in the list`, where: '' })
        }
        await sweepTabs({ combo, area: 'Settings', label, kind: 'settings', skipContrast })
      } catch (error) {
        await stuck({ combo, area: 'Settings', label, kind: 'settings' }, error, "Couldn't open it")
      }
    }
  }

  if (overlays) await sweepOverlays(combo, skipContrast)
}

/**
 * The screen's own tabs (Pull requests' All/Created, a Settings page's
 * sections, the model library's sources): each one not showing is opened
 * and looked at. On a Settings page a tab can be a setting (a style picker),
 * so the settings are put back afterwards.
 */
async function sweepTabs(view) {
  // Read again after every click: a tab can bring its own tabs, or take some away.
  const showing = () =>
    page.eval(() =>
      [...document.querySelectorAll('[role="tab"]')]
        .filter((el) => !el.closest('.mode-switch, [role="menu"], [role="dialog"], .popover') && el.getAttribute('aria-selected') !== 'true' && el.checkVisibility() && el.getBoundingClientRect().width > 0)
        .map((el) => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' '))
        .filter(Boolean)
    )
  if (!(await showing()).length) return
  const saved = view.kind === 'settings' ? await page.eval(() => window.api.settings.get()) : null
  const before = saved ? JSON.stringify(saved) : ''
  const seen = new Set()
  for (let n = 0; n < 12; n++) {
    const tab = (await showing()).find((t) => !seen.has(t) && !NEVER.test(t))
    if (tab === undefined) break
    seen.add(tab)
    try {
      // A label can break over lines (a count under it): any run of spaces matches.
      const pattern = tab.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')
      await page.click('[role="tab"]', { text: new RegExp(`^${pattern}$`), timeout: 4000 })
      const at = await settle()
      await look({ ...view, label: `${view.label} › ${tab}`, ms: at.ms, settled: at.settled, overlay: null })
    } catch (error) {
      await stuck({ ...view, label: `${view.label} › ${tab}` }, error, "Couldn't open the tab")
    }
  }
  // Put back what a tab changed, and load the window again so it shows what was put back.
  if (saved && JSON.stringify(await page.eval(() => window.api.settings.get())) !== before) {
    await page.eval((s) => window.api.settings.patch(s), saved)
    await reloadApp()
  }
}

/** Whether a menu, dialog or popover is open now. */
function openOverlay() {
  return page.eval((selector) => [...document.querySelectorAll(selector)].some((el) => el.getBoundingClientRect().width > 0 && el.checkVisibility?.()), OVERLAY)
}

async function sweepOverlays(combo, skipContrast) {
  const tries = [
    {
      label: 'Command palette',
      open: async () => {
        await page.press('Shift+Meta+k')
        if (!(await page.eval(() => Boolean(document.querySelector('.palette'))))) await page.press('Shift+Meta+K')
        await page.find('.palette', { timeout: 3000 })
        // Typed before its search has focus, the words would land in the message box.
        await page.waitFor(() => Boolean(document.activeElement?.closest('.palette')), { timeout: 2000, message: 'the palette’s search to have focus' })
        await page.type('settings')
      }
    },
    {
      label: 'Model menu',
      open: async () => {
        await page.click('.chip--model, .chip__model', { timeout: 4000 })
        await page.waitFor((s) => [...document.querySelectorAll(s)].some((el) => el.getBoundingClientRect().width > 0), { args: [OVERLAY], timeout: 3000, message: 'the model menu' })
      }
    },
    {
      label: 'Slash menu',
      open: async () => {
        // The menu opens for a / at the start, so the box starts empty.
        await page.click('.composer__input')
        await page.eval(() => document.querySelector('.composer__input')?.select?.())
        await page.press('Backspace')
        await page.type('/')
        await page.find('.suggest-menu', { timeout: 3000 })
      },
      close: async () => {
        await closeOverlays()
        await page.press('Backspace')
      }
    },
    {
      label: 'Add files and more',
      open: async () => {
        await page.click('[aria-label="Add files and more"]', { timeout: 4000 })
        await page.waitFor((s) => [...document.querySelectorAll(s)].some((el) => el.getBoundingClientRect().width > 0), { args: [OVERLAY], timeout: 3000, message: 'the + menu' })
      }
    }
  ]
  for (const t of tries) {
    try {
      await home('Chat')
      await t.open()
      const at = await settle(250, 2000)
      await look({ combo, area: 'Overlays', label: t.label, kind: 'overlay', overlay: OVERLAY, ms: at.ms, settled: at.settled, skipContrast })
    } catch (error) {
      await stuck({ combo, area: 'Overlays', label: t.label, kind: 'overlay' }, error, "Couldn't open it")
    } finally {
      await (t.close ?? closeOverlays)().catch(() => undefined)
    }
  }
}

/** A flow: something done, not only looked at. */
async function flow(name, fn) {
  try {
    const detail = (await fn()) ?? ''
    flows.push({ name, ok: true, detail })
    console.log(`  ✓ ${name}${detail ? `: ${detail}` : ''}`)
  } catch (error) {
    const shot = await page.screenshot(`flow-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`).catch(() => null)
    flows.push({ name, ok: false, detail: error.message.split('\n').slice(0, 3).join(' '), screenshot: shot ? `screens/flow-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png` : null })
    console.log(`  ✗ ${name}: ${error.message.split('\n')[0]}`)
  }
}

let quit = null
try {
  await page.waitForApp()
  await page.waitFor(() => !document.querySelector('.splash'), { timeout: 15_000, message: 'the launch splash to go' })
  await page.eval(watchLongTasks)
  console.log(`Eaon ${commit}: sweeping${quick ? ' (quick)' : ''}, hidden: ${process.env.EAON_E2E_HIDDEN === '1'}`)

  // Every coding CLI the app can find must be a stand-in; a real one could start turns on someone's plan.
  const engines = await page.eval(async () => (await window.api.engines.refresh(undefined, true)).map((e) => ({ id: e.id, installed: e.installed, path: e.path })))
  const real = engines.filter((e) => e.installed && e.path && !e.path.includes('/standins/bin/'))
  if (real.length) throw new Error(`Not isolated: the app found real CLIs (${real.map((e) => `${e.id} at ${e.path}`).join(', ')}); stopping before anything runs`)
  console.log(`Isolated: ${engines.filter((e) => e.installed).length} coding CLIs found, all stand-ins`)

  console.log('Flows')
  await flow('Point the chat at a model', async () => {
    await useFakeModel(page, fake)
    await page.eval(watchLongTasks)
    return 'the fake model is picked in the composer'
  })
  await flow('A reply with every kind of markdown', async () => {
    await sendMessage(page, 'Show me everything you can draw')
    await waitForReply(page, { text: 'All done.', streaming: false, timeout: 30_000 })
    await sleep(1500)
    const drawn = await page.eval(() => {
      const body = [...document.querySelectorAll('.msg--assistant')].filter((el) => (el.textContent || '').includes('All done.')).at(-1)
      if (!body) return { missing: ['the reply'] }
      const text = body.textContent || ''
      const missing = []
      if (!body.querySelector('table, [role="table"]')) missing.push('the table')
      if (!body.querySelector('pre code, pre')) missing.push('the code block')
      if (!body.querySelector('h1, h2, h3')) missing.push('the heading')
      if (!body.querySelector('.katex, math, mjx-container')) missing.push('the maths')
      // A diagram is drawn as an image of its SVG (MermaidBlock); one Mermaid couldn't read stays a code block with a note.
      const diagram = body.querySelector('.mermaid-block__img')
      if (!diagram || !diagram.complete || diagram.naturalWidth === 0) missing.push(`the mermaid diagram${/Couldn.t draw this diagram/.test(text) ? ' ("Couldn’t draw this diagram")' : ''}`)
      if (/\$\$/.test(text)) missing.push('maths drawn ($$ shows as text)')
      const wide = [...body.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > body.getBoundingClientRect().right + 2 && !el.closest('pre, .table-wrap, [data-scroll]'))
      if (wide.length) missing.push(`text past the message's edge (${wide.length} elements)`)
      return { missing }
    })
    await page.screenshot('flow-rich-reply')
    if (drawn.missing.length) throw new Error(`Not drawn: ${drawn.missing.join(', ')}`)
    return 'heading, lists, table, code, maths, diagram and a long word all drawn'
  })
  await flow('Settings search finds a setting', async () => {
    await home('Chat')
    await clickPlace('Settings')
    await page.find('.settings__nav')
    // A field at full width, a button that opens one when the window is narrow.
    if (!(await page.eval(() => Boolean(document.querySelector('.settings__search input')?.checkVisibility())))) await page.click('.settings__search-btn')
    await page.click('.settings__search input')
    await page.type('theme')
    const found = await page.waitFor(() => document.querySelectorAll('.settings__nav .nav-item, .settings__results *, [data-search-result]').length > 0 && (document.querySelector('.settings__nav')?.textContent || '').toLowerCase().includes('appearance'), {
      timeout: 4000,
      message: 'a search result for "theme"'
    })
    await page.screenshot('flow-settings-search')
    await closeOverlays()
    return found ? 'Appearance comes up for "theme"' : ''
  })
  await flow('Seed a worker and a project', async () => {
    await page.eval(() => window.api.workers.save({ name: 'Release checker', color: '#3E86C6', personality: '', purpose: 'Checks a release before it ships', model: null, access: 'autonomous', trading: null }))
    const folder = join(homeDir, 'Projects', 'demo-app')
    mkdirSync(join(folder, 'src'), { recursive: true })
    writeFileSync(join(folder, 'README.md'), '# demo-app\n\nA small project for the sweep.\n')
    writeFileSync(join(folder, 'src', 'index.ts'), 'export const hello = (name: string): string => `Hello, ${name}`\n')
    const git = (...a) => execFileSync('git', ['-c', 'user.name=Sweep', '-c', 'user.email=sweep@example.com', ...a], { cwd: folder, env: { ...process.env, HOME: homeDir } })
    git('init', '-q', '-b', 'main')
    git('add', '.')
    git('commit', '-qm', 'First commit')
    await page.eval(async (folder) => {
      const workspaces = await window.api.workspaces.get()
      const chat = workspaces.find((w) => w.kind === 'chat')
      const projects = await window.api.projects.get()
      await window.api.projects.save([...projects, { id: 'sweep-project', workspaceId: chat.id, name: 'demo-app', instructions: '', createdAt: Date.now(), folder }])
    }, folder)
    return 'a worker and a git project'
  })

  const combos = quick
    ? [{ name: 'dark', mode: 'dark', size: [1280, 820] }]
    : [
        { name: 'dark', mode: 'dark', size: [1280, 820] },
        { name: 'light', mode: 'light', size: [1280, 820] },
        { name: 'dark-small', mode: 'dark', size: [400, 400] },
        { name: 'see-through-dark', mode: 'dark', size: [1280, 820], seeThrough: 'dune', settingsPages: false, overlays: false, skipContrast: true },
        { name: 'see-through-light', mode: 'light', size: [1280, 820], seeThrough: 'dune', settingsPages: false, overlays: false, skipContrast: true }
      ]
  for (const combo of combos) {
    const size = await setLook(combo)
    console.log(`\n${combo.name} (${size.width}×${size.height})`)
    await sweep(combo.name, { settingsPages: combo.settingsPages ?? true, overlays: combo.overlays ?? true, skipContrast: combo.skipContrast ?? false })
  }
  await setLook({ mode: 'dark', size: [1280, 820] })

  console.log('\nMain process')
  const main = await app.main(() => {
    const { app } = require('electron')
    const metrics = app.getAppMetrics()
    return {
      memoryMB: Math.round(metrics.reduce((n, m) => n + m.memory.workingSetSize, 0) / 1024),
      processes: metrics.length,
      blocked: (globalThis.__e2eHidden ?? []).filter((r) => r.kind !== 'window').map((r) => `${r.kind}: ${typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)}`.slice(0, 200))
    }
  })
  quit = await app.quit()
  const orphans = await app.orphans()
  const summary = { ...main, quit, orphans }
  console.log(`  ${main.memoryMB} MB across ${main.processes} processes; quit in ${quit.ms} ms${quit.forced ? ' (forced)' : ''}; ${orphans.length} left behind`)
  writeFileSync(join(outDir, 'sweep.json'), JSON.stringify({ commit, startedAt: started, finishedAt: Date.now(), quick, views, flows, main: summary }, null, 2))
} catch (error) {
  console.error(`The sweep stopped: ${error.stack ?? error}`)
  writeFileSync(join(outDir, 'sweep.json'), JSON.stringify({ commit, startedAt: started, finishedAt: Date.now(), quick, views, flows, stopped: String(error.stack ?? error).slice(0, 2000) }, null, 2))
  process.exitCode = 1
} finally {
  if (app.running) await app.dispose({ reason: 'sweep ended' })
  await fake.close()
}

const all = views.flatMap((v) => v.issues ?? [])
const failedFlows = flows.filter((f) => !f.ok).length
console.log(`\n${views.length} screens, ${all.filter((i) => i.severity === 'error').length} errors, ${all.filter((i) => i.severity === 'warn').length} warnings; ${flows.length - failedFlows}/${flows.length} flows passed`)
console.log(`Results: ${join(outDir, 'sweep.json')}`)
if (all.some((i) => i.severity === 'error') || failedFlows) process.exitCode = 1
