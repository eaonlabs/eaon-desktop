/**
 * Import from other agent apps in the real app: Settings → ADE → From other
 * apps finds a Claude Squad session and a T3 Code thread in the scenario's
 * home, and a T3 Code project's scripts, shown as a row per app in plain
 * words (Choose lists an app's things by name); Import
 * makes ADE sessions on the same folders (named as the other app named them,
 * filed under their repository), opens the T3 thread's Claude conversation
 * in a pane, and keeps the scripts.
 *
 * Nothing runs: the ADE isn't opened, so no pane starts an agent.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openSettings, scenario } from './fixtures.mjs'

const CLAUDE_ID = '7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

scenario('import from other agent apps: Claude Squad and T3 Code sessions, and a project’s scripts, into the ADE', { timeout: 120_000 }, async (s) => {
  const app = await s.launch()
  const page = app.page
  const home = realpathSync(s.homeDir)

  // A repository, a worktree Claude Squad made of it, and one T3 Code made.
  const repo = join(home, 'code', 'shop')
  const squadTree = join(home, '.claude-squad', 'worktrees', 'checkout_1a2b')
  const t3Tree = join(home, '.t3', 'worktrees', 'shop', 'billing')
  mkdirSync(repo, { recursive: true })
  mkdirSync(join(home, '.t3', 'worktrees', 'shop'), { recursive: true })
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' }
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' }).trim()
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), 'shop\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'first')
  git(repo, 'worktree', 'add', '-q', '-b', 'me/checkout', squadTree)
  git(repo, 'worktree', 'add', '-q', '-b', 'billing', t3Tree)

  writeFileSync(
    join(home, '.claude-squad', 'state.json'),
    JSON.stringify({
      help_screens_seen: 3,
      instances: [
        {
          title: 'Checkout flow',
          path: repo,
          branch: 'me/checkout',
          status: 1,
          program: 'claude',
          created_at: '2026-11-01T10:00:00Z',
          updated_at: '2026-11-02T10:00:00Z',
          worktree: { repo_path: repo, worktree_path: squadTree, branch_name: 'me/checkout', session_name: 'Checkout flow' }
        }
      ]
    })
  )

  mkdirSync(join(home, '.t3', 'userdata'), { recursive: true })
  const db = new DatabaseSync(join(home, '.t3', 'userdata', 'statev2.sqlite'))
  db.exec(`
    CREATE TABLE projection_projects (project_id TEXT, title TEXT, workspace_root TEXT, scripts_json TEXT, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, title TEXT, default_provider TEXT, archived_at TEXT, deleted_at TEXT, updated_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, provider TEXT, driver TEXT, payload_json TEXT);
  `)
  db.prepare('INSERT INTO projection_projects VALUES (?, ?, ?, ?, NULL)').run(
    'p1',
    'shop',
    repo,
    JSON.stringify([
      { id: 'a', name: 'Install', command: 'bun install', icon: 'configure', runOnWorktreeCreate: true },
      { id: 'b', name: 'Dev server', command: 'bun run dev --port 4100', icon: 'play' }
    ])
  )
  db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)').run(
    't1',
    'p1',
    'Add billing page',
    'claudeAgent',
    '2026-11-03T10:00:00Z',
    JSON.stringify({ branch: 'billing', worktreePath: t3Tree })
  )
  db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?)').run(
    't1',
    'claudeAgent',
    'claudeAgent',
    JSON.stringify({ nativeThreadRef: { driver: 'claudeAgent', nativeId: CLAUDE_ID } })
  )
  db.close()

  // Settings → ADE: a row per app, with its logo and what it has in plain words; no folders or commands.
  await openSettings(page, 'ADE')
  const rows = await page.waitFor(
    () => {
      const list = [...document.querySelectorAll('.ade-apps .sources__app')]
      return list.length >= 2 ? list.map((r) => r.textContent?.replace(/\s+/g, ' ').trim() ?? '') : null
    },
    { message: 'the other apps', timeout: 20_000 }
  )
  s.t.diagnostic(`found: ${JSON.stringify(rows)}`)
  assert.deepEqual(rows, ['Claude Squad1 session', 'T3 Code1 session and its chat · commands for 1 projectChoose'])
  assert.equal(await page.eval(() => document.querySelectorAll('.ade-apps .sources__logo').length), 2)
  assert.ok(!rows.some((t) => t.includes(home) || t.includes('bun ')), 'no folders or commands in the list')
  await s.shot(page, 'from-other-apps')

  // Choose: T3 Code's things by name, each ticked.
  await page.click('.ade-apps .sources__choose')
  const items = await page.waitFor(() => {
    const list = [...document.querySelectorAll('.ade-apps .sources__item')]
    return list.length ? list.map((i) => [i.querySelector('.sources__item-label')?.textContent, i.querySelector('input')?.checked]) : null
  }, { message: 'T3 Code’s things' })
  assert.deepEqual(items, [
    ['Add billing page', true],
    ['Commands for shop', true]
  ])
  await s.shot(page, 'from-other-apps-choose')

  await page.click('.settings__inner button', { text: /^Import$/ })
  await page.find('.ade-import__done', { text: 'Imported 2 sessions and the commands for 1 project.', timeout: 20_000 })
  await s.shot(page, 'from-other-apps-imported')

  // The sessions: on the same folders, named as before, filed under the repository, and where they came from.
  const sessions = await page.eval(() => window.api.ade.sessions())
  const squad = sessions.find((x) => x.cwd === squadTree)
  const t3 = sessions.find((x) => x.cwd === t3Tree)
  assert.ok(squad && t3, JSON.stringify(sessions))
  assert.deepEqual(
    { title: squad.title, project: squad.project, branch: squad.branch, from: squad.importedFrom, worktree: squad.worktree },
    { title: 'Checkout flow', project: repo, branch: 'me/checkout', from: 'Claude Squad', worktree: false },
    'Eaon didn’t make the worktree, so removing the session won’t remove it'
  )
  assert.deepEqual({ title: t3.title, project: t3.project, from: t3.importedFrom }, { title: 'Add billing page', project: repo, from: 'T3 Code' })

  // The T3 thread's Claude conversation, in a pane of its session, to reopen when the ADE starts it.
  const layout = await page.waitFor(
    async (cwd) => {
      const all = await window.api.terminals.layout()
      return all[cwd]?.length ? all[cwd] : null
    },
    { args: [t3Tree], message: 'the conversation’s pane to be saved' }
  )
  assert.deepEqual(
    layout.map((p) => ({ agent: p.agent, resume: p.resume })),
    [{ agent: 'claude', resume: CLAUDE_ID }]
  )

  // The scripts: the ADE's setup and run, and Chat's Run menu.
  assert.deepEqual(await page.eval((dir) => window.api.adeTools.scripts(dir), repo), { setup: 'bun install', run: 'bun run dev --port 4100' })
  const chat = await page.eval((dir) => window.api.chatCode.scripts(dir), repo)
  assert.deepEqual(
    chat.scripts.map((x) => [x.name, x.command]),
    [
      ['Install', 'bun install'],
      ['Dev server', 'bun run dev --port 4100']
    ]
  )

  // Looked at again, the sessions are in the ADE and can't be brought in twice.
  await page.click('.settings__inner button', { text: /^Look again$/ })
  await page.waitFor(() => document.querySelector('.ade-apps .sources__app .sources__summary')?.textContent === 'In Eaon already', {
    message: 'Claude Squad to show as in Eaon'
  })
})
