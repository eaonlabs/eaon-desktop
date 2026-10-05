/**
 * Worker threads: a worker can work on a side task in a thread of its own
 * beside its main conversation, every run is listed in the Activity panel
 * (what woke it, the thread, how it ended), and the Workers search finds a
 * task by its title.
 *
 * The fake model holds a worker's streams open, labelled by thread (the side
 * task's message starts with "Side task"), so the runs overlap for as long
 * as the scenario needs them to.
 */
import assert from 'node:assert/strict'
import { reply } from './fakeProvider.mjs'
import { within } from './harness.mjs'
import { scenario, useFakeModel, waitForReply } from './fixtures.mjs'

const SIDE_TASK = 'Side task: list three risks to watch'

/** @param {import('./harness.mjs').Page} page */
async function openWorker(page, name) {
  await page.click('.mode-switch__option', { text: 'Workers' })
  await page.click('.nav-item--worker', { text: name })
  await page.waitFor((name) => document.querySelector('.worker-profile__name')?.textContent?.trim() === name, { args: [name], message: `${name}'s page` })
}

/** The thread tabs as shown: label, selected, and the state the tab carries. @param {import('./harness.mjs').Page} page */
function tabs(page) {
  return page.eval(() =>
    [...document.querySelectorAll('.worker-thread-tab')].map((tab) => ({
      label: tab.querySelector('.worker-thread-tab__label')?.textContent?.trim() ?? '',
      selected: tab.querySelector('[role="tab"]')?.getAttribute('aria-selected') === 'true',
      state: tab.getAttribute('data-state') ?? ''
    }))
  )
}

/**
 * A worker with its main thread and a side task both working, each on a held
 * stream. The worker uses the selected (fake) model.
 * @param {import('./fixtures.mjs').Scenario} s
 */
async function startTwoThreads(s) {
  const fake = await s.fake()
  const app = await s.launch()
  const page = app.page
  await useFakeModel(page, fake)
  fake.route((req) => {
    if (!req.worker) return reply.text('A side request answered.')
    return reply.hold(req.lastUser.includes('Side task') ? 'Side thread: working through the risks. ' : 'Main thread: drafting the report. ', req.lastUser.includes('Side task') ? 'side' : 'main')
  })
  const nova = await page.eval(() => window.api.workers.save({ name: 'Nova', color: '#3E86C6', personality: '', purpose: 'Researches things for the suite', model: null, access: 'autonomous', trading: null }))
  await openWorker(page, 'Nova')
  const main = fake.nextHeld((h) => h.label === 'main')
  await page.eval((id) => window.api.workers.send(id, 'Main job: draft the report'), nova.id)
  const mainStream = await main
  const side = fake.nextHeld((h) => h.label === 'side')
  const sent = await page.eval((id, text) => window.api.workers.send(id, text, [], { threadId: 'new' }), nova.id, SIDE_TASK)
  const sideStream = await side
  return { fake, app, page, nova, mainStream, sideStream, sideThreadId: sent.threadId }
}

scenario('a worker runs a side task beside its main thread; Stop only stops the thread it is on', { timeout: 150_000 }, async (s) => {
  const { page, mainStream, sideStream, sideThreadId } = await startTwoThreads(s)
  // Both at once: two open requests to the model for the one worker.
  assert.equal(mainStream.open && sideStream.open, true)
  assert.notEqual(sideThreadId, 'main', 'the side task got its own thread')

  await page.waitFor(() => document.querySelectorAll('.worker-thread-tab').length === 2, { message: 'the Main and side task tabs' })
  const shown = await tabs(page)
  s.t.diagnostic(`thread tabs: ${JSON.stringify(shown)}`)
  assert.equal(shown[0].label, 'Main')
  assert.match(shown[1].label, /risks/i, 'the side task is named after what it was asked')
  assert.deepEqual(shown.map((t) => t.state), ['running', 'running'], 'both threads show as working')
  await s.shot(page, 'main-and-side-working')

  // Each tab shows its own transcript.
  await page.click('.worker-thread-tab__main', { text: /risks/i })
  await waitForReply(page, { text: 'Side thread: working through the risks', streaming: true })
  assert.doesNotMatch(await page.eval(() => document.querySelector('.thread__inner')?.textContent ?? ''), /drafting the report/, "the side thread shows the main thread's reply")
  await s.shot(page, 'side-thread')

  // Stop on the side thread stops that run and leaves the main thread alone.
  await page.click('.worker-stop')
  await within(sideStream.closed, 5000, "Stop did not close the side thread's model request within 5 s")
  assert.equal(sideStream.aborted, true)
  assert.equal(mainStream.open, true, "stopping the side task closed the main thread's request too")
  await page.waitFor(() => document.querySelectorAll('.worker-thread-tab[data-state="running"]').length === 1, { message: 'only the main thread to still be working' })
  const afterStop = await tabs(page)
  assert.equal(afterStop.find((t) => t.label === 'Main')?.state, 'running', 'the main thread kept working')
  await s.shot(page, 'side-stopped-main-working')

  // The main thread finishes on its own.
  mainStream.finish('Main thread: the report is done.')
  await page.click('.worker-thread-tab__main', { text: /^Main$/ })
  await waitForReply(page, { text: 'the report is done', streaming: false, timeout: 20_000 })
  await page.waitFor(async () => (await window.api.workers.list()).every((w) => w.status !== 'working'), { message: 'no worker left working' })
})

scenario('the Activity panel lists each run with its state and the thread it ran in', { timeout: 150_000 }, async (s) => {
  const { page, nova, mainStream, sideStream, sideThreadId } = await startTwoThreads(s)
  await page.click('button', { text: /^Activity$/ })
  await page.find('.worker-activity')
  // Both runs are listed while they are still going.
  const running = await page.waitFor(
    () => {
      const runs = [...document.querySelectorAll('.worker-activity .worker-run')]
      return runs.length >= 2 && runs.filter((r) => r.getAttribute('data-state') === 'running').length === 2 ? runs.map((r) => r.textContent?.replace(/\s+/g, ' ').trim()) : null
    },
    { message: 'two running runs in the Activity panel' }
  )
  s.t.diagnostic(`while running:\n${running.join('\n')}`)
  await s.shot(page, 'activity-two-running')

  // One finishes, one is stopped: the panel says which is which.
  mainStream.finish('Main thread: done.')
  await page.eval((id, threadId) => window.api.workers.stop(id, threadId), nova.id, sideThreadId)
  await within(sideStream.closed, 5000, "Stop did not close the side thread's model request within 5 s")
  const ended = await page.waitFor(
    () => {
      const runs = [...document.querySelectorAll('.worker-activity .worker-run')]
      const states = runs.map((r) => r.querySelector('.worker-run__state')?.textContent?.trim())
      return runs.length === 2 && states.includes('Completed') && states.includes('Stopped')
        ? runs.map((r) => ({ state: r.querySelector('.worker-run__state')?.textContent?.trim(), label: r.querySelector('.worker-run__label')?.textContent?.trim(), meta: r.querySelector('.worker-run__meta')?.textContent?.trim() }))
        : null
    },
    { message: 'one Completed and one Stopped run in the Activity panel' }
  )
  s.t.diagnostic(`after: ${JSON.stringify(ended)}`)
  assert.ok(ended.every((r) => r.label), 'every run says what woke it')
  const sideRun = ended.find((r) => /risks/i.test(r.meta ?? ''))
  assert.ok(sideRun, 'the run that was in the side task says so ("in “…”")')
  assert.equal(sideRun.state, 'Stopped')
  await s.shot(page, 'activity-completed-and-stopped')

  // Main's records agree with what the panel shows.
  const executions = await page.eval((id) => window.api.workers.executions(id), nova.id)
  assert.deepEqual(executions.map((e) => e.state).sort(), ['cancelled', 'completed'])

  // "Open" on a run goes to the thread it ran in.
  await page.click('.worker-run .btn', { text: 'Open' })
  await page.waitFor(() => [...document.querySelectorAll('.worker-thread-tab')].some((t) => t.querySelector('[role="tab"]')?.getAttribute('aria-selected') === 'true'), { message: 'a thread to be open' })
})

scenario('the Workers search finds a task by its title and opens its thread', { timeout: 150_000 }, async (s) => {
  const { page, mainStream, sideStream, nova, sideThreadId } = await startTwoThreads(s)
  // Somewhere else first, so opening the result is a real navigation.
  await page.click('.worker-thread-tab__main', { text: /^Main$/ })
  await page.waitFor(() => document.querySelector('.worker-thread-tab [aria-selected="true"]')?.textContent?.includes('Main'), { message: 'the Main thread to be open' })

  await page.click('[aria-label="Search workers"]')
  await page.fill('input[placeholder="Search workers, tasks and questions"]', 'risk')
  const results = await page.waitFor(
    () => {
      const options = [...document.querySelectorAll('.worker-search__results [role="option"]')]
      return options.length ? options.map((o) => o.textContent?.replace(/\s+/g, ' ').trim()) : null
    },
    { message: 'search results for "risk"' }
  )
  s.t.diagnostic(`results for "risk": ${JSON.stringify(results)}`)
  await s.shot(page, 'search-results')
  const hit = results.find((r) => /risks/i.test(r ?? '') && /Nova · task/.test(r ?? ''))
  assert.ok(hit, `the task is not among the results: ${JSON.stringify(results)}`)
  assert.match(hit, /running/, 'the result says the task is still running')

  await page.click('.worker-search__results [role="option"]', { text: /Nova · task/ })
  await page.waitFor(() => /risks/i.test(document.querySelector('.worker-thread-tab [aria-selected="true"]')?.textContent ?? ''), { message: "the task's thread to open" })
  await waitForReply(page, { text: 'Side thread', streaming: true })
  await s.shot(page, 'search-opened-thread')

  // Nothing matching says so.
  await page.click('[aria-label="Search workers"]')
  await page.fill('input[placeholder="Search workers, tasks and questions"]', 'zzzzqx')
  await page.find('.menu__empty', { text: 'Nothing matches' })

  mainStream.finish()
  sideStream.finish()
  await page.eval((id, threadId) => window.api.workers.stop(id, threadId), nova.id, sideThreadId).catch(() => undefined)
})
