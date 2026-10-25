import { join } from 'node:path'
import { app } from 'electron'
import { openTerminal, writeLaunchScript } from '../../features/connectApps/launch'
import { onPath } from '../../shellEnv'
import { ACP_AGENTS } from './agents'
import { AcpEngine } from './index'

/** GitHub Copilot CLI and Gemini CLI as engines, with Electron's side of what they need. */
export function acpEngines(): AcpEngine[] {
  return Object.values(ACP_AGENTS).map(
    (spec) =>
      new AcpEngine(spec, {
        which: onPath,
        env: () => process.env,
        probeDir: () => join(app.getPath('userData'), 'acp-check'),
        clientVersion: app.getVersion(),
        openTerminal: async (command, title) => {
          const script = writeLaunchScript(join(app.getPath('userData'), 'acp-login'), spec.id, { env: {}, command }, process.platform)
          const opened = await openTerminal(script, title)
          if (!opened.ok) throw new Error(`The terminal didn’t open: ${opened.error}. Run ${command} yourself.`)
        }
      })
  )
}
