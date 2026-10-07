/**
 * A worker's model and settings, where people look for them: the model
 * picked when it is made, an Edit button on its page, and a model chip on its
 * message box as in Chat. And its face: a click winks, the same every time.
 * Reported in 2026.6.2 Beta 2 as "you can't choose a model per worker" and
 * "you can't edit workers" (both were only in the More menu), and "worker
 * expressions when clicked on don't feel consistent" (a random pick).
 */
import assert from 'node:assert/strict'
import { scenario, useFakeModel, workers } from './fixtures.mjs'

/** @param {import('./harness.mjs').Page} page */
async function pickIn(page, trigger, label) {
  await page.click(trigger)
  await page.click('.ms__row[role="option"]', { text: label })
}

scenario('a worker’s model is chosen when it is made, from its message box, and from Edit; a click on its face always winks', { timeout: 150_000 }, async (s) => {
  const fake = await s.fake()
  fake.setModels(['fake-model', 'fake-model-two'])
  const app = await s.launch()
  const page = app.page
  await useFakeModel(page, fake)

  // Made with a model of its own.
  await page.click('.mode-switch__option', { text: 'Workers' })
  await page.click('[aria-label="New worker"]')
  await page.fill('.worker-editor input.input[placeholder="Nova"]', 'Ada')
  await page.fill('.worker-editor textarea.input[placeholder^="What it is for"]', 'Checks the edit flow')
  await pickIn(page, '.worker-editor .ms__trigger', /two/i)
  await page.click('.btn--primary', { text: 'Create worker' })
  await page.waitFor(() => document.querySelector('.worker-profile__name')?.textContent?.trim() === 'Ada', { message: "the new worker's page" })
  let ada = (await workers(page)).find((w) => w.name === 'Ada')
  assert.deepEqual(ada?.model, { providerId: 'lm-studio', modelId: 'fake-model-two' })

  // The message box shows its model, and changes it.
  const chip = '.composer .ms__trigger.chip--model'
  assert.match((await page.eval((sel) => document.querySelector(sel)?.textContent, chip)) ?? '', /fake model two/i)
  await s.shot(page, 'worker-model-chip')
  await pickIn(page, chip, /^fake model$/i)
  await page.waitFor(async () => (await window.api.workers.list()).find((w) => w.name === 'Ada')?.model?.modelId === 'fake-model', { message: 'the chip’s choice to be saved' })
  await pickIn(page, chip, /Chat’s model/)
  await page.waitFor(async () => (await window.api.workers.list()).find((w) => w.name === 'Ada')?.model === null, { message: '“Chat’s model” to clear it' })

  // Edit is a button on its page now, not only in More — and both are on screen.
  // The header clips what doesn't fit, and at an ordinary window size it had
  // pushed Edit and More out of sight.
  const reach = await page.eval(() => {
    const side = document.querySelector('.worker-actions')?.closest('.topbar__side')?.getBoundingClientRect()
    const inside = (label) => {
      const r = document.querySelector(`.worker-actions [aria-label="${label}"]`)?.getBoundingClientRect()
      return Boolean(r && side && r.width > 0 && r.left >= side.left - 1 && r.right <= side.right + 1 && r.right <= window.innerWidth)
    }
    return { window: window.innerWidth, edit: inside('Edit'), more: inside('More'), activity: inside('Activity'), pause: inside('Pause') }
  })
  s.t.diagnostic(`header actions on screen: ${JSON.stringify(reach)}`)
  assert.deepEqual([reach.edit, reach.more, reach.activity, reach.pause], [true, true, true, true])
  await page.click('.worker-actions [aria-label="Edit"]')
  await page.find('.modal__title', { text: 'Edit Ada' })
  await s.shot(page, 'edit-from-header')
  await page.fill('.worker-editor input.input[placeholder="Nova"]', 'Ada Two')
  await pickIn(page, '.worker-editor .ms__trigger', /two/i)
  await page.click('.btn--primary', { text: 'Save' })
  await page.waitFor(() => !document.querySelector('.modal'), { message: 'the editor to close' })
  ada = (await workers(page)).find((w) => w.id === ada?.id)
  assert.equal(ada?.name, 'Ada Two')
  assert.deepEqual(ada?.model, { providerId: 'lm-studio', modelId: 'fake-model-two' })

  // Its face winks at every click, not a random look each time.
  const face = '.worker-profile svg.wf'
  for (let i = 0; i < 3; i++) {
    await page.click(face)
    const look = await page.waitFor(
      (sel) => {
        const svg = document.querySelector(sel)
        return svg?.querySelector('.wf-focus[data-wink]') ? svg.getAttribute('data-mood') : null
      },
      { args: [face], message: `wink ${i + 1}`, timeout: 3000 }
    )
    assert.equal(look, 'happy', `click ${i + 1}`)
    await page.waitFor((sel) => !document.querySelector(sel)?.querySelector('.wf-focus[data-wink]'), { args: [face], message: 'the wink to end', timeout: 4000 })
  }
  assert.deepEqual(app.pageErrors().filter((e) => /exception/i.test(e)), [])
})
