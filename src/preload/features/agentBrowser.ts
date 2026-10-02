import { ipcRenderer } from 'electron'
import type { AgentBrowserFrame, AgentBrowserStatus, AgentBrowserStep, BrowserInput, BrowserTarget } from '@shared/agentBrowser'

/**
 * Renderer bridge for the chat agent's own browser and its live view.
 * Exposed as `window.api.agentBrowser`. Keep every channel this feature uses
 * in this file.
 */

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/**
 * `target` is whose browser: `'agent'` (the default) or `'worker:<id>'`.
 */
export const agentBrowserApi = {
  /** Frames flow only while at least one live view is watching. */
  watch: (on: boolean, target?: BrowserTarget): Promise<AgentBrowserStatus> => ipcRenderer.invoke('agent-browser:watch', on, target),
  status: (target?: BrowserTarget): Promise<AgentBrowserStatus> => ipcRenderer.invoke('agent-browser:status', target),
  /** Shows the real window; closing it hides it again. */
  show: (target?: BrowserTarget): Promise<boolean> => ipcRenderer.invoke('agent-browser:show', target),
  /** Take over (the agent's next step waits) or hand back. */
  control: (on: boolean, target?: BrowserTarget): Promise<AgentBrowserStatus> => ipcRenderer.invoke('agent-browser:control', on, target),
  /** The user's mouse or keyboard, onto the page; ignored unless they have control. */
  input: (event: BrowserInput, target?: BrowserTarget): Promise<boolean> => ipcRenderer.invoke('agent-browser:input', event, target),
  /** An address typed in the view while in control. */
  navigate: (url: string, target?: BrowserTarget): Promise<boolean> => ipcRenderer.invoke('agent-browser:navigate', url, target),
  onFrame: (handler: (frame: AgentBrowserFrame) => void): (() => void) => subscribe('agent-browser:frame', handler),
  onStep: (handler: (step: AgentBrowserStep) => void): (() => void) => subscribe('agent-browser:step', handler),
  /** Control taken or handed back, from any view. */
  onStatus: (handler: (status: AgentBrowserStatus) => void): (() => void) => subscribe('agent-browser:status', handler)
}
