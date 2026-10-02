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
