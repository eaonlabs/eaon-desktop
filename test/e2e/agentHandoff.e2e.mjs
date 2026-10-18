/**
 * ADE: handing a pane's work to another agent. Claude Code (a stand-in that
 * writes a real-shaped transcript and session file) worked on a task; Hand off
 * writes that conversation into the project, kept out of git, and a new pane
 * starts Codex on it with the task on its command line. Amp takes no task on
 * its command line, so it gets the same line typed in once it is up. The
 * Claude pane is left running throughout.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { scenario } from './fixtures.mjs'

const SESSION = '3f1c2a9e-5b7d-4e21-9a0c-6d8e2f4b1a37'

scenario('ADE: hand off from Claude Code to Codex, and to an agent that takes its task typed', { timeout: 150_000, skip: process.platform === 'win32' ? 'the stand-in CLIs are shell scripts' : false }, async (s) => {
  // Outside the repository, so the stand-ins are plain CommonJS and named like the real CLIs in the process table.
  const fx = realpathSync(mkdtempSync(join(tmpdir(), 'eaon-handoff-e2e-')))
  try {
    const bin = join(fx, 'bin')
    const lib = join(fx, 'lib')
    mkdirSync(bin, { recursive: true })
    mkdirSync(lib, { recursive: true })
    const logs = { claude: join(fx, 'claude.log'), codex: join(fx, 'codex.log'), amp: join(fx, 'amp.log') }
    const cli = (name, source) => {
      writeFileSync(join(lib, name), source)
      writeFileSync(join(bin, name), `#!/bin/sh\nexec node '${join(lib, name)}' "$@"\n`)
      chmodSync(join(bin, name), 0o755)
    }
    cli(
      'claude',
      `const fs = require('fs'), path = require('path')
if (process.argv[2] === 'auth') { process.stdout.write('{"loggedIn":false}'); process.exit(0) }
fs.appendFileSync(${JSON.stringify(logs.claude)}, JSON.stringify(process.argv.slice(2)) + '\\n')
const dir = process.env.CLAUDE_CONFIG_DIR, cwd = process.cwd(), id = ${JSON.stringify(SESSION)}
fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true })
fs.writeFileSync(path.join(dir, 'sessions', process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: id, cwd }))
const tdir = path.join(dir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
fs.mkdirSync(tdir, { recursive: true })
const line = (o) => JSON.stringify({ sessionId: id, cwd, ...o })
fs.writeFileSync(path.join(tdir, id + '.jsonl'), [
  line({ type: 'user', message: { role: 'user', content: 'Make the checkout total include sales tax' } }),
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Adding tax to the cart total.' }, { type: 'tool_use', name: 'Edit', input: { file_path: 'src/cart.ts' } }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test -- cart' } }] } }),
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Tax is added, but the rounding test still fails.' }] } })
].join('\\n') + '\\n')
console.log('Claude Code (stand-in) ready')
process.stdin.resume()
`
    )
    cli(
      'codex',
      `const fs = require('fs')
fs.appendFileSync(${JSON.stringify(logs.codex)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n')
if (process.argv[2] === 'app-server' || process.argv[2] === 'login') process.exit(1)
console.log('Codex (stand-in) ready')
process.stdin.resume()
`
    )
    cli(
      'amp',
      `const fs = require('fs')
fs.appendFileSync(${JSON.stringify(logs.amp)}, 'started ' + JSON.stringify(process.argv.slice(2)) + '\\n')
console.log('Amp (stand-in) ready')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => fs.appendFileSync(${JSON.stringify(logs.amp)}, 'typed ' + JSON.stringify(d) + '\\n'))
`
    )
    writeFileSync(join(bin, 'plainsh'), '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n')
    chmodSync(join(bin, 'plainsh'), 0o755)

    const app = await s.launch({
      env: { PATH: `${bin}${delimiter}${process.env.PATH}`, SHELL: join(bin, 'plainsh'), CLAUDE_CONFIG_DIR: join(s.homeDir, '.claude'), CODEX_HOME: join(s.homeDir, '.codex') }
    })
    const page = app.page
    const home = realpathSync(s.homeDir)

    // A project in git, open in the ADE.
    const project = join(home, 'shop')
    mkdirSync(project, { recursive: true })
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' }
    const git = (...args) => execFileSync('git', ['-C', project, ...args], { env: gitEnv, encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(project, 'cart.ts'), 'export const total = 1\n')
    git('add', '.')
    git('commit', '-q', '-m', 'first')
    const settings = await page.eval(() => window.api.settings.get())
    const ade = (await page.eval(() => window.api.workspaces.get())).find((w) => w.kind === 'code')
    await page.eval((id, cwd, eaonCode) => window.api.settings.patch({ activeWorkspaceId: id, eaonCode: { ...eaonCode, lastCwd: cwd } }), ade.id, project, settings.eaonCode)
    await page.reload()

    // Claude Code works on the task.
    await page.click('.code-header .header-btn', { text: /New terminal/ })
    await page.click('.menu [role="menuitem"], .menu button', { text: /^Claude Code/ })
    const claudePane = await page.waitFor(async () => Object.values(await window.api.terminals.layout()).flat()[0]?.id, { message: 'the Claude Code pane' })
    await page.waitFor(async (id, session) => (await window.api.terminals.conversations([id]))[id] === session, {
      args: [claudePane, SESSION],
      timeout: 30_000,
      message: 'the watch to see Claude Code’s conversation'
    })

    // Hand off, from the pane's menu.
    await page.click('.term-pane__btn[aria-label="Pane options"]')
    await page.click('.menu button, .menu [role="menuitem"]', { text: /Hand off to another agent/ })
    await page.find('.handoff__current', { text: /Claude Code/ })
    await page.find('.handoff__agent[data-selected]', { text: /^Codex/ })
    await page.click('.handoff__note')
    await page.type('Fix the rounding test first')
    await s.shot(page, 'handoff-dialog')
    await page.click('.modal button.btn--primary, [role="dialog"] button.btn--primary', { text: /Hand off to Codex/ })

    // Codex starts in a new pane on one line pointing at the handoff; Claude's pane is still there.
    await page.waitFor(() => document.querySelectorAll('.term-pane').length === 2, { message: 'a second pane', timeout: 15_000 })
    // Eaon itself runs `codex app-server` (sign-in status); the pane's run is the one in the project.
    const codexRun = await waitForFile(logs.codex, 20_000, /handoffs/)
    const args = codexRun
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((run) => run.cwd === project).args
    assert.equal(args.length, 1, `codex was started on one task: ${JSON.stringify(args)}`)
    const file = /Read (\.eaon\/handoffs\/\S+\.md) first/.exec(args[0])?.[1]
    assert.ok(file, `the task names the handoff file: ${args[0]}`)
    const handoff = readFileSync(join(project, file), 'utf8')
    assert.match(handoff, /^# Handoff from Claude Code to Codex/)
    assert.match(handoff, /## Note from the user\n\nFix the rounding test first/)
    assert.match(handoff, /## What the user asked first\n\nMake the checkout total include sales tax/)
    assert.match(handoff, /## Where Claude Code stopped\n\n[\s\S]*the rounding test still fails/)
    assert.match(handoff, /- edited src\/cart\.ts\n- ran `npm test -- cart`/)
    assert.equal(git('status', '--porcelain'), '', 'the handoff stays out of git')
    assert.equal(readFileSync(logs.claude, 'utf8').trim().split('\n').length, 1, 'Claude Code was not restarted')
    await s.shot(page, 'handed-off-to-codex')

    // Amp takes no task on its command line: it starts bare, and the same line is typed in once it is up.
    await page.click('.term-pane__btn[aria-label="Pane options"]')
    await page.click('.menu button, .menu [role="menuitem"]', { text: /Hand off to another agent/ })
    await page.click('.handoff__agent', { text: /^Amp/ })
    await page.click('.modal button.btn--primary, [role="dialog"] button.btn--primary', { text: /Hand off to Amp/ })
    const ampLog = await waitForFile(logs.amp, 60_000, /typed /)
    assert.match(ampLog, /^started \[\]/, 'Amp started with no task on its command line')
    assert.match(ampLog, /typed "Read \.eaon\/handoffs\/[^"]+-claude-code-to-amp\.md first:/, `the task was typed in: ${ampLog}`)
    assert.equal(readdirSync(join(project, '.eaon', 'handoffs')).length, 2)
    await s.shot(page, 'handed-off-to-amp')
  } finally {
    rmSync(fx, { recursive: true, force: true })
  }
})

/** The file's text once it exists (and, with `want`, once it says that). */
async function waitForFile(file, timeout, want = /./) {
  const end = Date.now() + timeout
  for (;;) {
    const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (want.test(text)) return text
    if (Date.now() > end) throw new Error(`${file} never said ${want}: ${JSON.stringify(text)}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}
