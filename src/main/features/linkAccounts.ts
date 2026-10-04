import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DetectedApp, DetectedAppId } from '@shared/linkAccounts'
import { onPath } from '../shellEnv'
import type { Feature } from './types'

/**
 * Which AI apps are installed, so Settings → Link accounts can put their
 * providers first. Presence only: an app bundle on disk or a program on
 * PATH. Nothing inside another app (its data, sessions, cookies or keychain
 * items) is ever read. Channel: `link-accounts:detect`.
 */

interface Probe {
  id: DetectedAppId
  name: string
  /** App bundle names (macOS) or install folders under %LOCALAPPDATA% (Windows). */
  mac?: string[]
  windows?: string[]
  /** Programs on PATH. */
  bins?: string[]
}

const PROBES: Probe[] = [
  { id: 'chatgpt', name: 'ChatGPT', mac: ['ChatGPT.app'], windows: ['Programs\\ChatGPT'] },
  { id: 'codex', name: 'Codex', mac: ['Codex.app'], bins: ['codex'] },
  { id: 'claude', name: 'Claude', mac: ['Claude.app'], windows: ['AnthropicClaude'] },
  { id: 'claude-code', name: 'Claude Code', bins: ['claude'] },
  { id: 'grok', name: 'Grok', mac: ['Grok.app'] },
  { id: 'perplexity', name: 'Perplexity', mac: ['Perplexity.app'] },
  { id: 'gemini-cli', name: 'Gemini CLI', bins: ['gemini'] },
  { id: 'ollama', name: 'Ollama', mac: ['Ollama.app'], windows: ['Programs\\Ollama'], bins: ['ollama'] },
  { id: 'lm-studio', name: 'LM Studio', mac: ['LM Studio.app'], windows: ['Programs\\LM Studio'], bins: ['lms'] }
]

export function detectApps(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
  which: (bin: string) => string | null = onPath,
  home: string = homedir()
): DetectedApp[] {
  const local = process.env['LOCALAPPDATA'] || join(home, 'AppData', 'Local')
  return PROBES.map((probe) => {
    const bundles =
      platform === 'darwin'
        ? (probe.mac ?? []).flatMap((app) => [join('/Applications', app), join(home, 'Applications', app)])
        : platform === 'win32'
          ? (probe.windows ?? []).map((dir) => join(local, dir))
          : []
    const installed = bundles.some((path) => exists(path)) || (probe.bins ?? []).some((bin) => Boolean(which(bin)))
    return { id: probe.id, name: probe.name, installed }
  })
}

export const linkAccountsFeature: Feature = {
  id: 'link-accounts',
  register: ({ ipcMain }) => {
    ipcMain.handle('link-accounts:detect', () => detectApps())
  }
}
