import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseUnifiedDiff, type ReviewFile } from '../src/shared/adeReview'
import {
  COMMIT_DIFF_CAP,
  cleanCommitMessage,
  describeSent,
  diffForModel,
  findingsMessage,
  groupFindings,
  looksSecret,
  parseLocalReview,
  parsePrText
} from '../src/shared/gitAssist'
import { HostBook } from '../src/main/features/ade/hosts'
import { makeRunner } from '../src/main/features/ade/runner'
import { reviewLocalChanges, workingChanges, writeCommitMessage, writePullRequestText } from '../src/main/features/ade/assist'
import { askModel, type AskRequest } from '../src/main/agent/askModel'
import { removeProvider, updateProvider } from '../src/main/providers'
import { secrets } from '../src/main/secrets'

/**
 * The model's help with git (shared/gitAssist.ts, main/features/ade/assist.ts):
 * what of a diff is sent and how much, the prompts, the reading of answers,
 * and the three requests against a real repository with a stand-in model.
 * No test reaches a real model: `ask` is an argument, and askModel itself is
 * tried against a provider on this computer.
 */

const file = (path: string, lines: Array<['add' | 'del' | 'ctx', string]>, extra: Partial<ReviewFile> = {}): ReviewFile => {
  let old = 1
  let cur = 1
  return {
    path,
    oldPath: null,
    status: 'modified',
    added: lines.filter(([k]) => k === 'add').length,
    removed: lines.filter(([k]) => k === 'del').length,
    binary: false,
    hunks: [
      {
        header: '@@ -1,3 +1,4 @@',
        lines: lines.map(([kind, text]) => ({ kind, text, old: kind === 'add' ? null : old++, cur: kind === 'del' ? null : cur++ }))
      }
    ],
    ...extra
  }
}

const big = (path: string, n: number): ReviewFile => file(path, Array.from({ length: n }, (_, i) => ['add', `const value${i} = ${i} // some filler to take room`] as ['add', string]))

/* ------------------------------------------------------------------ what is sent */

test('a change that fits goes whole, every file named and its lines under it', () => {
  const d = diffForModel([file('src/a.ts', [['ctx', 'one'], ['del', 'two'], ['add', 'TWO']]), file('src/b.ts', [['add', 'new line']], { status: 'added' })], { cap: COMMIT_DIFF_CAP })
  assert.equal(d.files, 2)
  assert.equal(d.shown, 2)
  assert.equal(d.named, 0)
  assert.equal(d.cut, false)
  assert.match(d.text, /Changed files:\nM src\/a\.ts \(\+1 -1\)\nA src\/b\.ts \(\+1 -0\)/)
  assert.match(d.text, /=== src\/a\.ts \(modified, \+1 -1\)\n@@ -1,3 \+1,4 @@\n one\n-two\n\+TWO/)
  assert.match(d.text, /\+new line/)
})

test('one huge file is cut and the small ones still go whole, inside the cap', () => {
  const small = file('small.ts', [['add', 'tiny change']])
  const d = diffForModel([big('huge.ts', 4000), small, file('other.ts', [['del', 'gone']])], { cap: 6000 })
  assert.equal(d.cut, true)
  assert.ok(d.text.length <= 6000, `text is ${d.text.length} characters`)
  assert.match(d.text, /\+tiny change/)
  assert.match(d.text, /-gone/)
  assert.match(d.text, /more lines of this file not shown/)
  assert.equal(d.shown, 3)
})

test('with room for nothing but names, the files are named and the cut is said', () => {
  const files = Array.from({ length: 30 }, (_, i) => big(`f${i}.ts`, 200))
  const d = diffForModel(files, { cap: 2500 })
  assert.equal(d.cut, true)
  assert.ok(d.named > 0)
  assert.ok(d.text.length <= 2500, `text is ${d.text.length} characters`)
  for (const f of files) assert.ok(d.text.includes(f.path), `${f.path} is named`)
  assert.match(d.text, /not shown, over the size limit/)
})

test('a change of hundreds of files is listed to a limit and counted', () => {
  const files = Array.from({ length: 300 }, (_, i) => file(`dir/file${i}.ts`, [['add', 'x']]))
  const d = diffForModel(files, { cap: COMMIT_DIFF_CAP })
  assert.equal(d.files, 300)
  assert.equal(d.cut, true)
  assert.match(d.text, /\.\.\. and 180 more files/)
  assert.ok(d.text.length <= COMMIT_DIFF_CAP)
})

test('secrets, binaries and generated files are named and never read', () => {
  const files = [
    file('.env', [['add', 'API_KEY=sk-live-very-secret']], { status: 'added' }),
    file('certs/server.pem', [['add', '-----BEGIN PRIVATE KEY-----']], { status: 'added' }),
    file('.env.example', [['add', 'API_KEY=']], { status: 'added' }),
    file('package-lock.json', [['add', '"resolved": "https://registry"']]),
    file('logo.png', [], { binary: true, status: 'added' }),
    file('src/app.ts', [['add', 'real change']])
  ]
  const d = diffForModel(files, { cap: COMMIT_DIFF_CAP })
  assert.doesNotMatch(d.text, /sk-live-very-secret/)
  assert.doesNotMatch(d.text, /BEGIN PRIVATE KEY/)
  assert.doesNotMatch(d.text, /registry/)
  assert.match(d.text, /\.env \(added/)
  assert.match(d.text, /\+API_KEY=\n/, '.env.example is a template, not a secret')
  assert.match(d.text, /\+real change/)
  assert.deepEqual(d.withheld, ['.env', 'certs/server.pem'])
  assert.equal(d.named, 4)
  assert.ok(looksSecret('config/.env.production'))
  assert.ok(looksSecret('home/.ssh/id_ed25519'))
  assert.ok(!looksSecret('src/environment.ts'))
  assert.ok(!looksSecret('docs/keys.md'))
})

test('numbered lines carry the new file’s line numbers, and removed lines have none', () => {
  const d = diffForModel([file('a.ts', [['ctx', 'keep'], ['del', 'old'], ['add', 'new']])], { cap: COMMIT_DIFF_CAP, numbered: true })
  assert.ok(d.text.includes('\n     1 keep\n-      old\n+    2 new'), d.text)
})

test('the person is told what goes and how it was cut', () => {
  const whole = diffForModel([file('a.ts', [['add', 'x']])], { cap: 1000 })
  assert.equal(describeSent(whole, { to: 'Sonnet' }), 'Sends the diff of 1 file to Sonnet.')
  assert.equal(describeSent(whole, { extra: 'the last 5 commit subjects go too, for style' }), 'Sends the diff of 1 file to the model; the last 5 commit subjects go too, for style.')
  const cut = diffForModel([big('h.ts', 3000), file('.env', [['add', 'A=1']])], { cap: 3000 })
  const said = describeSent(cut)
  assert.match(said, /long files are cut to fit 3,000 characters/)
  assert.match(said, /1 file is named without lines \(binary, generated or too big to fit; the one that looks like a secret is never read\)/)
  assert.equal(describeSent(diffForModel([], { cap: 100 })), 'There are no changes to send.')
})

/* ------------------------------------------------------------------ what comes back */

test('a commit message is what the model wrote, without its label, quotes, fence or full stop', () => {
  assert.equal(cleanCommitMessage('Fix the login redirect.'), 'Fix the login redirect')
  assert.equal(cleanCommitMessage('```\nAdd search\n\nIt finds text across files.\n```'), 'Add search\n\nIt finds text across files.')
  assert.equal(cleanCommitMessage('Commit message: "Show the branch in the header"'), 'Show the branch in the header')
  assert.equal(cleanCommitMessage('<think>hmm</think>\n# Rename the setting\n\n\n\nBecause.'), 'Rename the setting\n\nBecause.')
  assert.equal(cleanCommitMessage('   \n '), null)
  assert.equal(cleanCommitMessage('x'.repeat(9000))?.length, 4000)
})

test('a pull request’s words are read from text, a fence, labels or JSON', () => {
  assert.deepEqual(parsePrText('Add search and replace\n\n## What\n- Replace across files'), { title: 'Add search and replace', body: '## What\n- Replace across files' })
  assert.deepEqual(parsePrText('**Title:** Speed up startup.\n\nDescription:\nLazy-load the editor.'), { title: 'Speed up startup', body: 'Lazy-load the editor.' })
  assert.deepEqual(parsePrText('```markdown\n# Fix the crash\n\nIt threw on empty input.\n```'), { title: 'Fix the crash', body: 'It threw on empty input.' })
  assert.deepEqual(parsePrText('{"title": "Fix it.", "body": "Details"}'), { title: 'Fix it', body: 'Details' })
  assert.deepEqual(parsePrText('Only a title'), { title: 'Only a title', body: '' })
  assert.equal(parsePrText('  '), null)
})

const REVIEWED = [
  file('src/a.ts', [['ctx', 'const a = 1'], ['add', 'const b = a / 0'], ['add', 'return b']]),
  file('src/b.ts', [['add', 'new code']], { status: 'added' })
]

test('a review keeps findings on files in the change, marks the line, and orders them', () => {
  const raw = JSON.stringify({
    summary: 'Adds a division.',
    comments: [
      { path: 'src/b.ts', line: 1, body: 'Second file.' },
      { path: 'src/a.ts', line: 3, body: 'Returns before use.' },
      { path: 'src/a.ts', line: 2, body: 'Divides by zero.' },
      { path: 'src/a.ts', line: 1, body: 'On a line it only sits beside.' },
      { path: 'src/ghost.ts', line: 4, body: 'A file the change does not have.' },
      { path: 'src/a.ts', line: 2, body: 'Divides by zero.' }
    ]
  })
  const review = parseLocalReview(`Here you go:\n\`\`\`json\n${raw}\n\`\`\``, REVIEWED)!
  assert.equal(review.summary, 'Adds a division.')
  assert.deepEqual(
    review.findings.map((f) => [f.path, f.line, f.onChange, f.quote]),
    [
      ['src/a.ts', 1, false, 'const a = 1'],
      ['src/a.ts', 2, true, 'const b = a / 0'],
      ['src/a.ts', 3, true, 'return b'],
      ['src/b.ts', 1, true, 'new code']
    ]
  )
  const groups = groupFindings(review.findings, ['src/b.ts', 'src/a.ts'])
  assert.deepEqual(groups.map((g) => [g.path, g.findings.length]), [['src/b.ts', 1], ['src/a.ts', 3]])
  assert.match(findingsMessage(review.findings.slice(1, 3)), /found 2 things[\s\S]*src\/a\.ts:2\nDivides by zero\.\n\nsrc\/a\.ts:3\nReturns before use\./)
  assert.match(findingsMessage(review.findings.slice(1, 2)), /found this\./)
})

test('an answer that is not JSON is kept as the summary, and an empty one is nothing', () => {
  const said = parseLocalReview('Looks fine to me, though I did not check the tests.', REVIEWED)!
  assert.equal(said.summary, 'Looks fine to me, though I did not check the tests.')
  assert.deepEqual(said.findings, [])
  assert.equal(parseLocalReview('  ', REVIEWED), null)
  assert.deepEqual(parseLocalReview('{"summary": "", "comments": []}', REVIEWED)?.findings, [])
})

/* ------------------------------------------------------------------ against a repository */

let tmp = ''
let repo = ''
const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com' }
const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim()
const run = makeRunner(new HostBook({ load: () => [], save: () => undefined, readConfig: async () => [] }))
const model = { providerId: 'stand-in', modelId: 'm1' }

/** A stand-in model: records what it was asked and answers with what the test sets. */
const asked: AskRequest[] = []
let answer: string | null = null
const ask = async (request: AskRequest): Promise<string | null> => {
  asked.push(request)
  return answer
}

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-assist-')))
  repo = path.join(tmp, 'acme')
  fs.mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  fs.mkdirSync(path.join(repo, '.github'))
  fs.writeFileSync(path.join(repo, '.github', 'pull_request_template.md'), '## What changed\n\n## How it was tested\n')
  fs.writeFileSync(path.join(repo, 'app.ts'), 'one\ntwo\nthree\n')
  git('add', '.')
  git('commit', '-q', '-m', 'feat: first version')
  git('commit', '-q', '--allow-empty', '-m', 'feat: second version')
})

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('a commit message is asked for from the working changes, with what is sent kept to the cap', async () => {
  fs.writeFileSync(path.join(repo, 'app.ts'), 'one\nTWO\nthree\n')
  fs.writeFileSync(path.join(repo, 'notes.md'), 'a new note\n')
  fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=do-not-send-this\n')
  asked.length = 0
  answer = '"feat: shout two and add a note."'
  const res = await writeCommitMessage(run, repo, model, ask)
  assert.ok(res.ok, res.ok ? '' : res.error)
  if (!res.ok) return
  assert.equal(res.message, 'feat: shout two and add a note')
  assert.match(res.sent, /^Sends the diff of 3 files to the model/)
  assert.match(res.sent, /the last 2 commit subjects go too, for style/)
  assert.equal(asked.length, 1)
  const sent = asked[0]
  assert.deepEqual({ providerId: sent.providerId, modelId: sent.modelId }, model)
  assert.match(sent.prompt, /\+TWO/)
  assert.match(sent.prompt, /\+a new note/)
  assert.match(sent.prompt, /Recent commit subjects:\n- feat: second version\n- feat: first version/)
  assert.match(sent.prompt, /Branch: main/)
  assert.doesNotMatch(sent.prompt, /do-not-send-this/)
  assert.ok(sent.prompt.length < COMMIT_DIFF_CAP + 2000)
})

test('no changes, a model that does not answer, and an empty answer are said, not thrown', async () => {
  const clean = path.join(tmp, 'clean')
  fs.mkdirSync(clean)
  execFileSync('git', ['-C', clean, 'init', '-q', '-b', 'main'], { env })
  fs.writeFileSync(path.join(clean, 'a.txt'), 'x\n')
  execFileSync('git', ['-C', clean, 'add', '.'], { env })
  execFileSync('git', ['-C', clean, 'commit', '-q', '-m', 'init'], { env })
  asked.length = 0
  assert.deepEqual(await writeCommitMessage(run, clean, model, ask), { ok: false, error: 'There are no changes to describe.' })
  assert.equal(asked.length, 0, 'nothing is sent when there is nothing to send')

  answer = null
  const none = await writeCommitMessage(run, repo, model, ask)
  assert.ok(!none.ok && /didn’t answer/.test(none.error) && /m1/.test(none.error))
  answer = '   '
  const blank = await writeCommitMessage(run, repo, model, ask)
  assert.ok(!blank.ok && /no message/.test(blank.error))

  const outside = await workingChanges(run, tmp)
  assert.ok(!outside.ok)
})

test('a pull request’s words come from the branch’s commits, its diff against the base and the repository’s template', async () => {
  git('checkout', '-q', '-b', 'feature/shout')
  git('add', '-A', ':!.env')
  git('commit', '-q', '-m', 'Shout line two')
  fs.writeFileSync(path.join(repo, 'app.ts'), 'one\nTWO\nthree\nfour\n')
  git('commit', '-q', '-am', 'Add a fourth line')
  asked.length = 0
  answer = '# Shout two and add a line\n\n## What changed\n- Line two is upper case\n\n## How it was tested\nBy hand.'
  const res = await writePullRequestText(run, repo, 'main', model, ask)
  assert.ok(res.ok, res.ok ? '' : res.error)
  if (!res.ok) return
  assert.equal(res.title, 'Shout two and add a line')
  assert.match(res.body, /^## What changed/)
  assert.match(res.sent, /the 2 commit subjects and the repository’s pull request template go too/)
  const prompt = asked[0].prompt
  assert.match(prompt, /Branch: feature\/shout, going into main/)
  assert.match(prompt, /Commits on the branch, oldest first:\n- Shout line two\n- Add a fourth line/)
  assert.match(prompt, /pull request template:\n## What changed/)
  assert.match(prompt, /\+four/)
  assert.match(prompt, /\+TWO/)

  const same = await writePullRequestText(run, repo, 'feature/shout', model, ask)
  assert.ok(!same.ok && /no commits that feature\/shout doesn’t/.test(same.error))
  answer = null
  assert.ok(!(await writePullRequestText(run, repo, 'main', model, ask)).ok)
})

test('a review asks about the working tree with numbered lines and returns findings by file', async () => {
  fs.writeFileSync(path.join(repo, 'app.ts'), 'one\nTWO\nthree\nfour\nfive = 1 / 0\n')
  asked.length = 0
  answer = JSON.stringify({ summary: 'Adds a fifth line.', comments: [{ path: 'app.ts', line: 5, body: 'Divides by zero.' }, { path: 'nope.ts', line: 1, body: 'Not in the change.' }] })
  const res = await reviewLocalChanges(run, repo, model, ask)
  assert.ok(res.ok, res.ok ? '' : res.error)
  if (!res.ok) return
  assert.equal(res.review.summary, 'Adds a fifth line.')
  assert.deepEqual(res.review.findings.map((f) => [f.path, f.line, f.onChange, f.quote]), [['app.ts', 5, true, 'five = 1 / 0']])
  // The .env is among the changes, by name; its line is not in what was sent.
  assert.deepEqual(res.paths, ['.env', 'app.ts'])
  assert.doesNotMatch(asked[0].prompt, /do-not-send-this/)
  assert.ok(asked[0].prompt.includes('+    5 five = 1 / 0'))
  assert.equal(asked[0].effort, 'light')

  git('checkout', '--', 'app.ts')
  fs.rmSync(path.join(repo, '.env'))
  const nothing = await reviewLocalChanges(run, repo, model, ask)
  assert.deepEqual(nothing, { ok: false, error: 'There is nothing to review: no changes are uncommitted.' })
})

/* ------------------------------------------------------------------ the model call itself */

test('askModel sends one request with no tools to the provider and returns its text', async () => {
  const bodies: Array<{ model: string; tools?: unknown[]; messages: Array<{ role: string; content: unknown }> }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString() || '{}'))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Fix the redirect' }, finish_reason: null }] }
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const id = 'git-assist-test'
  updateProvider(id, { name: 'Git assist test', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` })
  secrets.set(id, 'sk-git-assist-test')
  try {
    const text = await askModel({ providerId: id, modelId: 'stand-in', system: 'You write commit messages.', prompt: 'the diff', outputCap: 300, cacheKey: 'eaon-test' })
    assert.equal(text, 'Fix the redirect')
    assert.equal(bodies.length, 1)
    assert.equal(bodies[0].model, 'stand-in')
    assert.ok(!bodies[0].tools || bodies[0].tools.length === 0)
    assert.match(JSON.stringify(bodies[0].messages), /You write commit messages\./)
    assert.match(JSON.stringify(bodies[0].messages), /the diff/)
    assert.equal(await askModel({ providerId: 'no-such-provider', modelId: 'x', system: 's', prompt: 'p', outputCap: 10, cacheKey: 'k' }), null)
    assert.equal(await askModel({ providerId: id, modelId: 'stand-in', system: 's', prompt: '  ', outputCap: 10, cacheKey: 'k' }), null)
  } finally {
    server.close()
    removeProvider(id)
  }
})

test('the diff parser the review shares reads numbers the way the prompt prints them', () => {
  const [f] = parseUnifiedDiff(['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -4,2 +4,3 @@', ' keep', '-old', '+new', '+more'].join('\n'))
  const d = diffForModel([f], { cap: COMMIT_DIFF_CAP, numbered: true })
  assert.ok(d.text.includes('     4 keep\n-      old\n+    5 new\n+    6 more'), d.text)
})
