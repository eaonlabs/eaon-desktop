import { ipcRenderer } from 'electron'
import type { CliAccountsState, CliTool } from '@shared/cliAccounts'

/**
 * Renderer bridge for Claude Code and Codex accounts and their plan usage
 * (main/features/cliAccounts). Exposed as `window.api.cliAccounts`.
 */
export const cliAccountsApi = {
  state: (): Promise<CliAccountsState> => ipcRenderer.invoke('cli-accounts:state'),
  /** Reads the figures again unless they are fresh: the active accounts, or with `all` every account of `tool`. */
  refresh: (options: { tool?: CliTool; all?: boolean; force?: boolean } = {}): Promise<CliAccountsState> =>
    ipcRenderer.invoke('cli-accounts:refresh', options),
  /** Which account Eaon's terminals run the CLI as, from the next pane on. */
  use: (tool: CliTool, id: string): Promise<CliAccountsState> => ipcRenderer.invoke('cli-accounts:use', tool, id),
  rename: (tool: CliTool, id: string, label: string): Promise<CliAccountsState> => ipcRenderer.invoke('cli-accounts:rename', tool, id, label),
  /** Signs the account out (by the CLI) and forgets it. */
  remove: (tool: CliTool, id: string): Promise<CliAccountsState> => ipcRenderer.invoke('cli-accounts:remove', tool, id),
  /** Starts the CLI's own sign-in for a new account; progress arrives in `login`. */
  add: (tool: CliTool): Promise<CliAccountsState> => ipcRenderer.invoke('cli-accounts:add', tool),
  /** Signs an extra account in again, by the CLI's own sign-in in its folder. */
  signIn: (tool: CliTool, id: string): Promise<CliAccountsState> => ipcRenderer.invoke('cli-accounts:sign-in', tool, id),
  loginInput: (text: string): Promise<void> => ipcRenderer.invoke('cli-accounts:login-input', text),
  cancelLogin: (): Promise<void> => ipcRenderer.invoke('cli-accounts:login-cancel'),
  dismissLogin: (): Promise<void> => ipcRenderer.invoke('cli-accounts:login-dismiss'),
  /** Opens the sign-in page the CLI printed. */
  openLoginUrl: (): Promise<void> => ipcRenderer.invoke('cli-accounts:open-url'),
  onChanged: (listener: (state: CliAccountsState) => void): (() => void) => {
    const handler = (_e: unknown, state: CliAccountsState): void => listener(state)
    ipcRenderer.on('cli-accounts:changed', handler)
    return () => ipcRenderer.removeListener('cli-accounts:changed', handler)
  }
}
