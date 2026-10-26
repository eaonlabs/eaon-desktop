/**
 * One change an edit or write call made to a file: what was there and what
 * replaced it. The turn's "N changed files" card (chatCode/EditedFiles.tsx)
 * and the workspace card's Changes count read these.
 */
export interface FileChange {
  file: string
  /** An edit's old text; a write's whole file before it (empty when there was none, or it wasn't recorded). */
  before: string
  after: string
  /** A write: `before` and `after` are the whole file. */
  write?: boolean
  /** A write that made the file: nothing was there, or (an older chat's) nobody looked. */
  created?: boolean
  /** An edit that replaced every place its old text was. */
  replaceAll?: boolean
}
