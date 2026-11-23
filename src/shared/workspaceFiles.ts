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

/** Pictures the code panel shows instead of saying they aren't text. */
export const PREVIEW_IMAGES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon'
}
/** Pictures past this size are not previewed. */
export const PREVIEW_LIMIT = 25 * 1024 * 1024

/** The picture type a file's name says it is, if it is one the panel previews. */
export function previewType(path: string): string | undefined {
  const ext = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase()
  return ext ? PREVIEW_IMAGES[ext] : undefined
}

/** A picture to show, read in full. */
export interface WorkspaceImage {
  /** As a data: URL. */
  url: string
  size: number
}
