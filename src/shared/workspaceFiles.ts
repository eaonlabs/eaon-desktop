/** One entry of a folder, as Chat's code panel lists it. */
export interface WorkspaceEntry {
  name: string
  /** Absolute path. */
  path: string
  directory: boolean
}

/** A file opened in the code panel. */
export type WorkspaceFile =
  | { kind: 'text'; path: string; text: string; modified: number }
  /** Not opened as text: a binary file, or one too large to edit here. */
  | { kind: 'binary' | 'too-large'; path: string; size: number; modified: number }

/** Files past this size open as "too large" rather than in the editor. */
export const EDITABLE_LIMIT = 2 * 1024 * 1024
