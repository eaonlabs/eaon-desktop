import { test } from 'node:test'
import assert from 'node:assert/strict'
import { changesNothing, normalizeComputerInput, parseAction, riskReason } from '../src/main/features/computer/actions'
import { clipRect, displayUnchanged, frameFor, regionToScreen, toScreen, type Frame } from '../src/main/features/computer/geometry'
import { BROWSER_ACTIONS, captureFileName, chromeUserAgent, normalizeBrowserInput, normalizeCrawlUrl, skipCrawl } from '../src/main/features/workers/browser'
import { parseDevices, viewerCandidates } from '../src/main/features/simulator'
import { sameApp } from '../src/main/features/computer/tool'

/**
 * The pure parts of what widened the agent's reach: zooming the computer
 * tool into one window or region, saving screenshots, the site-capture
 * crawl's rules, and reading simctl's device list.
 */

const display = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 }

test('screenshot takes app, region and save_to, and refuses mixing them', () => {
  assert.deepEqual(parseAction({ action: 'screenshot', app: 'iPhone Mirroring' }), { action: 'screenshot', app: 'iPhone Mirroring' })
  assert.deepEqual(parseAction({ action: 'screenshot', region: [10, 20, 300, 200], save_to: 'shots/' }), {
    action: 'screenshot',
    region: [10, 20, 300, 200],
    saveTo: 'shots/'
  })
  assert.throws(() => parseAction({ action: 'screenshot', app: 'Simulator', region: [0, 0, 10, 10] }), /not both/)
  assert.throws(() => parseAction({ action: 'screenshot', region: [0, 0, 10] }), /\[x, y, width, height\]/)
  assert.throws(() => parseAction({ action: 'screenshot', display: 1, app: 'Simulator' }), /whole display/)
})

test('a screenshot saved to a file counts as a change; a plain one does not', () => {
  assert.equal(changesNothing({ action: 'screenshot' }), true)
  assert.equal(changesNothing({ action: 'screenshot', app: 'Simulator' }), true)
  assert.equal(changesNothing({ action: 'screenshot', save_to: 'a.png' }), false)
  assert.equal(changesNothing({ action: 'click' }), false)
})

test('a region of the latest screenshot maps to the screen rect it covers', () => {
  const frame = frameFor(display, 'balanced') // 1280×800 for 1440×900 points
  assert.deepEqual(regionToScreen(frame, [0, 0, 640, 400]), { x: 0, y: 0, width: 720, height: 450 })
  assert.throws(() => regionToScreen(frame, [0, 0, 0, 10]), /at least 1/)
})

test('clicks in a zoomed-in screenshot land inside the zoomed window', () => {
  // A 400×800 pt phone window at (520, 50), captured at 2× (800×1600 px) and sent at 640×1280.
  const zoomed: Frame = { displayId: 1, bounds: { x: 520, y: 50, width: 400, height: 800 }, display: display.bounds, width: 640, height: 1280 }
  assert.deepEqual(toScreen(zoomed, 0, 0), { x: 520, y: 50 })
  assert.deepEqual(toScreen(zoomed, 320, 640), { x: 720, y: 450 })
  assert.equal(displayUnchanged(zoomed, display), true, 'a zoomed frame is checked against its whole display')
  assert.equal(displayUnchanged(zoomed, { id: 1, bounds: { ...display.bounds, width: 1920 } }), false)
})

test('a window partly off its display is clipped to it', () => {
  assert.deepEqual(clipRect({ x: -50, y: 100, width: 400, height: 300 }, display.bounds), { x: 0, y: 100, width: 350, height: 300 })
  assert.equal(clipRect({ x: 2000, y: 0, width: 100, height: 100 }, display.bounds), null)
})

test('site capture treats fragments, trailing slashes and (by default) queries as the same page', () => {
  assert.equal(normalizeCrawlUrl('https://example.com/pricing/#plans', false), 'https://example.com/pricing')
  assert.equal(normalizeCrawlUrl('https://example.com/?ref=nav', false), 'https://example.com/')
  assert.equal(normalizeCrawlUrl('https://example.com/search?q=a', true), 'https://example.com/search?q=a')
  assert.equal(normalizeCrawlUrl('mailto:hi@example.com', false), null)
})

test('site capture never opens files or links that sign out, unsubscribe or delete', () => {
  assert.equal(skipCrawl('https://example.com/docs/guide.pdf'), true)
  assert.equal(skipCrawl('https://example.com/logout'), true)
  assert.equal(skipCrawl('https://example.com/account/sign-out'), true)
  assert.equal(skipCrawl('https://example.com/email/unsubscribe?id=4'), true)
  assert.equal(skipCrawl('https://example.com/blog/how-to-delete-files'), false, 'only a path segment that is the action itself')
  assert.equal(skipCrawl('https://example.com/features'), false)
})

test('captured pages are numbered in order and named after their path', () => {
  assert.equal(captureFileName(1, 'https://example.com/'), '001-home.png')
  assert.equal(captureFileName(12, 'https://example.com/Pricing/Team%20Plans'), '012-pricing-team-20plans.png')
})

test('simctl devices are read with a readable runtime name, unavailable ones left out', () => {
  const json = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
        { name: 'iPhone 17 Pro', udid: 'A', state: 'Booted', isAvailable: true },
        { name: 'iPhone 15', udid: 'B', state: 'Shutdown', isAvailable: false }
      ]
    }
  })
  assert.deepEqual(parseDevices(json), [{ name: 'iPhone 17 Pro', udid: 'A', state: 'Booted', runtime: 'iOS 26.5' }])
})

test('Xcode 27\'s DeviceHub is looked for first, then the old Simulator app', () => {
  const [hub, legacy] = viewerCandidates('/Applications/Xcode.app/Contents/Developer')
  assert.equal(hub.path, '/Applications/Xcode.app/Contents/Applications/DeviceHub.app')
  assert.equal(hub.windowApp, 'Device Hub')
  assert.equal(legacy.path, '/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app')
})

test('a screenshot of app "Simulator" finds the Device Hub window, and the other way round', () => {
  assert.equal(sameApp('Device Hub', 'Simulator'), true)
  assert.equal(sameApp('Simulator', 'Device Hub'), true)
  assert.equal(sameApp('iPhone Mirroring', 'iPhone Mirroring'), true)
  assert.equal(sameApp('Safari', 'Simulator'), false)
})

test('browser actions models guess are taken under their own names', () => {
  // The two calls a worker failed on.
  assert.deepEqual(normalizeBrowserInput({ action: 'new_tab', url: 'https://www.ubereats.com' }), { action: 'open', url: 'https://www.ubereats.com' })
  assert.equal(normalizeBrowserInput({ action: 'navigate', url: 'https://www.ubereats.com' }).action, 'open')
  assert.equal(normalizeBrowserInput({ action: 'goto', href: 'starbucks.com' }).url, 'starbucks.com')
  assert.equal(normalizeBrowserInput({ action: 'open', text: 'www.starbucks.com' }).url, 'www.starbucks.com')
  assert.deepEqual(normalizeBrowserInput({ action: 'fill', element: 'e12', value: 'latte' }), { action: 'type', element: 'e12', value: 'latte', ref: 'e12', text: 'latte' })
  assert.equal(normalizeBrowserInput({ action: 'Scroll Down' }).direction, 'down')
  assert.equal(normalizeBrowserInput({ action: 'scroll_up' }).direction, 'up')
  assert.equal(normalizeBrowserInput({ action: 'go_back' }).action, 'back')
  assert.equal(normalizeBrowserInput({ action: 'get_text' }).action, 'read')
  assert.equal(normalizeBrowserInput({ action: 'select_option', ref: 'e4', text: 'Grande' }).action, 'select')
  assert.equal(normalizeBrowserInput({ action: 'refresh' }).action, 'reload')
  assert.equal(normalizeBrowserInput({ action: 'keypress', keys: 'Enter' }).key, 'Enter')
  assert.equal(normalizeBrowserInput({ action: 'click', ref: 'not a ref' }).ref, 'not a ref', 'a ref that is not one is left for the tool to report')
  for (const action of BROWSER_ACTIONS) assert.equal(normalizeBrowserInput({ action }).action, action)
})

test('computer calls in Anthropic\'s computer-use shape are understood, and still checked for risk', () => {
  assert.deepEqual(parseAction(normalizeComputerInput({ action: 'left_click', coordinate: [640, 400] })), { action: 'click', x: 640, y: 400, button: 'left', clicks: 1 })
  assert.deepEqual(parseAction(normalizeComputerInput({ action: 'double_click', coordinate: [10, 20] })), { action: 'click', x: 10, y: 20, button: 'left', clicks: 2 })
  assert.equal((parseAction(normalizeComputerInput({ action: 'right_click', coordinate: [1, 2] })) as { button: string }).button, 'right')
  assert.deepEqual(parseAction(normalizeComputerInput({ action: 'mouse_move', coordinate: [5, 6] })), { action: 'move', x: 5, y: 6 })
  assert.deepEqual(parseAction(normalizeComputerInput({ action: 'left_click_drag', start_coordinate: [1, 2], coordinate: [30, 40] })), { action: 'drag', x: 1, y: 2, toX: 30, toY: 40 })
  assert.equal((parseAction(normalizeComputerInput({ action: 'key', text: 'Return' })) as { keys: string }).keys, 'Return')
  assert.deepEqual(parseAction(normalizeComputerInput({ action: 'scroll', coordinate: [100, 100], scroll_direction: 'down', scroll_amount: 5 })), { action: 'scroll', x: 100, y: 100, dx: 0, dy: 5 })
  assert.deepEqual(parseAction(normalizeComputerInput({ action: 'zoom', region: [100, 50, 300, 250] })), { action: 'screenshot', region: [100, 50, 200, 200] })
  assert.deepEqual(parseAction(normalizeComputerInput({ action: 'wait', duration: 2 })), { action: 'wait', seconds: 2 })
  assert.deepEqual(parseAction(normalizeComputerInput({ action: 'open_application', name: 'Safari' })), { action: 'open_app', app: 'Safari' })
  assert.notEqual(riskReason(normalizeComputerInput({ action: 'key', text: 'cmd+q' }), 'darwin'), null, 'a dangerous combo sent as text is still caught')
})

test('the agent browser introduces itself as plain Chrome', () => {
  const electron = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) eaon-desktop/2026.6.0 Chrome/146.0.7680.65 Electron/43.7.7 Safari/537.36'
  assert.equal(chromeUserAgent(electron), 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36')
  const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Eaon/2026.6.0 Chrome/146.0.7680.65 Electron/43.7.7 Safari/537.36'
  assert.equal(chromeUserAgent(windows), 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36')
})
