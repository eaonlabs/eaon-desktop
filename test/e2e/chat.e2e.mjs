/**
 * Chat against the fake model: a streamed reply, Stop in the middle of one,
 * what survives a quit and a crash, and what the user is told when the
 * provider fails or can't be reached.
 */
import assert from 'node:assert/strict'
import { reply } from './fakeProvider.mjs'
import { within } from './harness.mjs'
import { checkIsolated, lastReply, scenario, sendMessage, useFakeModel, waitForReply } from './fixtures.mjs'

/** Words that only ever appear in a reply that says nothing useful. */
const VAGUE = /something went wrong|unknown error|^error$|undefined|\[object Object\]/i

scenario('chat streams a reply, Stop ends one mid-stream, and both survive quit and relaunch', { timeout: 120_000 }, async (s) => {
  const fake = await s.fake()
  const app = await s.launch()
  await checkIsolated(app)
  const page = app.page
  await useFakeModel(page, fake)

  // A whole reply, streamed in several chunks.
  fake.route(() => reply.text('The quick brown fox jumps over the lazy dog, streamed in pieces.', { delayMs: 40 }))
  await sendMessage(page, 'Tell me about the fox')
  const done = await waitForReply(page, { text: 'over the lazy dog', streaming: false })
  assert.equal(done.error, '')
  assert.equal(fake.chats.at(-1)?.lastUser, 'Tell me about the fox')
  await s.shot(page, 'streamed-reply')

  // A reply held open by the server, stopped by the user part way through.
  fake.route(() => reply.hold('Counting slowly: one, '))
  await sendMessage(page, 'Count to a hundred')
  const held = await fake.nextHeld()
  held.write('two, three, ')
  await waitForReply(page, { text: 'two, three', streaming: true })
  await page.find('[aria-label="Stop"]')
  await s.shot(page, 'streaming-with-stop')
  await page.click('[aria-label="Stop"]')
  // Stop must reach the provider: the request is aborted, not left running.
  await within(held.closed, 5000, 'Stop did not close the provider request within 5 s')
  assert.equal(held.aborted, true, 'the held request should have been aborted by Stop')
  const stopped = await waitForReply(page, { text: 'two, three', streaming: false })
  assert.equal(stopped.error, '', 'stopping is not an error')
  await page.find('.send[aria-label="Send"]')
  await s.shot(page, 'stopped')

  // Quit the way the menu does; both replies are on disk and come back.
  const quit = await app.quit()
  assert.ok(quit.code === 0 || quit.forced, `exit code ${quit.code}`)
  s.t.diagnostic(`quit: Eaon finished in ${quit.appMs} ms, the process was gone after ${quit.ms} ms${quit.forced ? ' (killed: Electron was slow to exit after Eaon had quit)' : ''}`)
  assert.ok(quit.appMs !== null && quit.appMs < 10_000, `Eaon's quit took ${quit.appMs} ms`)
  const saved = JSON.stringify(app.readStore('chats.json'))
  assert.match(saved, /over the lazy dog/)
  assert.match(saved, /Count to a hundred/)

  const again = await s.relaunch(app)
  const page2 = again.page
  // Both messages are in the one chat: the fox reply is the first answer and
  // the stopped one is the last, so the last reply can't be used to find it.
  await page2.click('.nav-item', { text: 'Tell me about the fox' })
  await page2.waitFor(() => [...document.querySelectorAll('.msg--assistant')].some((el) => /over the lazy dog/.test(el.textContent ?? '')), {
    message: 'the fox reply to come back after the relaunch'
  })
  await page2.find('.msg-user-block', { text: 'Count to a hundred' })
  assert.equal(await page2.eval(() => document.querySelectorAll('[data-streaming], .loading-state').length), 0)
  await s.shot(page2, 'after-relaunch')

  await s.t.test('a stopped reply keeps the words it had after quit and relaunch', {
    todo: 'Bug (chat persistence, renderer state/store.ts): stop() clears streamingMessageId before the run reports back, so the stopped reply is treated as another window\'s and never saved; quit then loses it and it comes back as "No response".'
  }, async () => {
    assert.match(saved, /two, three/, 'chats.json has the stopped reply\'s text')
    const restored = await waitForReply(page2, { text: 'two, three', streaming: false, timeout: 3000 })
    assert.equal(restored.error, '')
  })
})

scenario('a crash mid-stream leaves nothing stuck streaming after relaunch', { timeout: 120_000 }, async (s) => {
  const fake = await s.fake()
  const app = await s.launch()
  const page = app.page
  await useFakeModel(page, fake)
  fake.route(() => reply.hold('These words were on screen when Eaon died. '))
  await sendMessage(page, 'Start something long')
  const held = await fake.nextHeld()
  await waitForReply(page, { text: 'on screen when Eaon died', streaming: true })
  await s.shot(page, 'streaming-before-crash')

  await app.kill()
  // The helpers (renderer, GPU, network) go with it.
  assert.deepEqual(await app.orphans(), [], 'Electron helpers outlived a killed main process')
  await held.closed
  assert.equal(held.aborted, true)

  fake.route(() => reply.text('Back after the crash.'))
  const again = await s.relaunch(app)
  const page2 = again.page
  await page2.click('.nav-item', { text: 'Start something long' })
  const after = await page2.waitFor(
    () => {
      const rows = [...document.querySelectorAll('.msg-row')].filter((row) => !row.matches('.msg-user-block'))
      return rows.length ? { all: rows.at(-1)?.textContent?.trim() ?? '' } : null
    },
    { message: 'the interrupted reply to render' }
  )
  s.t.diagnostic(`after the crash the reply shows: ${JSON.stringify(after.all)}`)
  // Nothing animates or offers Stop for a run that no longer exists.
  assert.equal(await page2.eval(() => document.querySelectorAll('[data-streaming], .loading-state, [aria-label="Stop"]').length), 0, 'a reply is still shown as streaming after the crash')
  await s.shot(page2, 'after-crash-relaunch')

  await s.t.test('the reply says it was interrupted rather than "No response"', {
    todo: 'Product gap (chat persistence): a reply cut off by a crash comes back as "No response" and the words that had streamed are lost, because deltas are only saved when the turn ends. Expected: the partial text, marked as interrupted.'
  }, async () => {
    const shown = await lastReply(page2)
    assert.doesNotMatch(shown?.all ?? '', /^No response$/)
    assert.match(shown?.all ?? '', /on screen when Eaon died|interrupt|stopped|closed/i)
  })

  // The chat still works: a new message in the same chat gets an answer.
  await sendMessage(page2, 'Are you back?')
  await waitForReply(page2, { text: 'Back after the crash', streaming: false })
  await s.shot(page2, 'recovered')
})

scenario('provider errors end the reply with a specific message', { timeout: 150_000 }, async (s) => {
  const fake = await s.fake()
  const app = await s.launch()
  const page = app.page
  await useFakeModel(page, fake)
  const quick = { 'retry-after-ms': '100' }
  const cases = [
    { name: '401', route: () => reply.status(401, 'Invalid API key provided'), expect: /401|key|auth|unauthori[sz]ed|rejected/i },
    { name: '429', route: () => reply.status(429, 'Rate limit reached for requests', quick), expect: /429|rate|limit|busy|too many/i },
    { name: '500', route: () => reply.status(500, 'The server had an error while processing your request', quick), expect: /500|server|provider|error/i },
    { name: 'malformed', route: () => reply.malformed(), expect: /./ },
    { name: 'dropped', route: () => reply.drop('Half a sent'), expect: /./ }
  ]
  const seen = []
  for (const c of cases) {
    fake.route(c.route)
    await page.click('.nav-item', { text: /^New chat$/ })
    await page.find('.composer__input')
    await sendMessage(page, `Trigger ${c.name}`)
    // Retries for 429/5xx are kept short by retry-after-ms; anything longer than this is a hang.
    const shown = await page.waitFor(
      () => {
        const rows = [...document.querySelectorAll('.msg-row')].filter((row) => !row.matches('.msg-user-block'))
        const row = rows.at(-1)
        if (!row || row.querySelector('[data-streaming], .loading-state')) return null
        return { error: row.querySelector('.msg__error')?.textContent?.trim() ?? '', all: row.textContent?.trim() ?? '' }
      },
      { timeout: 45_000, message: `the ${c.name} reply to finish` }
    )
    seen.push(`${c.name}: ${JSON.stringify(shown.error || shown.all)} (${fake.chats.filter((r) => r.lastUser === `Trigger ${c.name}`).length} requests)`)
    await s.shot(page, `error-${c.name}`)
    const message = shown.error || shown.all
    assert.ok(message, `${c.name}: the reply shows nothing at all`)
    assert.doesNotMatch(message, VAGUE, `${c.name}: the message is vague: ${message}`)
    assert.match(message, c.expect, `${c.name}: the message doesn't say what happened: ${message}`)
  }
  s.t.diagnostic(`messages shown:\n${seen.join('\n')}`)
  await page.find('.send')
  assert.equal(await page.eval(() => document.querySelectorAll('[aria-label="Stop"]').length), 0)
})

scenario('a provider that cannot be reached fails fast with a specific error, also right after launch', { timeout: 120_000 }, async (s) => {
  const fake = await s.fake()
  const app = await s.launch()
  const page = app.page
  await useFakeModel(page, fake)
  // The model was found; now the server goes away (LM Studio quit, laptop offline).
  await page.eval((url) => window.api.providers.update('lm-studio', { baseUrl: url }), `http://127.0.0.1:${app.offlinePort}/v1`)
  await page.reload()
  const started = Date.now()
  await sendMessage(page, 'Anyone there?')
  const failed = await waitForReply(page, { error: true, streaming: false, timeout: 20_000 })
  const ms = Date.now() - started
  s.t.diagnostic(`unreachable provider: "${failed.error}" after ${ms} ms`)
  assert.doesNotMatch(failed.error, VAGUE)
  assert.match(failed.error, /reach|connect|refused|offline|running|start/i, `the error doesn't say the provider can't be reached: ${failed.error}`)
  assert.match(failed.error, /LM Studio|127\.0\.0\.1/, `the error doesn't say which provider: ${failed.error}`)
  await s.shot(page, 'unreachable')

  // Launching while it is still unreachable: the app comes up, nothing hangs.
  await app.quit()
  const launchedAt = Date.now()
  const again = await s.relaunch(app)
  const page2 = again.page
  await page2.find('.composer__input')
  const ready = Date.now() - launchedAt
  s.t.diagnostic(`offline launch: composer in ${ready} ms`)
  assert.ok(ready < 20_000, `launch with the provider offline took ${ready} ms`)
  await sendMessage(page2, 'Still there?')
  const offline = await waitForReply(page2, { error: true, streaming: false, timeout: 20_000 })
  assert.match(offline.error, /reach|connect|refused|offline|running|start|model/i, `offline launch: ${offline.error}`)
  await s.shot(page2, 'offline-launch')
})
