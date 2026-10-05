import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '../src/main/agent/tools'
import {
  botWallNote,
  BrowserFailures,
  browserTool,
  BrowserStepError,
  downloadNote,
  explainBrowserError,
  httpStatusNote,
  isSecretPath,
  MAX_ELEMENT_FAILURES,
  netErrorAdvice,
  normalizeBrowserInput,
  parseRefs,
  stripAnsi,
  type WorkerBrowsers
} from '../src/main/features/workers/browser'

/**
 * The agent browser's failures, as the model hears them. The browser itself
 * (Electron + BetterWright) is exercised by agentBrowser-live.test.ts against
 * a local site of difficult pages; these tests pin the rules and the copy
 * with a fake browser, so they run anywhere.
 */

const cwd = mkdtempSync(join(tmpdir(), 'eaon-browser-'))

function ctx(overrides: Partial<{ messageId: string; chatTitle: string; signal: AbortSignal }> = {}): ToolContext {
  return {
    request: { chatId: 'c1', messageId: overrides.messageId ?? 'm1', chatTitle: overrides.chatTitle ?? 'Chat', workerId: 'w1' },
    turn: { notes: [] },
    cwd,
    signal: overrides.signal ?? new AbortController().signal,
    emit: () => undefined,
    toolId: 't',
    depth: 0,
    readOnly: false,
    settings: {},
    progress: () => undefined,
    confirm: async () => true
  } as unknown as ToolContext
}

/** A stand-in for WorkerBrowsers that records calls and answers as a page would. */
function fakeBrowser(page: { url?: string; snapshot?: string; run?: (code: string) => string | Promise<string> } = {}) {
  const calls: string[] = []
  const state = {
    url: page.url ?? 'https://shop.test/cart',
    refs: new Map([['e2', { role: 'button', name: 'Checkout' }], ['e5', { role: 'textbox', name: 'Email' }]]),
    probe: { found: true, tag: 'BUTTON', type: '', disabled: false, editable: false } as unknown,
    popup: null as string | null,
    download: null as null | { url: string; filename: string; mime: string; size: number },
    notes: [] as string[],
    openOutcome: 'arrived' as 'arrived' | 'timeout',
    openError: null as Error | null
  }
  const fake = {
    url: () => state.url,
    describe: (_id: string, ref: unknown) => (typeof ref === 'string' ? state.refs.get(ref) : undefined),
    refsOf: () => state.refs,
    controlled: () => false,
    beginStep: () => calls.push('beginStep'),
    takeNotes: () => state.notes.splice(0),
    probe: async () => state.probe,
    locator: (_id: string, ref: string) => `page.locator('aria-ref=${ref}')`,
    pointAt: async () => undefined,
    run: async (_id: string, code: string) => {
      calls.push(code)
      return page.run ? page.run(code) : 'changed'
    },
    snapshot: async () => page.snapshot ?? `page page-1 ${state.url}\n- button "Checkout" [ref=e2]`,
    landed: async () => undefined,
    open: async (_id: string, url: string) => {
      calls.push(`open ${url}`)
      if (state.openError) throw state.openError
      if (state.openOutcome === 'arrived') state.url = url
      return state.openOutcome
    },
    openTimeoutMs: () => 30_000,
    takePopup: () => {
      const url = state.popup
      state.popup = null
      return url
    },
    takeDownload: () => {
      const download = state.download
      state.download = null
      return download
    },
    takeLoadError: () => null,
    pendingChooser: () => false,
    pageNoteDeep: async () => null,
    claim: async () => ({ ok: true as const, note: null })
  }
  return { browsers: fake as unknown as WorkerBrowsers, calls, state }
}

const textOf = (result: unknown): string => (typeof result === 'string' ? result : (result as { text: string }).text)
const isError = (result: unknown): boolean => typeof result === 'object' && result !== null && (result as { isError?: boolean }).isError === true

test('a page that failed to load says why and what to do, not a bare Chromium code', () => {
  assert.match(netErrorAdvice('ERR_SOCKS_CONNECTION_FAILED', 'https://nope.invalid/', false), /no site at nope\.invalid .*typos/)
  assert.match(netErrorAdvice('ERR_SOCKS_CONNECTION_FAILED', 'http://127.0.0.1:5/', true), /refused the connection or couldn't be reached/)
  assert.match(netErrorAdvice('ERR_INTERNET_DISCONNECTED', 'https://a.test/'), /offline/)
  assert.match(netErrorAdvice('ERR_EMPTY_RESPONSE', 'https://a.test/'), /dropped the connection/)
  assert.match(netErrorAdvice('ERR_CERT_DATE_INVALID', 'https://a.test/'), /certificate.*Don't look for a way around/)
  assert.match(netErrorAdvice('ERR_TOO_MANY_REDIRECTS', 'https://a.test/'), /redirecting in a loop/)
  assert.match(netErrorAdvice('ERR_SOMETHING_NEW', 'https://a.test/'), /ERR_SOMETHING_NEW.*Check the address/)
})

test('an HTTP error page is named, with the next step for each kind', () => {
  assert.equal(httpStatusNote(200), null)
  assert.match(httpStatusNote(401, 'Unauthorized')!, /^HTTP 401 Unauthorized: .*take control/)
  assert.match(httpStatusNote(404, 'Not Found')!, /no page at this address/)
  assert.match(httpStatusNote(429)!, /rate-limiting/)
  assert.match(httpStatusNote(503)!, /the site itself has a problem/)
})

test('anti-bot walls are recognised by title or text, and the agent is told to hand over rather than retry', () => {
  assert.match(botWallNote({ title: 'Just a moment...', status: 403 })!, /anti-bot check \("Just a moment\.\.\.", HTTP 403\).*Don't retry/)
  assert.ok(botWallNote({ title: 'Example', text: 'Our systems have detected unusual traffic from your computer network' }))
  assert.ok(botWallNote({ title: 'Access Denied' }))
  assert.equal(botWallNote({ title: 'Checkout — Shop', text: 'Your cart has 2 items' }), null)
})

test('Playwright failures become what failed, why and what next — no ANSI escapes or call logs', () => {
  const covered = explainBrowserError(
    new Error(
      "locator.click: Timeout 10000ms exceeded.\nCall log:\n\u001b[2m  - waiting for locator('aria-ref=e2')\u001b[22m\n\u001b[2m    - locator resolved to <button>Checkout</button>\u001b[22m\n\u001b[2m      - <div class=\"consent\">…</div> intercepts pointer events\u001b[22m"
    ),
    'click button "Checkout"',
    new Map([['e9', { role: 'button', name: 'Accept all' }]])
  )
  assert.match(covered.message, /something is covering it \(<div class="consent">…<\/div>\).*button "Accept all" \[ref=e9\]/)
  assert.doesNotMatch(covered.message, /\u001b|Call log/)

  const stale = explainBrowserError(new Error("locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('aria-ref=e3')"), 'click button "Alpha"')
  assert.match(stale.message, /no longer on the page/)
  assert.equal(stale.snapshot, true)

  assert.match(explainBrowserError(new Error('locator.ariaSnapshot: Target crashed'), 'snapshot').message, /crashed.*reopened on the same address/)
  assert.match(explainBrowserError(new Error('Execution context was destroyed, most likely because of a navigation'), 'click link "Next"').message, /moved to another address/)
  assert.match(explainBrowserError(new Error('    - element is not enabled\nTimeout 10000ms exceeded'), 'click button "Pay"').message, /it is disabled/)
  const unknown = explainBrowserError(new Error('Error: something odd\nmore'), 'press Enter')
  assert.match(unknown.message, /^Could not press Enter: something odd\. Take a snapshot/)
  assert.equal(stripAnsi('\u001b[2mhi\u001b[22m'), 'hi')
})

test('refs are read from diff snapshots too, with removed lines naming the element, not "-"', () => {
  const refs = parseRefs('diff vs previous snapshot (+1 -2)\n- - generic [active] [ref=e1]:\n-   - button "Alpha" [ref=e3]\n+ - button "Gamma" [ref=e6]')
  assert.deepEqual(refs.get('e3'), { role: 'button', name: 'Alpha' })
  assert.deepEqual(refs.get('e6'), { role: 'button', name: 'Gamma' })
  assert.deepEqual(refs.get('e1'), { role: 'generic', name: '' })
})

test('upload and download calls are understood under the names models guess', () => {
  assert.deepEqual(normalizeBrowserInput({ action: 'attach_file', ref: 'e3', file_path: 'cv.pdf' }).paths, ['cv.pdf'])
  assert.deepEqual(normalizeBrowserInput({ action: 'set_input_files', ref: 'e3', files: ['a.png', 'b.png'] }).paths, ['a.png', 'b.png'])
  assert.equal(normalizeBrowserInput({ action: 'download_file', url: 'https://a.test/f.pdf', save_as: 'docs/f.pdf' }).save_to, 'docs/f.pdf')
})

test('a file the page tried to download is described with how to save it', () => {
  const note = downloadNote({ url: 'https://a.test/report.pdf', filename: 'report.pdf', mime: 'application/pdf', size: 2_400_000 })
  assert.match(note, /file download \(report\.pdf, application\/pdf, 2\.3 MB\).*download \{url: "https:\/\/a\.test\/report\.pdf"\}/)
})

test('keys and credentials are never uploaded without the user; ordinary files are only risky', () => {
  for (const path of ['/Users/a/.ssh/id_ed25519', '/Users/a/.aws/credentials', '/w/.env', '/w/.env.local', '/Users/a/Library/Keychains/login.keychain-db', '/Users/a/.netrc']) {
    assert.equal(isSecretPath(path), true, path)
  }
  assert.equal(isSecretPath('/Users/a/Eaon/resume.pdf'), false)
  const { browsers } = fakeBrowser()
  const tool = browserTool(browsers, { idOf: () => 'w1', signInHint: '' })
  assert.equal(tool.catastrophic?.({ action: 'upload', ref: 'e3', path: '~/.ssh/id_rsa' }, ctx()), true)
  assert.equal(tool.catastrophic?.({ action: 'upload', ref: 'e3', path: 'resume.pdf' }, ctx()), false)
  assert.equal(tool.risky?.({ action: 'upload', ref: 'e3', path: 'resume.pdf' }, ctx()), true)
  assert.equal(typeof tool.mutating === 'function' && tool.mutating({ action: 'find', text: 'x' }, ctx()), false)
  assert.equal(typeof tool.mutating === 'function' && tool.mutating({ action: 'download', url: 'https://a.test/x' }, ctx()), true)
})

test('the same element failing on the same page is stopped after three tries, even with the page reopened in between', async () => {
  // The loop's own guard resets on every successful open, so open → click
  // (fails) → open → click (fails) used to go on for ever.
  const { browsers, calls } = fakeBrowser({
    run: (code) => {
      if (code.includes('.click(')) throw new Error("locator.click: Timeout 10000ms exceeded.\n  - <div id=\"modal\"></div> intercepts pointer events")
      return 'ok'
    }
  })
  const tool = browserTool(browsers, { idOf: () => 'w1', signInHint: '' })
  for (let i = 0; i < MAX_ELEMENT_FAILURES; i++) {
    assert.equal(isError(await tool.run({ action: 'open', url: 'https://shop.test/cart' }, ctx())), false)
    const failed = await tool.run({ action: 'click', ref: 'e2' }, ctx())
    assert.equal(isError(failed), true)
    assert.match(textOf(failed), /something is covering it/)
  }
  await tool.run({ action: 'open', url: 'https://shop.test/cart' }, ctx())
  const clicksBefore = calls.filter((c) => c.includes('.click(')).length
  const refused = await tool.run({ action: 'click', ref: 'e2' }, ctx())
  assert.equal(isError(refused), true)
  assert.match(textOf(refused), /has failed 3 times.*Repeating it won't help/)
  assert.equal(calls.filter((c) => c.includes('.click(')).length, clicksBefore, 'the refused click never ran')
  // Another element is still allowed.
  assert.doesNotMatch(textOf(await tool.run({ action: 'click', ref: 'e5' }, ctx())), /has failed 3 times/)
})

test('typing into a form lets a button that failed be tried again', () => {
  const failures = new BrowserFailures()
  const key = failures.key('w1', 'https://a.test/form#x', 'click', 'button "Send"')
  for (let i = 0; i < 3; i++) failures.failed(key, 'disabled')
  assert.ok(failures.refuse(key, 'click button "Send"'))
  failures.pageChanged('w1', 'https://a.test/form')
  assert.equal(failures.refuse(key, 'click button "Send"'), null)
})

test('old failures are forgotten after ten minutes', () => {
  let now = 0
  const failures = new BrowserFailures(() => now)
  const key = failures.key('w1', 'https://a.test/', 'click', 'x')
  for (let i = 0; i < 3; i++) failures.failed(key, 'e')
  assert.ok(failures.refuse(key, 'click x'))
  now = 11 * 60_000
  assert.equal(failures.refuse(key, 'click x'), null)
})

test('a stale ref fails at once with the page as it is now, instead of waiting out the click', async () => {
  const { browsers, calls, state } = fakeBrowser({ snapshot: 'page page-1 https://shop.test/cart\n- button "Gamma" [ref=e6]' })
  state.probe = { found: false }
  const tool = browserTool(browsers, { idOf: () => 'w1', signInHint: '' })
  const result = await tool.run({ action: 'click', ref: 'e2' }, ctx())
  assert.equal(isError(result), true)
  assert.match(textOf(result), /button "Checkout" \(e2\) is no longer on the page.*\n\npage page-1.*Gamma/s)
  assert.equal(calls.some((c) => c.includes('.click(')), false)
  state.probe = { found: true, tag: 'BUTTON', type: '', disabled: true, editable: false }
  assert.match(textOf(await tool.run({ action: 'click', ref: 'e2' }, ctx())), /is disabled/)
  state.probe = { found: true, tag: 'DIV', type: '', disabled: false, editable: false }
  assert.match(textOf(await tool.run({ action: 'type', ref: 'e5', text: 'x' }, ctx())), /is a div, not a field that takes text/)
})

test('a link that opens a new tab is opened in place, and the agent is told', async () => {
  const { browsers, state, calls } = fakeBrowser({
    run: (code) => {
      if (code.includes('.click(')) state.popup = 'https://shop.test/terms'
      return 'changed'
    }
  })
  const tool = browserTool(browsers, { idOf: () => 'w1', signInHint: '' })
  const result = await tool.run({ action: 'click', ref: 'e2' }, ctx())
  assert.match(textOf(result), /^That opens https:\/\/shop\.test\/terms in a new tab\. There are no tabs here, so it opened in this one; use back to return\./)
  assert.ok(calls.includes('open https://shop.test/terms'))
})

test('a click that changed nothing says so; one that changed the page does not', async () => {
  let outcome = 'same'
  const { browsers } = fakeBrowser({ run: () => outcome })
  const tool = browserTool(browsers, { idOf: () => 'w1', signInHint: '' })
  assert.match(textOf(await tool.run({ action: 'click', ref: 'e2' }, ctx())), /^Nothing on the page changed after this click/)
  outcome = 'changed'
  assert.doesNotMatch(textOf(await tool.run({ action: 'click', ref: 'e2' }, ctx())), /Nothing on the page changed/)
})

test('opening a file link reports the download instead of the old page as if it were the new one', async () => {
  const { browsers, state } = fakeBrowser()
  // A file link: the load is given up for a download and the page stays where it was.
  ;(browsers as unknown as { open: (id: string, url: string) => Promise<'arrived'> }).open = async (_id, url) => {
    state.download = { url, filename: 'report.pdf', mime: 'application/pdf', size: 0 }
    return 'arrived'
  }
  const result = await tool(browsers).run({ action: 'open', url: 'https://shop.test/report.pdf' }, ctx())
  assert.match(textOf(result), /^That is a file download \(report\.pdf, application\/pdf\), not a page/)
  assert.equal(isError(result), true, 'the page did not change')
})

function tool(browsers: WorkerBrowsers) {
  return browserTool(browsers, { idOf: () => 'w1', signInHint: '' })
}

test('a page that never answers is stopped with where the browser still is', async () => {
  const { browsers, state } = fakeBrowser()
  state.openOutcome = 'timeout'
  const result = await tool(browsers).run({ action: 'open', url: 'https://slow.test/' }, ctx())
  assert.equal(isError(result), true)
  assert.match(textOf(result), /didn't start loading within 30 s.*still on https:\/\/shop\.test\/cart/)
})

test('a failed open hands back the advice as the result, not a thrown "Error:"', async () => {
  const { browsers, state } = fakeBrowser()
  state.openError = new BrowserStepError(netErrorAdvice('ERR_CONNECTION_REFUSED', 'https://down.test/'))
  const result = await tool(browsers).run({ action: 'open', url: 'https://down.test/' }, ctx())
  assert.equal(isError(result), true)
  assert.match(textOf(result), /^Could not open https:\/\/down\.test\/: down\.test refused the connection/)
})

test('what happened to the browser between steps (a crash and reopen) comes first in the next result', async () => {
  const { browsers, state } = fakeBrowser()
  state.notes.push("Your browser's page crashed (killed) and was reopened on https://shop.test/cart.")
  const result = await tool(browsers).run({ action: 'snapshot' }, ctx())
  assert.match(textOf(result), /^Your browser's page crashed \(killed\) and was reopened.*\n\npage page-1/s)
  assert.doesNotMatch(textOf(await tool(browsers).run({ action: 'snapshot' }, ctx())), /crashed/, 'told once')
})

test('a missing upload file is named, with where relative paths are looked for', async () => {
  const { browsers } = fakeBrowser()
  const result = await tool(browsers).run({ action: 'upload', ref: 'e2', path: 'nope.pdf' }, ctx())
  assert.equal(isError(result), true)
  assert.match(textOf(result), /there is no such file.*relative paths are in the work folder/)
  writeFileSync(join(cwd, 'cv.pdf'), 'x')
  let uploaded: string[] = []
  ;(browsers as unknown as { upload: (id: string, ref: string, files: string[]) => Promise<void> }).upload = async (_id, _ref, files) => {
    uploaded = files
  }
  const ok = await tool(browsers).run({ action: 'upload', ref: 'e2', path: 'cv.pdf' }, ctx())
  assert.equal(isError(ok), false)
  assert.deepEqual(uploaded, [join(cwd, 'cv.pdf')])
  assert.match(textOf(ok), /^Chose cv\.pdf in button "Checkout"/)
})

test('a browser shared by several chats is used by one run at a time, and the next is told the page may have moved', async () => {
  const { WorkerBrowsers } = await import('../src/main/features/workers/browser')
  const browsers = new WorkerBrowsers()
  const live = new Set(['run-A'])
  const signal = new AbortController().signal
  assert.deepEqual(await browsers.claim('agent', { id: 'run-A', label: 'Trip' }, (id) => live.has(id), signal, 100), { ok: true, note: null })
  const busy = await browsers.claim('agent', { id: 'run-B', label: 'Groceries' }, (id) => live.has(id), signal, 300)
  assert.equal(busy.ok, false)
  assert.match((busy as { text: string }).text, /busy: another conversation \("Trip"\) is using it/)
  setTimeout(() => live.delete('run-A'), 200)
  const after = await browsers.claim('agent', { id: 'run-B', label: 'Groceries' }, (id) => live.has(id), signal, 2000)
  assert.equal(after.ok, true)
  assert.match((after as { note: string }).note, /last used by another conversation \("Trip"\)/)
  // The same run again needs no wait and gets no note.
  assert.deepEqual(await browsers.claim('agent', { id: 'run-B', label: 'Groceries' }, (id) => live.has(id), signal, 0), { ok: true, note: null })
})
