import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import type { AgentTool, AgentToolsState } from '@shared/agentProviders'
import { AGENT_GUIDES, AGENT_PACKAGES } from '@shared/agentProviders'
import { onPath } from '../shellEnv'
import { store } from '../store'
import type { Feature } from './types'
import { terminalAgentList } from './terminals'

/**
 * Settings → Agent providers: every coding CLI the ADE can run, whether it is
 * on this computer, which version, and — for the ones installed with npm —
 * whether a newer one is out, with a button that updates it the same way.
 * Channels are `agent-providers:*`.
 */

const FRESH_MS = 10 * 60_000
const VERSION_TIMEOUT_MS = 8_000
const UPDATE_TIMEOUT_MS = 4 * 60_000

let state: AgentToolsState = { tools: [], checking: false, at: 0, updating: null, error: null }
let running: Promise<AgentToolsState> | null = null
let notify: (state: AgentToolsState) => void = () => {}

const run = (file: string, args: string[], timeout: number): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(file, args, { timeout, windowsHide: true, env: process.env, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(Object.assign(error, { stderr: String(stderr) })) : resolve(`${stdout}\n${stderr}`)
    )
  )

/** "claude 2.1.304 (Claude Code)" → "2.1.304"; the first thing that looks like a version. */
function versionOf(text: string): string | null {
  return /\bv?(\d+\.\d+(?:\.\d+)?(?:[-.][0-9A-Za-z.]+)?)\b/.exec(text)?.[1]?.replace(/\.+$/, '') ?? null
}

async function versionFor(path: string): Promise<string | null> {
  try {
    return versionOf(await run(path, ['--version'], VERSION_TIMEOUT_MS))
  } catch {
    return null
  }
}

/** The newest version npm has of a package, or null when it can't be asked. */
async function latestOf(pkg: string): Promise<string | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return null
    const body = (await response.json()) as { version?: unknown }
    return typeof body.version === 'string' ? body.version : null
  } catch {
    return null
  }
}

/** Whether a version is older than another, part by part. */
export function older(current: string, latest: string): boolean {
  const parts = (v: string): number[] => v.split(/[.-]/).map((p) => Number.parseInt(p, 10)).map((n) => (Number.isFinite(n) ? n : 0))
  const a = parts(current)
  const b = parts(latest)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  }
  return false
}

async function readTools(): Promise<AgentTool[]> {
  const checks = store.getSettings().agentProviders?.updateChecks !== false
  const agents = terminalAgentList().filter((a) => a.id !== 'shell')
  return Promise.all(
    agents.map(async (agent): Promise<AgentTool> => {
      const bin = agent.bin
      const path = bin ? onPath(bin) : null
      const installed = agent.installed
      const pkg = AGENT_PACKAGES[agent.id] ?? null
      const version = path ? await versionFor(path) : null
      // Installed with npm (it lives in a node_modules folder): npm can update it.
      const real = path ? await realpath(path).catch(() => path) : null
      const npmInstalled = Boolean(real && /node_modules/.test(real))
      const latest = checks && pkg && npmInstalled ? await latestOf(pkg) : null
      return {
        id: agent.id,
        label: agent.label,
        bin,
        path,
        installed,
        version,
        latest,
        updatable: Boolean(pkg && npmInstalled && version && latest && older(version, latest)),
        installHint: agent.installHint ?? null,
        guide: AGENT_GUIDES[agent.id] ?? null,
        other: agent.other ?? false
      }
    })
  )
}

export function refreshAgentTools(force = false): Promise<AgentToolsState> {
  if (!force && state.at && Date.now() - state.at < FRESH_MS) return Promise.resolve(state)
  if (running) return running
  state = { ...state, checking: true }
  notify(state)
  running = readTools()
    .then((tools) => {
      state = { ...state, tools, checking: false, at: Date.now() }
      notify(state)
      return state
    })
    .finally(() => {
      running = null
    })
  return running
}

/** Updates an npm-installed CLI to its newest version with npm, the way it was installed. */
async function updateTool(id: string): Promise<AgentToolsState> {
  const tool = state.tools.find((t) => t.id === id)
  const pkg = AGENT_PACKAGES[id]
  if (!tool || !pkg || !tool.updatable) throw new Error('That tool can’t be updated from here.')
  const npm = onPath('npm')
  if (!npm) throw new Error('npm isn’t on this computer’s PATH.')
  state = { ...state, updating: id, error: null }
  notify(state)
  try {
    await run(npm, ['install', '-g', `${pkg}@latest`], UPDATE_TIMEOUT_MS)
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? '')
    const denied = /EACCES|permission denied/i.test(stderr)
    state = {
      ...state,
      updating: null,
      error: denied ? `npm needs permission to update ${tool.label}. Run \`npm install -g ${pkg}@latest\` in a terminal.` : `Couldn’t update ${tool.label}: ${(error as Error).message.split('\n')[0]}`
    }
    notify(state)
    return state
  }
  state = { ...state, updating: null }
  return refreshAgentTools(true)
}

export const agentProvidersFeature: Feature = {
  id: 'agent-providers',
  register: ({ ipcMain, send }) => {
    notify = (next) => send('agent-providers:changed', next)
    ipcMain.handle('agent-providers:state', () => refreshAgentTools(false))
    ipcMain.handle('agent-providers:refresh', () => refreshAgentTools(true))
    ipcMain.handle('agent-providers:update', (_e, id: unknown) => updateTool(String(id)))
  }
}
