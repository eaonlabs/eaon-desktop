/**
 * One change an edit or write call made to a file: what was there and what
 * replaced it (a write's `before` is empty). The turn's "Edited N files"
 * card (chatCode/EditedFiles.tsx) and the composer's Changes pill read these.
 */
export interface FileChange {
  file: string
  before: string
  after: string
}
