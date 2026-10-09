import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { foldedBody, githubRepoOf, parseReview, reviewPrompt, reviewTask, REVIEW_FILE, TASK_FILE, type ReviewState, type ReviewTarget } from '@shared/prReview'
import { ISSUE_FILE, issuePrompt, reviewState, startedState, type LinearStatus } from '@shared/linear'
import { promptLine } from '../src/main/features/terminals'
import { prReviewFeature } from '../src/main/features/prReview'
import { linearFeature } from '../src/main/features/linear'
import { adeSessions } from '../src/main/features/ade'
import type { FeatureContext } from '../src/main/features/types'

/**
 * Pull request review by an agent, and Linear issues as ADE sessions —
 * against a fake `gh` (backed by a real local git repository) and a fake
 * Linear API, from a scratch home: never GitHub, Linear or the real ~.
 */

let home = ''
let bare = ''
let ghLog = ''
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

function handlers(feature: { register: (ctx: FeatureContext) => void }): Map<string, (...args: unknown[]) => unknown> {
  const map = new Map<string, (...args: unknown[]) => unknown>()
  feature.register({ ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => map.set(channel, fn), on: () => undefined } } as unknown as FeatureContext)
  return map
}

before(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-linear-')))
  process.env.HOME = home
  process.env.SHELL = '/usr/bin/false' // no login shell to read a PATH from: the fake gh stays first
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test'
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com'

  // "GitHub": a bare repository with main, and pull request #7's head.
  const work = path.join(home, 'seed')
  fs.mkdirSync(work)
  git(work, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(work, 'app.ts'), 'export const a = 1\n')
  git(work, 'add', '.')
  git(work, 'commit', '-q', '-m', 'first')
  git(work, 'checkout', '-q', '-b', 'fix-login')
  fs.writeFileSync(path.join(work, 'app.ts'), 'export const a = 2\n')
  git(work, 'commit', '-q', '-am', 'fix')
  bare = path.join(home, 'widget.git')
  execFileSync('git', ['clone', '-q', '--bare', work, bare])
  git(bare, 'update-ref', 'refs/pull/7/head', 'fix-login')

  // A fake gh: answers what Eaon asks, records what it was sent.
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin)
  ghLog = path.join(home, 'gh.log')
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
let input = ''
try { input = fs.readFileSync(0, 'utf8') } catch {}
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({ args, input }) + '\\n')
const say = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v))
if (args[0] === 'api' && args[1] === 'user') say('reviewer\\n')
else if (args[0] === 'pr' && args[1] === 'view' && args.includes('headRefOid')) say({ headRefOid: 'abc123' })
else if (args[0] === 'pr' && args[1] === 'view') say({ number: 7, title: 'Fix login', url: args[2], baseRefName: 'main', headRefName: 'fix-login', body: 'Fixes the login.', author: { login: 'someone' } })
else if (args[0] === 'repo' && args[1] === 'clone') require('child_process').execFileSync('git', ['clone', '-q', ${JSON.stringify(bare)}, args[3]])
else if (args[0] === 'api' && /pulls\\/7\\/reviews$/.test(args[1])) {
  const body = JSON.parse(input)
  if (body.comments && body.comments.some((c) => c.line > 1)) { process.stderr.write('HTTP 422: Unprocessable Entity (line must be part of the diff)'); process.exit(1) }
  say({ html_url: 'https://github.com/acme/widget/pull/7#pullrequestreview-1' })
}
else if (args[0] === 'pr' && args[1] === 'list') say(process.env.FAKE_PR_FOR_BRANCH ? [{ url: 'https://github.com/acme/widget/pull/8', title: 'ENG-12 Add search' }] : [])
else { process.stderr.write('unexpected: ' + args.join(' ')); process.exit(1) }
`
  )
  fs.chmodSync(path.join(bin, 'gh'), 0o755)
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
})

after(() => fs.rmSync(home, { recursive: true, force: true }))

/* ------------------------------------------------------------------ rules */

test('a review the agent wrote is made safe to show and post', () => {
  const r = parseReview({
    summary: '  Looks mostly fine. ',
    event: 'request_changes',
    comments: [
      { path: './src/a.ts', line: 3, body: 'Off by one.' },
      { file: 'b.ts', line: '9', comment: 'Unused.' },
      { path: '', line: 1, body: 'no file' },
      { path: 'c.ts', line: 0, body: 'no line' },
      { path: 'd.ts', line: 4, body: '   ' }
    ]
  })
  assert.deepEqual(r, {
    summary: 'Looks mostly fine.',
    event: 'REQUEST_CHANGES',
    comments: [
      { path: 'src/a.ts', line: 3, body: 'Off by one.' },
      { path: 'b.ts', line: 9, body: 'Unused.' }
    ]
  })
  assert.equal(parseReview({ summary: 'x', event: 'MERGE IT' })?.event, 'COMMENT')
  assert.equal(parseReview({}), null)
  assert.equal(parseReview('nope'), null)
  assert.match(foldedBody(r!), /Looks mostly fine\.[\s\S]*`src\/a\.ts` line 3[\s\S]*Off by one\./)
})

test('the brief tells the agent what to review, where to write, and not to change anything', () => {
  const t: ReviewTarget = { repo: 'acme/widget', number: 7, title: 'Fix login', url: 'https://github.com/acme/widget/pull/7', base: 'main', head: 'fix-login', body: 'Fixes it.', own: true }
  const brief = reviewTask(t)
  assert.match(brief, /git diff origin\/main\.\.\.HEAD/)
  assert.match(brief, new RegExp(REVIEW_FILE.replace('.', '\\.')))
  assert.match(brief, /Do not change, commit or push anything/)
  assert.match(brief, /Do not run the pull request’s code/, 'a stranger’s code is read, not run')
  assert.match(brief, /own pull request/)
  assert.ok(!reviewPrompt(t).includes('\n'))
  assert.match(reviewPrompt(t), new RegExp(TASK_FILE.replace('.', '\\.')))
  for (const [remote, repo] of [
    ['https://github.com/acme/widget.git', 'acme/widget'],
    ['git@github.com:acme/widget.git', 'acme/widget'],
    ['https://github.com/acme/widget', 'acme/widget'],
    ['https://gitlab.com/acme/widget.git', null]
  ] as const) assert.equal(githubRepoOf(remote), repo, remote)
})

test('an agent given a task starts on it, quoted whole; a resumed conversation or a shell is left alone', () => {
  const base = { paneId: 'p', cwd: '/w', cols: 80, rows: 24 }
  assert.equal(promptLine({ ...base, command: 'claude', agent: 'claude', prompt: "Review PR #7 (it's broken). Read .eaon/review-task.md" }).command, `claude 'Review PR #7 (it'\\''s broken). Read .eaon/review-task.md'`)
  assert.equal(promptLine({ ...base, command: 'codex', agent: 'codex', prompt: 'a\nb; rm -rf /' }).command, `codex 'a b; rm -rf /'`)
  assert.equal(promptLine({ ...base, command: 'claude', agent: 'claude', prompt: 'x', resume: 'id' }).command, 'claude')
  assert.equal(promptLine({ ...base, command: null, agent: 'shell', prompt: 'x' }).command, null)
})

test('Linear: work moves an issue to its first started state, and an open PR to its review one', () => {
  const states = [
    { id: 'b', name: 'Backlog', type: 'backlog', position: 0 },
    { id: 'r', name: 'In Review', type: 'started', position: 2 },
    { id: 'p', name: 'In Progress', type: 'started', position: 1 },
    { id: 'd', name: 'Done', type: 'completed', position: 3 }
  ]
  assert.equal(startedState(states)?.name, 'In Progress')
  assert.equal(reviewState(states)?.name, 'In Review')
  assert.equal(reviewState(states.filter((s) => s.id !== 'r')), null, 'no review state: it stays where it is')
  assert.ok(!issuePrompt({ identifier: 'ENG-1', title: 'a\nb' }).includes('\n'))
})

/* ------------------------------------------------------------------ PR review, end to end */

test('Review: the PR is cloned, checked out in a worktree session with the brief; the review is read back and posted, as one comment when GitHub refuses a line', async () => {
  const pr = handlers(prReviewFeature)
  const url = 'https://github.com/acme/widget/pull/7'
  const started = (await pr.get('pr-review:start')!(null, url)) as { ok: true; state: ReviewState; prompt: string }
  assert.ok(started.ok, JSON.stringify(started))
  const { cwd } = started.state
  assert.ok(cwd.startsWith(path.join(home, 'Eaon', 'worktrees')), cwd)
  assert.equal(fs.readFileSync(path.join(cwd, 'app.ts'), 'utf8'), 'export const a = 2\n', 'the PR’s head is checked out')
  assert.match(fs.readFileSync(path.join(cwd, TASK_FILE), 'utf8'), /Review pull request #7: Fix login/)
  assert.equal(git(cwd, 'status', '--porcelain'), '', '.eaon/ is kept out of git')
  const session = adeSessions().get(started.state.sessionId)
  assert.equal(session?.title, 'Review #7: Fix login')
  assert.equal(session?.worktree, true)
  assert.match(started.prompt, /Review pull request #7/)

  // Nothing written yet; then the agent writes its review.
  let list = (await pr.get('pr-review:list')!(null)) as ReviewState[]
  assert.equal(list[0].review, null)
  fs.writeFileSync(path.join(cwd, REVIEW_FILE), JSON.stringify({ summary: 'One problem.', event: 'REQUEST_CHANGES', comments: [{ path: 'app.ts', line: 1, body: 'Why 2?' }] }))
  list = (await pr.get('pr-review:list')!(null)) as ReviewState[]
  assert.equal(list[0].review?.comments.length, 1)

  // Posted as edited: the event and the line comment go to GitHub.
  fs.writeFileSync(ghLog, '')
  const posted = (await pr.get('pr-review:post')!(null, url, { ...list[0].review!, summary: 'One problem, edited.' })) as { ok: boolean; url: string }
  assert.deepEqual(posted, { ok: true, url: 'https://github.com/acme/widget/pull/7#pullrequestreview-1' })
  const sent = fs.readFileSync(ghLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; input: string }).find((c) => c.args[1]?.endsWith('/reviews'))!
  assert.deepEqual(JSON.parse(sent.input), { commit_id: 'abc123', event: 'REQUEST_CHANGES', body: 'One problem, edited.', comments: [{ path: 'app.ts', line: 1, side: 'RIGHT', body: 'Why 2?' }] })

  // A line GitHub won't take: the whole review goes as one comment instead of failing.
  fs.writeFileSync(ghLog, '')
  const folded = (await pr.get('pr-review:post')!(null, url, { summary: 'S', event: 'COMMENT', comments: [{ path: 'app.ts', line: 40, body: 'Far away.' }] })) as { ok: boolean }
  assert.equal(folded.ok, true)
  const calls = fs.readFileSync(ghLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; input: string }).filter((c) => c.args[1]?.endsWith('/reviews'))
  assert.equal(calls.length, 2)
  assert.deepEqual(JSON.parse(calls[1].input).comments, undefined)
  assert.match(JSON.parse(calls[1].input).body, /`app\.ts` line 40[\s\S]*Far away\./)
})

/* ------------------------------------------------------------------ Linear, end to end */

test('Linear: connect, list, Start makes a session on the issue’s branch and moves it; a PR opening links it and moves it to review', async () => {
  const seen: { query: string; variables: Record<string, unknown> }[] = []
  const issue = {
    id: 'iss-1',
    identifier: 'ENG-12',
    title: 'Add search',
    description: 'Search the docs.',
    url: 'https://linear.app/acme/issue/ENG-12',
    branchName: 'test/eng-12-add-search',
    priority: 2,
    priorityLabel: 'High',
    updatedAt: '2026-10-08T00:00:00Z',
    state: { name: 'Todo', type: 'unstarted', color: '#999999' },
    team: { id: 't1', key: 'ENG', name: 'Engineering' }
  }
  const states = [
    { id: 's-todo', name: 'Todo', type: 'unstarted', position: 0 },
    { id: 's-prog', name: 'In Progress', type: 'started', position: 1 },
    { id: 's-rev', name: 'In Review', type: 'started', position: 2 }
  ]
  let current = { type: 'unstarted', name: 'Todo' }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const { query, variables } = JSON.parse(body) as { query: string; variables: Record<string, unknown> }
      seen.push({ query, variables })
      const send = (data: unknown): void => void res.end(JSON.stringify({ data }))
      if (req.headers.authorization !== 'lin_api_testtesttesttesttesttest') return void ((res.statusCode = 401), res.end('{}'))
      if (query.includes('assignedIssues')) return send({ viewer: { assignedIssues: { nodes: [issue] } } })
      if (query.includes('viewer')) return send({ viewer: { name: 'Al', email: 'al@example.com' } })
      if (query.includes('issueUpdate')) {
        const s = states.find((x) => x.id === variables.state)!
        current = { type: s.type, name: s.name }
        return send({ issueUpdate: { success: true } })
      }
      if (query.includes('attachmentLinkURL')) return send({ attachmentLinkURL: { success: true } })
      if (query.includes('issue(id')) return send({ issue: { ...issue, state: { ...current, color: '#999' }, team: { ...issue.team, states: { nodes: states } } } })
      res.statusCode = 400
      res.end('{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  process.env.EAON_LINEAR_API = `http://127.0.0.1:${(server.address() as { port: number }).port}/graphql`
  try {
    const linear = handlers(linearFeature)
    assert.equal(((await linear.get('linear:status')!(null)) as LinearStatus).connected, false)
    assert.match(((await linear.get('linear:connect')!(null, 'not-a-key')) as LinearStatus).error ?? '', /lin_api_/)
    const connected = (await linear.get('linear:connect')!(null, 'lin_api_testtesttesttesttesttest')) as LinearStatus
    assert.deepEqual(connected.user, { name: 'Al', email: 'al@example.com' })

    const listed = (await linear.get('linear:issues')!(null)) as { ok: true; issues: { identifier: string }[] }
    assert.deepEqual(listed.issues.map((i) => i.identifier), ['ENG-12'])

    // A project in the ADE: the clone the review made.
    const project = path.join(home, 'Eaon', 'repos', 'acme', 'widget')
    const startedIssue = (await linear.get('linear:start')!(null, 'iss-1', project)) as { ok: true; session: { cwd: string; title: string }; prompt: string; moved: string }
    assert.ok(startedIssue.ok, JSON.stringify(startedIssue))
    assert.equal(git(startedIssue.session.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'test/eng-12-add-search', 'on the branch Linear named')
    assert.match(fs.readFileSync(path.join(startedIssue.session.cwd, ISSUE_FILE), 'utf8'), /ENG-12: Add search[\s\S]*Search the docs\./)
    assert.equal(startedIssue.session.title, 'ENG-12 Add search')
    assert.equal(startedIssue.moved, 'In Progress')
    assert.equal(current.name, 'In Progress')

    // No PR yet: nothing happens. Then one opens.
    await linear.get('linear:sync')!(null)
    assert.ok(!seen.some((s) => s.query.includes('attachmentLinkURL')))
    process.env.FAKE_PR_FOR_BRANCH = '1'
    await linear.get('linear:sync')!(null)
    const link = seen.find((s) => s.query.includes('attachmentLinkURL'))
    assert.deepEqual(link?.variables, { id: 'iss-1', url: 'https://github.com/acme/widget/pull/8', title: 'ENG-12 Add search' })
    assert.equal(current.name, 'In Review')
    // Linked once.
    const before = seen.length
    await linear.get('linear:sync')!(null)
    assert.equal(seen.filter((s) => s.query.includes('attachmentLinkURL')).length, 1)
    assert.ok(seen.length === before)

    assert.equal(((await linear.get('linear:disconnect')!(null)) as LinearStatus).connected, false)
  } finally {
    delete process.env.FAKE_PR_FOR_BRANCH
    delete process.env.EAON_LINEAR_API
    server.close()
  }
})
