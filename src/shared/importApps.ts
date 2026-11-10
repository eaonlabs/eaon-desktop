/**
 * Import from another app: bring the MCP servers a person already set up in
 * another app into Eaon, from the setup or from Settings → MCP Servers.
 *
 * Only the other app's list of MCP servers is read: the one file that holds
 * it, and nothing else in that file. Never a sign-in, a session, a cookie or
 * a keychain item (see shared/linkAccounts.ts for why). Values in a server's
 * environment (an API key someone put there) are copied by the importer in
 * the main process when a server is chosen, and never sent to the window.
 */

export type ImportAppId = 'claude-desktop' | 'cursor' | 'windsurf' | 'vscode' | 'gemini-cli'

/** One server found in another app's list, as the window shows it. */
export interface ImportableServer {
  /** Names this server for `apply`: `<app>:<name in that app>`. */
  key: string
  name: string
  transport: 'stdio' | 'http'
  /** What it runs or connects to, as a person would read it: `npx -y @scope/server` or the URL. */
  summary: string
  /** The names of its environment variables, so a chosen server's keys are known by name only. */
  envNames: string[]
  /** Eaon already has this server (the same command and arguments, or the same URL). */
  duplicate: boolean
}

export interface ImportableApp {
  id: ImportAppId
  name: string
  /** Its list was found and read; false when the app isn't set up for MCP on this computer. */
  found: boolean
  servers: ImportableServer[]
}

export interface ImportResult {
  /** Names of the servers added. */
  added: string[]
  /** Chosen servers left out: already in Eaon, or gone from the other app since. */
  skipped: number
}
