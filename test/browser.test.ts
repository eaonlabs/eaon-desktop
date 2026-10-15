import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ANNOTATE_SHORTCUT, browserKey, matchesBinding, type DesignNote, type KeyLike, type PickedElement } from '@shared/browser'
import { toUrl, hostOf, isLocalUrl } from '../src/renderer/src/components/browser/urls'
import { formatNotes, sourceText } from '../src/renderer/src/components/browser/designPrompt'
import { PICKER_SOURCE } from '../src/renderer/src/components/browser/picker'

/**
 * The in-app browser: the shortcuts a page hands to the panel, what the
 * address bar makes of what is typed, and the block of context Design Mode
 * sends to a coding agent.
 */

const key = (k: string, mods: Partial<Omit<KeyLike, 'key'>> = {}): KeyLike => ({ key: k, meta: false, ctrl: false, alt: false, shift: false, ...mods })

test('glyph bindings: ⌘ is Command on a Mac and Ctrl elsewhere', () => {
  assert.ok(matchesBinding(ANNOTATE_SHORTCUT, key('C', { meta: true, shift: true }), true))
  assert.ok(matchesBinding(ANNOTATE_SHORTCUT, key('c', { meta: true, shift: true }), true), 'case of the key does not matter')
  assert.ok(!matchesBinding(ANNOTATE_SHORTCUT, key('c', { ctrl: true, shift: true }), true))
  assert.ok(matchesBinding(ANNOTATE_SHORTCUT, key('C', { ctrl: true, shift: true }), false))
  assert.ok(!matchesBinding(ANNOTATE_SHORTCUT, key('c', { meta: true }), true), 'every modifier must match')
  assert.ok(matchesBinding('⌘L', key('l', { meta: true }), true))
})

test('named bindings recorded off the Mac, and cleared ones', () => {
  assert.ok(matchesBinding('Ctrl+Shift+C', key('C', { ctrl: true, shift: true }), false))
  assert.ok(matchesBinding('Ctrl+Alt+↑', key('ArrowUp', { ctrl: true, alt: true }), false))
  assert.ok(!matchesBinding('Ctrl+Shift+C', key('C', { ctrl: true }), false))
  assert.ok(!matchesBinding(null, key('c', { meta: true, shift: true }), true))
  assert.ok(!matchesBinding(undefined, key('c'), true))
})

test('browser keys inside a page', () => {
  assert.equal(browserKey(key('r', { meta: true }), true), 'reload')
  assert.equal(browserKey(key('w', { ctrl: true }), false), 'close-tab')
  assert.equal(browserKey(key('[', { meta: true }), true), 'back')
  assert.equal(browserKey(key('i', { meta: true, alt: true }), true), 'devtools')
  assert.equal(browserKey(key('f', { meta: true }), true), 'find')
  assert.equal(browserKey(key('r', { ctrl: true }), true), null, 'Ctrl+R on a Mac is the page’s')
  assert.equal(browserKey(key('r', { meta: true, shift: true }), true), null)
  assert.equal(browserKey(key('a'), true), null)
})

test('the address bar: addresses, local dev servers, a bare port, and searches', () => {
  assert.equal(toUrl('  '), null)
  assert.equal(toUrl('https://example.com/a'), 'https://example.com/a')
  assert.equal(toUrl('example.com'), 'https://example.com')
  assert.equal(toUrl('docs.example.co.uk/path?q=1'), 'https://docs.example.co.uk/path?q=1')
  assert.equal(toUrl('localhost:5173'), 'http://localhost:5173')
  assert.equal(toUrl('127.0.0.1:3000/app'), 'http://127.0.0.1:3000/app')
  assert.equal(toUrl('myapp.local'), 'http://myapp.local')
  assert.equal(toUrl('5173'), 'http://localhost:5173')
  assert.equal(toUrl('how to center a div'), 'https://duckduckgo.com/?q=how%20to%20center%20a%20div')
  assert.equal(hostOf('https://www.example.com/x'), 'example.com')
  assert.equal(hostOf('http://localhost:5173/'), 'localhost:5173')
  assert.ok(isLocalUrl('http://localhost:5173/'))
  assert.ok(isLocalUrl('http://[::1]:8080'))
  assert.ok(!isLocalUrl('https://localhost.example.com/'))
})

test('the picker parses as a script', () => {
  assert.doesNotThrow(() => new Function(PICKER_SOURCE))
})

const element = (patch: Partial<PickedElement> = {}): PickedElement => ({
  url: 'http://localhost:5173/',
  title: 'My app',
  selector: 'main > section.hero > button.btn.primary',
  label: 'button.btn.primary',
  components: ['Button', 'Hero', 'App'],
  source: { file: '/Users/me/app/src/components/Hero.tsx', line: 42, column: 7 },
  html: '<button class="btn primary">Get started</button>',
  parentTag: '<section class="hero">',
  text: 'Get started',
  styles: { 'font-family': 'Inter', color: 'rgb(255, 255, 255)', display: 'inline-flex' },
  rect: { x: 320.4, y: 480, width: 120, height: 40 },
  viewport: { width: 1280, height: 800 },
  ...patch
})

const note = (patch: Partial<DesignNote> = {}): DesignNote => ({
  id: 'n1',
  element: element(),
  screenshot: '/tmp/element-1.png',
  thumbnail: null,
  note: 'Make it larger\nand blue',
  createdAt: 0,
  ...patch
})

test('source locations read relative to the project', () => {
  assert.equal(sourceText(element().source, '/Users/me/app'), 'src/components/Hero.tsx:42:7')
  assert.equal(sourceText({ file: 'src/App.tsx', line: 3, approximate: true }, null), 'src/App.tsx:3 (approximate)')
  assert.equal(sourceText({ file: 'src/App.vue' }, null), 'src/App.vue')
  assert.equal(sourceText(null, '/x'), null)
})

test('notes for a terminal: one block with the request, source, styles and the screenshot’s path', () => {
  const text = formatNotes([note(), note({ id: 'n2', note: '', screenshot: null, element: element({ label: 'h1', source: null, components: [] }) })], {
    cwd: '/Users/me/app',
    screenshots: 'paths'
  })
  assert.match(text, /^Design Mode: 2 elements picked in the browser on http:\/\/localhost:5173\/ \(“My app”\)\./)
  assert.match(text, /1\. <button\.btn\.primary> — Make it larger and blue/)
  assert.match(text, /Source: src\/components\/Hero\.tsx:42:7/)
  assert.match(text, /Components: Button › Hero › App/)
  assert.match(text, /Box: 120×40 at 320,480 in a 1280×800 viewport/)
  assert.match(text, /Computed styles: display: inline-flex; color: rgb\(255, 255, 255\); font-family: Inter/, 'layout and colour first')
  assert.match(text, /Screenshot: \/tmp\/element-1\.png/)
  assert.match(text, /2\. <h1>\n/, 'a note with nothing written is still sent, as context')
  assert.ok(!/2\. <h1>[^\n]*Source/.test(text))
})

test('notes for the chat composer point at attached screenshots', () => {
  const text = formatNotes([note()], { screenshots: 'attached' })
  assert.match(text, /^Design Mode: 1 element/)
  assert.match(text, /Screenshot: attached \(1\)/)
  assert.ok(!text.includes('/tmp/element-1.png'))
  assert.equal(formatNotes([], { screenshots: 'paths' }), '')
})

test('notes from different pages say which page each is on', () => {
  const text = formatNotes([note(), note({ id: 'n2', element: element({ url: 'http://localhost:5173/settings' }) })], { screenshots: 'paths' })
  assert.match(text, /on 2 pages/)
  assert.match(text, /Page: http:\/\/localhost:5173\/settings/)
})
