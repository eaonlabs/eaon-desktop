import type { ChatMessage } from '@shared/types'

const isAbsolute = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')

/**
 * `path` against `root`, as the agent's tools resolve it: an absolute path
 * stands, a relative one sits under the folder. `./` and `../` are folded so
 * the result matches the paths the tree lists.
 */
export function joinPath(root: string, path: string): string {
  if (isAbsolute(path)) return path
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const parts = root.split(/[\\/]/)
  for (const part of path.split(/[\\/]/)) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join(sep)
}

/** Paths the agent wrote or edited across `messages`, in the order it first touched them. */
export function touchedFiles(messages: ChatMessage[]): string[] {
  const seen = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'tool' || part.status !== 'done') continue
      if (part.name !== 'edit_file' && part.name !== 'write_file') continue
      if (typeof part.input.path === 'string' && part.input.path) seen.add(part.input.path)
    }
  }
  return [...seen]
}
