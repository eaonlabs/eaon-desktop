/**
 * Computer use on Cua Driver in the real app: with computer use on, a Work
 * turn is offered Cua's desktop tools (once Eaon knows them; the first turn
 * after a fresh install still has Eaon's own), a call reaches the bundled
 * driver Eaon started and its answer reaches the model, and Settings says
 * which engine is in use. Only a read-only tool is called: the test machine
 * hasn't given this Electron Accessibility, and nothing should be clicked.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { reply } from './fakeProvider.mjs'
import { openSettings, scenario, sendMessage, useFakeModel, waitForReply } from './fixtures.mjs'

const bundled = existsSync(new URL('../../resources/cua-driver/' + (process.platform === 'darwin' ? 'darwin' : `${process.platform}-${process.arch}`), import.meta.url))

scenario('computer use runs on Cua Driver: its desktop tools are offered, a call reaches it, Settings names it', { timeout: 150_000, skip: bundled ? false : 'no bundled cua-driver' }, async (s) => {
  const fake = await s.fake()
  const app = await s.launch()
  const page = app.page
  await useFakeModel(page, fake)
  await page.eval(() => window.api.settings.patch({ approvalMode: 'auto' }))
  await page.eval(async () => {
    const settings = await window.api.settings.get()
    await window.api.settings.patch({ computerUse: { ...settings.computerUse, enabled: true } })
  })

  // First turn after a fresh install: Eaon's own tool, while Cua's list is fetched.
  fake.route(() => reply.text('First look.'))
  await sendMessage(page, 'Hello')
  await waitForReply(page, { text: /First look/, streaming: false })
  const first = fake.chats.at(-1).tools
  s.t.diagnostic(`first turn tools: ${first.filter((t) => /computer|desktop_/.test(t)).join(', ')}`)
  assert.ok(first.includes('computer') || first.some((t) => t.startsWith('desktop_')), 'computer use is offered')

  // Cua has started and listed its tools: saved beside Eaon's data.
  const cuaHome = join(s.profileDir, 'cua-driver')
  const deadline = Date.now() + 30_000
  while (!(existsSync(cuaHome) && readdirSync(cuaHome).some((f) => /^tools-.*\.json$/.test(f))) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
  assert.ok(existsSync(cuaHome) && readdirSync(cuaHome).some((f) => /^tools-.*\.json$/.test(f)), 'Cua’s tool list is kept')

  // The next turn has Cua's tools, not Eaon's own; a read-only one is called and answers.
  fake.route((req) => {
    if (req.toolResultsSinceUser === 0) return reply.tool('desktop_get_screen_size', {}, 'Checking the screen. ')
    const result = req.messages.filter((m) => m.role === 'tool').at(-1)
    const said = typeof result?.content === 'string' ? result.content : JSON.stringify(result?.content ?? '')
    return reply.text(`Cua said: ${said.slice(0, 160)}`)
  })
  await sendMessage(page, 'How big is my screen?')
  const answered = await waitForReply(page, { text: /Cua said:/, streaming: false, timeout: 60_000 })
  const second = fake.chats.find((c) => c.lastUser.includes('How big'))?.tools ?? []
  s.t.diagnostic(`second turn tools: ${second.filter((t) => /computer|desktop_/.test(t)).join(', ')}`)
  for (const name of ['desktop_get_window_state', 'desktop_click', 'desktop_type_text', 'desktop_list_apps']) assert.ok(second.includes(name), `offers ${name}`)
  assert.ok(!second.includes('computer'), 'Eaon’s own tool is not offered beside Cua’s')
  assert.ok(!second.some((t) => /desktop_(browser_|start_recording|set_config|check_for_update|install_)/.test(t)), 'nothing Eaon leaves out')
  assert.match(answered.text, /Main display: \d+x\d+/, `the driver answered: ${answered.text}`)
  await s.shot(page, 'cua-answered')

  // Settings names the engine.
  await openSettings(page, 'Computer use')
  const engine = await page.find('.settings__inner', { text: /Cua Driver \d+\.\d+/ })
  assert.ok(engine)
  await s.shot(page, 'settings-engine')
  await page.click('.settings__back')
  await page.waitFor(() => document.querySelector('.composer__input') !== null, { message: 'back at the chat' })

  // Turned off, the tools go, and so does the driver's process when Eaon quits (checked by the harness's leftover-process check).
  await page.eval(async () => {
    const settings = await window.api.settings.get()
    await window.api.settings.patch({ computerUse: { ...settings.computerUse, enabled: false } })
  })
  fake.route(() => reply.text('Off now.'))
  await sendMessage(page, 'And now?')
  await waitForReply(page, { text: /Off now/, streaming: false })
  assert.ok(!fake.chats.at(-1).tools.some((t) => t === 'computer' || t.startsWith('desktop_')), 'no computer tools with it off')
})
