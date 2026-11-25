#!/usr/bin/env node
/**
 * The release check: everything that says whether this commit can ship, run
 * in one go, with one report at the end.
 *
 *   npm run check:release                      every stage (about an hour)
 *   npm run check:release -- --only sweep,e2e  some stages
 *   npm run check:release -- --skip catalogs   all but some
 *   npm run check:release -- --quick           the sweep in one look only, no catalogs
 *   --visible                                  let the app's windows come on screen
 *   --plain                                    a line per stage, even in a terminal
 *
 * In a terminal it shows its progress in place: each stage passing, failing
 * or running, live counts and each result as it lands (release-check-watch.mjs,
 * which `npm run check:release:watch` opens on a run already going).
 *
 * Stages, in order:
 *   typecheck   the web, main and CLI TypeScript projects
 *   build       the app (electron-vite, VM helper, host) and the CLI
 *   index       Settings search's index is up to date with the pages
 *   unit        the main-process tests (npm run test:main)
 *   e2e         the end-to-end scenarios, the built app against a fake model
 *   sweep       every screen in every look, checked for UI problems (test/sweep)
 *   catalogs    the plugin catalog against vendors' servers, the model library
 *               against Hugging Face (network; never registers a client)
 *   ci          what GitHub's own checks said about this commit
 *   audit       known vulnerabilities in what the app ships (npm audit)
 *
 * The app runs hidden (test/e2e/hidden.cjs), on scratch profiles and HOMEs,
 * with the coding CLIs replaced by signed-out stand-ins (test/e2e/standins.mjs):
 * nothing comes on screen, nothing reaches the real keychain, and no turn
 * goes to anyone's plan. The unit tests run as `npm run test:main` does.
 *
 * Writes out/release-check/<time>/: report.html (open it), report.md,
 * results.json, logs/ and the sweep's screenshots. Exits non-zero when
 * something blocks the release.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { writeStandIns } from '../test/e2e/standins.mjs'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const listOf = (flag) => (args.includes(flag) ? String(args[args.indexOf(flag) + 1] ?? '').split(',').filter(Boolean) : null)
const only = listOf('--only')
const skip = listOf('--skip') ?? []
const quick = args.includes('--quick')
const visible = args.includes('--visible')

const STAGES = ['typecheck', 'build', 'index', 'unit', 'e2e', 'sweep', 'catalogs', 'ci', 'audit']
const wanted = (stage) => (only ? only.includes(stage) : !skip.includes(stage)) && !(quick && stage === 'catalogs')

/**
 * Unit tests that fail on this Mac for reasons outside the app, shown as
 * known rather than as failures. Each says why; take one out when its
 * reason no longer holds.
 */
const KNOWN_UNIT = {
  'on a Mac, a guest shell reaches the network only when allowed': 'the sandboxed guest shell gets no answer from the internet on this Mac; failed the same way on main before PR #72 (Nov 21)',
  'on a Mac, the internet doesn’t reach this computer’s own services': 'the sandboxed guest shell gets no answer from the internet on this Mac; failed the same way on main before PR #72 (Nov 21)'
}

const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')
const outDir = join(root, 'out', 'release-check', stamp)
const logsDir = join(outDir, 'logs')
mkdirSync(logsDir, { recursive: true })

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const git = (...a) => {
  try {
    return execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}
const commit = git('rev-parse', 'HEAD')
const info = {
  version: pkg.version,
  commit: commit.slice(0, 8),
  branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  subject: git('log', '-1', '--format=%s'),
  dirty: git('status', '--porcelain').split('\n').filter(Boolean).length,
  startedAt: Date.now(),
  hidden: !visible
}

const standIns = writeStandIns(join(outDir, 'standins'))
/** The environment the app-launching stages run in. */
const appEnv = {
  ...process.env,
  ...standIns.env,
  PATH: `${standIns.bin}:${process.env.PATH}`,
  ...(visible ? {} : { EAON_E2E_HIDDEN: '1' }),
  EAON_E2E_ARTIFACTS: join(outDir, 'e2e')
}

/**
 * Runs a command, its output into logs/<name>.log, and resolves with the
 * exit code and the output (the last 4 MB of it).
 * @returns {Promise<{ code: number | null, output: string, ms: number }>}
 */
function run(name, command, commandArgs, { env = process.env, cwd = root } = {}) {
  const started = Date.now()
  const log = createWriteStream(join(logsDir, `${name}.log`))
  log.write(`$ ${command} ${commandArgs.join(' ')}\n\n`)
  return new Promise((done) => {
    let output = ''
    const child = spawn(command, commandArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const take = (data) => {
      log.write(data)
      output += String(data)
      if (output.length > 4_000_000) output = output.slice(-4_000_000)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', (error) => take(`\n${error.message}\n`))
    child.on('close', (code) => {
      log.end()
      done({ code, output, ms: Date.now() - started })
    })
  })
}

/** node --test's spec-reporter totals and failing tests. */
function nodeTestResults(output) {
  const total = (key) => Number(new RegExp(`^ℹ ${key} (\\d+)`, 'm').exec(output)?.[1] ?? NaN)
  const failing = []
  const at = output.lastIndexOf('✖ failing tests:')
  if (at !== -1) {
    const lines = output.slice(at).split('\n').slice(1)
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)✖ (.+?)(?: \([\d.]+m?s\))?$/.exec(lines[i])
      if (!m) continue
      // The error is on the lines under the name, indented further.
      const detail = lines
        .slice(i + 1, i + 12)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('at ') && !/^(test at|\{|\}|code:|failureType:|cause:)/.test(l))
        .slice(0, 3)
        .join(' ')
      failing.push({ name: m[2].trim(), detail: detail.slice(0, 400), indent: m[1].length })
    }
  }
  // A file's own entry and its failing test both show; keep the innermost names.
  const names = failing.filter((f, i) => !(failing[i + 1] && failing[i + 1].indent > f.indent))
  return { tests: total('tests'), pass: total('pass'), fail: total('fail'), skipped: total('skipped'), todo: total('todo'), cancelled: total('cancelled'), failing: names }
}

const fmt = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`)

/** @type {Record<string, { status: 'pass' | 'fail' | 'warn' | 'skip', summary: string, ms: number, problems: { title: string, detail?: string, known?: string }[], data?: any }>} */
const results = {}

const stages = {
  async typecheck() {
    const r = await run('typecheck', 'npm', ['run', 'typecheck'])
    const errors = [...r.output.matchAll(/^(.+\(\d+,\d+\)): error (TS\d+): (.+)$/gm)].map((m) => ({ title: `${m[1]} ${m[2]}`, detail: m[3] }))
    if (r.code === 0) return { status: 'pass', summary: 'No type errors in the web, main or CLI projects', ms: r.ms, problems: [] }
    return { status: 'fail', summary: `${errors.length || 'Some'} type error${errors.length === 1 ? '' : 's'}`, ms: r.ms, problems: errors.length ? errors : [{ title: 'Type check failed', detail: r.output.slice(-1500) }] }
  },

  async build() {
    const app = await run('build-app', 'npm', ['run', 'build'])
    const cli = app.code === 0 ? await run('build-cli', 'npm', ['run', 'build:cli']) : { code: null, output: '', ms: 0 }
    const problems = []
    if (app.code !== 0) problems.push({ title: 'The app did not build', detail: app.output.slice(-2000) })
    if (cli.code !== 0 && app.code === 0) problems.push({ title: 'The CLI did not build', detail: cli.output.slice(-2000) })
    const warnings = [...new Set([...app.output.matchAll(/^.*(\(!\)|warning:|Circular dependency).*$/gim)].map((m) => m[0].trim()))].slice(0, 20)
    const big = [...app.output.matchAll(/(\S+\.js)\s+([\d,.]+) kB/g)].map((m) => ({ file: m[1], kb: Number(m[2].replace(/,/g, '')) })).sort((a, b) => b.kb - a.kb)
    const status = problems.length ? 'fail' : 'pass'
    return {
      status,
      summary: problems.length ? problems.map((p) => p.title).join('; ') : `Built the app and the CLI${big[0] ? `; largest renderer chunk ${Math.round(big[0].kb / 1024)} MB` : ''}`,
      ms: app.ms + cli.ms,
      problems: [...problems, ...warnings.map((w) => ({ title: 'Build warning', detail: w, known: 'a warning, not a failure' }))],
      data: { largest: big.slice(0, 5) }
    }
  },

  async index() {
    const r = await run('settings-index', 'node', ['scripts/settings-index.mjs', '--check'])
    return r.code === 0
      ? { status: 'pass', summary: 'Settings search knows every page and row', ms: r.ms, problems: [] }
      : { status: 'fail', summary: 'Settings search is out of date: run node scripts/settings-index.mjs', ms: r.ms, problems: [{ title: 'settingsIndex.ts is stale', detail: r.output.slice(-800) }] }
  },

  async unit() {
    const r = await run('unit', 'npm', ['run', 'test:main'], { env: { ...process.env, EAON_TEST_OUT: 'test-release-check' } })
    const t = nodeTestResults(r.output)
    const problems = t.failing.map((f) => ({ title: f.name, detail: f.detail, ...(KNOWN_UNIT[f.name] ? { known: KNOWN_UNIT[f.name] } : {}) }))
    const real = problems.filter((p) => !p.known)
    if (Number.isNaN(t.tests)) return { status: 'fail', summary: `The tests didn't finish (exit ${r.code})`, ms: r.ms, problems: [{ title: 'No test totals', detail: r.output.slice(-2000) }] }
    return {
      status: real.length ? 'fail' : problems.length ? 'warn' : 'pass',
      summary: `${t.pass} passed, ${t.fail} failed${problems.length - real.length ? ` (${problems.length - real.length} known)` : ''}, ${t.skipped} skipped of ${t.tests}`,
      ms: r.ms,
      problems,
      data: t
    }
  },

  async e2e() {
    const r = await run('e2e', 'node', ['scripts/test-e2e.mjs', '--no-build'], { env: appEnv })
    const t = nodeTestResults(r.output)
    const problems = t.failing.map((f) => ({ title: f.name, detail: f.detail }))
    const skipped = [...r.output.matchAll(/^\s*﹣ (.+?) \([\d.]+m?s\) # (.+)$/gm)].map((m) => ({ name: m[1], why: m[2] }))
    if (Number.isNaN(t.tests)) return { status: 'fail', summary: `The scenarios didn't finish (exit ${r.code})`, ms: r.ms, problems: [{ title: 'No totals', detail: r.output.slice(-2000) }] }
    return {
      status: t.fail ? 'fail' : 'pass',
      summary: `${t.pass} of ${t.tests} scenarios passed, ${t.fail} failed, ${t.skipped} skipped${t.todo ? `, ${t.todo} known bugs (todo)` : ''}`,
      ms: r.ms,
      problems,
      data: { ...t, skippedWhy: skipped, screens: relative(outDir, join(outDir, 'e2e', 'screens')) }
    }
  },

  async sweep() {
    const out = join(outDir, 'sweep')
    const r = await run('sweep', 'node', ['test/sweep/ui-sweep.mjs', '--out', out, ...(quick ? ['--quick'] : []), ...(visible ? ['--visible'] : [])], { env: appEnv })
    const file = join(out, 'sweep.json')
    if (!existsSync(file)) return { status: 'fail', summary: `The sweep didn't run (exit ${r.code})`, ms: r.ms, problems: [{ title: 'No sweep results', detail: r.output.slice(-2000) }] }
    const sweep = JSON.parse(readFileSync(file, 'utf8'))
    const issues = sweep.views.flatMap((v) => (v.issues ?? []).map((i) => ({ ...i, view: v })))
    const errors = issues.filter((i) => i.severity === 'error')
    const warns = issues.filter((i) => i.severity === 'warn')
    const failedFlows = sweep.flows.filter((f) => !f.ok)
    const problems = [
      ...(sweep.stopped ? [{ title: 'The sweep stopped part way', detail: sweep.stopped.slice(0, 600) }] : []),
      ...failedFlows.map((f) => ({ title: `Flow failed: ${f.name}`, detail: f.detail })),
      ...errors.map((i) => ({ title: `${i.view.combo} · ${i.view.area} › ${i.view.label}: ${i.message}`, detail: i.where }))
    ]
    return {
      status: problems.length ? 'fail' : warns.length ? 'warn' : 'pass',
      summary: `${sweep.views.length} screens: ${errors.length} errors, ${warns.length} warnings; ${sweep.flows.length - failedFlows.length} of ${sweep.flows.length} flows passed`,
      ms: r.ms,
      problems,
      data: { ...sweep, dir: 'sweep' }
    }
  },

  async catalogs() {
    const plugins = await run('verify-plugins', 'node', ['scripts/verify-plugins.mjs', '--no-register'])
    const models = await run('verify-models', 'node', ['scripts/verify-model-library.mjs'])
    const problems = []
    // ✖ and ✗ start a failed entry's line; \b would never match beside them.
    const failedLines = (output) => output.split('\n').filter((l) => /^\s*[✖✗]|\b(FAIL|failed|missing)\b/.test(l)).slice(0, 25)
    for (const [title, r] of [['Plugin catalog', plugins], ['Model library', models]]) {
      if (r.code === 0) continue
      const lines = failedLines(r.output)
      for (const line of lines.length ? lines : [r.output.trim().split('\n').slice(-3).join(' ')]) problems.push({ title, detail: line.trim() })
    }
    // A vendor's server being down today is worth knowing, not a reason to hold the release.
    return {
      status: problems.length ? 'warn' : 'pass',
      summary: `Plugin catalog ${plugins.code === 0 ? 'checks out' : 'has entries that failed'}; model library ${models.code === 0 ? 'checks out' : 'has entries that failed'}`,
      ms: plugins.ms + models.ms,
      problems
    }
  },

  async ci() {
    const started = Date.now()
    try {
      // gh's own complaints go into the error, not onto the terminal.
      const gh = (...a) => execFileSync('gh', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      const repo = gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner').trim()
      // A commit made here and not pushed is unknown to GitHub: nothing has checked it yet.
      const pushed = (() => {
        try {
          gh('api', `repos/${repo}/commits/${commit}`, '--jq', '.sha')
          return true
        } catch {
          return false
        }
      })()
      if (!pushed) return { status: 'warn', summary: `${info.commit} isn't on GitHub yet, so no checks have run on it`, ms: Date.now() - started, problems: [] }
      const checksOf = (sha) => JSON.parse(gh('api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`)).check_runs
      let runs = checksOf(commit)
      let from = ''
      if (!runs.length) {
        // A merge commit on main has none of its own: the workflows ran on the pull request that made it.
        const pulls = JSON.parse(gh('api', `repos/${repo}/commits/${commit}/pulls`))
        const pull = pulls.find((p) => p.merged_at) ?? pulls[0]
        if (pull) {
          runs = checksOf(pull.head.sha)
          from = ` (on pull request #${pull.number}, which made this commit)`
        }
      }
      if (!runs.length) return { status: 'warn', summary: `GitHub has no checks for ${info.commit} (not pushed, or no workflow ran on it)`, ms: Date.now() - started, problems: [] }
      const bad = runs.filter((c) => c.conclusion && !['success', 'skipped', 'neutral'].includes(c.conclusion))
      const pending = runs.filter((c) => c.status !== 'completed')
      return {
        status: bad.length ? 'fail' : pending.length ? 'warn' : 'pass',
        summary: `${runs.length - bad.length - pending.length} of ${runs.length} GitHub checks passed${pending.length ? `, ${pending.length} still running` : ''}${bad.length ? `, ${bad.length} failed` : ''}${from}`,
        ms: Date.now() - started,
        problems: [...bad.map((c) => ({ title: `${c.name}: ${c.conclusion}`, detail: c.html_url })), ...pending.map((c) => ({ title: `${c.name}: still running`, detail: c.html_url, known: 'not finished' }))],
        data: runs.map((c) => ({ name: c.name, conclusion: c.conclusion ?? c.status }))
      }
    } catch (error) {
      return { status: 'warn', summary: `Couldn't ask GitHub: ${String(error.message).split('\n')[0]}`, ms: Date.now() - started, problems: [] }
    }
  },

  async audit() {
    const r = await run('audit', 'npm', ['audit', '--omit=dev', '--json'])
    try {
      const report = JSON.parse(r.output.slice(r.output.indexOf('{')))
      const counts = report.metadata?.vulnerabilities ?? {}
      const serious = Object.values(report.vulnerabilities ?? {}).filter((v) => v.severity === 'high' || v.severity === 'critical')
      return {
        status: serious.length ? 'warn' : 'pass',
        summary: `${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low in what ships`,
        ms: r.ms,
        problems: serious.map((v) => ({ title: `${v.name} (${v.severity})`, detail: (v.via ?? []).map((x) => (typeof x === 'string' ? x : x.title)).join('; ').slice(0, 300) }))
      }
    } catch {
      return { status: 'warn', summary: "npm audit didn't answer (offline?)", ms: r.ms, problems: [] }
    }
  }
}

writeFileSync(join(outDir, 'results.json'), JSON.stringify({ info, results }, null, 2))
// In a terminal the check draws its progress in place (release-check-watch.mjs); piped, it prints a line per stage.
const view = process.stdout.isTTY && !args.includes('--plain') ? (await import('./release-check-watch.mjs')).watch(outDir, { embedded: true }) : null
const say = (text) => {
  if (!view) process.stdout.write(text)
}
say(`Release check: Eaon ${info.version} at ${info.commit} (${info.branch})${info.dirty ? `, ${info.dirty} uncommitted changes` : ''}\n`)
say(`Report: ${join(outDir, 'report.html')}\n\n`)
for (const stage of STAGES) {
  if (!wanted(stage)) {
    results[stage] = { status: 'skip', summary: 'Not run this time', ms: 0, problems: [] }
    continue
  }
  // The rest needs a build; without one there is nothing to run.
  if (['e2e', 'sweep'].includes(stage) && results.build?.status === 'fail') {
    results[stage] = { status: 'skip', summary: 'Skipped: the app did not build', ms: 0, problems: [] }
    continue
  }
  say(`▸ ${stage} … `)
  try {
    results[stage] = await stages[stage]()
  } catch (error) {
    results[stage] = { status: 'fail', summary: `The stage itself broke: ${error.message}`, ms: 0, problems: [{ title: 'Stage error', detail: String(error.stack).slice(0, 1500) }] }
  }
  const r = results[stage]
  say(`${{ pass: '✓', fail: '✗', warn: '!', skip: '-' }[r.status]} ${r.summary} (${fmt(r.ms)})\n`)
  writeFileSync(join(outDir, 'results.json'), JSON.stringify({ info, results }, null, 2))
}
info.finishedAt = Date.now()

const blocking = Object.entries(results).flatMap(([stage, r]) => (r.status === 'fail' ? r.problems.filter((p) => !p.known).map((p) => ({ stage, ...p })) : []))
const verdict = blocking.length ? `Not ready: ${blocking.length} problem${blocking.length === 1 ? '' : 's'} to fix` : Object.values(results).some((r) => r.status === 'warn') ? 'Ready, with things worth a look' : 'Ready'
writeFileSync(join(outDir, 'results.json'), JSON.stringify({ info, verdict, results }, null, 2))
writeFileSync(join(outDir, 'report.md'), markdownReport())
writeFileSync(join(outDir, 'report.html'), htmlReport())
// The view leaves its own summary (stages, failures, verdict) in the terminal as it closes.
view?.stop()
say(`\n${verdict}  (${fmt(info.finishedAt - info.startedAt)})\n`)
say(`Report: ${join(outDir, 'report.html')}\n`)
process.exit(blocking.length ? 1 : 0)

function markdownReport() {
  const lines = [`# Release check: Eaon ${info.version} at ${info.commit}`, '', `**${verdict}**`, '', '| Stage | Result | Time |', '| --- | --- | --- |']
  for (const [stage, r] of Object.entries(results)) lines.push(`| ${stage} | ${{ pass: '✓', fail: '✗', warn: '!', skip: '–' }[r.status]} ${r.summary} | ${fmt(r.ms)} |`)
  if (blocking.length) {
    lines.push('', '## To fix', '')
    for (const p of blocking) lines.push(`- **${p.stage}**: ${p.title}${p.detail ? ` (${p.detail.replace(/\s+/g, ' ').slice(0, 200)})` : ''}`)
  }
  return `${lines.join('\n')}\n`
}

function htmlReport() {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const badge = (status) => `<span class="badge badge--${status}">${{ pass: 'Pass', fail: 'Fail', warn: 'Look', skip: 'Skipped' }[status]}</span>`
  const stageRows = Object.entries(results)
    .map(([stage, r]) => `<tr><td>${esc(stage)}</td><td>${badge(r.status)}</td><td>${esc(r.summary)}</td><td class="num">${fmt(r.ms)}</td></tr>`)
    .join('')
  const problemList = (problems) =>
    `<ul class="problems">${problems.map((p) => `<li${p.known ? ' class="known"' : ''}><strong>${esc(p.title)}</strong>${p.known ? ` <em>known: ${esc(p.known)}</em>` : ''}${p.detail ? `<pre>${esc(p.detail)}</pre>` : ''}</li>`).join('')}</ul>`
  const stageDetails = Object.entries(results)
    .filter(([, r]) => r.problems.length)
    .map(([stage, r]) => `<details${r.status === 'fail' ? ' open' : ''}><summary>${esc(stage)}: ${r.problems.length} item${r.problems.length === 1 ? '' : 's'}</summary>${problemList(r.problems)}</details>`)
    .join('')

  const sweep = results.sweep?.data
  let gallery = ''
  let kinds = ''
  if (sweep?.views) {
    const counts = new Map()
    for (const v of sweep.views)
      for (const i of v.issues ?? []) {
        const k = `${i.severity}|${i.kind}`
        const e = counts.get(k) ?? { severity: i.severity, kind: i.kind, n: 0, examples: [] }
        e.n += 1
        if (e.examples.length < 6) e.examples.push(`${v.combo} · ${v.area} › ${v.label}: ${i.message}${i.where ? ` (${i.where})` : ''}`)
        counts.set(k, e)
      }
    const order = { error: 0, warn: 1, info: 2 }
    kinds = [...counts.values()]
      .sort((a, b) => order[a.severity] - order[b.severity] || b.n - a.n)
      .map((e) => `<details><summary>${badge(e.severity === 'error' ? 'fail' : e.severity === 'warn' ? 'warn' : 'skip')} ${esc(e.kind)} × ${e.n}</summary><ul class="problems">${e.examples.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>`)
      .join('')
    const flows = sweep.flows.map((f) => `<li>${f.ok ? '✓' : '✗'} <strong>${esc(f.name)}</strong> ${esc(f.detail)}${f.screenshot ? ` <a href="sweep/${esc(f.screenshot)}">screenshot</a>` : ''}</li>`).join('')
    const combos = [...new Set(sweep.views.map((v) => v.combo))]
    gallery =
      `<h2>Flows</h2><ul class="flows">${flows}</ul><h2>Every screen</h2>` +
      combos
        .map(
          (combo) =>
            `<h3>${esc(combo)}</h3><div class="grid">${sweep.views
              .filter((v) => v.combo === combo)
              .map((v) => {
                const shown = (v.issues ?? []).filter((i) => i.severity !== 'info')
                const worst = shown.some((i) => i.severity === 'error') ? 'fail' : shown.length ? 'warn' : 'pass'
                return `<figure class="card card--${worst}">${v.screenshot ? `<a href="sweep/${esc(v.screenshot)}"><img loading="lazy" src="sweep/${esc(v.screenshot)}" alt=""></a>` : '<div class="noshot">No screenshot</div>'}<figcaption><strong>${esc(v.area)} › ${esc(v.label)}</strong>${shown.length ? `<ul>${shown
                  .slice(0, 6)
                  .map((i) => `<li class="sev-${i.severity}">${esc(i.message)}</li>`)
                  .join('')}${shown.length > 6 ? `<li>and ${shown.length - 6} more</li>` : ''}</ul>` : ''}</figcaption></figure>`
              })
              .join('')}</div>`
        )
        .join('')
  }

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Release check ${esc(info.version)}</title><style>
:root{--bg:#fff;--fg:#1a1c1f;--muted:#5d6470;--line:#e3e5e8;--card:#f6f7f8;--pass:#1f7a3f;--fail:#b42318;--warn:#9a6700;--skip:#5d6470}
@media (prefers-color-scheme:dark){:root{--bg:#121314;--fg:#ececec;--muted:#a0a6ae;--line:#2a2c2f;--card:#1b1c1e;--pass:#4ac26b;--fail:#ff7b72;--warn:#d29922;--skip:#8b949e}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,system-ui,sans-serif}main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 8px}h3{font-size:15px;margin:20px 0 8px;color:var(--muted)}.meta{color:var(--muted)}
.verdict{font-size:18px;font-weight:600;margin:16px 0;padding:12px 16px;border-radius:10px;background:var(--card);border-left:4px solid var(--${blocking.length ? 'fail' : 'pass'})}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}.num{text-align:right;white-space:nowrap;color:var(--muted)}
.badge{display:inline-block;font-size:12px;font-weight:600;padding:1px 8px;border-radius:99px;border:1px solid currentColor}.badge--pass{color:var(--pass)}.badge--fail{color:var(--fail)}.badge--warn{color:var(--warn)}.badge--skip{color:var(--skip)}
details{margin:8px 0;padding:8px 12px;background:var(--card);border-radius:8px}summary{cursor:pointer;font-weight:600}
.problems{margin:8px 0;padding-left:20px}.problems li{margin:6px 0}.problems pre{white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--muted);margin:4px 0}.known{opacity:.7}
.flows{padding-left:20px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.card{margin:0;background:var(--card);border-radius:10px;overflow:hidden;border:1px solid var(--line);border-top:3px solid var(--pass)}.card--warn{border-top-color:var(--warn)}.card--fail{border-top-color:var(--fail)}
.card img{display:block;width:100%;height:auto;aspect-ratio:1280/820;object-fit:cover;object-position:top}.noshot{padding:40px;text-align:center;color:var(--muted)}
figcaption{padding:8px 10px;font-size:12.5px}figcaption ul{margin:4px 0 0;padding-left:16px}.sev-error{color:var(--fail)}.sev-warn{color:var(--warn)}
</style></head><body><main>
<h1>Release check: Eaon ${esc(info.version)}</h1>
<div class="meta">${esc(info.commit)} on ${esc(info.branch)}: ${esc(info.subject)}${info.dirty ? ` · ${info.dirty} uncommitted changes` : ''} · ${new Date(info.startedAt).toLocaleString()} · ${fmt((info.finishedAt ?? Date.now()) - info.startedAt)}${info.hidden ? ' · app ran hidden' : ''}</div>
<div class="verdict">${esc(verdict)}</div>
<table><thead><tr><th>Stage</th><th>Result</th><th>What it found</th><th class="num">Time</th></tr></thead><tbody>${stageRows}</tbody></table>
${stageDetails ? `<h2>Details</h2>${stageDetails}` : ''}
${kinds ? `<h2>UI findings by kind</h2>${kinds}` : ''}
${gallery}
<p class="meta">Logs: <a href="logs/">logs/</a> · Raw results: <a href="results.json">results.json</a></p>
</main></body></html>`
}
