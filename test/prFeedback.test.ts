import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { feedbackMessage, openThreads, parseFeedback, parsePrUrl } from '../src/shared/prFeedback'
import { HostBook } from '../src/main/features/ade/hosts'
import { makeRunner } from '../src/main/features/ade/runner'
import { prFeedback } from '../src/main/features/ade/review'

/** What reviewers said on a pull request, read from GitHub and handed to an agent: the shaping, and the fetch against a stand-in gh. */

const answer = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [
            { isResolved: false, isOutdated: false, path: 'src/a.ts', line: 12, originalLine: 10, comments: { nodes: [{ body: 'This leaks the handle.', author: { login: 'rev1' } }, { body: 'Agreed.', author: { login: 'rev2' } }] } },
            { isResolved: true, isOutdated: false, path: 'src/b.ts', line: 3, comments: { nodes: [{ body: 'nit', author: { login: 'rev1' } }] } },
            { isResolved: false, isOutdated: true, path: 'src/c.ts', line: null, originalLine: 40, comments: { nodes: [{ body: 'Rename this.', author: null }] } },
            { isResolved: false, path: '', comments: { nodes: [{ body: 'no path', author: { login: 'x' } }] } },
            { isResolved: false, path: 'src/d.ts', line: 1, comments: { nodes: [{ body: '   ', author: { login: 'x' } }] } }
          ]
        },
        reviews: {
          nodes: [
            { state: 'CHANGES_REQUESTED', body: 'Please add tests.', author: { login: 'rev1' } },
            { state: 'APPROVED', body: 'LGTM', author: { login: 'rev2' } },
            { state: 'COMMENTED', body: '', author: { login: 'rev3' } },
            { state: 'COMMENTED', body: 'One thought on naming.', author: { login: 'rev3' } }
          ]
        }
      }
    }
  }
}

test('a pull request address is read only when it is a GitHub pull request', () => {
  assert.deepEqual(parsePrUrl('https://github.com/acme/widget/pull/7'), { owner: 'acme', name: 'widget', number: 7 })
  assert.deepEqual(parsePrUrl('https://github.com/acme/widget.js/pull/7/'), { owner: 'acme', name: 'widget.js', number: 7 })
  for (const bad of ['http://github.com/acme/widget/pull/7', 'https://evil.com/acme/widget/pull/7', 'https://github.com/acme/widget/issues/7', 'https://github.com/acme/widget/pull/7/files', 'https://github.com/acme/widget/pull/x', '', null, 7]) {
    assert.equal(parsePrUrl(bad), null, String(bad))
  }
})

test('GitHub’s answer becomes threads and review notes, dropping what has no file, no words, or no meaning', () => {
  const f = parseFeedback(answer)!
  assert.deepEqual(f.threads.map((t) => [t.path, t.line, t.outdated, t.resolved, t.comments.length]), [
    ['src/a.ts', 12, false, false, 2],
    ['src/b.ts', 3, false, true, 1],
    ['src/c.ts', 40, true, false, 1]
  ])
  assert.equal(f.threads[2].comments[0].author, 'someone')
  assert.deepEqual(f.notes.map((n) => [n.author, n.state]), [['rev1', 'CHANGES_REQUESTED'], ['rev3', 'COMMENTED']], 'an approval and an empty comment are not feedback')
  assert.deepEqual(openThreads(f.threads).map((t) => t.path), ['src/a.ts', 'src/c.ts'])
  assert.equal(parseFeedback({ data: { repository: { pullRequest: null } } }), null)
  assert.equal(parseFeedback(null), null)
  assert.equal(parseFeedback('x'), null)
})

test('the agent is sent the open threads by file and line, then what the reviews said, and told not to commit', () => {
  const text = feedbackMessage(parseFeedback(answer)!, { number: 7, title: 'Add search', url: 'https://github.com/acme/widget/pull/7' })
  assert.match(text, /pull request #7 \(Add search, https:\/\/github\.com\/acme\/widget\/pull\/7\)/)
  assert.match(text, /if you disagree with one, say why/)
  assert.match(text, /Don't commit or push/)
  assert.match(text, /1\. src\/a\.ts:12\n   rev1: This leaks the handle\.\n   rev2: Agreed\./)
  assert.match(text, /2\. src\/c\.ts:40 \(the code it was about has changed since\)/)
  assert.doesNotMatch(text, /src\/b\.ts/, 'a resolved thread is left out')
  assert.ok(text.indexOf('rev1 (asked for changes) wrote:\nPlease add tests.') < text.indexOf('rev3 (commented) wrote'), 'a request for changes comes first')
  const long = feedbackMessage({ threads: [{ path: 'a', line: 1, outdated: false, resolved: false, comments: [{ author: 'r', body: 'x'.repeat(5000) }] }], notes: [] }, { number: 1, title: 't', url: 'u' })
  assert.match(long, /\[cut: 3500 more characters\]/)
})

let dir = ''
let bin = ''
const prior = process.env.EAON_GH_BIN
before(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prfeedback-')))
  bin = path.join(dir, 'gh')
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
require('fs').appendFileSync(${JSON.stringify(path.join(dir, 'gh.log'))}, JSON.stringify(args) + '\\n')
if (process.env.FAKE_GH_FAIL) { process.stderr.write('gh: To get started with GitHub CLI, please run: gh auth login'); process.exit(4) }
process.stdout.write(${JSON.stringify(JSON.stringify(answer))})
`
  )
  fs.chmodSync(bin, 0o755)
  process.env.EAON_GH_BIN = bin
})
after(() => {
  if (prior === undefined) delete process.env.EAON_GH_BIN
  else process.env.EAON_GH_BIN = prior
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the fetch asks gh’s GraphQL for that pull request only, and says what went wrong', async () => {
  const run = makeRunner(new HostBook({ read: () => [], write: () => undefined, sshConfig: () => '' } as never))
  const ok = await prFeedback(run, dir, 'https://github.com/acme/widget/pull/7')
  assert.ok(ok.ok && ok.threads.length === 3 && ok.notes.length === 2)
  const logged = JSON.parse(fs.readFileSync(path.join(dir, 'gh.log'), 'utf8').trim().split('\n')[0]) as string[]
  assert.deepEqual(logged.slice(0, 2), ['api', 'graphql'])
  assert.ok(logged.includes('owner=acme') && logged.includes('name=widget') && logged.includes('number=7'))
  assert.ok(logged.some((a) => a.startsWith('query=') && a.includes('reviewThreads')))

  const bad = await prFeedback(run, dir, 'https://evil.example/acme/widget/pull/7')
  assert.ok(!bad.ok && /isn’t a GitHub pull request/.test(bad.error))
  assert.equal(fs.readFileSync(path.join(dir, 'gh.log'), 'utf8').trim().split('\n').length, 1, 'gh was not asked for it')

  process.env.FAKE_GH_FAIL = '1'
  try {
    const down = await prFeedback(run, dir, 'https://github.com/acme/widget/pull/7')
    assert.ok(!down.ok && /gh auth login/.test(down.error))
  } finally {
    delete process.env.FAKE_GH_FAIL
  }
})
