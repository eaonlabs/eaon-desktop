/**
 * The review panel's tools in the real app: Markdown comments written with a
 * preview, edited, and on a range of lines; a comment being written surviving
 * the window coming back to the front; comments kept through a reload; a
 * failed CI check's log read and sent to an agent; and a conflict with main
 * made by "Update from main", handed to the agent, resolved here block by
 * block, and the merge finished.
 *
 * `gh` is a stand-in (EAON_GH_BIN) that answers for one pull request
 * (octo-org/demo#7) and one failed job, and writes down every call, so
 * nothing touches GitHub. The "agent" is `cat` running as `claude`, so what it
 * was sent lands in a file.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scenario } from './fixtures.mjs'

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' }).trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

function fakeGh(dir, log) {
  const pr = {
    number: 7,
    title: 'Shout the middle lines',
    url: 'https://github.com/octo-org/demo/pull/7',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'UNSTABLE',
    baseRefName: 'main',
    reviewDecision: '',
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'build', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/octo-org/demo/actions/runs/101/job/201' },
      { __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/octo-org/demo/actions/runs/101/job/202' }
    ]
  }
  writeFileSync(join(dir, 'pr.json'), JSON.stringify(pr))
  writeFileSync(
    join(dir, 'log.txt'),
    ['test\tRun npm test\t2026-10-01T10:00:00.0000000Z > demo@1.0.0 test', 'test\tRun npm test\t2026-10-01T10:00:01.0000000Z not ok 1 - shouts the middle lines', 'test\tRun npm test\t2026-10-01T10:00:02.0000000Z ##[error]Process completed with exit code 1.', ''].join('\n')
  )
  writeFileSync(
    join(dir, 'gh'),
    `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
case "$1 $2" in
  "pr view") cat ${JSON.stringify(join(dir, 'pr.json'))} ;;
  "run view") cat ${JSON.stringify(join(dir, 'log.txt'))} ;;
  "run list") echo '[]' ;;
  *) ;;
esac
`
  )
  chmodSync(join(dir, 'gh'), 0o755)
}

/** A click with Shift held, as a range comment is made. */
const shiftClick = (page, text) =>
  page.eval((text) => {
    const row = [...document.querySelectorAll('.review-diff__row')].find((r) => r.textContent?.includes(text))
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    return Boolean(row)
  }, text)

scenario('ADE review tools: Markdown and range comments, CI logs to an agent, resolving a conflict with main', { timeout: 180_000 }, async (s) => {
  mkdirSync(s.homeDir, { recursive: true })
  const bin = join(s.homeDir, '..', 'fake-gh')
  mkdirSync(bin, { recursive: true })
  const ghLog = join(bin, 'calls.log')
  fakeGh(bin, ghLog)

  // The commits Eaon makes (the merge) need a name, which the scenario's empty HOME doesn't give.
  const app = await s.launch({ env: { EAON_GH_BIN: join(bin, 'gh'), GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' } })
  const page = app.page
  const home = realpathSync(s.homeDir)

  // A branch that changed lines 2 and 3, and a main that changed line 2 since: a conflict waiting.
  const repo = join(home, 'projects', 'demo')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'app.ts'), 'one\ntwo\nthree\nfour\nfive\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'first')
  git(repo, 'checkout', '-q', '-b', 'feature/shout')
  writeFileSync(join(repo, 'app.ts'), 'one\nTWO\nTHREE\nfour\nfive\n')
  git(repo, 'commit', '-q', '-am', 'Shout two and three')
  git(repo, 'checkout', '-q', 'main')
  writeFileSync(join(repo, 'app.ts'), 'one\nmain two\nthree\nfour\nfive\n')
  git(repo, 'commit', '-q', '-am', 'Change two on main')
  git(repo, 'checkout', '-q', 'feature/shout')

  const settings = await page.eval(() => window.api.settings.get())
  const ade = (await page.eval(() => window.api.workspaces.get())).find((w) => w.kind === 'code')
  await page.eval((id, folder, eaonCode) => window.api.settings.patch({ activeWorkspaceId: id, eaonCode: { ...eaonCode, lastCwd: folder } }), ade.id, repo, settings.eaonCode)
  await page.reload()
  await page.find('.ade-session__title', { text: 'demo' })
  await page.click('.code-header .review-btn')
  await page.find('.review-file__head', { text: /app\.ts/, timeout: 20_000 })

  // The pull request's checks, failing first, and main being ahead.
  const checks = await page.waitFor(() => {
    const rows = [...document.querySelectorAll('.review-check')].map((r) => `${r.querySelector('.review-check__name')?.textContent}:${r.getAttribute('data-status')}`)
    return rows.length ? rows : null
  }, { message: 'the checks', timeout: 20_000 })
  assert.deepEqual(checks, ['test:failed', 'build:passed'])
  await page.find('.review-update', { text: /main has 1 commit this branch doesn’t/ })

  // A Markdown comment, previewed before it's added.
  await page.click('.review-diff__row[data-kind="add"]', { text: /TWO/ })
  await page.fill('.review-comment--draft textarea', 'Use **lower case**.')
  await page.click('.review-comment--draft [role="tab"]', { text: /^Preview$/ })
  await page.find('.review-comment__preview strong', { text: 'lower case' })
  await page.click('.review-comment--draft [role="tab"]', { text: /^Write$/ })
  await page.click('.review-comment--draft button', { text: /^Add comment$/ })
  await page.find('.review-comment__body strong', { text: 'lower case' })

  // Edited, not deleted and written again.
  await page.click('.review-comment button[aria-label="Edit comment"]')
  assert.equal(await page.eval(() => document.querySelector('.review-comment--draft textarea')?.value), 'Use **lower case**.')
  await page.fill('.review-comment--draft textarea', 'Use **lower case**, like the rest.')
  await page.click('.review-comment--draft button', { text: /^Save comment$/ })
  await page.find('.review-comment__body', { text: /like the rest/ })
  assert.equal(await page.eval(() => document.querySelectorAll('.review-comment:not(.review-comment--draft)').length), 1)

  // A range: THREE, then shift-click on five.
  await page.click('.review-diff__row[data-kind="add"]', { text: /THREE/ })
  assert.ok(await shiftClick(page, 'five'))
  await page.find('.review-comment__where', { text: 'Lines 3–5' })
  assert.equal(await page.eval(() => document.querySelectorAll('.review-diff__row[data-picked]').length), 3)
  await page.fill('.review-comment--draft textarea', 'Collapse these into one.')
  await page.click('.review-comment--draft button', { text: /^Add comment$/ })
  await page.find('.review-comment:not(.review-comment--draft) .review-comment__where', { text: 'Lines 3–5' })
  await s.shot(page, 'comments')

  // A comment being written outlives the window coming back to the front (the diff is looked at again).
  await page.click('.review-diff__row', { text: /four/ })
  await page.fill('.review-comment--draft textarea', 'Half a thought')
  await page.eval(() => window.dispatchEvent(new Event('focus')))
  await sleep(1500)
  // Trimmed: now and then the typing the harness does over DevTools leaves a trailing space, and comments are trimmed when saved anyway.
  assert.equal(await page.eval(() => document.querySelector('.review-comment--draft textarea')?.value.trim() ?? null), 'Half a thought')
  await page.click('.review-comment--draft button', { text: /^Cancel$/ })

  // Through a reload, the comments are still there.
  await page.reload()
  await page.find('.ade-session__title', { text: 'demo' })
  await page.find('.code-header .review-btn__count', { text: '2' })
  await page.click('.code-header .review-btn')
  await page.find('.review-comment__body', { text: /like the rest/, timeout: 20_000 })
  await page.find('.review-comment__body', { text: /Collapse these/ })

  // The failed check's log, the end of it.
  await page.click('.review-check[data-status="failed"] button', { text: /^View log$/ })
  const log = await page.find('.review-log', { text: /not ok 1 - shouts the middle lines/, timeout: 20_000 })
  assert.ok(log)
  assert.match(readFileSync(ghLog, 'utf8'), /^run view --job 202 --log-failed$/m)
  await s.shot(page, 'ci-log')

  // An "agent" to send things to.
  await page.click('.code-header .header-btn', { text: /New terminal/ })
  await page.click('.menu [role="menuitem"], .menu button', { text: /^Shell/ })
  await page.find('.term-pane')
  await sleep(2000)
  const received = join(home, 'received.txt')
  await page.click('.term-pane__screen')
  await page.type(`(exec -a claude cat > '${received}')`)
  await page.press('Enter')
  await page.find('.review__foot button', { text: /Send to agent/, timeout: 45_000 })

  // The failure goes to it with its link and its log, fenced.
  await page.click('.review-check button', { text: /^Send to agent$/ })
  const ci = await fileWith(received, /run the relevant tests/)
  assert.match(ci, /The CI check "test" failed on this branch\.\nhttps:\/\/github\.com\/octo-org\/demo\/actions\/runs\/101\/job\/202/)
  assert.match(ci, /```text\n── test › Run npm test\n> demo@1\.0\.0 test\nnot ok 1 - shouts the middle lines/)

  // Then the comments, as one message: the range quoted line by line.
  await page.click('.review__foot button', { text: /Send to agent/ })
  const sent = await fileWith(received, /Collapse these/)
  assert.match(sent, /app\.ts:2\n> TWO\nUse \*\*lower case\*\*, like the rest\./)
  assert.match(sent, /app\.ts:3-5\n> THREE\n> four\n> five\nCollapse these into one\./)
  await page.waitFor(() => !document.querySelector('.review__foot'), { message: 'the sent comments to clear' })

  // Update from main: a conflict, listed with what to do about it.
  await page.click('.review-update button', { text: /^Update from main$/ })
  await page.find('.review-conflicts', { text: /Merge in progress · 1 file has conflicts/, timeout: 20_000 })
  await page.find('.review-conflict__file', { text: 'app.ts' })
  await s.shot(page, 'conflict')

  // Handed to the agent…
  await page.click('.review-conflicts button', { text: /^Ask agent to resolve$/ })
  await fileWith(received, /Merging main left conflicts in this file:\n\n- app\.ts\n\nPlease resolve every conflict marker/)

  // …or resolved here: theirs (main's line two), then the merge finished.
  await page.click('.review-conflict__file', { text: 'app.ts' })
  await page.find('.review-resolver__side[data-side="ours"] pre', { text: /TWO\nTHREE/ })
  await page.find('.review-resolver__side[data-side="theirs"] pre', { text: /main two\nthree/ })
  await page.click('.review-resolver button', { text: /^Use theirs$/ })
  await s.shot(page, 'resolver')
  await page.click('.review-resolver button', { text: /^Save and mark resolved$/ })
  await page.find('.review-conflicts', { text: /Every conflict is resolved/, timeout: 20_000 })
  await page.click('.review-conflicts button', { text: /^Finish merge$/ })
  await page.waitFor(() => !document.querySelector('.review-conflicts'), { message: 'the merge to finish', timeout: 20_000 })
  assert.equal(readFileSync(join(repo, 'app.ts'), 'utf8'), 'one\nmain two\nthree\nfour\nfive\n')
  assert.match(git(repo, 'log', '-1', '--format=%s'), /^Merge branch 'main' into feature\/shout/)
  assert.equal(git(repo, 'status', '--porcelain'), '')
  await s.shot(page, 'merged')
})
