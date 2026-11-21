import { spawn } from 'node:child_process'
import path from 'node:path'
import type { ScriptRun } from '@shared/adeScripts'

/**
 * Running a project's teardown script (setup and run are typed into a
 * terminal the user watches; this one runs unseen, before a session is
 * archived, so its output is collected and its time is limited).
 */

/** How long a teardown may run. */
export const TEARDOWN_TIMEOUT_MS = 120_000
/** How much of the end of its output is kept. */
const OUTPUT_KEEP = 4000

/** What to run for `command` under `shell`: the shell's own way of taking a command, as a login shell where it takes one (the profile is where tools get on PATH). */
export function invocation(shell: string, command: string, platform: NodeJS.Platform = process.platform): { bin: string; args: string[] } {
  const name = path.basename(shell).toLowerCase().replace(/\.exe$/, '')
  if (platform === 'win32') {
    if (name === 'pwsh' || name === 'powershell') return { bin: shell, args: ['-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', command] }
    return { bin: shell, args: ['/d', '/s', '/c', command] }
  }
  return { bin: shell, args: [...(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh'].includes(name) ? ['-l'] : []), '-c', command] }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/** Runs `command` in `cwd`, waits for it, and says how it went. Never throws. */
export function runScript(cwd: string, command: string, shell: string, timeoutMs = TEARDOWN_TIMEOUT_MS): Promise<ScriptRun> {
  return new Promise((resolve) => {
    const { bin, args } = invocation(shell, command)
    let output = ''
    let timedOut = false
    let settled = false
    const done = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0 && !timedOut, command, code, timedOut, output: output.replace(ANSI, '').slice(-OUTPUT_KEEP) })
    }
    // Never waits for input that nobody is there to give.
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    const take = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-OUTPUT_KEEP * 2)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.once('error', (error) => {
      output += `${error.message}\n`
      done(null)
    })
    child.once('close', (code) => done(code))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      // A script that ignores that is ended for good a moment later.
      setTimeout(() => child.kill('SIGKILL'), 2000).unref()
    }, timeoutMs)
    timer.unref()
  })
}
