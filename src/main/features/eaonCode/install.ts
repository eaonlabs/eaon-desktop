import { spawn } from 'node:child_process'
import { EAON_CODE_PACKAGE } from '@shared/eaonCode'
import { checkNode, findOnPath, NODE_REQUIREMENT } from './locate'

export const INSTALL_ARGS = ['install', '-g', '--ignore-scripts', EAON_CODE_PACKAGE]

/**
 * Turns npm's failure output into the one thing the user can do about it.
 * npm's own message leads with a stack of `npm error` lines whose useful part
 * is usually the code, so match on the code first.
 */
export function explainInstallFailure(output: string, code: number | null): string {
  if (/EACCES|permission denied/i.test(output)) {
    return 'npm could not write to its global folder (permission denied). Point npm at a folder you own (`npm config set prefix ~/.npm-global`) or install Node with a version manager such as nvm, then try again.'
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|network/i.test(output)) {
    return 'npm could not reach the package registry. Check your internet connection or proxy settings and try again.'
  }
  if (/EBADENGINE|Unsupported engine/i.test(output)) {
    return `Eaon Code needs Node ${NODE_REQUIREMENT}. Install a newer Node and try again.`
  }
  if (/E404|404 Not Found/i.test(output)) {
    return `npm could not find ${EAON_CODE_PACKAGE} on the registry it is configured to use.`
  }
  const last = output
    .trim()
    .split('\n')
    .filter((line) => line.trim())
    .slice(-3)
    .join(' ')
  return `npm exited with code ${code ?? 'unknown'}${last ? `: ${last}` : '.'}`
}

/**
 * `npm install -g --ignore-scripts @eaonlabs/eaon-code`, the install command
 * from Eaon Code's README. `--ignore-scripts` is theirs, not ours: the package
 * needs no lifecycle scripts, and skipping them keeps a one-click install from
 * running arbitrary dependency code.
 */
export async function installEaonCode(
  onLog: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ ok: boolean; message: string }> {
  const node = await checkNode()
  if (!node.path) {
    return { ok: false, message: `Node.js was not found on your PATH. Install Node ${NODE_REQUIREMENT} from nodejs.org, then try again.` }
  }
  if (!node.ok) {
    return {
      ok: false,
      message: `Eaon Code needs Node ${NODE_REQUIREMENT}, but your PATH has Node ${node.version ?? '(unknown)'} at ${node.path}. Install a newer Node (for example \`nvm install 22\`), then try again.`
    }
  }
  const npm = findOnPath('npm')
  if (!npm) {
    return { ok: false, message: 'npm was not found on your PATH. It ships with Node.js — reinstall Node from nodejs.org, then try again.' }
  }

  onLog(`$ npm ${INSTALL_ARGS.join(' ')}`)
  return new Promise((resolve) => {
    let output = ''
    const child = spawn(npm, INSTALL_ARGS, {
      env,
      shell: process.platform === 'win32',
      windowsHide: true
    })
    const collect = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      output = (output + text).slice(-20_000)
      for (const line of text.split('\n')) if (line.trim()) onLog(line)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (error) => resolve({ ok: false, message: `Could not run npm: ${error.message}` }))
    child.on('close', (code) =>
      resolve(code === 0 ? { ok: true, message: 'Eaon Code is installed.' } : { ok: false, message: explainInstallFailure(output, code) })
    )
  })
}
