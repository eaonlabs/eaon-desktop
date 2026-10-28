/**
 * Auto-compact: a chat that nears the model's context window has its older
 * messages summarised before the next reply. The strip above the message box
 * shows how far the summary has got, as a percentage and a bar, says when
 * it's done, and the reply goes on from the summary.
 */
import assert from 'node:assert/strict'
import { reply } from './fakeProvider.mjs'
import { checkIsolated, scenario, sendMessage, useFakeModel, waitForReply } from './fixtures.mjs'

const isSummary = (req) => req.system.startsWith('Summarise the conversation so far')
/** A request message's words, whether its content is a string or parts. */
const words = (message) => (typeof message.content === 'string' ? message.content : (message.content ?? []).map((part) => part.text ?? '').join(''))

/** What the strip says right now, or null when it isn't there. */
function stripNow() {
  const strip = document.querySelector('.compaction')
  if (!strip) return null
  const bar = strip.querySelector('.compaction__bar')
  return {
    state: strip.getAttribute('data-state'),
    title: strip.querySelector('.compaction__title')?.textContent ?? '',
    detail: strip.querySelector('.compaction__detail')?.textContent ?? '',
    percent: Number.parseInt(strip.querySelector('.compaction__percent')?.textContent ?? '', 10),
    bar: Number(bar?.getAttribute('aria-valuenow'))
  }
}

scenario('a long chat auto-compacts, showing how far the summary has got, and the reply goes on from it', { timeout: 120_000 }, async (s) => {
  const fake = await s.fake()
  const app = await s.launch()
  await checkIsolated(app)
  const page = app.page
  await useFakeModel(page, fake)
  // A low line, so three short exchanges are "long".
  await page.eval(() => window.api.settings.patch({ context: { autoCompact: true, compactAt: 0.05 } }))

  fake.route((req) => reply.text(`Answer to ${req.lastUser.toLowerCase()}.`))
  for (const question of ['The first question', 'The second question', 'The third question']) {
    await sendMessage(page, question)
    await waitForReply(page, { text: `Answer to ${question.toLowerCase()}.`, streaming: false })
  }
  assert.equal(await page.eval(() => document.querySelector('.compaction')), null, 'nothing to compact yet')

  // The fourth goes over the line. The summary is held, to see the strip part way.
  fake.route((req) => (isSummary(req) ? reply.hold('Goals: answer four questions. ', 'summary') : reply.text('Still here, working from the summary.')))
  await sendMessage(page, 'The fourth question')
  const summary = await fake.nextHeld((stream) => stream.label === 'summary')
  const reading = await page.waitFor(stripNow, { message: 'the auto-compact strip to show' })
  assert.equal(reading.state, 'running')
  assert.equal(reading.title, 'Auto-compacting')
  assert.equal(reading.detail, 'Summarizing 6 earlier messages to make room')

  summary.write('State: the first three are answered; '.repeat(16))
  const writing = await page.waitFor(
    () => {
      const now = (() => {
        const strip = document.querySelector('.compaction')
        return strip ? Number.parseInt(strip.querySelector('.compaction__percent')?.textContent ?? '', 10) : 0
      })()
      return now >= 40 && now <= 95 ? now : null
    },
    { message: 'the strip to show the summary part written (40–95%)' }
  )
  const part = await page.eval(stripNow)
  assert.equal(part.bar, writing, 'the bar and the number agree')
  s.t.diagnostic(`auto-compacting at ${writing}%`)
  await s.shot(page, 'auto-compacting')

  summary.finish('Next: answer the fourth.')
  const done = await page.waitFor(() => {
    const strip = document.querySelector('.compaction[data-state="done"]')
    return strip ? { title: strip.querySelector('.compaction__title')?.textContent, percent: strip.querySelector('.compaction__percent')?.textContent } : null
  }, { message: 'the strip to say the chat was compacted' })
  assert.deepEqual(done, { title: 'Compacted', percent: '100%' })
  await s.shot(page, 'compacted')

  // The reply is written from the summary, not the whole conversation.
  await waitForReply(page, { text: 'working from the summary', streaming: false })
  const sent = fake.chats.at(-1)
  assert.ok(!isSummary(sent))
  assert.ok(sent.messages.some((m) => words(m).includes('Summary of the conversation so far:\nGoals: answer four questions.')), 'the reply was asked for with the summary')
  assert.ok(!sent.messages.some((m) => words(m).includes('The second question')), 'and without the messages it stands in for')

  // The strip goes; a quiet rule marks where the chat was compacted.
  await page.waitFor(() => !document.querySelector('.compaction'), { timeout: 8000, message: 'the strip to go once it has said so' })
  await page.find('.thread-compacted', { text: 'Auto-compacted' })
  await s.shot(page, 'after')
})
