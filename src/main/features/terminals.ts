import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { Feature } from './types'
import { PtyManager, type RestorePlan } from './terminals/ptyManager'
import { AGENT_KINDS, setAgentScript, setExtraAgentBin } from './terminals/agentSessions'
import { PaneRecords, restoredScreen } from './terminals/paneRecords'
import { cwdsOf, SessionWatch } from './terminals/sessionWatch'
import { onPath } from '../shellEnv'
import { secrets } from '../secrets'
import { store } from '../store'
import { buildChildEnv } from './eaonCode/env'
import { findInstallerCopy } from './eaonCode/locate'
import { eaonCliBinary, eaonCliEnv } from './eaonCli'
import { cliAccountEnv } from './cliAccounts'
import { currentPane, privacyBlockedMessage, type TerminalAgent, type TerminalAgentId, type TerminalLayout, type TerminalSpawnRequest } from '@shared/terminals'

/**
 * The ADE's terminal view: real shells in the project folder, each optionally
 * running a CLI coding agent. See `terminals/ptyManager.ts` for why the shells
 * live here rather than in the renderer.
 */

const LAYOUT_FILE = 'ade-terminals.json'

const AGENTS: { id: TerminalAgentId; label: string; bin: string | null; installHint?: string }[] = [
  { id: 'eaon-code', label: 'Eaon Code', bin: 'eaon-code', installHint: 'Settings → Eaon Code' },
  // Ships inside the app; a source checkout builds it with scripts/build-eaon-cli.sh.
  { id: 'eaon-cli', label: 'Eaon CLI', bin: 'eaon-cli', installHint: 'npm run build:eaon-cli' },
  { id: 'claude', label: 'Claude Code', bin: 'claude', installHint: 'npm install -g @anthropic-ai/claude-code' },
  { id: 'codex', label: 'Codex', bin: 'codex', installHint: 'npm install -g @openai/codex' },
  {
    id: 'antigravity',
    label: 'Antigravity',
    bin: 'agy',
    installHint:
      process.platform === 'win32'
        ? 'irm https://antigravity.google/cli/install.ps1 | iex'
        : 'curl -fsSL https://antigravity.google/cli/install.sh | bash'
  },
  { id: 'opencode', label: 'OpenCode', bin: 'opencode', installHint: 'npm install -g opencode-ai' },
  { id: 'shell', label: 'Shell', bin: null }
]

/** A path typed into a shell: quoted when it needs to be. */
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * How an Eaon Code pane starts it: the path pinned in Settings, else the
 * installer's copy, else `eaon-code` off PATH (the same order as Settings →
 * Eaon Code). The installer's copy runs as `node …/cli.js`, not through the
 * `eaon-code` wrapper it writes: the wrapper fetches and rebuilds on start,
 * and the panes a launch restores would all rebuild one folder at once.
 */
function eaonCodeCommand(pinned: string | null): string | null {
  if (pinned) return /\.[cm]?js$/i.test(pinned) ? `node ${shellQuote(pinned)}` : shellQuote(pinned)
  const copy = findInstallerCopy()
  if (copy) return `node ${shellQuote(copy.cli)}`
  return onPath('eaon-code') ? 'eaon-code' : null
}

function agents(): TerminalAgent[] {
  const eaonBinary = store.getSettings().eaonCode.binaryPath
  const copy = eaonBinary ? null : findInstallerCopy()
  // Eaon Code run from a pinned binary shows up under that binary's name, and
  // the installer's copy under its script's whole path (`cli` alone could be anything).
  setExtraAgentBin(eaonBinary || null, 'eaon-code')
  setAgentScript(copy?.cli ?? (eaonBinary && /\.[cm]?js$/i.test(eaonBinary) ? eaonBinary : null), 'eaon-code')
  // Eaon CLI runs from inside the app, wherever the app is — spaces and all.
  const eaonCli = eaonCliBinary()
  setAgentScript(eaonCli, 'eaon-cli')
  return AGENTS.map(({ id, label, bin, installHint }) => {
    if (!bin) return { id, label, command: null, installed: true }
    if (id === 'eaon-code') {
      const command = eaonCodeCommand(eaonBinary || null)
      return { id, label, command: command ?? bin, installed: Boolean(command), ...(installHint ? { installHint } : {}) }
    }
    if (id === 'eaon-cli') {
      return { id, label, command: eaonCli ? shellQuote(eaonCli) : bin, installed: Boolean(eaonCli), ...(installHint ? { installHint } : {}) }
    }
    return {
      id,
      label,
      command: bin,
      installed: Boolean(onPath(bin)),
      ...(installHint ? { installHint } : {})
    }
  })
}

/**
 * Extra environment for a pane's agent. An Eaon Code pane gets the API keys
 * saved in Eaon (as the provider variables Eaon Code reads) when Settings →
 * Eaon Code shares them; a key already exported in the shell still wins. An
 * Eaon CLI pane gets where Eaon serves the downloaded models, starting the
 * server if it is off; without it, Eaon CLI says what is wrong itself.
 */
async function agentEnv(agent: TerminalAgentId | undefined): Promise<Record<string, string>> {
  // Every pane runs `claude` and `codex` as the accounts chosen in Settings → Accounts.
  return { ...cliAccountEnv(), ...(await toolEnv(agent)) }
}

async function toolEnv(agent: TerminalAgentId | undefined): Promise<Record<string, string>> {
  if (agent === 'eaon-cli') return eaonCliEnv().catch(() => ({}))
  if (agent !== 'eaon-code' || !store.getSettings().eaonCode.shareKeys) return {}
  const { env, shared } = buildChildEnv({}, true, (providerId) => secrets.get(providerId))
  const extra: Record<string, string> = {}
  for (const name of shared) {
    const value = env[name]
    if (value && !process.env[name]) extra[name] = value
  }
  return extra
}

/** A saved grid with each pane's agent made current (a Gemini CLI pane from before comes back as a shell). */
function currentLayout(layout: TerminalLayout): TerminalLayout {
  return Object.fromEntries(
    Object.entries(layout ?? {}).map(([cwd, panes]) => [cwd, (panes ?? []).map(currentPane)])
  )
}

/** Every pane id in the saved grid, across folders. */
function layoutPaneIds(layout: TerminalLayout): Set<string> {
  return new Set(Object.values(layout ?? {}).flatMap((panes) => (panes ?? []).map((pane) => pane.id)))
}

function isDir(dir: string | undefined): dir is string {
  try {
    return Boolean(dir) && fs.statSync(dir as string).isDirectory()
  } catch {
    return false
  }
}

/**
 * A pane opened on a past conversation starts its agent on that
 * conversation (`claude --resume <id>`, `codex resume <id>`). The id goes into
 * a shell command line, so only an id shaped like the agent's own is used.
 */
export function resumeLine(req: TerminalSpawnRequest): TerminalSpawnRequest {
  const agent = req.agent
  if (!req.resume || !req.command || !agent || agent === 'shell') return req
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(req.resume) && !/^ses_[A-Za-z0-9]+$/.test(req.resume)) return req
  return { ...req, command: AGENT_KINDS[agent].resume(req.command, req.resume) }
}

/**
 * Whether macOS's privacy settings (Files and Folders) keep this app out of
 * `cwd`. Denied, listing it fails with EPERM — not EACCES, which is ordinary
 * file permissions — while the folder can still be stat'ed, so it looks fine
 * until anything inside it is read.
 */
async function blockedByPrivacy(cwd: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  try {
    await fs.promises.readdir(cwd)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface TerminalsOptions {
  /** Where pane records and saved screens live (default: userData/terminals). */
  dir?: string
  /** Which agents are installed and how each is launched (default: read off PATH). */
  agents?: () => TerminalAgent[]
  /** How long a pane counts as still starting after its command is typed. */
  settleMs?: number
}

/**
 * The ADE's terminals: shells for the grid, and bringing them back after a
 * quit. The watch notes what each pane is running (and which conversation),
 * the records keep that with each pane's last screen, and a pane's first
 * spawn in a run becomes its restore.
 *
 * A factory so a test can run it twice — once to quit, once to come back.
 */
export function createTerminals(options: TerminalsOptions = {}): Feature & { tick: () => Promise<void> } {
  const manager = new PtyManager(options.settleMs)
  const listAgents = options.agents ?? agents
  let records: PaneRecords | null = null
  let watch: SessionWatch | null = null
  /** Panes that have had their restore this run; a later Restart starts them as asked. */
  const restored = new Set<string>()

  const paneRecords = (): PaneRecords => {
    if (!records) records = new PaneRecords(options.dir ?? path.join(app.getPath('userData'), 'terminals'))
    return records
  }

  /**
   * How a pane comes back from the last run, or null when there is nothing
   * to bring back. The record of what was running wins over what the pane was
   * opened as: most agents are started by typing their name into a shell, and
   * the pane's own spec never learns that.
   */
  const planRestore = async (req: TerminalSpawnRequest): Promise<{ plan: RestorePlan; agent: TerminalAgentId } | null> => {
    const rec = paneRecords().get(req.paneId)
    const saved = paneRecords().takeScrollback(req.paneId)
    if (!rec && !saved) return null
    const screen = saved ? restoredScreen(saved.text, saved.at) : null
    const installed = listAgents()
    const commandOf = (id: TerminalAgentId): string | null => installed.find((a) => a.id === id && a.installed)?.command ?? null

    if (rec) {
      const cwd = isDir(rec.cwd) ? rec.cwd : req.cwd
      if (rec.agent === 'shell') return { agent: 'shell', plan: { cwd, command: rec.program ?? null, screen } }
      const command = commandOf(rec.agent)
      // The agent was uninstalled (or can't be found) since: the pane comes
      // back as its shell, and says why rather than leaving the user to wonder.
      if (!command) {
        const missing = installed.find((a) => a.id === rec.agent)
        const note = `\x1b[2m── ${missing?.label ?? rec.agent} isn't on this computer any more, so this pane opened as a plain shell.${missing?.installHint ? ` To get it back: ${missing.installHint}` : ''} ──\x1b[0m\r\n`
        return { agent: 'shell', plan: { cwd, command: null, screen: `${screen ?? ''}${note}` } }
      }
      const kind = AGENT_KINDS[rec.agent]
      if (rec.sessionId && (await kind.resumable(cwd, rec.sessionId).catch(() => false))) {
        // The agent draws its own conversation again; the old screen would only repeat it.
        return { agent: rec.agent, plan: { cwd, command: kind.resume(command, rec.sessionId), screen: null } }
      }
      return { agent: rec.agent, plan: { cwd, command, screen } }
    }

    const agent = req.agent ?? 'shell'
    const command = agent === 'shell' ? null : commandOf(agent)
    // Where there is a watch, no record means the pane never got going
    // (closed within seconds of opening): it starts as it was opened.
    if (!command || agent === 'shell' || SessionWatch.supported()) return { agent, plan: { cwd: req.cwd, command: req.command, screen } }
    /*
     * Windows, where there is no process table to watch. The pane comes back
     * as what it was opened as, carrying on the folder's latest conversation
     * when it is the only pane of its agent there — with two, which one was
     * whose cannot be told, and both would open the same one.
     */
    const siblings = (store.getJson<TerminalLayout>(LAYOUT_FILE, {})[req.cwd] ?? []).filter((pane) => pane.agent === agent)
    const line = siblings.length === 1 ? AGENT_KINDS[agent].continueLatest(command) : command
    return { agent, plan: { cwd: req.cwd, command: line, screen } }
  }

  /** Puts down what each live pane was doing, for its next launch. Before the shells are killed. */
  const rememberPanes = async (): Promise<void> => {
    // One last look — an agent quit in the last few seconds is not still running.
    if (watch) await Promise.race([watch.tick(), new Promise((resolve) => setTimeout(resolve, 1000))])
    watch?.stop()
    const live = manager.pids()
    const recs = paneRecords()
    if (live.size > 0 && SessionWatch.supported()) {
      // The folder each shell is in, so a pane that had cd'd elsewhere comes back there.
      const cwds = await cwdsOf([...live.values()], 1000).catch(() => new Map<number, string>())
      for (const [paneId, pid] of live) {
        const rec = recs.get(paneId)
        // A pane still starting what it was given keeps the record it started from.
        if (manager.settling(paneId) && rec) continue
        if (!rec || rec.agent === 'shell') recs.set(paneId, { agent: 'shell', ...(rec?.program ? { program: rec.program } : {}), cwd: cwds.get(pid) ?? rec?.cwd })
      }
    }
    for (const paneId of live.keys()) recs.saveScrollback(paneId, manager.historyOf(paneId))
    recs.flush()
  }

  return {
    id: 'terminals',
    tick: () => watch?.tick() ?? Promise.resolve(),
    register: ({ ipcMain, send }) => {
      manager.setSender(send)
      // Closed panes leave nothing behind for a launch that will never ask.
      paneRecords().prune(layoutPaneIds(store.getJson<TerminalLayout>(LAYOUT_FILE, {})))
      watch = new SessionWatch(
        () => manager.pids(),
        (paneId) => manager.settling(paneId),
        paneRecords(),
        (paneId, agent) => send('terminal:agent', { paneId, agent })
      )
      watch.start()

      ipcMain.handle('terminal:agents', () => listAgents())
      ipcMain.handle('terminal:spawn', async (_e, req: TerminalSpawnRequest) => {
        // A folder macOS keeps Eaon out of: say so, instead of a shell whose every command fails.
        if (!manager.has(req.paneId) && (await blockedByPrivacy(req.cwd))) {
          return { ok: false, privacy: true, error: privacyBlockedMessage(req.cwd, app.getPath('home')) }
        }
        // A pane with a live shell reattaches to it; only a pane's first
        // start in a run is its restore.
        if (!manager.has(req.paneId) && !restored.has(req.paneId)) {
          restored.add(req.paneId)
          const restore = await planRestore(req).catch(() => null)
          if (restore) {
            const result = manager.spawn(req, await agentEnv(restore.agent), restore.plan)
            if (result.ok && restore.agent !== (req.agent ?? 'shell')) send('terminal:agent', { paneId: req.paneId, agent: restore.agent })
            watch?.expect(req.paneId, restore.agent)
            return result
          }
        }
        restored.add(req.paneId)
        return manager.spawn(resumeLine(req), await agentEnv(req.agent))
      })
      ipcMain.handle('terminal:running', () => watch?.snapshot() ?? {})
      // The conversation each pane is in, as far as the watch has seen: the ADE's
      // sidebar lists a folder's past conversations without the ones open in a pane.
      ipcMain.handle('terminal:conversations', (_e, paneIds: unknown) =>
        Object.fromEntries(
          (Array.isArray(paneIds) ? paneIds : [])
            .filter((id): id is string => typeof id === 'string')
            .slice(0, 200)
            .map((id) => [id, paneRecords().get(id)?.sessionId ?? null])
        )
      )
      ipcMain.handle('terminal:layout', () => currentLayout(store.getJson<TerminalLayout>(LAYOUT_FILE, {})))
      ipcMain.handle('terminal:save-layout', (_e, layout: TerminalLayout) => {
        store.setJson(LAYOUT_FILE, layout)
        paneRecords().prune(layoutPaneIds(layout))
      })
      // Keystrokes and resizes are fire-and-forget: a round trip per key would
      // put IPC latency between the user and every character they type.
      ipcMain.on('terminal:write', (_e, paneId: string, data: string) => manager.write(paneId, data))
      ipcMain.on('terminal:resize', (_e, paneId: string, cols: number, rows: number) => manager.resize(paneId, cols, rows))
      ipcMain.on('terminal:kill', (_e, paneId: string) => manager.kill(paneId))
    },
    shutdown: async () => {
      await rememberPanes().catch(() => undefined)
      await manager.shutdown()
    }
  }
}

export const terminalsFeature = createTerminals()
