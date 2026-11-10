/**
 * Tells interested features that an agent run started in a project folder,
 * without the loop importing any of them. The MCP project files (a project's
 * own `.mcp.json`) use it to offer their servers for approval once.
 */

type Listener = (folder: string) => void
const listeners = new Set<Listener>()

export function onProjectRun(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function noteProjectRun(folder: string | null): void {
  if (!folder) return
  for (const listener of listeners) {
    try {
      listener(folder)
    } catch (error) {
      console.error('[project] listener failed:', error)
    }
  }
}
