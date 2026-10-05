/**
 * Asking before acting: Chat is the agent (Work mode), and with Permissions
 * on "Ask first" a file write waits for the user. Approving lets it happen;
 * denying stops it and tells the model so. The work folder is the scenario's
 * own HOME/Eaon, never the real one.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { reply } from './fakeProvider.mjs'
import { scenario, sendMessage, useFakeModel, waitForReply } from './fixtures.mjs'

/**
 * The model asks to write `file` on the first request of a turn, then
 * answers with what the tool said.
 */
function writeThenReport(file) {
  return (req) => {
    if (req.toolResultsSinceUser === 0) return reply.tool('write_file', { path: file, content: `written by the e2e suite\n` }, 'I will write the file. ')
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

  // Approve.
  fake.route(writeThenReport('approved.txt'))
  await sendMessage(page, 'Write approved.txt')
  await page.find('.approval-layer[data-state="in"] .approval__approve')
  const card = await page.eval(() => document.querySelector('.approval-layer .approval')?.textContent ?? '')
  assert.match(card, /approved\.txt/, 'the approval card should say which file')
  assert.equal(existsSync(join(workFolder, 'approved.txt')), false, 'nothing is written before the user answers')
  await s.shot(page, 'approval-asked')
  await page.click('.approval-layer .approval__approve')
  await waitForReply(page, { text: /Tool said: Wrote/, streaming: false })
  assert.equal(readFileSync(join(workFolder, 'approved.txt'), 'utf8'), 'written by the e2e suite\n')
  await page.waitFor(() => !document.querySelector('.approval-layer'), { message: 'the approval card to leave' })
  await s.shot(page, 'approved')

  // Deny.
  fake.route(writeThenReport('denied.txt'))
  await sendMessage(page, 'Write denied.txt')
  await page.find('.approval-layer[data-state="in"] .approval__deny')
  await page.click('.approval-layer .approval__deny')
  const denied = await waitForReply(page, { text: /Tool said:/, streaming: false })
  assert.match(denied.text, /denied/i, `the model should be told the user said no: ${denied.text}`)
  assert.equal(existsSync(join(workFolder, 'denied.txt')), false, 'a denied write must not happen')
  await page.waitFor(() => !document.querySelector('.approval-layer'), { message: 'the approval card to leave' })
  await s.shot(page, 'denied')

  // Esc answers no, as the card's hint says.
  fake.route(writeThenReport('escaped.txt'))
  await sendMessage(page, 'Write escaped.txt')
  await page.find('.approval-layer[data-state="in"] .approval__deny')
  await page.press('Escape')
  await waitForReply(page, { text: /Tool said:.*denied/i, streaming: false })
  assert.equal(existsSync(join(workFolder, 'escaped.txt')), false)
})
