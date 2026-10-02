import { ipcRenderer } from 'electron'
import type { McpServerStatus } from '@shared/types'
import type { ManualClient, PluginSignInResult, SignInTarget } from '@shared/plugins'
import type { SkillDraft, SkillInfo } from '@shared/skills'

/**
 * Renderer bridge for plugins and skills. Exposed as `window.api.pluginAuth`.
 * Keep every channel this feature uses in this one file. Credentials never
 * cross this bridge in the main → renderer direction: the renderer learns
 * whether a plugin is connected, never its token.
 */
export const pluginsApi = {
  /** One-click connect for a catalog plugin that needs no credentials. */
  enable: (pluginId: string): Promise<McpServerStatus[]> => ipcRenderer.invoke('plugins:enable', pluginId),
  /** Pasted-token connect. An empty token disconnects. */
  connectToken: (pluginId: string, token: string): Promise<McpServerStatus[]> =>
    ipcRenderer.invoke('plugins:connect', pluginId, token),
  /** Browser sign-in; resolves when the browser comes back (or it fails). */
  signIn: (target: SignInTarget, client?: ManualClient): Promise<PluginSignInResult> =>
    ipcRenderer.invoke('plugins:sign-in', target, client),
  cancelSignIn: (target: SignInTarget): Promise<void> => ipcRenderer.invoke('plugins:cancel-sign-in', target),
  disconnect: (pluginId: string): Promise<McpServerStatus[]> => ipcRenderer.invoke('plugins:disconnect', pluginId),
  /** Signs a hand-added HTTP server out, keeping it configured. */
  signOutServer: (serverId: string): Promise<McpServerStatus[]> => ipcRenderer.invoke('plugins:sign-out-server', serverId),
  /** Ids of connected catalog plugins. */
  connected: (): Promise<string[]> => ipcRenderer.invoke('plugins:connected'),
  /** The client id typed for a plugin earlier (never its secret), to pre-fill the form. */
  clientId: (pluginId: string): Promise<string | null> => ipcRenderer.invoke('plugins:client-id', pluginId),

  skills: {
    /** Every skill visible from the Work folder `cwd`, enabled or not. */
    list: (cwd: string | null): Promise<SkillInfo[]> => ipcRenderer.invoke('skills:list', cwd),
    create: (draft: SkillDraft): Promise<SkillInfo> => ipcRenderer.invoke('skills:create', draft),
    installFromGithub: (url: string): Promise<SkillInfo> => ipcRenderer.invoke('skills:install', url),
    remove: (name: string): Promise<void> => ipcRenderer.invoke('skills:remove', name),
    openFolder: (): Promise<void> => ipcRenderer.invoke('skills:open-folder'),
    reveal: (path: string): Promise<void> => ipcRenderer.invoke('skills:reveal', path)
  }
}
