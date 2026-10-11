/**
 * Review and SSH sessions in the real app.
 *
 * Review: a branch with a commit and uncommitted work shows its files and
 * lines; a comment on a line goes to an agent as one message (the "agent" is
 * `cat` running as `claude`, so what it was sent lands in a file); Commit all
 * commits; and with no GitHub remote the panel says why there's no pull request.
 *
 * SSH: a session over SSH to a host from ~/.ssh/config. The `ssh` client is a
 * stand-in (EAON_SSH_BIN) that runs the remote command here, so everything of
 * Eaon's own is real: the host picker, the ssh arguments, the remote shell
 * landing in the folder, git over SSH for the change count and the review.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scenario } from './fixtures.mjs'

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' }).trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeRepo(dir) {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'app.ts'), 'one\ntwo\nthree\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'first')
}

/** Waits for a file to exist and hold `pattern`; returns its text. */
async function fileWith(path, pattern, timeout = 15_000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8')
      if (pattern.test(text)) return text
    }
    await sleep(250)
  }
  assert.fail(`${path} never held ${pattern}${existsSync(path) ? `; it holds ${JSON.stringify(readFileSync(path, 'utf8'))}` : ''}`)
}

scenario('ADE review and SSH sessions: diff, line comments to an agent, commit, a session over SSH', { timeout: 180_000 }, async (s) => {
  mkdirSync(s.homeDir, { recursive: true })
  const fakeSsh = join(s.homeDir, '..', 'fake-ssh')
  const sshLog = join(s.homeDir, '..', 'ssh.log')
  // Skips ssh's options and the host (logged), then runs the remote command line here.
  writeFileSync(
    fakeSsh,
    [
      '#!/bin/bash',
      'while [ $# -gt 0 ]; do case "$1" in -o|-p|-i) shift 2;; -tt|-t) shift;; *) break;; esac; done',
      'echo "$1" >> ' + JSON.stringify(sshLog),
      'shift',
      'exec /bin/sh -c "$*"'
    ].join('\n')
  )
  chmodSync(fakeSsh, 0o755)

  const app = await s.launch({ env: { EAON_SSH_BIN: fakeSsh } })
  const page = app.page
  const home = realpathSync(s.homeDir)

  // A branch with one commit and work not committed yet, one file of it new.
  const repo = join(home, 'projects', 'acme')
  makeRepo(repo)
  git(repo, 'checkout', '-q', '-b', 'feature/shout')
  writeFileSync(join(repo, 'app.ts'), 'one\nTWO\nthree\n')
  git(repo, 'commit', '-q', '-am', 'shout two')
  writeFileSync(join(repo, 'app.ts'), 'one\nTWO\nthree\nfour\n')
  writeFileSync(join(repo, 'notes.md'), 'hello\n')

  // The "other machine": a folder here, reached through the stand-in ssh as host devbox.
  const remote = join(home, 'remote', 'app')
  makeRepo(remote)
  writeFileSync(join(remote, 'app.ts'), 'one\ntwo\nthree\nremote edit\n')
  mkdirSync(join(home, '.ssh'), { recursive: true })
  writeFileSync(join(home, '.ssh', 'config'), 'Host devbox\n  HostName devbox.example\n  User me\n\nHost *\n  ServerAliveInterval 30\n')

  const settings = await page.eval(() => window.api.settings.get())
  const ade = (await page.eval(() => window.api.workspaces.get())).find((w) => w.kind === 'code')
  await page.eval((id, folder, eaonCode) => window.api.settings.patch({ activeWorkspaceId: id, eaonCode: { ...eaonCode, lastCwd: folder } }), ade.id, repo, settings.eaonCode)
  await page.reload()
  await page.find('.ade-session__title', { text: 'acme' })

  // Review: the branch's files, committed and not, new ones included.
  await page.click('.code-header .review-btn')
  const files = await page.waitFor(
    () => {
      const rows = [...document.querySelectorAll('.review-file__head')].map((r) => r.textContent?.replace(/\s+/g, ' ').trim())
      return rows.length ? rows : null
    },
    { message: 'the review’s files', timeout: 20_000 }
  )
  s.t.diagnostic(`review files: ${JSON.stringify(files)}`)
  assert.deepEqual(files, ['Mapp.ts+2−1', 'Anotes.md+1−0'])
  assert.match(await page.eval(() => document.querySelector('.review__branch')?.textContent ?? ''), /feature\/shout → main/)
  // No GitHub remote: said in the pull request's place.
  assert.match(await page.eval(() => document.querySelector('.review__section .review__muted')?.textContent ?? ''), /GitHub|gh/)
  await s.shot(page, 'review-open')

  // A comment on the line that became TWO.
  await page.click('.review-diff__row[data-kind="add"]', { text: /TWO/ })
  await page.fill('.review-comment--draft textarea', 'Keep it lower-case, like the others.')
  await page.click('.review-comment--draft button', { text: /^Add comment$/ })
  await page.find('.review-comment__body', { text: /lower-case/ })
  await page.find('.review__foot', { text: /1 comment[\s\S]*Start an agent/ })
  await s.shot(page, 'review-comment')

  // An "agent" to send it to: cat, running under Claude Code's name, writing what it gets to a file.
  await page.click('.code-header .header-btn', { text: /New terminal/ })
  await page.click('.menu [role="menuitem"], .menu button', { text: /^Shell/ })
  await page.find('.term-pane')
  await sleep(2000)
  const received = join(home, 'received.txt')
  await page.click('.term-pane__screen')
  await page.type(`(exec -a claude cat > '${received}')`)
  await page.press('Enter')
  // The process watcher looks every few seconds; once it sees `claude`, the pane is an agent.
  await page.find('.review__foot button', { text: /Send to agent/, timeout: 45_000 })
  await page.click('.review__foot button', { text: /Send to agent/ })
  const sent = await fileWith(received, /lower-case/)
  s.t.diagnostic(`the agent got: ${JSON.stringify(sent)}`)
  assert.match(sent, /I reviewed your changes and left a comment/)
  assert.match(sent, /app\.ts:2\n> TWO\nKeep it lower-case/)
  await page.waitFor(() => !document.querySelector('.review__foot'), { message: 'the sent comments to clear' })

  // Commit all, from the panel.
  await page.fill('.review-form textarea[placeholder="Commit message"]', 'Add four and notes')
  await page.click('.review-form button', { text: /^Commit all$/ })
  await page.waitFor(() => !document.querySelector('textarea[placeholder="Commit message"]'), { message: 'nothing left to commit', timeout: 20_000 })
  assert.equal(git(repo, 'log', '-1', '--format=%s'), 'Add four and notes')
  assert.equal(git(repo, 'status', '--porcelain'), '')
  await s.shot(page, 'review-committed')

  // A session over SSH: the host from ~/.ssh/config, a folder under the remote home.
  await page.click('.sidebar .nav-item', { text: /^Session over SSH$/ })
  await page.find('.modal', { text: /devbox/ })
  await page.fill('.modal input[placeholder="~/projects/app"]', '~/remote/app')
  await page.click('.ade-dialog__agent', { text: /^Shell$/ })
  await s.shot(page, 'ssh-dialog')
  await page.click('.modal button', { text: /^Connect$/ })
  await page.waitFor(() => !document.querySelector('.modal'), { message: 'the dialog to close', timeout: 30_000 })
  const row = await page.waitFor(
    () => [...document.querySelectorAll('.ade-session')].map((x) => x.textContent?.replace(/\s+/g, ' ')).find((t) => /on devbox/.test(t ?? '')) ?? null,
    { message: 'the remote session in the sidebar', timeout: 20_000 }
  )
  s.t.diagnostic(`remote session row: ${row}`)
  assert.match(row, /app.*main · on devbox/)
  assert.match(readFileSync(sshLog, 'utf8'), /^devbox$/m)

  // Its terminal is the remote shell, in the remote folder.
  await page.waitFor(() => document.querySelectorAll('.term-pane').length === 1, { message: 'the remote session’s terminal' })
  await sleep(2500)
  await page.click('.term-pane__screen')
  const where = join(home, 'remote-pwd.txt')
  await page.type(`pwd -P > '${where}'`)
  await page.press('Enter')
  assert.equal((await fileWith(where, /\S/)).trim(), remote)

  // The change count and the review come over SSH too.
  await page.waitFor(() => /\+1\s*−0/.test([...document.querySelectorAll('.ade-session')].find((x) => /on devbox/.test(x.textContent ?? ''))?.querySelector('.ade-session__diff')?.textContent ?? ''), {
    message: 'the remote session’s change count',
    timeout: 20_000
  })
  const remoteFiles = await page.waitFor(
    () => {
      const rows = [...document.querySelectorAll('.review-file__head')].map((r) => r.textContent?.replace(/\s+/g, ' ').trim())
      return rows.length === 1 ? rows : null
    },
    { message: 'the remote review', timeout: 20_000 }
  )
  assert.deepEqual(remoteFiles, ['Mapp.ts+1−0'])
  await s.shot(page, 'ssh-review')
})
