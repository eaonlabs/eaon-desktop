/**
 * An agent's own browser — the chat agent's, or a worker's — as the live view
 * sees it: frames as the page paints, the steps the agent takes, and the
 * user taking over. See main/features/agentBrowser.ts.
 */

/** Whose browser: `'agent'` (the chat agent) or `'worker:<id>'`. */
export type BrowserTarget = string

export const AGENT_BROWSER: BrowserTarget = 'agent'
export const workerBrowserTarget = (workerId: string): BrowserTarget => `worker:${workerId}`

/** One captured picture of the agent's browser, sent only when it changed. */
export interface AgentBrowserFrame {
  target: BrowserTarget
  url: string
  title: string
  /** A JPEG data URL. */
  image: string
  /** The page's own size in CSS pixels, for mapping a click on the picture back onto the page. */
  viewport: { width: number; height: number }
  at: number
}

/** A step the agent takes in its browser, as it starts and again as it ends. */
export interface AgentBrowserStep {
  target: BrowserTarget
  /** The chat the agent was working in, so only that chat's view reacts. */
  chatId: string
  action: string
  /** The page, or the element it acts on ('button "Sign in"'). */
  detail: string
  done: boolean
  at: number
}

export interface AgentBrowserStatus {
  target: BrowserTarget
  /** The browser has been used this session (it starts on the agent's first page). */
  open: boolean
  url: string
  title: string
  /** The user has taken over; the agent's next step waits until they hand it back. */
  controlled: boolean
}

/** What the user does to the page while they have control, forwarded as real input. */
export type BrowserInput =
  | { type: 'mouseDown' | 'mouseUp' | 'mouseMove'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clickCount?: number }
  | { type: 'mouseWheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; key: string; modifiers: ('shift' | 'control' | 'alt' | 'meta')[] }
  | { type: 'text'; text: string }
  | { type: 'edit'; command: 'paste' | 'copy' | 'cut' | 'selectAll' | 'undo' | 'redo' }
