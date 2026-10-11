/**
 * Pull requests → one pull request's tabs, in the real app: Overview, Files
 * (its diff), Checks, and Merge (the repository's allowed methods, the commit
 * message, deleting the branch), ending in a real `gh pr merge` call.
 *
 * `gh` is a stand-in first on PATH that answers like the real one for one
 * pull request (acme/app#7) and writes down every call, so nothing touches
 * GitHub. The test reads the calls back to check what Eaon asked for.
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scenario } from './fixtures.mjs'

const URL = 'https://github.com/acme/app/pull/7'

function fakeGh(dir, log, merged) {
  const detail = (state) =>
    JSON.stringify({
      number: 7,
      title: 'Add the usage meter',
      body: 'Shows plan usage in the header.\n\n- Claude Code\n- Codex',
      author: { login: 'alexrivera' },
      state,
      isDraft: false,
      baseRefName: 'main',
      headRefName: 'feature/usage-meter',
      additions: 3,
      deletions: 1,
      changedFiles: 2,
      createdAt: '2026-10-08T10:00:00Z',
      updatedAt: '2026-10-09T10:00:00Z',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'UNSTABLE',
      reviewDecision: 'APPROVED',
      latestReviews: [{ author: { login: 'reviewer' }, state: 'APPROVED' }],
      statusCheckRollup: [
        { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/app/actions/1' },
        { name: 'e2e', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/app/actions/2' },
        { context: 'lint', state: 'SUCCESS', targetUrl: null }
      ],
      url: URL
    })
  const diff = [
    'diff --git a/src/meter.ts b/src/meter.ts',
    'index 1..2 100644',
    '--- a/src/meter.ts',
    '+++ b/src/meter.ts',
    '@@ -1,2 +1,3 @@',
    ' export const meter = 1',
    '-export const old = 0',
    '+export const plan = 2',
    '+export const used = 3',
    'diff --git a/README.md b/README.md',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/README.md',
    '@@ -0,0 +1 @@',
    '+# Usage meter',
    ''
  ].join('\n')
  writeFileSync(join(dir, 'detail-open.json'), detail('OPEN'))
  writeFileSync(join(dir, 'detail-merged.json'), detail('MERGED'))
  writeFileSync(join(dir, 'diff.txt'), diff)
  writeFileSync(
    join(dir, 'gh'),
    `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
case "$1 $2" in
  "search prs")
    if [[ "$*" == *"--author=@me"* ]]; then
      echo '[{"repository":{"nameWithOwner":"acme/app"},"number":7,"title":"Add the usage meter","updatedAt":"2026-10-09T10:00:00Z","state":"open","isDraft":false,"url":"${URL}"}]'
    else echo '[]'; fi ;;
  "pr view")
    if [[ "$*" == *"--json additions,deletions,headRefName"* ]]; then echo '{"additions":3,"deletions":1,"headRefName":"feature/usage-meter"}'
    elif [ -f ${JSON.stringify(merged)} ]; then cat ${JSON.stringify(join(dir, 'detail-merged.json'))}
    else cat ${JSON.stringify(join(dir, 'detail-open.json'))}; fi ;;
  "repo view") echo '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":true,"deleteBranchOnMerge":false}' ;;
  "pr diff") cat ${JSON.stringify(join(dir, 'diff.txt'))} ;;
  "pr merge") touch ${JSON.stringify(merged)} ;;
  *) ;;
esac
`
  )
  chmodSync(join(dir, 'gh'), 0o755)
}

scenario('Pull requests: a pull request’s Overview, Files, Checks and Merge tabs, merging through gh', { timeout: 120_000 }, async (s) => {
  mkdirSync(s.homeDir, { recursive: true })
  const bin = join(s.homeDir, '..', 'fake-gh')
  mkdirSync(bin, { recursive: true })
  const log = join(bin, 'calls.log')
  const merged = join(bin, 'merged')
  fakeGh(bin, log, merged)

  const app = await s.launch({ env: { EAON_GH_BIN: join(bin, 'gh') } })
  const page = app.page
  const ade = (await page.eval(() => window.api.workspaces.get())).find((w) => w.kind === 'code')
  await page.eval((id) => window.api.settings.patch({ activeWorkspaceId: id }), ade.id)
  await page.reload()
  await page.click('.sidebar .nav-item', { text: /^Pull requests$/ })
  await page.click('.pr-row', { text: /Add the usage meter/, timeout: 20_000 })

  // Overview: the description, who opened it, the review.
  await page.find('.pr-body', { text: /Shows plan usage in the header/, timeout: 15_000 })
  await page.find('.pr-detail__branch', { text: 'feature/usage-meter → main' })
  await page.find('.pr-reviewer', { text: /reviewer: approved/ })
  await s.shot(page, 'overview')

  // Files: the diff, file by file, with real line numbers.
  await page.click('.pr-tabs [role="tab"]', { text: /^Files/ })
  const files = await page.waitFor(
    () => {
      const rows = [...document.querySelectorAll('.pr-files .review-file__head')].map((r) => r.textContent?.replace(/\s+/g, ' ').trim())
      return rows.length ? rows : null
    },
    { message: 'the files', timeout: 15_000 }
  )
  assert.deepEqual(files, ['Msrc/meter.ts+2−1', 'AREADME.md+1−0'])
  await s.shot(page, 'files')

  // Checks: the failing one first.
  await page.click('.pr-tabs [role="tab"]', { text: /^Checks/ })
  const checks = await page.waitFor(() => {
    const rows = [...document.querySelectorAll('.pr-check')].map((r) => `${r.querySelector('.pr-check__name')?.textContent}:${r.getAttribute('data-status')}`)
    return rows.length ? rows : null
  }, { message: 'the checks' })
  assert.deepEqual(checks, ['e2e:failed', 'build:passed', 'lint:passed'])
  await s.shot(page, 'checks')

  // Merge: only what the repository allows; a failing check is said, not blocking.
  await page.click('.pr-tabs [role="tab"]', { text: /^Merge$/ })
  await page.find('.pr-merge__status', { text: /1 check is failing, but it can still be merged/ })
  const methods = await page.eval(() => [...document.querySelectorAll('.pr-merge [role="tab"]')].map((b) => b.textContent))
  assert.deepEqual(methods, ['Squash and merge', 'Rebase and merge'])
  const subject = await page.waitFor(() => document.querySelector('.pr-merge input.input')?.value || null, { message: 'the commit message' })
  assert.equal(subject, 'Add the usage meter (#7)')
  await page.fill('.pr-merge input.input', 'Add the usage meter to the header (#7)')
  await s.shot(page, 'merge')

  // Merge asks once more, then goes.
  await page.click('.pr-merge__actions .btn--primary', { text: /^Merge$/ })
  await page.find('.pr-merge__actions .btn--primary', { text: /Merge into main\?/ })
  assert.ok(!existsSync(merged), 'nothing merged on the first click')
  await page.click('.pr-merge__actions .btn--primary', { text: /Merge into main\?/ })
  await page.find('.pr-merge__status', { text: /^Merged\./, timeout: 20_000 })
  const call = readFileSync(log, 'utf8').split('\n').find((l) => l.startsWith('pr merge'))
  s.t.diagnostic(`gh was called with: ${call}`)
  assert.equal(call, `pr merge ${URL} --squash --delete-branch --subject Add the usage meter to the header (#7) --body `)
  await s.shot(page, 'merged')
})
