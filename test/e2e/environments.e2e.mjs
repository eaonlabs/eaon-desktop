/**
 * Cloud environments in the real app: a session started in one runs on a
 * copy of its project on that machine, and its work comes back as a branch.
 *
 * The machine is a folder here reached through a stand-in `ssh`
 * (EAON_SSH_BIN) that runs the remote command line on this computer, so
 * everything of Eaon's own is real: the picker under the message box, the
 * copy (a git bundle, the uncommitted changes, the new files), the agent's
 * tools over "ssh", the badge in the header, and Bring back. The model is the
 * fake one, asked to run a command there.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scenario, sendMessage, useFakeModel, waitForReply } from './fixtures.mjs'

const identity = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: { ...process.env, ...identity }, encoding: 'utf8' }).trim()

scenario('Cloud environments: a session runs on a copy elsewhere, and its work comes back as a branch', { timeout: 240_000 }, async (s) => {
  mkdirSync(s.homeDir, { recursive: true })
  const fakeSsh = join(s.homeDir, '..', 'fake-ssh')
  const sshLog = join(s.homeDir, '..', 'ssh.log')
  // Skips ssh's options and logs the host, then runs the remote command line here.
  writeFileSync(
    fakeSsh,
    [
      '#!/bin/bash',
      'while [ $# -gt 0 ]; do case "$1" in -o|-p|-i) shift 2;; -tt|-t|-T) shift;; *) break;; esac; done',
      'echo "$1" >> ' + JSON.stringify(sshLog),
      'shift',
      'exec /bin/sh -c "$*"'
    ].join('\n')
  )
  chmodSync(fakeSsh, 0o755)

  const fake = await s.fake()
  // Who the copy's commits are by: the profile's HOME has no git config.
  const app = await s.launch({ env: { EAON_SSH_BIN: fakeSsh, SHELL: '/bin/sh', ...identity } })
  const page = app.page
  const home = realpathSync(s.homeDir)

  // The "other machine", as ~/.ssh/config names it.
  mkdirSync(join(home, '.ssh'), { recursive: true })
  writeFileSync(join(home, '.ssh', 'config'), 'Host devbox\n  HostName devbox.example\n')

  // A project on a branch, with work not committed yet, a new file, and an ignored .env that stays here.
  const repo = join(home, 'projects', 'acme')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'app.ts'), 'one\ntwo\n')
  writeFileSync(join(repo, '.gitignore'), '.env\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'first')
  git(repo, 'checkout', '-q', '-b', 'feature/sky')
  writeFileSync(join(repo, 'app.ts'), 'one\ntwo\nthree, not committed\n')
  writeFileSync(join(repo, 'notes.md'), 'new here\n')
  writeFileSync(join(repo, '.env'), 'SECRET=1\n')

  await useFakeModel(page, fake)
  const hosts = await page.eval(async () => (await window.api.ade.hosts()).map((h) => h.id))
  assert.ok(hosts.includes('cfg:devbox'), `devbox is a host Eaon knows: ${JSON.stringify(hosts)}`)
  // The environment, picked for new sessions; and the project, as Chat keeps it. Full access, so the command runs without a card.
  const chatWorkspace = await page.eval(async () => (await window.api.workspaces.get()).find((w) => w.kind === 'chat')?.id)
  await page.eval(
    async (repo, workspaceId) => {
      await window.api.settings.patch({
        approvalMode: 'full',
        environments: [{ id: 'env-devbox', name: 'Devbox', kind: 'ssh', ssh: { hostId: 'cfg:devbox', folder: '~/eaon' }, createdAt: 1 }],
        environment: 'env-devbox'
      })
      await window.api.projects.save([...(await window.api.projects.get()), { id: 'proj-acme', workspaceId, name: 'acme', instructions: '', createdAt: 1, folder: repo }])
    },
    repo,
    chatWorkspace
  )
  await page.reload()

  // The project's start page, in the IDE: the picker under the box says where the session will run.
  await page.click('.mode-switch__option', { text: 'IDE' })
  await page.click('.sidebar .nav-item--sub', { text: /Start a session in this project/ })
  await page.find('.composer-pill--env', { text: /Devbox/ })
  await page.screenshot('environment-picker')

  // The menu: this computer, then the cloud, with a way to add one.
  await page.click('.composer-pill--env')
  await page.find('.env-menu .menu__item', { text: /This computer/ })
  await page.find('.env-menu .menu__item', { text: /Devbox/ })
  await page.find('.env-menu .menu__item', { text: /New environment/ })
  await page.screenshot('environment-menu')
  await page.press('Escape')

  // One of Eaon's own models runs here, and would stop with this computer: said before any machine is set up.
  await sendMessage(page, 'Look around and leave a file')
  await waitForReply(page, { error: true, streaming: false, timeout: 30_000 })
  const said = await page.eval(() => document.querySelector('.msg__error')?.textContent ?? '')
  assert.match(said, /runs Codex or Claude Code on its machine/)
  assert.match(said, /Choose a model|Pick Codex or Claude/)
  assert.ok(!existsSync(join(home, 'eaon')), 'no copy was made for a model that can’t run there')
  // The header says where it will run, not yet set up.
  await page.find('.place-chip[data-state="idle"]', { text: /Devbox/ })
  await page.screenshot('environment-needs-engine')

  // Getting the place ready, as a session's first turn does: the copy in ~/eaon on the machine, with each step said.
  const steps = await page.eval(() => {
    const seen = []
    window.api.environments.onProgress((p) => p.key === 'e2e' && seen.push(p.step))
    window.__steps = seen
    return true
  })
  assert.ok(steps)
  const prepared = await page.eval((repo) => window.api.environments.prepare({ key: 'e2e', envId: 'env-devbox', project: repo, title: 'Look around' }), repo)
  assert.equal(prepared.ok, true, prepared.error)
  const place = prepared.place
  const said2 = await page.eval(() => window.__steps)
  assert.ok(said2.some((step) => /Packing the repository/.test(step)) && said2.some((step) => /Bringing over a new file/.test(step)), JSON.stringify(said2))

  // The copy: on the project's branch, with the uncommitted change and the new file, and not the ignored .env.
  const copies = readdirSync(join(home, 'eaon')).filter((name) => name.startsWith('acme-'))
  assert.equal(copies.length, 1, `one copy in ~/eaon, found ${copies.join(', ')}`)
  const copy = join(home, 'eaon', copies[0])
  assert.equal(place.folder, `ssh://${encodeURIComponent('cfg:devbox')}${copy}`)
  assert.equal(place.state, 'ready')
  assert.equal(place.branch, 'feature/sky')
  assert.equal(git(copy, 'branch', '--show-current'), 'feature/sky')
  assert.equal(readFileSync(join(copy, 'app.ts'), 'utf8'), 'one\ntwo\nthree, not committed\n')
  assert.equal(readFileSync(join(copy, 'notes.md'), 'utf8'), 'new here\n')
  assert.ok(!existsSync(join(copy, '.env')), 'the ignored .env stays on this computer')
  assert.equal(git(copy, 'remote'), '', 'a project with no origin gives its copy none')
  assert.match(readFileSync(sshLog, 'utf8'), /devbox/)

  // What an agent did there: a file made, and a change committed.
  writeFileSync(join(copy, 'made-there.txt'), 'made there\n')
  writeFileSync(join(copy, 'app.ts'), 'one\ntwo\nthree, committed there\n')
  git(copy, 'commit', '-q', '-am', 'from the cloud')

  // Bring back: the work there, committed or not, as a branch here; the checkout here as it was.
  const back = await page.eval(async (place) => window.api.environments.bringBack(place, 'Look around and leave a file'), place)
  assert.equal(back.ok, true, back.error)
  assert.equal(back.branch, 'eaon/look-around-and-leave-a-file')
  assert.equal(git(repo, 'branch', '--show-current'), 'feature/sky', 'the checkout here is untouched')
  assert.equal(git(repo, 'show', `${back.branch}:made-there.txt`), 'made there')
  assert.equal(git(repo, 'show', `${back.branch}:notes.md`), 'new here')
  assert.equal(git(repo, 'show', `${back.branch}:app.ts`), 'one\ntwo\nthree, committed there')
  assert.match(git(repo, 'log', '-1', '--format=%s', back.branch), /Uncommitted work from devbox/)
  assert.equal(git(repo, 'log', '-1', '--format=%s', `${back.branch}~1`), 'from the cloud')
  assert.ok(!existsSync(join(repo, 'made-there.txt')), 'bringing back made a branch, not files in the checkout')

  // Again later: the branch moves to what is there now.
  const again = await page.eval(async (place) => window.api.environments.bringBack(place, 'Look around and leave a file'), place)
  assert.equal(again.ok, true, 'a second bring back moves the branch to the same work')
})
