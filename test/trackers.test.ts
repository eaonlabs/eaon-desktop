import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { ISSUE_FILE } from '@shared/linear'
import {
  adfToText,
  githubBranch,
  isJiraKey,
  issueFromBranch,
  jiraBranch,
  jiraSite,
  parseGithubId,
  reviewTransition,
  slug,
  startTransition,
  trackerPrompt,
  trackerTask,
  type JiraTransition,
  type TrackerIssue,
  type TrackerIssuesResult,
  type TrackerStartResult,
  type TrackerStatus
} from '@shared/trackers'
import { commitPrompt, prPrompt } from '@shared/gitAssist'
import { trackersFeature } from '../src/main/features/trackers'
import type { FeatureContext } from '../src/main/features/types'

/**
 * Jira and GitHub issues as ADE sessions: the rules, then each tracker end to
 * end against a fake Jira API on this computer and a fake `gh` (backed by a
 * real local git repository), from a scratch home: never Atlassian, GitHub or
 * the real ~.
 */

let home = ''
let project = ''
let ghLog = ''
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

function handlers(feature: { register: (ctx: FeatureContext) => void }): Map<string, (...args: unknown[]) => unknown> {
  const map = new Map<string, (...args: unknown[]) => unknown>()
  feature.register({ ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => map.set(channel, fn), on: () => undefined } } as unknown as FeatureContext)
  return map
}

before(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trackers-')))
  process.env.HOME = home
  process.env.SHELL = '/usr/bin/false' // no login shell to read a PATH from: the fake gh stays first
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test'
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com'

  project = path.join(home, 'widget')
  fs.mkdirSync(project)
  git(project, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(project, 'app.ts'), 'export const a = 1\n')
  git(project, 'add', '.')
  git(project, 'commit', '-q', '-m', 'first')

  // A fake gh: answers what Eaon asks, records what it was sent.
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin)
  ghLog = path.join(home, 'gh.log')
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(args) + '\\n')
const say = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v))
if (process.env.FAKE_GH_SIGNED_OUT) { process.stderr.write('To get started with GitHub CLI, please run: gh auth login'); process.exit(4) }
if (args[0] === 'api' && args[1] === 'user') say('octo\\n')
else if (args[0] === 'search' && args[1] === 'issues') say([
  { number: 3, title: 'Older bug', body: 'x', url: 'https://github.com/acme/widget/issues/3', updatedAt: '2026-10-01T00:00:00Z', repository: { nameWithOwner: 'acme/widget' }, labels: [] },
  { number: 12, title: 'Add search!', body: 'Search the docs.', url: 'https://github.com/acme/widget/issues/12', updatedAt: '2026-10-08T00:00:00Z', repository: { nameWithOwner: 'acme/widget' }, labels: [{ name: 'bug' }, { name: 'help wanted' }] }
])
else if (args[0] === 'issue' && args[1] === 'view') say({ number: 12, title: 'Add search!', body: 'Search the docs.', url: 'https://github.com/acme/widget/issues/12', updatedAt: '2026-10-08T00:00:00Z', labels: [{ name: 'bug' }] })
else if (args[0] === 'pr' && args[1] === 'list') say(process.env.FAKE_PR_FOR_BRANCH ? [{ url: 'https://github.com/acme/widget/pull/8', title: 'ENG-12 Add search' }] : [])
else { process.stderr.write('unexpected: ' + args.join(' ')); process.exit(1) }
`
  )
  fs.chmodSync(path.join(bin, 'gh'), 0o755)
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
})

after(() => fs.rmSync(home, { recursive: true, force: true }))

/* ------------------------------------------------------------------ rules */

test('a Jira site is taken from what people type, and only ever as https to a host', () => {
  assert.equal(jiraSite('acme'), 'https://acme.atlassian.net')
  assert.equal(jiraSite('  Acme.atlassian.net '), 'https://acme.atlassian.net')
  assert.equal(jiraSite('https://acme.atlassian.net/jira/software/projects/ENG/boards/1'), 'https://acme.atlassian.net', 'a pasted link keeps only the site')
  assert.equal(jiraSite('jira.example.com'), 'https://jira.example.com')
  assert.equal(jiraSite('http://acme.atlassian.net'), null, 'the token never goes in the clear')
  assert.equal(jiraSite('https://user:pass@acme.atlassian.net'), null, 'no login in the address')
  assert.equal(jiraSite('not a site'), null)
  assert.equal(jiraSite(''), null)
  assert.equal(jiraSite(42), null)
  assert.equal(jiraSite('http://127.0.0.1:4010'), 'http://127.0.0.1:4010', 'a scratch server on this computer is fine')
  assert.equal(jiraSite('http://evil.example.com'), null)
})

test('Jira keys and GitHub ids are only what they should be', () => {
  assert.ok(isJiraKey('ENG-12'))
  assert.ok(isJiraKey('PLAT_X2-4001'))
  for (const bad of ['eng-12', 'ENG-', '12', 'ENG-12/../x', 'ENG-12 ', 'E-1', '', null, 5]) assert.ok(!isJiraKey(bad), String(bad))
  assert.deepEqual(parseGithubId('acme/widget#12'), { repo: 'acme/widget', number: 12 })
  for (const bad of ['acme/widget', 'acme/widget#', '#12', 'a b/c#1', '../x/y#1', 'acme/widget#12; rm', null]) assert.equal(parseGithubId(bad), null, String(bad))
})

test('branches are named for the issue, short and safe for git', () => {
  assert.equal(slug('Fix the login page!'), 'fix-the-login-page')
  assert.equal(slug('Crème brûlée: ünïcode'), 'creme-brulee-unicode')
  assert.equal(slug('!!!'), 'issue')
  assert.ok(slug('x'.repeat(200)).length <= 40)
  assert.equal(jiraBranch('ENG-12', 'Add search'), 'eng-12-add-search')
  assert.equal(githubBranch(12, 'Add search!'), 'issue-12-add-search')
})

test('Jira’s rich text becomes plain text the agent can read', () => {
  const doc = {
    type: 'doc',
    version: 1,
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Goal' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Search the ' }, { type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href: 'https://x.test/docs' } }] }, { type: 'text', text: '.' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] }] },
      { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] }] },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const a = 1' }] },
      { type: 'paragraph', content: [{ type: 'mention', attrs: { text: '@al' } }, { type: 'hardBreak' }, { type: 'text', text: 'please look' }] },
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x' } }] }
    ]
  }
  assert.equal(adfToText(doc), ['## Goal', 'Search the docs (https://x.test/docs).', '- one', '- two', '1. first', '```ts', 'const a = 1', '```', '@al', 'please look', '[attachment]'].join('\n'))
  assert.equal(adfToText(null), '')
  assert.equal(adfToText('already text '), 'already text')
  assert.equal(adfToText({ type: 'doc', content: [] }), '')
})

test('work moves a Jira issue to an in-progress status that is not a review one, and an open PR to the review one', () => {
  const t = (id: string, name: string, category: string): JiraTransition => ({ id, name, to: { name, category } })
  const list = [t('1', 'To Do', 'new'), t('2', 'In Review', 'indeterminate'), t('3', 'In Progress', 'indeterminate'), t('4', 'Done', 'done')]
  assert.equal(startTransition(list)?.id, '3')
  assert.equal(reviewTransition(list)?.id, '2')
  assert.equal(startTransition([t('2', 'In Review', 'indeterminate')])?.id, '2', 'a project with only a review status still moves')
  assert.equal(startTransition([t('1', 'To Do', 'new'), t('4', 'Done', 'done')]), null, 'never straight to done')
  assert.equal(reviewTransition([t('3', 'In Progress', 'indeterminate')]), null)
})

test('the brief tells the agent which tracker the issue is from and how its pull request finds it', () => {
  const issue: TrackerIssue = {
    tracker: 'github',
    id: 'acme/widget#12',
    key: '#12',
    title: 'Add search',
    description: 'Search the docs.',
    url: 'https://github.com/acme/widget/issues/12',
    branchName: 'issue-12-add-search',
    priorityLabel: '',
    status: { name: 'Open', category: 'todo', color: '#e2a32f' },
    group: { id: 'acme/widget', name: 'acme/widget' },
    labels: ['bug'],
    updatedAt: ''
  }
  assert.match(trackerTask(issue), /Closes acme\/widget#12/)
  assert.match(trackerTask(issue), /Labels: bug/)
  assert.match(trackerPrompt(issue), new RegExp(`GitHub issue acme/widget#12 .*${ISSUE_FILE.replace('.', '\\.')}`))
  const jira = trackerTask({ ...issue, tracker: 'jira', id: 'ENG-12', key: 'ENG-12', description: '' })
  assert.match(jira, /title starts with `ENG-12`/)
  assert.match(jira, /_\(no description\)_/)
})

test('the issue a branch was made for is found from its name, and ordinary branches are left alone', () => {
  assert.deepEqual(issueFromBranch('eng-12-add-search'), { kind: 'jira', key: 'ENG-12' })
  assert.deepEqual(issueFromBranch('al/eng-123-fix-login'), { kind: 'jira', key: 'ENG-123' })
  assert.deepEqual(issueFromBranch('feature/plat2-45'), { kind: 'jira', key: 'PLAT2-45' })
  assert.deepEqual(issueFromBranch('issue-12-add-search'), { kind: 'github', number: 12 })
  assert.deepEqual(issueFromBranch('fix/issue-7'), { kind: 'github', number: 7 })
  for (const none of ['main', 'feature/add-dark-mode-toggle', 'release-2026-1', 'v2-3', 'hotfix-12', 'feature/tmp-9', 'fix/the-2-things', '', null, undefined]) assert.equal(issueFromBranch(none), null, String(none))
})

test('a commit message and a pull request are asked to name the issue the branch is for', () => {
  const diff = { text: 'diff', sent: [], cut: false } as never
  const jiraCommit = commitPrompt({ diff, branch: 'eng-12-add-search', recent: [] })
  assert.match(jiraCommit, /issue ENG-12[\s\S]*prefix[\s\S]*Refs ENG-12/)
  assert.match(commitPrompt({ diff, branch: 'issue-12-x', recent: [] }), /GitHub issue #12[\s\S]*Refs #12/)
  assert.doesNotMatch(commitPrompt({ diff, branch: 'feature/add-search', recent: [] }), /issue/i)
  assert.match(prPrompt({ diff, branch: 'eng-12-add-search', base: 'main', commits: [], template: null }), /Begin the title with ENG-12/)
  assert.match(prPrompt({ diff, branch: 'issue-12-x', base: 'main', commits: [], template: null }), /Closes #12/)
  assert.doesNotMatch(prPrompt({ diff, branch: 'feature/x', base: 'main', commits: [], template: null }), /Closes|Begin the title/)
})

/* -------------------------------------------------------------- GitHub */

test('GitHub: signed in through gh, the issues are listed newest first, and Start makes the session on an issue branch', async () => {
  const h = handlers(trackersFeature)
  const status = (await h.get('trackers:status')!(null, 'github')) as TrackerStatus
  assert.equal(status.connected, true)
  assert.equal(status.user?.name, 'octo')

  const listed = (await h.get('trackers:issues')!(null, 'github')) as TrackerIssuesResult
  assert.ok(listed.ok)
  assert.deepEqual(listed.issues.map((i) => i.id), ['acme/widget#12', 'acme/widget#3'])
  assert.deepEqual(listed.issues[0].labels, ['bug', 'help wanted'])
  assert.equal(listed.issues[0].branchName, 'issue-12-add-search')

  const started = (await h.get('trackers:start')!(null, 'github', 'acme/widget#12', project)) as TrackerStartResult
  assert.ok(started.ok, JSON.stringify(started))
  assert.equal(git(started.session.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'issue-12-add-search')
  assert.match(fs.readFileSync(path.join(started.session.cwd, ISSUE_FILE), 'utf8'), /acme\/widget#12: Add search![\s\S]*Search the docs\.[\s\S]*Closes acme\/widget#12/)
  assert.equal(started.moved, null, 'GitHub issues have no status to move')
  assert.equal(git(project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the project folder is not touched')
  assert.equal(git(started.session.cwd, 'status', '--porcelain'), '', '.eaon is excluded, so the worktree is clean')

  // Again: the same session, not a second worktree.
  const again = (await h.get('trackers:start')!(null, 'github', 'acme/widget#12', project)) as TrackerStartResult
  assert.ok(again.ok)
  assert.equal(again.session.cwd, started.session.cwd)

  const after = (await h.get('trackers:issues')!(null, 'github')) as TrackerIssuesResult
  assert.ok(after.ok)
  assert.equal(after.sessions['acme/widget#12'], started.session.cwd)
  assert.equal(after.sessions['acme/widget#3'], undefined)
})

test('GitHub: not signed in, or an id that is not an issue, says so and does nothing', async () => {
  const h = handlers(trackersFeature)
  process.env.FAKE_GH_SIGNED_OUT = '1'
  try {
    const status = (await h.get('trackers:status')!(null, 'github')) as TrackerStatus
    assert.equal(status.connected, false)
    assert.match(status.error ?? '', /gh auth login/)
    const listed = (await h.get('trackers:issues')!(null, 'github')) as TrackerIssuesResult
    assert.ok(!listed.ok && /gh auth login/.test(listed.error))
  } finally {
    delete process.env.FAKE_GH_SIGNED_OUT
  }
  const bad = (await h.get('trackers:start')!(null, 'github', '../../etc#1', project)) as TrackerStartResult
  assert.ok(!bad.ok)
  const nope = (await h.get('trackers:start')!(null, 'github', 'acme/widget#12', path.join(home, 'not-a-repo'))) as TrackerStartResult
  assert.ok(!nope.ok)
  const unknown = (await h.get('trackers:issues')!(null, 'trello')) as TrackerIssuesResult
  assert.ok(!unknown.ok)
})

/* ---------------------------------------------------------------- Jira */

test('Jira: connect with a token, list, Start moves the issue, a PR opening links it and moves it to review; nothing leaves for another host', async () => {
  const requests: { method: string; url: string; auth: string | undefined; body: unknown }[] = []
  const issue = {
    key: 'ENG-12',
    fields: {
      summary: 'Add search',
      description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Search the docs.' }] }] },
      updated: '2026-10-08T00:00:00.000+0000',
      labels: ['backend'],
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      priority: { name: 'High' },
      project: { key: 'ENG', name: 'Engineering' }
    }
  }
  const transitions = [
    { id: '11', name: 'Start', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
    { id: '21', name: 'Request review', to: { name: 'In Review', statusCategory: { key: 'indeterminate' } } },
    { id: '31', name: 'Finish', to: { name: 'Done', statusCategory: { key: 'done' } } }
  ]
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const parsed = body ? (JSON.parse(body) as unknown) : null
      requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: parsed })
      const send = (data: unknown, status = 200): void => {
        res.statusCode = status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(data))
      }
      const expected = `Basic ${Buffer.from('al@example.com:jira-token-123').toString('base64')}`
      if (req.headers.authorization !== expected) return send({ errorMessages: ['nope'] }, 401)
      if (req.url === '/rest/api/3/myself') return send({ displayName: 'Al', emailAddress: 'al@example.com' })
      if (req.url!.startsWith('/rest/api/3/search/jql')) return send({ issues: [issue] })
      if (req.url!.startsWith('/rest/api/3/issue/ENG-12?')) return send(issue)
      if (req.url === '/rest/api/3/issue/ENG-12/transitions' && req.method === 'GET') return send({ transitions })
      if (req.url === '/rest/api/3/issue/ENG-12/transitions' && req.method === 'POST') {
        const t = transitions.find((x) => x.id === (parsed as { transition: { id: string } }).transition.id)!
        issue.fields.status = { name: t.to.name, statusCategory: { key: t.to.statusCategory.key } }
        res.statusCode = 204
        return void res.end()
      }
      if (req.url === '/rest/api/3/issue/ENG-12/remotelink') return send({ id: 1 }, 201)
      send({ errorMessages: ['unexpected'] }, 400)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  process.env.EAON_JIRA_API = `http://127.0.0.1:${port}`
  try {
    const h = handlers(trackersFeature)
    assert.equal(((await h.get('trackers:status')!(null, 'jira')) as TrackerStatus).connected, false)
    for (const bad of [{ site: 'nope nope', email: 'al@example.com', token: 'jira-token-123' }, { site: 'acme', email: 'not-an-email', token: 'jira-token-123' }, { site: 'acme', email: 'al@example.com', token: 'x' }, undefined]) {
      assert.equal(((await h.get('trackers:connect')!(null, 'jira', bad)) as TrackerStatus).connected, false)
    }
    const wrong = (await h.get('trackers:connect')!(null, 'jira', { site: `http://127.0.0.1:${port}`, email: 'al@example.com', token: 'wrong-token-1' })) as TrackerStatus
    assert.equal(wrong.connected, false)
    assert.match(wrong.error ?? '', /didn’t accept that email and API token/)
    assert.equal(((await h.get('trackers:status')!(null, 'jira')) as TrackerStatus).connected, false, 'a wrong token is not kept')

    const connected = (await h.get('trackers:connect')!(null, 'jira', { site: `http://127.0.0.1:${port}`, email: 'al@example.com', token: 'jira-token-123' })) as TrackerStatus
    assert.deepEqual(connected.user, { name: 'Al', email: 'al@example.com' })
    assert.equal(((await h.get('trackers:status')!(null, 'jira')) as TrackerStatus).connected, true, 'kept, so it is still connected')

    const listed = (await h.get('trackers:issues')!(null, 'jira')) as TrackerIssuesResult
    assert.ok(listed.ok, JSON.stringify(listed))
    assert.deepEqual(listed.issues.map((i) => [i.id, i.title, i.description, i.priorityLabel, i.status.name, i.status.category, i.group.name]), [
      ['ENG-12', 'Add search', 'Search the docs.', 'High', 'To Do', 'todo', 'Engineering']
    ])
    const search = requests.find((r) => r.url.startsWith('/rest/api/3/search/jql'))!
    assert.match(decodeURIComponent(search.url), /assignee = currentUser\(\) AND statusCategory != Done/)

    const started = (await h.get('trackers:start')!(null, 'jira', 'ENG-12', project)) as TrackerStartResult
    assert.ok(started.ok, JSON.stringify(started))
    assert.equal(git(started.session.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'eng-12-add-search')
    assert.match(fs.readFileSync(path.join(started.session.cwd, ISSUE_FILE), 'utf8'), /ENG-12: Add search[\s\S]*Search the docs\.[\s\S]*title starts with `ENG-12`/)
    assert.equal(started.session.title, 'ENG-12 Add search')
    assert.equal(started.moved, 'In Progress')
    assert.equal(issue.fields.status.name, 'In Progress')

    // No PR yet: nothing happens. Then one opens.
    await h.get('trackers:sync')!(null)
    assert.ok(!requests.some((r) => r.url.endsWith('/remotelink')))
    process.env.FAKE_PR_FOR_BRANCH = '1'
    await h.get('trackers:sync')!(null)
    const link = requests.find((r) => r.url.endsWith('/remotelink'))
    assert.deepEqual(link?.body, { globalId: 'https://github.com/acme/widget/pull/8', object: { url: 'https://github.com/acme/widget/pull/8', title: 'ENG-12 Add search' } })
    assert.equal(issue.fields.status.name, 'In Review')
    // Linked once.
    await h.get('trackers:sync')!(null)
    assert.equal(requests.filter((r) => r.url.endsWith('/remotelink')).length, 1)

    // An issue already in progress stays where it is when started again.
    const again = (await h.get('trackers:start')!(null, 'jira', 'ENG-12', project)) as TrackerStartResult
    assert.ok(again.ok)
    assert.equal(again.moved, null)
    assert.equal(again.session.cwd, started.session.cwd)

    // Every request carried the token to the one site.
    assert.ok(requests.every((r) => r.auth === `Basic ${Buffer.from('al@example.com:jira-token-123').toString('base64')}` || r.url === '/rest/api/3/myself'))

    const gone = (await h.get('trackers:disconnect')!(null, 'jira')) as TrackerStatus
    assert.equal(gone.connected, false)
    const after = (await h.get('trackers:issues')!(null, 'jira')) as TrackerIssuesResult
    assert.ok(!after.ok && /Connect Jira first/.test(after.error))
  } finally {
    delete process.env.FAKE_PR_FOR_BRANCH
    delete process.env.EAON_JIRA_API
    server.close()
  }
})

test('Jira: a site that never answers, or a key that is not an issue, fails clearly', async () => {
  const h = handlers(trackersFeature)
  process.env.EAON_JIRA_API = 'http://127.0.0.1:1'
  try {
    const c = (await h.get('trackers:connect')!(null, 'jira', { site: 'http://127.0.0.1:1', email: 'al@example.com', token: 'jira-token-123' })) as TrackerStatus
    assert.equal(c.connected, false)
    assert.match(c.error ?? '', /Jira didn’t answer/)
  } finally {
    delete process.env.EAON_JIRA_API
  }
  const start = (await h.get('trackers:start')!(null, 'jira', 'ENG-12', project)) as TrackerStartResult
  assert.ok(!start.ok && /Connect Jira first/.test(start.error))
})

test('Jira: a site that redirects somewhere else never gets the token followed there', async () => {
  let sentToOther = 0
  const other = http.createServer((_req, res) => {
    sentToOther++
    res.end('{}')
  })
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r))
  const otherPort = (other.address() as { port: number }).port
  const site = http.createServer((_req, res) => {
    res.statusCode = 302
    res.setHeader('Location', `http://127.0.0.1:${otherPort}/steal`)
    res.end()
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r))
  const port = (site.address() as { port: number }).port
  process.env.EAON_JIRA_API = `http://127.0.0.1:${port}`
  try {
    const h = handlers(trackersFeature)
    const c = (await h.get('trackers:connect')!(null, 'jira', { site: `http://127.0.0.1:${port}`, email: 'al@example.com', token: 'jira-token-123' })) as TrackerStatus
    assert.equal(c.connected, false)
    assert.equal(sentToOther, 0, 'the redirect was not followed')
  } finally {
    delete process.env.EAON_JIRA_API
    site.close()
    other.close()
  }
})
