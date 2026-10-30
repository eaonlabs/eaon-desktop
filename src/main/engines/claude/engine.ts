import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { app } from 'electron'
import { openTerminal, writeLaunchScript } from '../../features/connectApps/launch'
import { cliToolEnv } from '../../features/cliAccounts/current'
import { spawnSpec } from '../../features/eaonCode/locate'
import { onPath } from '../../shellEnv'
import { ClaudeEngine } from './index'

/** Claude as an engine, with Electron's side of what it needs. */
export function claudeEngine(): ClaudeEngine {
  return new ClaudeEngine({
    which: onPath,
    // The Claude account chosen in Settings → Accounts, as the ADE's Claude Code panes run. An Eaon
    // started from inside a Claude Code session (a developer's terminal) doesn't pass that session on.
    env: () => {
      const env: Record<string, string | undefined> = { ...process.env, ...cliToolEnv('claude') }
      for (const name of Object.keys(env)) if (name === 'CLAUDECODE' || name === 'CLAUDE_CODE_ENTRYPOINT' || name === 'CLAUDE_CODE_SSE_PORT') delete env[name]
      return env
    },
    run: (command, args, env) => {
      const spec = spawnSpec(command, args)
      return new Promise((resolve) => {
        execFile(spec.command, spec.args, { env, shell: spec.shell, timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) =>
          resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        )
      })
    },
    probeDir: () => join(app.getPath('userData'), 'claude-check'),
    clientVersion: app.getVersion(),
    openTerminal: async (command, title) => {
      const script = writeLaunchScript(join(app.getPath('userData'), 'claude-login'), 'claude', { env: cliToolEnv('claude'), command }, process.platform)
      const opened = await openTerminal(script, title)
      if (!opened.ok) throw new Error(`The terminal didn’t open: ${opened.error}. Run claude auth login yourself.`)
    }
  })
}
