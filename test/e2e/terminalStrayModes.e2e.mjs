/**
 * A CLI that ends without turning mouse reporting off (Claude Code killed or
 * crashed) used to leave its ADE pane printing every mouse move at the shell
 * prompt as `35;40;26M35;41;26M…`. Mouse reports with only the shell to read
 * them are now dropped and the terminal told to stop sending them, while a
 * program that asked for the mouse still gets every report.
 */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { scenario } from './fixtures.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

scenario('ADE terminal: mouse reporting a crashed CLI left on is switched off, not printed at the prompt', { timeout: 90_000, skip: process.platform === 'win32' ? 'ConPTY always names the shell as the foreground program' : false }, async (s) => {
  const app = await s.launch({})
  const page = app.page
  const folder = join(s.homeDir, 'project')
  mkdirSync(folder, { recursive: true })
  const settings = await page.eval(() => window.api.settings.get())
  const ade = (await page.eval(() => window.api.workspaces.get())).find((w) => w.kind === 'code')
  await page.eval((id, cwd, eaonCode) => window.api.settings.patch({ activeWorkspaceId: id, eaonCode: { ...eaonCode, lastCwd: cwd } }), ade.id, folder, settings.eaonCode)
  await page.reload()
  await page.click('.code-header .header-btn', { text: /New terminal/ })
  await page.click('.menu [role="menuitem"], .menu button', { text: /^Shell/ })
  await page.find('.term-pane')

  const pane = await page.waitFor(async () => Object.values(await window.api.terminals.layout()).flat()[0]?.id, { message: 'the shell pane' })
  await page.eval((id) => {
    window.__out = ''
    window.api.terminals.onData((e) => {
      if (e.paneId === id) window.__out += e.data
    })
  }, pane)
  const type = (text) => page.eval((id, t) => window.api.terminals.write(id, t), pane, text)
  const output = () => page.eval(() => window.__out)

  // What a CLI leaves behind when it dies mid-run: any-motion SGR mouse reporting, on, with the shell back at its prompt.
  await sleep(1500)
  await type("printf '\\033[?1003h\\033[?1006h'; echo MOUSE-ON\r")
  await page.waitFor(() => window.__out.includes('MOUSE-ON\r\n') || window.__out.split('MOUSE-ON').length > 2, { message: 'the modes switched on' })
  const before = (await output()).length

  // The terminal sends a few mouse moves.
  await type('\x1b[<35;40;26M\x1b[<35;41;26M')
  await type('\x1b[<35;42;26M')
  await sleep(1200)
  const after = (await output()).slice(before)
  assert.ok(after.includes('\x1b[?1003l') && after.includes('\x1b[?1006l'), `the pane is told to stop reporting the mouse: ${JSON.stringify(after)}`)
  assert.ok(!/35;4\d;26M/.test(after), `the moves never reach the prompt: ${JSON.stringify(after)}`)

  // A program that asked for the mouse still gets its reports (cat -v shows them).
  await type('cat -v\r')
  await sleep(800)
  const mark = (await output()).length
  await type('\x1b[<0;12;3M')
  await type('\r')
  await page.waitFor((from) => window.__out.slice(from).includes('[<0;12;3M'), { message: 'cat to echo the report it was sent', args: [mark] })
  await type('\x03')
  await s.shot(page, 'shell-after-stray-modes')
})
