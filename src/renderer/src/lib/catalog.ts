import { MCP_CATALOG } from '@shared/mcpCatalog'

/**
 * Static catalogue backing the plugin directory. Skills are not listed here:
 * they are discovered from SKILL.md folders on disk (see main/features/skills.ts).
 */

export interface PluginEntry {
  id: string
  name: string
  description: string
  /** `managed` entries are provisioned by a workspace admin, not installed by hand. */
  access: 'install' | 'managed'
  category: 'core' | 'featured' | 'productivity' | 'more'
}

/**
 * The plugin list every surface shows. Derived from the MCP catalog rather than
 * hand-maintained: this used to be six local document tools (Documents, PDF,
 * Spreadsheets, Presentations, Template Creator, Visualize) that were never
 * wired to anything, and keeping a second list beside the real catalog is how
 * the two drift apart.
 */
export const CORE_PLUGINS: PluginEntry[] = MCP_CATALOG.map((entry) => ({
  id: entry.id,
  name: entry.displayName,
  description: entry.summary,
  access: 'install',
  category: 'core'
}))
