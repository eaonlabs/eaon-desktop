import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { ModManifest } from '@shared/mods'
import { quoteArg, type ShellKind } from '../terminals/shellQuote'

/**
 * Mods in the coding CLIs Eaon starts in ADE panes, with what each CLI takes
 * for one session, so nothing is written to the user's own ~/.claude or
 * ~/.codex:
 *
 * - Claude Code: `--plugin-dir <folder>` for each mod's Claude Code plugin.
 * - Codex: `-c developer_instructions=…` and `-c mcp_servers.<name>.…`.
 *
 * The flags go right after the binary, so the session watch, which knows the
 * agent by the line's first word, still does, and a resume or a first task
 * added later lands after them.
 */

const firstWord = (command: string): string => /^\S+/.exec(command)?.[0] ?? ''
const binaryOf = (command: string): string => basename(firstWord(command).replace(/^['"]|['"]$/g, '')).replace(/\.(exe|cmd)$/i, '')

/** Puts `flags` after the line's binary. */
const after = (command: string, flags: string[]): string => {
  if (!flags.length) return command
  const first = firstWord(command)
  return `${first} ${flags.join(' ')}${command.slice(first.length)}`
}

/** The user's Codex config, to leave alone what it sets itself: an override would replace it for the session. */
function codexConfig(codexHome: string | undefined): string {
  const file = join(codexHome || join(homedir(), '.codex'), 'config.toml')
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  } catch {
    return ''
  }
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A Codex `-c` value: TOML, which reads JSON strings and arrays of strings as they are. */
const toml = (value: string | string[]): string => JSON.stringify(value)

/**
 * The pane's line with the enabled mods' parts for its CLI. `dirOf` gives
 * each mod's installed folder. Lines for any other program come back as
 * they are.
 */
export function withMods(
  command: string,
  mods: ModManifest[],
  dirOf: (id: string) => string,
  kind: ShellKind,
  options: { codexHome?: string } = {}
): string {
  if (!command || mods.length === 0) return command
  const bin = binaryOf(command)
  if (bin === 'claude') {
    const flags = mods
      .filter((m) => m.contributes.claudePlugin)
      .map((m) => `--plugin-dir ${quoteArg(join(dirOf(m.id), ...m.contributes.claudePlugin!.split('/')), kind)}`)
    return after(command, flags)
  }
  if (bin === 'codex') {
    const flags: string[] = []
    const config = codexConfig(options.codexHome)
    const instructions = mods
      .filter((m) => m.contributes.codex?.instructions)
      .map((m) => `${m.contributes.codex!.instructions}`)
    if (instructions.length && !/^\s*developer_instructions\s*=/m.test(config)) {
      flags.push(`-c ${quoteArg(`developer_instructions=${toml(instructions.join('\n\n'))}`, kind)}`)
    }
    for (const mod of mods) {
      for (const [name, server] of Object.entries(mod.contributes.codex?.mcpServers ?? {})) {
        const key = `mcp_servers.${name}`
        if (new RegExp(`^\\s*\\[mcp_servers\\.${escape(name)}\\]`, 'm').test(config)) continue
        flags.push(`-c ${quoteArg(`${key}.command=${toml(server.command)}`, kind)}`)
        if (server.args?.length) flags.push(`-c ${quoteArg(`${key}.args=${toml(server.args)}`, kind)}`)
      }
    }
    return after(command, flags)
  }
  return command
}
