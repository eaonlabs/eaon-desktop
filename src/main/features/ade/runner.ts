import { execFile } from 'node:child_process'
import { remoteLocation } from '@shared/adeRemote'
import type { HostBook } from './hosts'
import { connectProblem, remoteCommandLine, remoteExec, type RemoteExecResult } from './ssh'

/**
 * Runs `git` or `gh` in a session's folder, wherever it is: here, or on the
 * session's SSH host (a `ssh://` folder). Never stops to ask for a password or
 * an editor, since there is no terminal to answer in.
 */

export interface RunResult {
  ok: boolean
  /** The exit code; null when it never ran (not installed, couldn't connect, timed out). */
  code: number | null
  stdout: string
  stderr: string
}

const QUIET_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' }

export function makeRunner(hosts: HostBook) {
  return async function run(cwd: string, cmd: string, args: string[], timeoutMs = 30_000): Promise<RunResult> {
    const remote = remoteLocation(cwd)
    if (remote) {
      const host = await hosts.find(remote.hostId)
      if (!host) return { ok: false, code: null, stdout: '', stderr: 'That SSH host isn’t in ~/.ssh/config or Eaon’s hosts any more.' }
      const env = Object.entries(QUIET_ENV).map(([k, v]) => `${k}=${v}`)
      const res: RemoteExecResult = await remoteExec(host, remoteCommandLine(remote.path, 'env', [...env, cmd, ...args]), { timeoutMs })
      // 255 is ssh's own failure; anything else is the command's.
      if (res.code === 255 || res.code === null) return { ...res, ok: false, stderr: connectProblem(host, res) }
      return res
    }
    return new Promise((resolve) => {
      execFile(
        cmd,
        args,
        { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...QUIET_ENV } },
        (error, stdout, stderr) => {
          const raw = (error as { code?: unknown } | null)?.code
          const code = error ? (typeof raw === 'number' ? raw : null) : 0
          const missing = raw === 'ENOENT'
          resolve({
            ok: !error,
            code,
            stdout: String(stdout ?? ''),
            stderr: missing ? `${cmd} isn’t installed on this computer.` : String(stderr || (error ? error.message : ''))
          })
        }
      )
    })
  }
}

export type Runner = ReturnType<typeof makeRunner>

/** The last thing a command said about why it failed, without git's "fatal:" prefix. */
export function problemOf(res: RunResult, fallback: string): string {
  const said = `${res.stderr}\n${res.stdout}`.trim().split('\n').map((l) => l.trim()).filter(Boolean)
  const line = said.find((l) => /^(fatal|error):/i.test(l)) ?? said.pop()
  return line ? line.replace(/^(fatal|error):\s*/i, '') : fallback
}
