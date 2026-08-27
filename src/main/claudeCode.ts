import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { store } from './store'
import { getLocalServerStatus } from './localServer'

/**
 * Points Claude Code at this app's local API server by writing the relevant
 * environment variables into ~/.claude/settings.json.
 *
 * That file belongs to the user, not to us, so every write merges into the
 * existing document and takes a .backup copy first. Reset removes only the keys
 * this app added and leaves everything else untouched.
 */

const CLAUDE_DIR = () => join(homedir(), '.claude')
const SETTINGS_PATH = () => join(CLAUDE_DIR(), 'settings.json')

/** Keys this integration owns — the only ones Reset is allowed to remove. */
const MANAGED_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL'
]

interface ClaudeSettings {
  env?: Record<string, string>
  [key: string]: unknown
}

function readSettings(): ClaudeSettings {
  try {
    const path = SETTINGS_PATH()
    if (!existsSync(path)) return {}
    return JSON.parse(readFileSync(path, 'utf8')) as ClaudeSettings
  } catch {
    // A malformed file is the user's; refuse to guess at its contents.
    throw new Error('~/.claude/settings.json is not valid JSON — fix or move it first.')
  }
}

function writeSettings(next: ClaudeSettings): void {
  const dir = CLAUDE_DIR()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = SETTINGS_PATH()
  if (existsSync(path)) copyFileSync(path, `${path}.backup`)
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
}

export function getClaudeCodeConfigPath(): string {
  return SETTINGS_PATH()
}

/** The env block this app would write, so the UI can preview it. */
export function buildClaudeCodeEnv(): Record<string, string> {
  const { claudeCode, localServer } = store.getSettings()
  const running = getLocalServerStatus()
  const port = running.port || localServer.port || 1337

  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    // The local server does not check credentials, but Claude Code requires a
    // non-empty token before it will send a request at all.
    ANTHROPIC_AUTH_TOKEN: 'eaon-local'
  }
  if (claudeCode.largeModelId) env.ANTHROPIC_MODEL = claudeCode.largeModelId
  if (claudeCode.smallModelId) env.ANTHROPIC_SMALL_FAST_MODEL = claudeCode.smallModelId
  for (const entry of claudeCode.env) {
    if (entry.key.trim()) env[entry.key.trim()] = entry.value
  }
  return env
}

export function applyClaudeCodeConfig(): { path: string; env: Record<string, string> } {
  const settings = readSettings()
  const env = buildClaudeCodeEnv()
  writeSettings({ ...settings, env: { ...(settings.env ?? {}), ...env } })
  store.patchSettings({ claudeCode: { ...store.getSettings().claudeCode, enabled: true } })
  return { path: SETTINGS_PATH(), env }
}

export function resetClaudeCodeConfig(): { path: string } {
  const settings = readSettings()
  const env = { ...(settings.env ?? {}) }
  const custom = store.getSettings().claudeCode.env.map((e) => e.key.trim()).filter(Boolean)
  for (const key of [...MANAGED_KEYS, ...custom]) delete env[key]

  const next: ClaudeSettings = { ...settings }
  if (Object.keys(env).length > 0) next.env = env
  else delete next.env

  writeSettings(next)
  store.patchSettings({ claudeCode: { ...store.getSettings().claudeCode, enabled: false } })
  return { path: SETTINGS_PATH() }
}
