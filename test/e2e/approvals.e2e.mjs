/**
 * Asking before acting: Chat is the agent (Work mode), and with Permissions
 * on "Ask first" a file write waits for the user, asked in the transcript.
 * Allow lets it happen; Stop doesn't, and tells the model so. The work folder is the scenario's
 * own HOME/Eaon, never the real one.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { reply } from './fakeProvider.mjs'
import { scenario, sendMessage, useFakeModel, waitForReply } from './fixtures.mjs'

/**
 * The model asks to write `file` on the first request of a turn, then
 * answers with what the tool said.
 */
function writeThenReport(file, content = `written by the e2e suite\n`) {
  return (req) => {
    if (req.toolResultsSinceUser === 0) return reply.tool('write_file', { path: file, content }, 'I will write the file. ')
    const result = req.messages.filter((m) => m.role === 'tool').at(-1)
    const said = typeof result?.content === 'string' ? result.content : JSON.stringify(result?.content ?? '')
    return reply.text(`Tool said: ${said.slice(0, 160)}`)
  }
}

scenario('approval in Work mode: approve runs the action, deny stops it', { timeout: 120_000 }, async (s) => {
  const fake = await s.fake()
  const app = await s.launch()
  const page = app.page
  await useFakeModel(page, fake)
  await page.eval(() => window.api.settings.patch({ approvalMode: 'ask' }))
  const workFolder = join(s.homeDir, 'Eaon')

  // Approve. The open chat asks in its transcript, under the reply, not in a card over it.
  fake.route(writeThenReport('approved.txt'))
  await sendMessage(page, 'Write approved.txt')
  await page.find('.thread .ask-row .ask-row__allow')
  const row = await page.eval(() => {
    const row = document.querySelector('.ask-row')
    return {
      title: row?.querySelector('.ask-row__title')?.textContent ?? '',
      who: row?.querySelector('.ask-row__who')?.textContent ?? '',
      link: row?.querySelector('.ask-row__link')?.textContent ?? '',
      answers: [...(row?.querySelectorAll('.ask-row__answers button') ?? [])].map((b) => b.textContent),
      dialog: Boolean(document.querySelector('.approval-layer')),
      running: [...document.querySelectorAll('.msg-row')].at(-1)?.querySelector('.wl-row .step-shimmer')?.textContent ?? null
    }
  })
  assert.equal(row.title, 'Write approved.txt')
  assert.equal(row.who, 'Eaon')
  assert.equal(row.link, '1 line')
  assert.deepEqual(row.answers, ['Allow', 'Stop'])
  assert.equal(row.dialog, false, 'no dialog over the chat as well')
  assert.equal(row.running, null, `the call it asks about isn't also shown running: ${row.running}`)
  assert.equal(existsSync(join(workFolder, 'approved.txt')), false, 'nothing is written before the user answers')
  await s.shot(page, 'approval-asked')
  // The link opens what it would write.
  await page.click('.ask-row__link')
  await page.find('.ask-row__preview .diff__row')
  await s.shot(page, 'approval-asked-open')
  await page.click('.ask-row__allow')
  await waitForReply(page, { text: /Tool said: Wrote/, streaming: false })
  assert.equal(readFileSync(join(workFolder, 'approved.txt'), 'utf8'), 'written by the e2e suite\n')
  await page.waitFor(() => !document.querySelector('.ask-row'), { message: 'the question to leave' })
  await s.shot(page, 'approved')

  // Deny.
  fake.route(writeThenReport('denied.txt'))
  await sendMessage(page, 'Write denied.txt')
  await page.find('.ask-row .ask-row__stop')
  await page.click('.ask-row__stop')
  const denied = await waitForReply(page, { text: /Tool said:/, streaming: false })
  assert.match(denied.text, /denied/i, `the model should be told the user said no: ${denied.text}`)
  assert.equal(existsSync(join(workFolder, 'denied.txt')), false, 'a denied write must not happen')
  await page.waitFor(() => !document.querySelector('.ask-row'), { message: 'the question to leave' })
  await s.shot(page, 'denied')

  // A write over a file that's there: called a replace, and what goes is shown as well as what comes.
  mkdirSync(workFolder, { recursive: true })
  writeFileSync(join(workFolder, 'qa-note.txt'), 'one\ntwo\nthree\n')
  fake.route(writeThenReport('qa-note.txt', 'one\nTWO\n'))
  await sendMessage(page, 'Rewrite qa-note.txt')
  await page.find('.ask-row .ask-row__allow')
  await page.click('.ask-row__link')
  await page.find('.ask-row__preview .diff__row')
  const replace = await page.eval(() => {
    const row = document.querySelector('.ask-row')
    return {
      title: row?.querySelector('.ask-row__title')?.textContent ?? '',
      link: row?.querySelector('.ask-row__link')?.textContent ?? '',
      removed: [...(row?.querySelectorAll('.diff__row[data-kind="del"]') ?? [])].map((line) => line.textContent?.trim())
    }
  })
  assert.equal(replace.title, 'Replace qa-note.txt')
  assert.equal(replace.link, '+1 −2', 'one line added, two removed')
  assert.equal(replace.removed.length, 2, `the removed lines are shown: ${JSON.stringify(replace.removed)}`)
  await s.shot(page, 'approval-replace')
  await page.click('.ask-row__allow')
  await waitForReply(page, { text: /Tool said: Replaced/, streaming: false })
  // The changed-files card counts it as a change to the file, not a new one.
  const changed = await page.waitFor(() => {
    const card = [...document.querySelectorAll('.cfiles')].at(-1)
    return card ? { text: card.textContent ?? '', isNew: Boolean(card.querySelector('.cfiles__new')) } : null
  }, { message: 'the changed-files card' })
  assert.equal(changed.isNew, false, 'a replaced file isn’t "New"')
  assert.match(changed.text, /\+1−2/)
  await page.waitFor(() => !document.querySelector('.ask-row'), { message: 'the question to leave' })

  // Esc answers no, as Stop's hint says.
  fake.route(writeThenReport('escaped.txt'))
  await sendMessage(page, 'Write escaped.txt')
  await page.find('.ask-row .ask-row__stop')
  // Someone typing keeps the message box: the question doesn't take its focus
  // (a ⏎ meant to send allowed the call). Esc there is left alone; the
  // question takes the keys once it has focus.
  assert.equal(await page.eval(() => Boolean(document.activeElement?.closest('.composer'))), true, 'the message box keeps its focus')
  await page.eval(() => document.querySelector('.ask-row')?.focus())
  await page.waitFor(() => Boolean(document.activeElement?.closest('.ask-row')), { message: 'the question to take focus' })
  await page.press('Escape')
  await waitForReply(page, { text: /Tool said:.*denied/i, streaming: false })
  assert.equal(existsSync(join(workFolder, 'escaped.txt')), false)
})
