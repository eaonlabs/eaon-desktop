/** Small helpers for showing local files (attachments, Library) in the UI. */

const IMAGE = /\.(png|jpe?g|gif|webp|heic|avif)$/i
const VIDEO = /\.(mp4|m4v|mov|webm)$/i
const AUDIO = /\.(mp3|m4a|wav|aac|flac|ogg)$/i
const DOCUMENT = /\.(pdf|docx?|pages|rtf|txt|md|odt|key|pptx?|xlsx?|numbers|csv)$/i
const CODE = /\.(js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|json|ya?ml|toml|html|css|scss|sql)$/i
const ARCHIVE = /\.(zip|tar|gz|tgz|bz2|xz|7z|rar|dmg)$/i

export type FileKind = 'image' | 'video' | 'audio' | 'document' | 'code' | 'archive' | 'other'

export const isImagePath = (path: string): boolean => IMAGE.test(path)
export const isVideoPath = (path: string): boolean => VIDEO.test(path)

export function fileKind(path: string): FileKind {
  if (IMAGE.test(path)) return 'image'
  if (VIDEO.test(path)) return 'video'
  if (AUDIO.test(path)) return 'audio'
  if (DOCUMENT.test(path)) return 'document'
  if (CODE.test(path)) return 'code'
  if (ARCHIVE.test(path)) return 'archive'
  return 'other'
}

/**
 * The `eaon-file://` URL for a local image or video. encodeURI leaves # and ?
 * alone, which would cut the path short ("Shot #2.png" became a fragment), so
 * those are escaped too.
 */
export function fileUrl(path: string): string {
  // Windows paths become /C:/…, which the protocol handler turns back into C:/….
  const slashed = path.replace(/\\/g, '/')
  const rooted = slashed.startsWith('/') ? slashed : `/${slashed}`
  return `eaon-file://${encodeURI(rooted).replace(/[#?]/g, encodeURIComponent)}`
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** "Show in Finder" says Finder only on a Mac; Windows has File Explorer, Linux a file manager. */
export function revealLabel(platform: string = typeof window !== 'undefined' ? window.api?.platform ?? '' : ''): string {
  if (platform === 'darwin') return 'Show in Finder'
  if (platform === 'win32') return 'Show in File Explorer'
  return 'Show in folder'
}

/** Drag types an editor's file tree uses (VS Code and its forks): files as links, not as File objects. */
const EDITOR_DRAG_TYPES = ['resourceurls', 'codefiles', 'application/vnd.code.uri-list']

/** Whether a drag is files from an editor's tree, as far as can be told before the drop. */
export const editorDrag = (types: readonly string[]): boolean => types.some((t) => EDITOR_DRAG_TYPES.includes(t.toLowerCase()))

/** A `file://` URL as a path on this computer, or null for anything else. */
export function filePathOf(uri: string): string | null {
  let url: URL
  try {
    url = new URL(uri.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'file:') return null
  const path = decodeURIComponent(url.pathname)
  // Windows: file:///C:/x → C:/x.
  return /^\/[a-z]:\//i.test(path) ? path.slice(1) : path || null
}

/**
 * The local files a drop carries as links: an editor's resource list, or a
 * uri-list made only of file:// links. A web link, or text, gives none and
 * drops as text.
 */
export function droppedFilePaths(data: Pick<DataTransfer, 'getData' | 'types'>): string[] {
  const lists: string[] = []
  for (const type of ['resourceurls', 'application/vnd.code.uri-list']) {
    if (!data.types.includes(type)) continue
    const raw = data.getData(type)
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) lists.push(...parsed.filter((u): u is string => typeof u === 'string'))
      continue
    } catch {
      lists.push(...raw.split(/\r?\n/))
    }
  }
  if (lists.length === 0 && data.types.includes('text/uri-list')) {
    const uris = data
      .getData('text/uri-list')
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.startsWith('#'))
    // Only when every link is a file: a web link dragged in stays text.
    if (uris.length > 0 && uris.every((u) => u.trim().startsWith('file:'))) lists.push(...uris)
  }
  return [...new Set(lists.map(filePathOf).filter((p): p is string => Boolean(p)))]
}
