/** Settings → Browser control: Browser Use in the user's own browser (main/features/browserUse.ts). */
export interface BrowserControlStatus {
  enabled: boolean
  /** The browser chosen in Settings, or null for "whichever allows debugging". */
  browser: string | null
  /** Browser Use and its Python are set up. */
  installed: boolean
  version: string | null
  /** While setting up: the step it is on. */
  setupStep: string | null
  setupError: string | null
  /** Chromium browsers on this computer, and whether each allows remote debugging right now. */
  browsers: { id: string; name: string; debugging: boolean }[]
  /** Attached to a browser right now. */
  connected: boolean
}
