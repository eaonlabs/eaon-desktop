/**
 * Automations (features/scheduler) with a cron schedule: written in the
 * editor, previewed as a sentence with its next runs, saved, and shown on
 * the task's card. Nothing runs: the expression is a Monday-morning one and
 * the task is checked straight after saving.
 */
import assert from 'node:assert/strict'
import { scenario } from './fixtures.mjs'

scenario('automations: a cron schedule with its own time zone', { timeout: 90_000 }, async (s) => {
  const app = await s.launch()
  const page = app.page

  await page.click('.mode-switch__option', { text: 'Workers' })
  await page.click('.nav-item', { text: 'Automations' })
  await page.find('.page__title', { text: 'Automations' })
  await page.click('.btn--primary', { text: 'New automation' })

  await page.fill('.sched-field input.input', 'Release notes')
  await page.fill('.sched-form__prompt', 'Summarise what merged last week.')
  await page.click('.segment__item', { text: 'Cron' })

  // A mistake is explained, and Create stays off.
  await page.fill('input[aria-label="Cron expression"]', '0 25 * * 1')
  await page.find('.sched-preview[data-error="true"]', { text: 'hour must be between 0 and 23' })
  assert.equal(await page.eval(() => [...document.querySelectorAll('.btn--primary')].find((b) => b.textContent?.trim() === 'Create')?.disabled), true)

  await page.fill('input[aria-label="Cron expression"]', '30 8 * * 1')
  await page.fill('input[aria-label="Time zone"]', 'Asia/Tokyo')
  await page.find('.sched-cron__reads', { text: 'Every Monday at 8:30 AM (Asia/Tokyo)' })
  await page.find('.sched-preview', { text: 'Next run' })
  const upcoming = await page.eval(() => document.querySelectorAll('.sched-upcoming li').length)
  assert.equal(upcoming, 2, 'the two runs after the next one are listed')
  // The dialog never scrolls sideways, even with focus in the right-hand box.
  const sideways = await page.eval(() => {
    const body = document.querySelector('.modal__body')
    return body ? body.scrollWidth - body.clientWidth + body.scrollLeft : -1
  })
  assert.equal(sideways, 0)
  await s.shot(page, 'automation-cron-editor')

  // A preset fills the expression in.
  await page.click('.sched-link', { text: 'Weekdays at 9' })
  await page.find('.sched-cron__reads', { text: 'Weekdays at 9:00 AM (Asia/Tokyo)' })

  await page.click('.btn--primary', { text: 'Create' })
  await page.find('.sched-list', { text: 'Weekdays at 9:00 AM (Asia/Tokyo)' })
  const saved = await page.eval(async () => (await window.api.scheduler.list()).find((t) => t.name === 'Release notes'))
  assert.deepEqual(saved?.schedule, { kind: 'cron', expr: '0 9 * * 1-5', tz: 'Asia/Tokyo' })
  assert.ok(saved?.enabled && typeof saved.nextRunAt === 'number' && saved.nextRunAt > Date.now(), 'it has a next run')
  // 9:00 in Tokyo (+09:00, no daylight saving) is 00:00 UTC.
  const next = new Date(saved.nextRunAt)
  assert.equal(next.getUTCHours(), 0)
  assert.equal(next.getUTCMinutes(), 0)
  await s.shot(page, 'automation-cron-saved')
})
