import { useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { MCP_CATALOG, type McpCatalogEntry } from '@shared/mcpCatalog'
import type { McpServer, McpServerStatus } from '@shared/types'
import type { SkillInfo } from '@shared/skills'
import { useApp } from '../../state/store'

/** Live MCP server statuses, kept current by the main process's `mcp:status` events. */
export function useMcpStatuses(): McpServerStatus[] {
  const [statuses, setStatuses] = useState<McpServerStatus[]>([])
  useEffect(() => {
    let live = true
    void window.api.mcp.statuses().then((s) => live && setStatuses(s))
    const off = window.api.mcp.onStatus(setStatuses)
    return () => {
      live = false
      off()
    }
  }, [])
  return statuses
}

/**
 * Connecting or disconnecting a plugin rewrites mcp.json in the main process;
 * this pulls the new rows into the store so every surface (the composer tray,
 * Settings → MCP Servers) sees the change without a reload.
 */
export async function refreshServers(): Promise<void> {
  useApp.setState({ mcpServers: await window.api.mcp.get() })
}

export interface ConnectedPlugin {
  entry: McpCatalogEntry
  server: McpServer
}

/** Catalog plugins that have a server row, in catalog order. */
export function useConnectedPlugins(): ConnectedPlugin[] {
  const servers = useApp(useShallow((s) => s.mcpServers))
  return useMemo(() => {
    const byPlugin = new Map(servers.filter((s) => s.pluginId).map((s) => [s.pluginId!, s]))
    return MCP_CATALOG.filter((entry) => byPlugin.has(entry.id)).map((entry) => ({ entry, server: byPlugin.get(entry.id)! }))
  }, [servers])
}

export const pluginServerId = (pluginId: string): string => `plugin-${pluginId}`

/** Skills visible from the Work folder, re-read whenever `version` changes. */
export function useSkills(version = 0): { skills: SkillInfo[]; loaded: boolean; reload: () => void } {
  const cwd = useApp((s) => s.workspaces.find((w) => w.kind === 'work')?.cwd ?? null)
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    void window.api.pluginAuth.skills.list(cwd).then((list) => {
      if (!live) return
      setSkills(list)
      setLoaded(true)
    })
    return () => {
      live = false
    }
  }, [cwd, version, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { skills, loaded, reload }
}
