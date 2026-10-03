import type { ReactNode } from 'react'
import { BookOpen, Globe, Laptop } from 'lucide-react'
import type { McpServer, McpServerStatus } from '@shared/types'
import type { SkillInfo } from '@shared/skills'
import { mcpCatalogEntry } from '@shared/mcpCatalog'
import { PluginLogo } from '../plugins/PluginLogo'
import type { SuggestItem } from './SuggestMenu'

/**
 * Rows the "/" and "@" menus share between Chat's composer and a worker's.
 * Each does what the same row in the + menu does; the menus are a faster way
 * in, not a second set of switches.
 */

/** A plugin pulled into a message with "@": what its chip needs. */
export interface Mention {
  id: string
  name: string
  pluginId?: string
}

/** Mentions whose "@Name" is still in the text, so deleting the word drops the chip too. */
export function liveMentions(mentions: Mention[], text: string): Mention[] {
  const lower = text.toLowerCase()
  return mentions.filter((m) => lower.includes(`@${m.name.toLowerCase()}`))
}

/**
 * Every configured plugin, the ones switched on first. Picking one switches
 * it on if it was off (the + menu's toggle; plugins are on or off
 * everywhere, not per chat) and mentions it by name in the message, so the
 * agent knows which one the user means.
 */
export function pluginItems(
  servers: McpServer[],
  statuses: McpServerStatus[],
  onPick: (server: McpServer) => void,
  section = 'Plugins'
): SuggestItem[] {
  return [...servers]
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || Number(Boolean(b.pluginId)) - Number(Boolean(a.pluginId)))
    .map((server) => {
      const entry = server.pluginId ? mcpCatalogEntry(server.pluginId) : undefined
      const state = statuses.find((s) => s.serverId === server.id)?.state
      return {
        id: `plugin:${server.id}`,
        title: server.name,
        keywords: `${server.pluginId ?? ''} ${server.id} plugin`,
        section,
        icon: <PluginLogo logo={entry?.logoAssetName} name={server.name} size={18} />,
        hint: !server.enabled ? 'Off · turns on' : state === 'needs-auth' ? 'Sign in' : state === 'error' ? 'Error' : undefined,
        insert: `@${server.name}`,
        run: () => onPick(server)
      }
    })
}

/** The browser and computer use, as things to mention. Computer use that is off opens its settings instead. */
export function toolMentionItems({
  computerOn,
  onBrowser,
  onComputerSettings,
  browserHint
}: {
  computerOn: boolean
  onBrowser?: () => void
  onComputerSettings: () => void
  browserHint?: string
}): SuggestItem[] {
  return [
    {
      id: 'tool:browser',
      title: 'Browser',
      keywords: 'web browse site page',
      section: 'Tools',
      icon: <Globe size={16} strokeWidth={1.8} />,
      hint: browserHint,
      insert: '@Browser',
      run: onBrowser
    },
    computerOn
      ? {
          id: 'tool:computer',
          title: 'Computer',
          keywords: 'computer use screen mouse keyboard',
          section: 'Tools',
          icon: <Laptop size={16} strokeWidth={1.8} />,
          insert: '@Computer'
        }
      : {
          id: 'tool:computer',
          title: 'Computer use',
          keywords: 'computer use screen mouse keyboard',
          section: 'Tools',
          icon: <Laptop size={16} strokeWidth={1.8} />,
          hint: 'Off · set up',
          run: onComputerSettings
        }
  ]
}

/**
 * Enabled skills as "/" commands. A skill is something the agent loads, not
 * a switch, so picking one writes the request into the message in plain
 * words: the user sees exactly what the agent is asked, and the agent's
 * skill guidance tells it to load the skill by that name.
 */
export function skillItems(skills: SkillInfo[], disabled: string[]): SuggestItem[] {
  const off = new Set(disabled)
  return skills
    .filter((skill) => !off.has(skill.name))
    .map((skill) => ({
      id: `skill:${skill.name}`,
      title: skill.name,
      keywords: 'skill',
      section: 'Skills',
      description: skill.description.length > 90 ? `${skill.description.slice(0, 87)}…` : skill.description || undefined,
      icon: <BookOpen size={16} strokeWidth={1.8} />,
      insert: `Use the ${skill.name} skill:`
    }))
}

/** Permission levels as commands; `levels` names them for the composer at hand (the app's, or a worker's own). */
export function permissionItems<L extends string>(
  levels: { id: L; title: string; keywords: string; icon: ReactNode }[],
  current: L | undefined,
  onPick: (level: L) => void
): SuggestItem[] {
  return levels.map((level) => ({
    id: `permission:${level.id}`,
    title: level.title,
    keywords: `permissions approval ${level.keywords}`,
    section: 'Permissions',
    icon: level.icon,
    checked: current === level.id,
    run: () => onPick(level.id)
  }))
}
