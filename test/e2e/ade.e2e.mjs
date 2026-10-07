/**
 * ADE sessions in the real app: Settings → ADE imports the folders Claude Code
 * and Codex have conversations in, the sidebar lists them by project with
 * their agents, New session makes a branch in its own worktree and starts an
 * agent in it, and removing it removes the worktree (never the branch).
 *
 * Everything lives in the scenario's scratch home: a git repository made
 * here, a worktree "another tool" made, and conversation files written in the
 * shapes Claude Code and Codex use. The app is pointed at that home's
 * ~/.claude and ~/.codex explicitly, so a developer's own are never read.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { within } from './harness.mjs'
import { openSettings, scenario } from './fixtures.mjs'

const CLAUDE_A = '11111111-1111-4111-8111-111111111111'
const CLAUDE_B = '22222222-2222-4222-8222-222222222222'
const CLAUDE_WT = '33333333-3333-4333-8333-333333333333'
const CODEX_A = '44444444-4444-4444-8444-444444444444'

const slug = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-')
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
const HOURS = 3_600_000

/** A Claude Code transcript that took a turn, with the title Claude Code gave it. */
function claudeTranscript(home, cwd, id, title, ageHours) {
  const file = join(home, '.claude', 'projects', slug(cwd), `${id}.jsonl`)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(
    file,
    jsonl([
      { type: 'user', message: { role: 'user', content: 'please look into it' }, cwd, sessionId: id },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] }, cwd },
      { type: 'ai-title', aiTitle: title, sessionId: id }
    ])
  )
  const at = (Date.now() - ageHours * HOURS) / 1000
  utimesSync(file, at, at)
}

function codexRollout(home, cwd, id, asked, ageHours) {
  const dir = join(home, '.codex', 'sessions', '2026', '10', '06')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-2026-10-06T05-00-00-${id}.jsonl`)
  writeFileSync(
    file,
    jsonl([
      { type: 'session_meta', payload: { id, cwd } },
      { type: 'event_msg', payload: { type: 'user_message', message: asked } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } }
    ])
  )
  const at = (Date.now() - ageHours * HOURS) / 1000
  utimesSync(file, at, at)
}

/**
 * The terminals as laid out, in reading order. Layout boxes, not what is
 * drawn: a terminal that has just opened is still scaling in.
 */
async function grid(page) {
  await page.waitFor(() => [...document.querySelectorAll('.term-pane')].every((p) => p.getAnimations().length === 0), {
    message: 'the terminals to finish opening'
  })
  return page.eval(() =>
    [...document.querySelectorAll('.term-pane')]
      .map((p) => ({ name: p.querySelector('.term-pane__name')?.textContent ?? '', x: p.offsetLeft, y: p.offsetTop, w: p.offsetWidth, h: p.offsetHeight }))
      .sort((a, b) => a.y - b.y || a.x - b.x)
  )
}

/** The middle of the first element matching `selector` (inside the pane named `pane`, if given). */
function centre(page, selector, pane) {
  return page.eval(
    (selector, pane) => {
      const root = pane ? [...document.querySelectorAll('.term-pane')].find((p) => p.querySelector('.term-pane__name')?.textContent === pane) : document
      const r = root?.querySelector(selector)?.getBoundingClientRect()
      return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
    },
    selector,
    pane ?? null
  )
}

/** A real mouse drag: press, move in steps with the button held, release. */
async function mouseDrag(page, from, to, { release = true } = {}) {
  const send = (params) => page.cdp.send('Input.dispatchMouseEvent', params)
  await send({ type: 'mouseMoved', x: from.x, y: from.y })
  await send({ type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 10; i++) {
    await send({ type: 'mouseMoved', x: from.x + ((to.x - from.x) * i) / 10, y: from.y + ((to.y - from.y) * i) / 10, button: 'left', buttons: 1 })
  }
  if (release) await send({ type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 })
}

/** The sidebar as shown: projects with their count, sessions with title, branch line and state, the agents under the open one. */
function sidebar(page) {
  return page.eval(() =>
    [...document.querySelectorAll('.ade-project')].map((p) => ({
      project: p.querySelector('.ade-project__name')?.textContent ?? '',
      count: p.querySelector('.ade-project__count')?.textContent ?? '',
      sessions: [...p.querySelectorAll('.ade-session')].map((s) => ({
        title: s.querySelector('.ade-session__title')?.textContent ?? '',
        sub: s.querySelector('.ade-session__branch')?.textContent ?? '',
        state: s.getAttribute('data-state') ?? '',
        active: s.getAttribute('data-active') === 'true',
        agentsHead: s.querySelector('.ade-agents__head')?.textContent?.trim() ?? '',
        agents: [...s.querySelectorAll('.ade-agent')].map((a) => ({
          kind: a.getAttribute('data-kind') ?? '',
          task: a.querySelector('.ade-agent__task')?.textContent ?? '',
          age: a.querySelector('.ade-agent__age')?.textContent ?? ''
        }))
      }))
    }))
  )
}

scenario('ADE sessions: import from Claude Code and Codex, a new session on its own branch, removed cleanly', { timeout: 180_000 }, async (s) => {
  const launchEnv = { CLAUDE_CONFIG_DIR: join(s.homeDir, '.claude'), CODEX_HOME: join(s.homeDir, '.codex') }
  const app = await s.launch({ env: launchEnv })
  const page = app.page
  const home = realpathSync(s.homeDir)

  // A repository, and a worktree of it that some other tool made.
  const repo = join(home, 'projects', 'acme-internal')
  const other = join(home, 'projects', 'acme-elsewhere', 'checkout-baseline')
  mkdirSync(repo, { recursive: true })
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' }
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' }).trim()
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), 'acme\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'first')
  git(repo, 'worktree', 'add', '-q', '-b', 'feature/checkout-baseline', other)

  claudeTranscript(home, repo, CLAUDE_A, 'fixed checks detail link', 6)
  codexRollout(home, repo, CODEX_A, 'verifying CI panel deep link', 7)
  claudeTranscript(home, repo, CLAUDE_B, 'adding regression coverage', 8)
  claudeTranscript(home, other, CLAUDE_WT, 'baseline checkout numbers', 30)

  // Settings → ADE → Find sessions: both folders, with what each has.
  await openSettings(page, 'ADE')
  await page.click('.settings__inner button', { text: /^Find sessions$/ })
  const found = await page.waitFor(
    () => {
      const items = [...document.querySelectorAll('.ade-import__item')]
      return items.length ? items.map((i) => i.textContent?.replace(/\s+/g, ' ').trim() ?? '') : null
    },
    { message: 'the import list', timeout: 20_000 }
  )
  s.t.diagnostic(`import found: ${JSON.stringify(found)}`)
  assert.equal(found.length, 2)
  assert.ok(found.some((t) => /^acme-internal/.test(t) && /fixed checks detail link/.test(t)))
  assert.ok(found.some((t) => /^checkout-baseline in acme-internal/.test(t)), 'the other tool’s worktree is filed under its repository')
  await s.shot(page, 'settings-import-found')
  await page.click('.settings__inner button', { text: /^Import 2 sessions$/ })
  await page.find('.ade-import__done', { text: /Imported 2 sessions/ })
  await s.shot(page, 'settings-imported')

  // The ADE: one project, its two sessions.
  await page.click('.ade-import__toggle', { text: /^Open the ADE$/ })
  await page.find('.ade-project__name', { text: 'acme-internal' })
  await page.click('.ade-session__title', { text: /^acme-internal$/ })
  const afterImport = await page.waitFor(
    async () => {
      const shown = [...document.querySelectorAll('.ade-session[data-active="true"] .ade-agent')]
      return shown.length === 3 ? true : null
    },
    { message: 'the project folder’s three conversations under it', timeout: 20_000 }
  )
  assert.ok(afterImport)
  let tree = await sidebar(page)
  s.t.diagnostic(`sidebar after import: ${JSON.stringify(tree)}`)
  assert.equal(tree.length, 1)
  assert.equal(tree[0].project, 'acme-internal')
  assert.equal(tree[0].count, '2')
  const root = tree[0].sessions.find((x) => x.title === 'acme-internal')
  assert.ok(root?.active)
  assert.equal(root.sub, 'main · project folder')
  assert.equal(root.agentsHead, '3 agents')
  assert.deepEqual(
    root.agents.map((a) => [a.kind, a.task, a.age]),
    [
      ['past', 'fixed checks detail link', '6h'],
      ['past', 'verifying CI panel deep link', '7h'],
      ['past', 'adding regression coverage', '8h']
    ]
  )
  const baseline = tree[0].sessions.find((x) => x.title === 'checkout-baseline')
  assert.equal(baseline?.sub, 'feature/checkout-baseline')
  await s.shot(page, 'sidebar-imported')

  // With no terminals open, the session's page offers the same conversations to carry on with
  // (they were only in the sidebar, so a session looked empty).
  const past = await page.waitFor(
    () => {
      const items = [...document.querySelectorAll('.term-past__item .term-past__title')].map((t) => t.textContent)
      return items.length ? items : null
    },
    { message: 'the past conversations on the session’s page', timeout: 20_000 }
  )
  assert.deepEqual(past, ['fixed checks detail link', 'verifying CI panel deep link', 'adding regression coverage'])
  await s.shot(page, 'session-past-conversations')

  // New session: a branch from the title, in a worktree of its own, with a shell started in it.
  await page.click('.sidebar .nav-item', { text: /^New session$/ })
  await page.find('.modal', { text: /New session/ })
  await page.fill('.modal input[placeholder="Fix CI checks detail link"]', 'Fix CI checks detail link')
  const branchShown = await page.eval(() => document.querySelector('.ade-dialog__branch input')?.value)
  assert.equal(branchShown, 'fix/ci-checks-detail-link')
  await page.click('.ade-dialog__agent', { text: /^Shell$/ })
  await s.shot(page, 'new-session-dialog')
  await page.click('.modal button', { text: /^Create session$/ })
  await page.waitFor(() => !document.querySelector('.modal'), { message: 'the dialog to close', timeout: 30_000 })
  const worktree = join(home, 'Eaon', 'worktrees', 'acme-internal', 'ci-checks-detail-link')
  assert.ok(existsSync(worktree), `the worktree at ${worktree}`)
  assert.equal(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix/ci-checks-detail-link')
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the project folder stays on its branch')
  await page.find('.term-pane')

  // Make the shell work for a few seconds and name its task, as Claude Code does in its title.
  await page.click('.term-pane__screen')
  await page.type(`printf '\\033]0;\\342\\234\\263 Fixing checks detail link\\007'; for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo tick $i; sleep 0.4; done`)
  await page.press('Enter')
  const working = await page.waitFor(
    () => {
      const s = document.querySelector('.ade-session[data-active="true"]')
      const agent = s?.querySelector('.ade-agent')
      return s?.getAttribute('data-state') === 'working' && agent?.getAttribute('data-kind') === 'working' ? agent.textContent : null
    },
    { message: 'the new session to show its agent working', timeout: 20_000 }
  )
  s.t.diagnostic(`working agent row: ${JSON.stringify(working)}`)
  // The task is the title the shell was given, which lands a moment after the first output.
  await page.waitFor(() => document.querySelector('.ade-session[data-active="true"] .ade-agent__task')?.textContent === 'Fixing checks detail link', {
    message: 'the agent row to show the task from the terminal title',
    timeout: 10_000
  })
  tree = await sidebar(page)
  const made = tree[0].sessions.find((x) => x.active)
  assert.equal(made?.title, 'Fix CI checks detail link')
  assert.equal(made?.sub, 'fix/ci-checks-detail-link')
  assert.equal(tree[0].count, '3')
  assert.equal(made?.agents[0]?.task, 'Fixing checks detail link')
  await s.shot(page, 'sidebar-working')
  // Quiet again: the session waits for you (green), its agent done for now.
  await page.waitFor(() => document.querySelector('.ade-session[data-active="true"]')?.getAttribute('data-state') === 'live', {
    message: 'the session to go quiet',
    timeout: 30_000
  })
  await s.shot(page, 'sidebar-live')

  // Three terminals in the session: two above, one stretched below.
  for (let n = 0; n < 2; n++) {
    await page.click('.code-header .header-btn', { text: /New terminal/ })
    await page.click('[role="menuitem"]', { text: /^Shell$/ })
  }
  await page.waitFor(() => document.querySelectorAll('.term-pane').length === 3, { message: 'three terminals' })
  let shown = await grid(page)
  await s.shot(page, 'grid-three')
  s.t.diagnostic(`grid of three: ${JSON.stringify(shown)}`)
  assert.deepEqual(
    shown.map((p) => p.name),
    ['Cynthia', 'Andy', 'Sarah']
  )
  const [left, right, below] = shown
  assert.ok(Math.abs(left.w - right.w) <= 2, 'the two above start even')
  assert.ok(below.w > left.w + right.w, 'the one below spans both columns')

  // Drag the column divider 200px right: the left terminal grows by what the right one loses.
  const col = await centre(page, '.term-divider[data-axis="cols"]')
  assert.ok(col, 'a column divider between the two above')
  await mouseDrag(page, col, { x: col.x + 200, y: col.y })
  shown = await grid(page)
  s.t.diagnostic(`after dragging the column divider: ${JSON.stringify(shown)}`)
  assert.ok(Math.abs(shown[0].w - (left.w + 200)) <= 3, `left ${left.w} → ${shown[0].w}`)
  assert.ok(Math.abs(shown[1].w - (right.w - 200)) <= 3, `right ${right.w} → ${shown[1].w}`)
  assert.equal(shown[2].w, below.w, 'the one below still spans the whole width')
  // And the row divider 80px up: the top row gives the bottom one its height.
  const row = await centre(page, '.term-divider[data-axis="rows"]')
  await mouseDrag(page, row, { x: row.x, y: row.y - 80 })
  const rows = await grid(page)
  assert.ok(Math.abs(rows[0].h - (left.h - 80)) <= 3, `top ${left.h} → ${rows[0].h}`)
  assert.ok(Math.abs(rows[2].h - (below.h + 80)) <= 3, `bottom ${below.h} → ${rows[2].h}`)
  // Remembered for this folder.
  const remembered = await page.eval(() => localStorage.getItem('eaon.ade.gridSizes'))
  assert.match(remembered ?? '', /ci-checks-detail-link\|2x2/)
  await s.shot(page, 'grid-resized')

  // From the keyboard: a focused divider moves with the arrow keys; Enter evens it out again, as a double-click does.
  await page.eval(() => document.querySelector('.term-divider[data-axis="cols"]').focus())
  const beforeKey = (await grid(page))[0].w
  await page.press('ArrowRight')
  assert.ok(Math.abs((await grid(page))[0].w - (beforeKey + 24)) <= 3, 'ArrowRight moves the divider 24px')
  const send = (params) => page.cdp.send('Input.dispatchMouseEvent', params)
  for (const clickCount of [1, 2]) {
    await send({ type: 'mousePressed', x: col.x + 224, y: col.y, button: 'left', buttons: 1, clickCount })
    await send({ type: 'mouseReleased', x: col.x + 224, y: col.y, button: 'left', buttons: 0, clickCount })
  }
  await page.waitFor(
    () => {
      const [a, b] = [...document.querySelectorAll('.term-pane')].map((p) => p.getBoundingClientRect().width)
      return Math.abs(a - b) <= 2
    },
    { message: 'a double-click to even the columns out' }
  )

  // Drag Cynthia's title bar onto Andy with the mouse: they trade places.
  await page.cdp.send('Input.setInterceptDrags', { enabled: true })
  const dragged = new Promise((resolve) => {
    const off = page.cdp.on('Input.dragIntercepted', (params) => {
      off()
      resolve(params.data)
    })
  })
  const handle = await centre(page, '.term-pane__name', 'Cynthia')
  const onto = await centre(page, '.term-pane__screen', 'Andy')
  await mouseDrag(page, handle, { x: handle.x + 40, y: handle.y + 20 }, { release: false })
  const data = await within(dragged, 10_000, 'the title bar drag to start')
  await page.cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: onto.x, y: onto.y, data })
  await page.cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: onto.x, y: onto.y, data })
  await page.find('.term-pane__drop[data-over="true"]', { text: /Swap with Andy/ })
  await s.shot(page, 'grid-dragging')
  await page.cdp.send('Input.dispatchDragEvent', { type: 'drop', x: onto.x, y: onto.y, data })
  await send({ type: 'mouseReleased', x: onto.x, y: onto.y, button: 'left', buttons: 0, clickCount: 1 })
  await page.cdp.send('Input.setInterceptDrags', { enabled: false })
  await page.waitFor(() => !document.querySelector('.term-pane__drop'), { message: 'the drop targets to go once dropped' })
  assert.deepEqual(
    (await grid(page)).map((p) => p.name),
    ['Andy', 'Cynthia', 'Sarah']
  )
  // The new order is saved with the folder's terminals.
  await page.waitFor(
    async (cwd) => {
      const layout = await window.api.terminals.layout()
      return (layout[cwd] ?? []).map((p) => p.name).join(',') === 'Andy,Cynthia,Sarah'
    },
    { args: [worktree], message: 'the swapped order to be saved' }
  )
  // The same from a terminal's menu: Andy moves right, back where he was.
  const options = await centre(page, '.term-pane__btn[aria-label="Pane options"]', 'Andy')
  await page.mouse(options.x, options.y)
  await page.click('[role="menuitem"]', { text: /^Move right$/ })
  await page.waitFor(
    () =>
      [...document.querySelectorAll('.term-pane')]
        .sort((a, b) => a.offsetTop - b.offsetTop || a.offsetLeft - b.offsetLeft)
        .map((p) => p.querySelector('.term-pane__name')?.textContent)
        .join(',') === 'Cynthia,Andy,Sarah',
    { message: 'Move right to swap Andy with the one after him' }
  )

  // Remove it, worktree too: the folder goes, the branch stays.
  await page.eval(() => {
    const row = document.querySelector('.ade-session[data-active="true"] .ade-session__row')
    const rect = row.getBoundingClientRect()
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 20, clientY: rect.top + 10 }))
  })
  await page.click('[role="menuitem"]', { text: /Remove session/ })
  await page.click('.ade-dialog__check input')
  await page.click('.modal button', { text: /^Remove$/ })
  await page.waitFor(() => !document.querySelector('.modal'), { message: 'the remove dialog to close', timeout: 30_000 })
  assert.equal(existsSync(worktree), false, 'the worktree folder is gone')
  assert.equal(git(repo, 'branch', '--list', 'fix/ci-checks-detail-link'), 'fix/ci-checks-detail-link', 'the branch stays')
  tree = await sidebar(page)
  assert.equal(tree[0].count, '2')
  assert.deepEqual(app.pageErrors().filter((e) => /exception/i.test(e)), [])
  await s.shot(page, 'sidebar-after-remove')
})
