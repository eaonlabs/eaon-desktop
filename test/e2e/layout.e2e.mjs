/**
 * The window at its narrowest: the composer's Send button stays on screen
 * and clickable — on the home screen, in a long chat, with a long model name
 * and a long draft, and in a worker's composer.
 */
import assert from 'node:assert/strict'
import { reply } from './fakeProvider.mjs'
import { scenario, sendMessage, useFakeModel, waitForReply } from './fixtures.mjs'

const LONG_MODEL = 'an-extremely-long-model-identifier-that-goes-on-and-on-2026-preview-instruct-q8'

/**
 * Where the composer's Send button is, and whether a click at its centre
 * would reach it.
 * @param {import('./harness.mjs').Page} page
 */
function sendButton(page) {
  return page.eval(() => {
    const buttons = [...document.querySelectorAll('.send')].filter((b) => b.getBoundingClientRect().width > 0)
    const send = buttons.at(-1)
    if (!send) return { ok: false, why: 'no Send button' }
    const rect = send.getBoundingClientRect()
    const inside = rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    const reachable = Boolean(hit && (hit === send || send.contains(hit)))
    const composer = send.closest('.composer')?.getBoundingClientRect()
    return {
      ok: inside && reachable && rect.width >= 24,
      why: !inside ? 'outside the window' : !reachable ? `covered by ${hit?.className}` : rect.width < 24 ? 'squashed' : '',
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      composer: composer ? { x: Math.round(composer.x), w: Math.round(composer.width) } : null,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      overflow: document.documentElement.scrollWidth > window.innerWidth
    }
  })
}

scenario('a narrow window keeps the composer and its Send button usable', { timeout: 120_000 }, async (s) => {
  const fake = await s.fake()
  fake.setModels(['fake-model', LONG_MODEL])
  const app = await s.launch()
  const page = app.page
  await useFakeModel(page, fake, LONG_MODEL)

  const minimum = await page.minimumSize()
  const size = await page.resize(400, 400)
  s.t.diagnostic(`minimum window size ${minimum.join('×')}; resized to ${size.width}×${size.height}`)
  assert.ok(size.width <= 760, `the window can't be made narrower than ${size.width}px`)

  // Home, with a long draft in the box.
  await page.click('.composer__input')
  await page.type('A long draft that wraps across several lines in a narrow window. '.repeat(6))
  let send = await sendButton(page)
  s.t.diagnostic(`home: ${JSON.stringify(send)}`)
  assert.ok(send.ok, `home screen: Send is ${send.why}`)
  assert.equal(send.overflow, false, 'the page scrolls sideways')
  await s.shot(page, 'narrow-home')
  await page.press('Enter')

  // A long reply, then the composer under it.
  fake.route(() => reply.text(Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} of a long answer.`).join('\n\n'), { delayMs: 2 }))
  await page.waitFor(() => !document.querySelector('[data-streaming], .loading-state') && document.querySelectorAll('.msg-row').length > 0, { message: 'the first reply to end' })
  await sendMessage(page, 'Write a long answer')
  await waitForReply(page, { text: 'Paragraph 30', streaming: false })
  send = await sendButton(page)
  s.t.diagnostic(`chat: ${JSON.stringify(send)}`)
  assert.ok(send.ok, `chat: Send is ${send.why}`)
  await s.shot(page, 'narrow-chat')

  // The model chip with a long name is cut short, not pushing Send out.
  const chip = await page.eval(() => {
    const el = document.querySelector('.chip--model')?.getBoundingClientRect()
    const composer = document.querySelector('.composer')?.getBoundingClientRect()
    return el && composer ? { chipRight: el.right, composerRight: composer.right } : null
  })
  assert.ok(chip && chip.chipRight <= chip.composerRight, 'the model chip runs out of the composer')

  // A worker's composer.
  await page.eval(() => window.api.workers.save({ name: 'Narrow', color: '#3E86C6', personality: '', purpose: 'Checks narrow windows', model: null, access: 'autonomous', trading: null }))
  await page.click('.mode-switch__option', { text: 'Workers' })
  await page.click('.nav-item--worker', { text: 'Narrow' })
  await page.click('.composer__input')
  await page.type('A message to a worker in a narrow window, long enough to wrap twice. '.repeat(3))
  send = await sendButton(page)
  s.t.diagnostic(`worker: ${JSON.stringify(send)}`)
  assert.ok(send.ok, `worker composer: Send is ${send.why}`)
  await s.shot(page, 'narrow-worker')
})
