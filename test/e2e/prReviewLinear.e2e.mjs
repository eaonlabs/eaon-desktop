/**
 * Pull request review and Linear in the real app. On the Pull requests page,
 * Review checks the PR out in an ADE session and starts Claude Code on it;
 * the review it writes shows on the page, is edited, and is posted. On the
 * Linear page, an API key connects, the issues list, and Start makes a
 * session on the issue's branch with the agent given the issue.
 *
 * GitHub, Claude Code and Linear are stand-ins in the scenario's scratch
 * home: a fake `gh` over a local bare repository, a fake `claude` that writes
 * a review, and a fake Linear API. Panes run in a shell that reads no
 * profile, so a real `claude` or `gh` elsewhere on this computer never runs.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { delimiter, join } from 'node:path'
import { scenario } from './fixtures.mjs'

const KEY = 'lin_api_e2etestkeye2etestkey00'
const PR_URL = 'https://github.com/acme/widget/pull/7'

/** The JSON lines a stand-in logged, once there are at least `count` (or what there is after 30 s). */
async function linesOf(file, count) {
  const read = () => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  const deadline = Date.now() + 30_000
  while (read().length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
  return read()
}

/** A fake Linear GraphQL API with one issue; records what it is asked. */
async function fakeLinear() {
  const seen = []
  let state = { name: 'Todo', type: 'unstarted' }
  const states = [
    { id: 's-todo', name: 'Todo', type: 'unstarted', position: 0 },
    { id: 's-prog', name: 'In Progress', type: 'started', position: 1 },
    { id: 's-rev', name: 'In Review', type: 'started', position: 2 }
  ]
  const issue = () => ({
    id: 'iss-1',
    identifier: 'ENG-12',
    title: 'Add search to the docs',
    description: 'People can’t find anything. Add a search box to the docs site.',
    url: 'https://linear.app/acme/issue/ENG-12',
    branchName: 'alex/eng-12-add-search',
    priority: 2,
    priorityLabel: 'High',
    updatedAt: new Date().toISOString(),
    state: { ...state, color: state.type === 'started' ? '#f2c94c' : '#95a2b3' },
    team: { id: 't1', key: 'ENG', name: 'Engineering' }
  })
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const { query, variables } = JSON.parse(body)
      seen.push({ query, variables })
      const send = (data) => res.end(JSON.stringify({ data }))
      if (req.headers.authorization !== KEY) return void ((res.statusCode = 401), res.end('{}'))
      if (query.includes('assignedIssues')) return send({ viewer: { assignedIssues: { nodes: [issue()] } } })
      if (query.includes('viewer')) return send({ viewer: { name: 'Alex Rivera', email: 'alex@example.com' } })
      if (query.includes('issueUpdate')) {
        const s = states.find((x) => x.id === variables.state)
        state = { name: s.name, type: s.type }
        return send({ issueUpdate: { success: true } })
      }
      if (query.includes('attachmentLinkURL')) return send({ attachmentLinkURL: { success: true } })
      if (query.includes('issue(id')) return send({ issue: { ...issue(), team: { ...issue().team, states: { nodes: states } } } })
      res.statusCode = 400
      res.end('{}')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}/graphql`, seen, state: () => state, close: () => server.close() }
}

scenario('PR review and Linear: an agent reviews a PR in the ADE and it is posted; a Linear issue starts a session on its branch', { timeout: 180_000 }, async (s) => {
  // The stand-ins live beside the scratch home, not in it: a fresh launch empties the home.
  const fx = join(s.homeDir, '..', 'stand-ins')
  rmSync(fx, { recursive: true, force: true })
  mkdirSync(fx, { recursive: true })
  const home = join(realpathSync(join(s.homeDir, '..')), 'home')
  const gitEnv = { ...process.env, HOME: home, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' }
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' }).trim()

  // "GitHub": acme/widget as a bare repository, with pull request #7's head.
  const seed = join(fx, 'seed')
  mkdirSync(seed, { recursive: true })
  git(seed, 'init', '-q', '-b', 'main')
  writeFileSync(join(seed, 'login.ts'), 'export const retries = 1\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '-q', '-m', 'first')
  git(seed, 'checkout', '-q', '-b', 'fix-login')
  writeFileSync(join(seed, 'login.ts'), 'export const retries = 3\n')
  git(seed, 'commit', '-q', '-am', 'retry login')
  const bare = join(fx, 'widget.git')
  execFileSync('git', ['clone', '-q', '--bare', seed, bare], { env: gitEnv })
  git(bare, 'update-ref', 'refs/pull/7/head', 'fix-login')
  // The fake gh's clone is the one made here; its origin points at the bare repository.

  const bin = join(fx, 'bin')
  mkdirSync(bin, { recursive: true })
  const ghLog = join(fx, 'gh.log')
  const claudeLog = join(fx, 'claude.log')
  // Node stand-ins as .cjs (this repository's package.json makes a bare script a module), run by a shell wrapper of the real name.
  const script = (name, text) => {
    const file = join(bin, name)
    if (text.startsWith('#!/usr/bin/env node')) {
      writeFileSync(`${file}.cjs`, text.replace(/^#!.*\n/, ''))
      text = `#!/bin/sh\nexec node '${file}.cjs' "$@"\n`
    }
    writeFileSync(file, text)
    chmodSync(file, 0o755)
  }
  script(
    'gh',
    `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
const input = args.includes('--input') ? fs.readFileSync(0, 'utf8') : ''
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({ args, input }) + '\\n')
const say = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v))
const pr = { repository: { nameWithOwner: 'acme/widget' }, number: 7, title: 'Retry the login three times', updatedAt: new Date().toISOString(), state: 'open', isDraft: false, url: ${JSON.stringify(PR_URL)} }
if (args[0] === 'search' && args[1] === 'prs') say(args[2] === '--author=@me' ? [] : [pr])
else if (args[0] === 'api' && args[1] === 'user') say('alexrivera\\n')
else if (args[0] === 'pr' && args[1] === 'view' && args.includes('headRefOid')) say({ headRefOid: 'abc123' })
else if (args[0] === 'pr' && args[1] === 'view' && args.includes('additions,deletions,headRefName')) say({ additions: 1, deletions: 1, headRefName: 'fix-login' })
else if (args[0] === 'pr' && args[1] === 'view') say({ number: 7, title: pr.title, url: pr.url, baseRefName: 'main', headRefName: 'fix-login', body: 'Logins fail on a flaky network.', author: { login: 'someone-else' } })
else if (args[0] === 'repo' && args[1] === 'clone') require('child_process').execFileSync('git', ['clone', '-q', ${JSON.stringify(bare)}, args[3]])
else if (args[0] === 'api' && args[1] === 'repos/acme/widget/pulls/7/reviews') say({ html_url: ${JSON.stringify(PR_URL)} + '#pullrequestreview-1' })
else if (args[0] === 'pr' && args[1] === 'list') say([])
else { process.stderr.write('unexpected: ' + args.join(' ')); process.exit(1) }
`
  )
  // Claude Code, as far as this test needs: notes what it was asked, and writes a review where the brief says.
  script(
    'claude',
    `#!/usr/bin/env node
const fs = require('fs')
// The app asks who is signed in (Settings → Accounts, the usage meter): not a run.
if (process.argv[2] === 'auth') { process.stdout.write('{"loggedIn":false}'); process.exit(0) }
fs.appendFileSync(${JSON.stringify(claudeLog)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n')
if (fs.existsSync('.eaon/review-task.md')) {
  fs.writeFileSync('.eaon/review.json', JSON.stringify({ summary: 'Three retries hides a real outage.', event: 'REQUEST_CHANGES', comments: [{ path: 'login.ts', line: 1, body: 'Back off between retries.' }] }))
  console.log('Review written to .eaon/review.json')
} else console.log('Working on it.')
`
  )
  // A shell that reads no profile, so PATH stays as given: the stand-ins first.
  script('plainsh', '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n')

  const linear = await fakeLinear()
  try {
    const app = await s.launch({
      env: {
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        SHELL: join(bin, 'plainsh'),
        EAON_LINEAR_API: linear.url,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        CODEX_HOME: join(home, '.codex')
      }
    })
    const page = app.page
    assert.equal(realpathSync(s.homeDir), home)

    // The ADE's Pull requests page: the PR asked of us, and Review.
    await page.click('.mode-switch__option', { text: 'ADE' })
    await page.click('.sidebar .nav-item', { text: /^Pull requests$/ })
    await page.click('.pr-row__title', { text: 'Retry the login three times', timeout: 20_000 })
    await page.find('.pr-review', { text: /Agent review/ })
    await s.shot(page, 'pr-review-offered')
    await page.click('.pr-review button', { text: /^Review$/ })

    // Checked out in a worktree of its own, and Claude Code started there on the brief.
    const worktree = join(home, 'Eaon', 'worktrees', 'widget', 'review-pr-7')
    await page.waitFor(() => document.querySelector('.term-pane') !== null, { message: 'the review’s terminal', timeout: 60_000 })
    const asked = await linesOf(claudeLog, 1)
    s.t.diagnostic(`claude was run with: ${JSON.stringify(asked)}`)
    assert.equal(asked.length, 1, 'Claude Code started once')
    assert.equal(realpathSync(asked[0].cwd), realpathSync(worktree))
    assert.equal(asked[0].args.length, 1, 'the task is one argument')
    assert.match(asked[0].args[0], /^Review pull request #7 \(Retry the login three times\)\. Read \.eaon\/review-task\.md/)
    assert.equal(readFileSync(join(worktree, 'login.ts'), 'utf8'), 'export const retries = 3\n', 'the PR’s change is what’s checked out')
    assert.equal(git(worktree, 'status', '--porcelain'), '', 'Eaon’s notes stay out of git')
    const sub = await page.eval(() => [...document.querySelectorAll('.ade-session')].map((el) => el.textContent?.replace(/\s+/g, ' ')).find((t) => t?.includes('Review #7')))
    assert.match(sub ?? '', /review-pr-7 · no branch/, 'the sidebar names the review’s folder, not its whole path')
    await s.shot(page, 'pr-review-agent-in-ade')

    // Back on the page, the review the agent wrote, to edit and post.
    await page.click('.sidebar .nav-item', { text: /^Pull requests$/ })
    await page.click('.pr-row__title', { text: 'Retry the login three times' })
    await page.find('.pr-review__summary', { timeout: 20_000 })
    const shown = await page.eval(() => ({
      summary: document.querySelector('.pr-review__summary')?.value,
      where: [...document.querySelectorAll('.pr-review__where code')].map((c) => c.textContent),
      event: document.querySelector('.pr-review .segment__item[data-active="true"]')?.textContent
    }))
    assert.deepEqual(shown, { summary: 'Three retries hides a real outage.', where: ['login.ts:1'], event: 'Request changes' })
    await page.fill('.pr-review__summary', 'Three retries hides a real outage. Edited before posting.')
    await page.click('.pr-review .segment__item', { text: /^Comment$/ })
    await s.shot(page, 'pr-review-written')
    await page.click('.pr-review button', { text: /^Post review to GitHub$/ })
    await page.find('.pr-review', { text: /Posted\./, timeout: 20_000 })
    const posted = readFileSync(ghLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.args[1] === 'repos/acme/widget/pulls/7/reviews')
    assert.equal(posted.length, 1)
    assert.deepEqual(JSON.parse(posted[0].input), {
      commit_id: 'abc123',
      event: 'COMMENT',
      body: 'Three retries hides a real outage. Edited before posting.',
      comments: [{ path: 'login.ts', line: 1, side: 'RIGHT', body: 'Back off between retries.' }]
    })
    await s.shot(page, 'pr-review-posted')

    // Linear: connect with a key, see the issue, start it in the project the review cloned.
    await page.click('.sidebar .nav-item', { text: /^Linear$/ })
    await page.find('.linear-connect')
    await s.shot(page, 'linear-connect')
    await page.fill('.linear-connect input', KEY)
    await page.click('.linear-connect button', { text: /^Connect$/ })
    await page.click('.pr-row__title', { text: 'Add search to the docs', timeout: 20_000 })
    await page.find('.linear-actions button', { text: /Start in the ADE/ })
    await s.shot(page, 'linear-issue')
    await page.click('.linear-actions button', { text: /Start in the ADE/ })

    await page.waitFor(() => document.querySelectorAll('.term-pane').length > 0 && !document.querySelector('.linear-actions'), { message: 'the issue’s session', timeout: 60_000 })
    const runs = await linesOf(claudeLog, 2)
    s.t.diagnostic(`claude runs: ${JSON.stringify(runs)}`)
    assert.equal(runs.length, 2)
    const worked = runs[1]
    assert.match(worked.args[0], /^Work on Linear issue ENG-12 \(Add search to the docs\)\. Read \.eaon\/issue\.md/)
    const issueDir = realpathSync(worked.cwd)
    assert.ok(issueDir.startsWith(join(home, 'Eaon', 'worktrees', 'widget') + '/'), `a worktree of its own: ${issueDir}`)
    assert.equal(git(issueDir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'alex/eng-12-add-search', 'on the branch Linear named')
    assert.match(readFileSync(join(issueDir, '.eaon', 'issue.md'), 'utf8'), /People can’t find anything/)
    assert.equal(linear.state().name, 'In Progress', 'the issue moved to In Progress')
    await s.shot(page, 'linear-agent-in-ade')

    // The page now says the issue is in the ADE.
    await page.click('.sidebar .nav-item', { text: /^Linear$/ })
    await page.find('.linear-started', { text: 'In the ADE', timeout: 20_000 })
    await page.click('.pr-row__title', { text: 'Add search to the docs' })
    await page.find('.linear-actions button', { text: /Open session/ })
    await s.shot(page, 'linear-in-ade')

    // From every page in the ADE's sidebar, a session takes you back to it: the
    // one already active (once a dead click), another one, or one of its agents.
    const sessionShown = (what) =>
      page.waitFor(
        () => {
          const pane = document.querySelector('.term-pane')
          return !document.querySelector('.sidebar .nav-item[data-active]') && pane !== null && pane.getBoundingClientRect().width > 0
        },
        { message: `the session, after ${what}`, timeout: 10_000 }
      )
    for (const pageName of ['Pull requests', 'Linear', 'Models', 'Plugins']) {
      await page.click('.sidebar .nav-item', { text: new RegExp(`^${pageName}$`) })
      await page.waitFor((name) => document.querySelector('.sidebar .nav-item[data-active]')?.textContent?.trim() === name, { args: [pageName], message: `${pageName} open` })
      await page.click('.ade-session[data-active] .ade-session__row')
      await sessionShown(`clicking the active session from ${pageName}`)
    }
    await page.click('.sidebar .nav-item', { text: /^Pull requests$/ })
    await page.click('.ade-session:not([data-active]) .ade-session__row')
    await sessionShown('clicking another session from Pull requests')
    await page.click('.sidebar .nav-item', { text: /^Linear$/ })
    await page.click('.ade-session[data-active] .ade-agent')
    await sessionShown('clicking an agent from Linear')
    await s.shot(page, 'back-to-the-session')
  } finally {
    linear.close()
  }
})
