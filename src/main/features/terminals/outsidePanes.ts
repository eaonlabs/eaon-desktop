/**
 * Panes another feature opens outside the ADE's grid (the Trading tab's
 * Claude Code), with what their shell gets on top of a pane's usual
 * environment. They start as asked every time: never restored from a
 * record, since what they run is set up fresh for each launch. Its own
 * module, so a feature can prepare a pane without loading the terminals.
 */
const outsidePanes = new Map<string, Record<string, string>>()

export function prepareOutsidePane(paneId: string, env: Record<string, string> = {}): void {
  outsidePanes.set(paneId, env)
}

/** The extra environment of a pane opened outside the grid, or undefined for a grid pane. */
export function outsidePaneEnv(paneId: string): Record<string, string> | undefined {
  return outsidePanes.get(paneId)
}
