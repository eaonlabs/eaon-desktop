/**
 * Where a release check is, read from what scripts/release-check.mjs writes
 * as it goes: results.json after each stage, and each stage's log, which
 * grows line by line while the stage runs. The terminal view
 * (release-check-watch.mjs) draws this; reading never changes the run, so
 * a view can start, stop and start again at any point of a run, or after it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

export const root = resolve(import.meta.dirname, '..')
export const runsDir = join(root, 'out', 'release-check')

/** What each stage checks, in the order the check runs them, and the logs it writes. */
export const STAGES = [
  { id: 'typecheck', name: 'Type check', what: 'The web, main-process and CLI TypeScript projects compile with no errors', logs: ['typecheck'] },
  { id: 'build', name: 'Build', what: 'The app (renderer, main, VM helper, host) and the eaon CLI build', logs: ['build-app', 'build-cli'] },
  { id: 'index', name: 'Settings index', what: 'Settings search knows every page and every row', logs: ['settings-index'] },
  { id: 'unit', name: 'Unit tests', what: 'Every main-process test: providers, agents, tools, storage, security, the CLI', logs: ['unit'], feed: 'tests' },
  { id: 'e2e', name: 'End-to-end', what: 'The built app, hidden, used like a person would against a fake model: chat, ADE, Workers, Settings, onboarding, windows', logs: ['e2e'], feed: 'tests' },
  { id: 'sweep', name: 'UI sweep', what: 'Every screen, tab and menu in dark, light, the smallest window and See-through, checked for UI problems', logs: ['sweep'], feed: 'sweep' },
  { id: 'catalogs', name: 'Catalogs', what: 'The plugin catalog against vendors’ servers, the model library against Hugging Face', logs: ['verify-plugins', 'verify-models'] },
  { id: 'ci', name: 'GitHub checks', what: 'What GitHub’s own builds and tests said about this commit', logs: [] },
  { id: 'audit', name: 'Dependency audit', what: 'Known vulnerabilities in what the app ships', logs: ['audit'] }
]

const read = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** The newest run's folder, or null before the first. */
export function newestRun() {
  const all = existsSync(runsDir) ? readdirSync(runsDir).filter((d) => statSync(join(runsDir, d)).isDirectory()).sort() : []
  return all.length ? join(runsDir, all.at(-1)) : null
}

/** Test results from node --test's spec output, as they arrive. Suites (▶ … then ✔ …) are not counted as tests. */
export function testFeed(log) {
  const items = []
  const suites = new Set()
  for (const line of log.split('\n')) {
    if (/^ℹ tests \d+/.test(line) || /^✖ failing tests:/.test(line)) break
    const suite = /^(\s*)▶ (.+)$/.exec(line)
    if (suite) {
      suites.add(`${suite[1].length}|${suite[2].trim()}`)
      continue
    }
    const m = /^(\s*)(✔|✖|﹣) (.+?) \(([\d.]+)(m?s)\)(?: # (.*))?$/.exec(line)
    if (!m || suites.has(`${m[1].length}|${m[3].trim()}`)) continue
    const todo = /^TODO/i.test(m[6] ?? '')
    items.push({
      status: m[2] === '✔' ? (todo ? 'warn' : 'pass') : m[2] === '✖' ? (todo ? 'warn' : 'fail') : 'skip',
      name: m[3].trim(),
      ms: Math.round(m[5] === 's' ? Number(m[4]) * 1000 : Number(m[4])),
      note: m[6] ?? ''
    })
  }
  // The spec reporter names a test once it has finished, so the one running can't be named: what finished last.
  const last = items.at(-1)
  return { items, now: last ? `last finished: ${last.name}` : 'starting' }
}

/** The sweep's own lines: ✓ / ! / ✗ per screen and per flow, and which look it is in. */
export function sweepFeed(log) {
  const items = []
  let look = ''
  let now = 'starting'
  for (const line of log.split('\n')) {
    const header = /^(dark|light|dark-small|see-through-dark|see-through-light) \((\d+×\d+)\)$/.exec(line.trim())
    if (header) {
      look = `${header[1]} ${header[2]}`
      continue
    }
    if (line.trim() === 'Flows') look = 'flows'
    const m = /^\s+(✓|!|✗) (.+?)(?:\s{2}\((\d+) errors?, (\d+) warnings?\))?$/.exec(line)
    if (m) {
      const [name, ...rest] = m[2].split(': ')
      items.push({ status: m[1] === '✓' ? 'pass' : m[1] === '!' ? 'warn' : 'fail', name: `${look ? `${look} · ` : ''}${name}`, note: m[3] !== undefined ? `${m[3]} errors, ${m[4]} warnings` : rest.join(': ') })
      now = `last looked at: ${look ? `${look} · ` : ''}${name}`
    } else if (/^(Isolated|Main process|The sweep stopped)/.test(line.trim())) now = line.trim()
  }
  return { items, now }
}

/** The newest screenshot under a folder: its name, and how long ago it was taken. */
function newestShot(dir) {
  if (!existsSync(dir)) return null
  let best = null
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.png')) continue
    const t = statSync(join(dir, f)).mtimeMs
    if (!best || t > best.t) best = { t, name: f.replace(/\.png$/, '').replace(/-/g, ' ') }
  }
  return best
}

/** Everything about a run, as of now. */
export function readRun(dir) {
  let saved = {}
  try {
    saved = JSON.parse(read(join(dir, 'results.json')) || '{}')
  } catch {
    /* being written this moment */
  }
  const results = saved.results ?? {}
  const done = Boolean(saved.verdict)
  const short = (text) => (typeof text === 'string' ? text.split(`${root}${sep}`).join('') : text)
  let running = null
  const stages = STAGES.map((s, index) => {
    const r = results[s.id]
    const logs = s.logs.map((name) => join(dir, 'logs', `${name}.log`)).filter(existsSync)
    const started = logs.length ? Math.min(...logs.map((p) => statSync(p).birthtimeMs)) : null
    let status = r ? r.status : 'pending'
    // The first stage with no result, once everything before it has one, is the one running.
    if (!r && !done && !running && STAGES.slice(0, index).every((p) => results[p.id]) && (logs.length || s.id === 'ci')) {
      status = 'running'
      running = s.id
    }
    const stage = {
      id: s.id,
      name: s.name,
      what: s.what,
      status,
      summary: r?.summary ?? '',
      ms: r?.ms ?? (status === 'running' && started ? Date.now() - started : null),
      problems: (r?.problems ?? []).map((p) => ({ ...p, title: short(p.title), detail: short(p.detail) }))
    }
    if (s.feed) {
      const feed = (s.feed === 'sweep' ? sweepFeed : testFeed)(read(join(dir, 'logs', `${s.logs[0]}.log`)))
      stage.counts = { pass: 0, fail: 0, warn: 0, skip: 0 }
      for (const item of feed.items) stage.counts[item.status] += 1
      stage.items = feed.items
      stage.now = status === 'running' ? feed.now : ''
      // A failure the check knows is this computer's, not the app's, says so.
      stage.failures = feed.items.filter((i) => i.status === 'fail').map((i) => ({ ...i, known: stage.problems.find((p) => p.title === i.name && p.known)?.known ?? null }))
    }
    return stage
  })
  const shot = running === 'sweep' ? newestShot(join(dir, 'sweep', 'screens')) : running === 'e2e' ? newestShot(join(dir, 'e2e', 'screens')) : null
  return { dir, run: dir.split(sep).at(-1), info: saved.info ?? {}, verdict: saved.verdict ?? null, done, running, stages, shot, report: done && existsSync(join(dir, 'report.html')) ? join(dir, 'report.html') : null }
}
