/**
 * Pull requests → one pull request's tabs, in the real app, laid out as on
 * GitHub: Conversation (the description, the merge box with the
 * repository's allowed methods, the commit message, deleting the branch),
 * Files changed (its diff), Checks, ending in a real `gh pr merge` call.
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
      reviews: [{ author: { login: 'reviewer' }, authorAssociation: 'MEMBER', state: 'APPROVED', body: 'Looks good.', submittedAt: '2026-10-09T09:00:00Z' }],
      comments: [{ author: { login: 'alexrivera' }, authorAssociation: 'OWNER', body: 'Ready for a look.', createdAt: '2026-10-08T12:00:00Z' }],
      commits: [{ oid: 'a1b2c3d4e5f6a7b8c9d0', messageHeadline: 'Add the usage meter', committedDate: '2026-10-08T09:00:00Z', authors: [{ login: 'alexrivera', name: 'Alex Rivera' }] }],
      labels: [{ name: 'feature', color: '0e8a16' }],
      assignees: [{ login: 'alexrivera' }],
      reviewRequests: [],
      mergedAt: state === 'MERGED' ? '2026-10-10T10:00:00Z' : null,
      mergedBy: state === 'MERGED' ? { login: 'alexrivera' } : null,
      mergeCommit: state === 'MERGED' ? { oid: 'f00dfeed00112233' } : null,
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
      echo '[{"repository":{"nameWithOwner":"acme/app"},"number":7,"title":"Add the usage meter","updatedAt":"2026-10-09T10:00:00Z","createdAt":"2026-10-08T10:00:00Z","state":"open","isDraft":false,"url":"${URL}","author":{"login":"alexrivera"},"commentsCount":1,"labels":[{"name":"feature","color":"0e8a16"}]}]'
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

scenario('Pull requests: a pull request’s Conversation, Files changed and Checks, as on GitHub, merging through gh', { timeout: 120_000 }, async (s) => {
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
  await page.click('.sidebar .nav-item, .sidebar .foot-bar__btn', { text: /^Pull requests$/ })
  // The list, as github.com/pulls: the title, then the repository, number, author and when.
  await page.find('.gh-row .gh-row__meta', { text: /acme\/app#7 opened .* by alexrivera/, timeout: 20_000 })
  await page.click('.gh-row', { text: /Add the usage meter/ })

  // Conversation: the description and the comment as speech bubbles, the review on the line, the sidebar.
  await page.find('.gh-comment__body', { text: /Shows plan usage in the header/, timeout: 15_000 })
  await page.find('.gh-header__sentence', { text: /alexrivera wants to merge 1 commit into main from feature\/usage-meter/ })
  await page.find('.gh-comment__body', { text: /Ready for a look\./ })
  await page.find('.gh-tl-body', { text: /reviewer approved these changes/ })
  await page.find('.gh-sidebar li[data-state="APPROVED"]', { text: /reviewer/ })
  await page.find('.gh-sidebar .gh-label', { text: /^feature$/ })
  await s.shot(page, 'conversation')

  // Files changed: the diff, file by file, with real line numbers.
  await page.click('.gh-tabnav [role="tab"]', { text: /^Files changed/ })
  const files = await page.waitFor(
    () => {
      const rows = [...document.querySelectorAll('.gh-file__head')].map((r) => r.textContent?.replace(/\s+/g, ' ').trim())
      return rows.length ? rows : null
    },
    { message: 'the files', timeout: 15_000 }
  )
  assert.deepEqual(files, ['src/meter.ts+2−1', 'README.mdAdded+1−0'])
  await s.shot(page, 'files')

  // Checks: the failing one first.
  await page.click('.gh-tabnav [role="tab"]', { text: /^Checks/ })
  const checks = await page.waitFor(() => {
    const rows = [...document.querySelectorAll('.gh-check')].map((r) => `${r.querySelector('.gh-check__name')?.textContent}:${r.getAttribute('data-status')}`)
    return rows.length ? rows : null
  }, { message: 'the checks' })
  assert.deepEqual(checks, ['e2e:failed', 'build:passed', 'lint:passed'])
  await s.shot(page, 'checks')

  // The merge box: a failing check is said, not blocking; only the methods the repository allows.
  await page.click('.gh-tabnav [role="tab"]', { text: /^Conversation/ })
  await page.find('.gh-merge__title', { text: /Some checks were not successful/ })
  await page.click('.gh-split__caret')
  const methods = await page.waitFor(() => {
    const titles = [...document.querySelectorAll('.menu .menu__item-title')].map((b) => b.textContent)
    return titles.length ? titles : null
  }, { message: 'the merge methods' })
  assert.deepEqual(methods, ['Squash and merge', 'Rebase and merge'])
  await page.click('.menu .menu__item', { text: /^Squash and merge/ })

  // Merging asks for the commit message first, behind Confirm, as on GitHub.
  await page.click('.gh-split__main', { text: /^Squash and merge$/ })
  const subject = await page.waitFor(() => document.querySelector('.gh-merge__form input.gh-input')?.value || null, { message: 'the commit message' })
  assert.equal(subject, 'Add the usage meter (#7)')
  assert.ok(!existsSync(merged), 'nothing merged on the first click')
  await page.fill('.gh-merge__form input.gh-input', 'Add the usage meter to the header (#7)')
  await s.shot(page, 'merge')
  await page.click('.gh-merge__confirm .gh-btn--primary', { text: /^Confirm squash and merge$/ })
  await page.find('.gh-merge__title', { text: /Pull request successfully merged and closed/, timeout: 20_000 })
  const call = readFileSync(log, 'utf8').split('\n').find((l) => l.startsWith('pr merge'))
  s.t.diagnostic(`gh was called with: ${call}`)
  assert.equal(call, `pr merge ${URL} --squash --delete-branch --subject Add the usage meter to the header (#7) --body `)
  await page.find('.gh-tl-body', { text: /alexrivera merged commit f00dfee into main/ })
  await s.shot(page, 'merged')
})
