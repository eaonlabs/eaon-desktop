/**
 * Workers: always-on agents with their own threads, run by the main process
 * (features/workers). A worker created in the UI answers a message; two
 * workers run at once, and stopping one leaves the other running.
 *
 * The fake model tells workers apart by their system prompt ("You are Ada,
 * one of the user's Eaon Workers"), and worker files go under the scenario's
 * own HOME/Eaon/Workers.
 */
import assert from 'node:assert/strict'
import { reply } from './fakeProvider.mjs'
import { within } from './harness.mjs'
import { scenario, useFakeModel, waitForReply, workers } from './fixtures.mjs'

/** @param {import('./harness.mjs').Page} page */
async function openWorkersTab(page) {
  await page.click('.mode-switch__option', { text: 'Workers' })
  await page.find('[aria-label="New worker"]')
}

/** @param {import('./harness.mjs').Page} page */
async function openWorker(page, name) {
  await page.click('.nav-item--worker', { text: name })
  await page.waitFor((name) => document.querySelector('.worker-profile__name')?.textContent?.trim() === name, { args: [name], message: `${name}'s page` })
}

/** @param {import('./harness.mjs').Page} page */
function workerState(page, name) {
  return page.eval(async (name) => {
    const worker = (await window.api.workers.list()).find((w) => w.name === name)
    const item = [...document.querySelectorAll('.nav-item--worker')].find((el) => el.textContent?.includes(name))
    return { status: worker?.status ?? null, running: Boolean(worker?.runningMessageId), spinner: Boolean(item?.querySelector('.spinner')) }
  }, name)
}

scenario('workers: create one in the UI, message it and get a reply', { timeout: 120_000 }, async (s) => {
  const fake = await s.fake()
  const app = await s.launch()
  const page = app.page
  await useFakeModel(page, fake)
  fake.route((req) => (req.worker ? reply.text(`${req.worker} here. Got: ${req.lastUser.split('\n').at(-1)?.slice(0, 60)}`) : reply.text('Hello from chat.')))

  await openWorkersTab(page)
  await s.shot(page, 'workers-empty')
  await page.click('[aria-label="New worker"]')
  await page.fill('.worker-editor input.input[placeholder="Nova"]', 'Ada')
  await page.fill('.worker-editor textarea.input[placeholder^="What it is for"]', 'Answers questions from the end-to-end suite')
  await s.shot(page, 'worker-editor')
  await page.click('.btn--primary', { text: 'Create worker' })
  await page.waitFor(() => document.querySelector('.worker-profile__name')?.textContent?.trim() === 'Ada', { message: "the new worker's page" })
  const created = (await workers(page)).find((w) => w.name === 'Ada')
  assert.ok(created, 'the worker was saved in main')
  // Nothing runs until it is given a job (no turn on creation).
  assert.equal(fake.chats.filter((r) => r.worker === 'Ada').length, 0)

  await page.click('.composer__input')
  await page.type('ping from the suite')
  await page.click('.send[aria-label="Send"]')
  const answered = await waitForReply(page, { text: /Ada here\. Got: .*ping from the suite/, streaming: false, timeout: 30_000 })
  assert.equal(answered.error, '')
  const request = fake.chats.find((r) => r.worker === 'Ada')
  assert.ok(request, 'the worker turn reached the model')
  assert.match(request.system, /Answers questions from the end-to-end suite/, "the worker's purpose is in its prompt")
  await page.waitFor(async () => (await window.api.workers.list()).find((w) => w.name === 'Ada')?.status !== 'working', { message: 'Ada to finish' })
  await s.shot(page, 'worker-replied')

  // The reply is on disk and survives a restart.
  await app.quit()
  const again = await s.relaunch(app)
  await openWorkersTab(again.page)
  await openWorker(again.page, 'Ada')
  await waitForReply(again.page, { text: 'Ada here', streaming: false })
})

scenario('two workers run at the same time; stopping one leaves the other running', { timeout: 150_000 }, async (s) => {
  const fake = await s.fake()
  const app = await s.launch()
  const page = app.page
  await useFakeModel(page, fake)
  fake.route((req) => (req.worker ? reply.hold(`${req.worker} is on it. `, req.worker) : reply.text('A side request answered.')))

  const ids = {}
  for (const name of ['Ada', 'Bo']) {
    const worker = await page.eval((name) => window.api.workers.save({ name, color: '#3E86C6', personality: '', purpose: `Long jobs for ${name}`, model: null, access: 'autonomous', trading: null }), name)
    ids[name] = worker.id
  }
  await openWorkersTab(page)
  await page.find('.nav-item--worker', { text: 'Bo' })

  await page.eval((ids) => Promise.all([window.api.workers.send(ids.Ada, 'Start the long job'), window.api.workers.send(ids.Bo, 'Start the long job')]), ids)
  const [ada, bo] = await Promise.all([fake.nextHeld((h) => h.label === 'Ada'), fake.nextHeld((h) => h.label === 'Bo')])
  // Both at once, not one after the other: both requests are open now.
  assert.equal(ada.open && bo.open, true)
  await page.waitFor(
    async () => {
      const list = await window.api.workers.list()
      const spinners = [...document.querySelectorAll('.nav-item--worker')].filter((el) => el.querySelector('.spinner')).length
      return list.filter((w) => w.status === 'working').length === 2 && spinners === 2
    },
    { message: 'both workers to show as working' }
  )
  await openWorker(page, 'Ada')
  await waitForReply(page, { text: 'Ada is on it', streaming: true })
  await s.shot(page, 'both-working')

  // Stop Ada from its page.
  await page.click('.worker-stop')
  await within(ada.closed, 5000, "Stop did not close Ada's model request within 5 s")
  assert.equal(ada.aborted, true)
  await page.waitFor(async () => (await window.api.workers.list()).find((w) => w.name === 'Ada')?.status !== 'working', { message: 'Ada to stop working' })
  assert.equal(bo.open, true, "stopping Ada closed Bo's request too")
  const boState = await workerState(page, 'Bo')
  assert.equal(boState.status, 'working', `Bo stopped when Ada was stopped: ${JSON.stringify(boState)}`)
  assert.equal(boState.spinner, true)
  await waitForReply(page, { streaming: false })
  await s.shot(page, 'ada-stopped-bo-working')

  // Bo finishes on its own.
  bo.write('Still going. ')
  bo.finish('Bo finished the long job.')
  await openWorker(page, 'Bo')
  await waitForReply(page, { text: 'Bo finished the long job', streaming: false, timeout: 20_000 })
  await page.waitFor(async () => (await window.api.workers.list()).every((w) => w.status !== 'working'), { message: 'no worker left working' })
  await s.shot(page, 'bo-finished')
})
