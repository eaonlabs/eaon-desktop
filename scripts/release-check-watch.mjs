#!/usr/bin/env node
/**
 * A release check's progress in the terminal: every stage with whether it
 * passed, failed or is running, what the running one checks and what it
 * finished last, live counts, the failures so far, and each test or screen
 * as it lands.
 *
 *   npm run check:release:watch            the newest run (waits for one to begin)
 *   npm run check:release:watch -- <dir>   a particular run
 *
 * In a terminal it redraws in place; q or Ctrl+C closes the view and the
 * check keeps running. Piped (into a file, in CI) it prints each stage and
 * each result once, as plain lines, and ends when the run does.
 * `npm run check:release` shows the same view itself when run in a terminal.
 */
import { pathToFileURL } from 'node:url'
import { newestRun, readRun } from './release-check-state.mjs'

const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
const green = paint('32')
const red = paint('31')
const yellow = paint('33')
const cyan = paint('36')
const dim = paint('2')
const bold = paint('1')
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

const fmt = (ms) => (ms == null ? '' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`)
const ICON = { pass: green('✓'), fail: red('✗'), warn: yellow('!'), skip: dim('–'), pending: dim('○') }
const TAG = { pass: green('PASS '), fail: red('FAIL '), warn: yellow('LOOK '), skip: dim('SKIP ') }

/** One line of [text, paint] parts, cut to the terminal's width. */
function row(width, ...parts) {
  let left = Math.max(10, width - 1)
  let out = ''
  for (const [text, style = (s) => s] of parts) {
    if (left <= 0) break
    const s = String(text)
    const cut = s.length > left ? `${s.slice(0, Math.max(0, left - 1))}…` : s
    out += style(cut)
    left -= cut.length
  }
  return out
}

function countsText(c, known = 0) {
  const parts = [`${c.pass} passed`, `${c.fail} failed${known ? ` (${known} known)` : ''}`]
  if (c.warn) parts.push(`${c.warn} to look at`)
  if (c.skip) parts.push(`${c.skip} skipped`)
  return parts.join(' · ')
}

/** The whole view, as lines for a screen `width` by `height`. */
export function screen(state, width, height) {
  const lines = []
  const i = state.info
  const failed = state.stages.filter((s) => s.status === 'fail').length
  const elapsed = fmt((state.done && i.finishedAt ? i.finishedAt : Date.now()) - (i.startedAt ?? Date.now()))
  lines.push(row(width, [' Release check  ', bold], [`Eaon ${i.version ?? ''} · ${i.commit ?? ''} on ${i.branch ?? ''}${i.hidden ? ' · app hidden' : ''} · ${elapsed}`, dim]))
  const overall = state.done ? (state.verdict.startsWith('Not ready') ? red(` ✗ ${state.verdict}`) : green(` ✓ ${state.verdict}`)) : failed ? red(` RUNNING · ${failed} stage${failed === 1 ? '' : 's'} failed so far`) : cyan(' RUNNING')
  lines.push(color ? bold(overall) : overall, '')

  const spin = SPIN[Math.floor(Date.now() / 100) % SPIN.length]
  for (const s of state.stages) {
    const icon = s.status === 'running' ? cyan(spin) : ICON[s.status]
    const time = s.status === 'pending' ? '' : fmt(s.ms)
    const known = s.failures?.filter((f) => f.known).length ?? 0
    const text = s.status === 'pending' ? 'waiting' : s.status === 'running' && s.counts ? countsText(s.counts) : s.status === 'running' ? 'running…' : s.summary
    const style = s.status === 'pending' ? dim : s.status === 'fail' ? red : s.status === 'running' ? cyan : (x) => x
    lines.push(`${row(width, [' '], [`${icon} `], [s.name.padEnd(17), s.status === 'pending' ? dim : bold], [time.padStart(7), dim], ['  '], [s.counts && s.status !== 'running' && s.counts.fail ? `${text}${known && !/known/.test(text) ? ` (${known} known)` : ''}` : text, style])}`)
    if (s.status === 'running') {
      lines.push(row(width, ['      '], [s.what, dim]))
      if (s.now) lines.push(row(width, ['      '], [s.now, cyan]))
      if (state.shot) lines.push(row(width, ['      '], [`the hidden app's last screenshot: ${state.shot.name}`, dim]))
    }
    // A failed stage with no test list of its own says what failed under it.
    if (s.status === 'fail' && !s.counts) for (const p of s.problems.filter((p) => !p.known).slice(0, 3)) lines.push(row(width, ['      '], [p.title, red]))
  }

  const failures = state.stages.flatMap((s) => (s.failures ?? []).map((f) => ({ ...f, stage: s.name })))
  if (failures.length) {
    lines.push('', row(width, [` FAILURES (${failures.length})`, bold]))
    for (const f of failures.slice(-6)) lines.push(row(width, ['   '], [f.known ? yellow('KNOWN ') : red('FAIL  ')], [`${f.stage} › ${f.name}`], [f.known ? `  ${f.known}` : '', dim]))
  }

  const current = state.stages.find((s) => s.id === state.running && s.items) ?? [...state.stages].reverse().find((s) => s.items?.length)
  if (current) {
    lines.push('', row(width, [` LIVE · ${current.name}`, bold], [`  ${current.items.length} done`, dim]))
    const room = Math.max(3, height - lines.length - 2)
    for (const item of current.items.slice(-room).reverse()) {
      lines.push(row(width, ['   '], [TAG[item.status]], [item.name], [item.note || item.ms ? `  ${[item.note, item.ms ? fmt(item.ms) : ''].filter(Boolean).join(' · ')}` : '', dim]))
    }
  }
  while (lines.length < height - 1) lines.push('')
  lines.length = Math.min(lines.length, height - 1)
  lines.push(row(width, [state.done ? ` Done. Report: ${state.report ?? state.dir}` : ' q closes this view; the check keeps running', dim]))
  return lines
}

/** What stays in the terminal once the view closes on a finished run. */
function summary(state) {
  const lines = ['', bold(` Release check: Eaon ${state.info.version ?? ''} at ${state.info.commit ?? ''}`), '']
  for (const s of state.stages) lines.push(`   ${ICON[s.status] ?? ICON.pending} ${s.name.padEnd(17)} ${dim(fmt(s.ms).padStart(7))}  ${s.summary || (s.status === 'pending' ? dim('not run') : '')}`)
  const failures = state.stages.flatMap((s) => (s.failures ?? []).map((f) => ({ ...f, stage: s.name })))
  if (failures.length) {
    lines.push('', bold(' Failures'))
    for (const f of failures) lines.push(`   ${f.known ? yellow('KNOWN') : red('FAIL ')} ${f.stage} › ${f.name}${f.known ? dim(`  ${f.known}`) : ''}`)
  }
  lines.push('', state.verdict ? (state.verdict.startsWith('Not ready') ? red(bold(` ${state.verdict}`)) : green(bold(` ${state.verdict}`))) : yellow(' The run did not finish'))
  if (state.report) lines.push(dim(` Report: ${state.report}`))
  return `${lines.join('\n')}\n`
}

/**
 * Shows a run's progress until it ends (or `stop()`), then leaves the
 * summary in the terminal. `dir` may be a function, for a view started
 * before the run's folder exists.
 * @param {string | (() => string | null)} dir
 * @param {{ embedded?: boolean }} options  embedded: drawn by the check itself, which owns Ctrl+C and the exit
 */
export function watch(dir, { embedded = false } = {}) {
  const dirOf = typeof dir === 'function' ? dir : () => dir
  let timer = null
  let last = null
  let closed = false
  const out = process.stdout

  if (!out.isTTY) {
    // Piped: each stage and each result once, as lines.
    const printed = new Map()
    const seen = new Map()
    const tick = () => {
      const d = dirOf()
      if (!d) return
      const state = (last = readRun(d))
      for (const s of state.stages) {
        if (seen.get(s.id) !== s.status && s.status !== 'pending') {
          seen.set(s.id, s.status)
          out.write(s.status === 'running' ? `▸ ${s.name}: ${s.what}\n` : `${{ pass: '✓', fail: '✗', warn: '!', skip: '–' }[s.status]} ${s.name}: ${s.summary} (${fmt(s.ms)})\n`)
        }
        const from = printed.get(s.id) ?? 0
        for (const item of (s.items ?? []).slice(from)) out.write(`  ${{ pass: 'PASS', fail: 'FAIL', warn: 'LOOK', skip: 'SKIP' }[item.status]} ${s.name} › ${item.name}${item.note ? ` (${item.note})` : ''}\n`)
        printed.set(s.id, s.items?.length ?? 0)
      }
      if (state.done && !embedded) {
        stop()
        out.write(`\n${state.verdict}\n${state.report ? `Report: ${state.report}\n` : ''}`)
      }
    }
    timer = setInterval(tick, 2000)
    tick()
    return { stop, last: () => last }
  }

  // A terminal: its own screen, redrawn in place, put back as it was on the way out.
  out.write('\x1b[?1049h\x1b[?25l')
  const draw = () => {
    const d = dirOf()
    const width = out.columns || 100
    const height = out.rows || 40
    if (!d) {
      out.write(`\x1b[H\x1b[2J${row(width, [' Waiting for a release check to begin (npm run check:release)…', dim])}`)
      return
    }
    const state = (last = readRun(d))
    out.write(`\x1b[H${screen(state, width, height).map((l) => `${l}\x1b[K`).join('\n')}\x1b[J`)
    if (state.done && !embedded) stop()
  }
  timer = setInterval(draw, 250)
  out.on('resize', draw)
  draw()

  if (!embedded && process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', (key) => {
      if (key[0] === 0x71 || key[0] === 0x03) stop()
    })
  }

  function stop() {
    if (closed) return
    closed = true
    clearInterval(timer)
    if (out.isTTY) {
      out.off('resize', draw)
      out.write('\x1b[?25h\x1b[?1049l')
      if (!embedded && process.stdin.isTTY) {
        process.stdin.setRawMode(false)
        process.stdin.pause()
      }
      const d = dirOf()
      const state = d ? readRun(d) : null
      if (state?.done || (state && embedded)) out.write(summary(state))
      else if (state) out.write(`${dim(' Closed the view. The check keeps running; watch it again with npm run check:release:watch')}\n`)
    }
    if (!embedded) process.exit(0)
  }
  // However this ends, the terminal gets its cursor and screen back.
  process.once('exit', () => {
    if (!closed && out.isTTY) out.write('\x1b[?25h\x1b[?1049l')
  })
  return { stop, last: () => last }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const given = process.argv.slice(2).find((a) => !a.startsWith('--'))
  watch(given ?? newestRun)
}
