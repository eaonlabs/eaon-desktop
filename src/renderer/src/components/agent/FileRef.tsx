import { createContext, useContext, type JSX, type ReactNode } from 'react'
import { FileIcon } from './FileIcon'
// The reading of a path moved to shared, where the terminals read paths the same way.
export { parseFileRef } from '@shared/fileRef'

/**
 * A file path in a reply (`src/app.ts:42`, `[the config](vite.config.ts)`)
 * as a link that opens the file at that line. Only where a provider says
 * what opening means — the chat's code panel; elsewhere (a worker's page, a
 * settings note) it stays the code span it was.
 */

export interface FileLinkHandler {
  /** ⌘-click (Ctrl on Windows and Linux) asks for the outside editor. */
  open: (path: string, line: number | null, external: boolean) => void
}

export const FileLinks = createContext<FileLinkHandler | null>(null)

/** A code span (or a link's label) that opens a file. */
export function FileRef({ text, path, line, children, asCode = true }: { text: string; path: string; line: number | null; children?: ReactNode; asCode?: boolean }): JSX.Element {
  const links = useContext(FileLinks)
  const label = children ?? text
  if (!links) return asCode ? <code className="md__code">{label}</code> : <span>{label}</span>
  // As code, a chip: the file's mark and its name (the whole path is the tooltip).
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
  return (
    <a
      href="#"
      className={asCode ? 'md__code md__file' : 'md__file md__file--text'}
      title={`Open ${path}${line ? ` at line ${line}` : ''} (⌘-click for your editor)`}
      onClick={(event) => {
        event.preventDefault()
        links.open(path, line, event.metaKey || event.ctrlKey)
      }}
    >
      {asCode ? (
        <>
          <span className="md__file-icon" aria-hidden>
            <FileIcon file={name} size={12} />
          </span>
          {name}
          {line ? `:${line}` : ''}
        </>
      ) : (
        label
      )}
    </a>
  )
}
