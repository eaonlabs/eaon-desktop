import { useEffect, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { ChevronLeft, ChevronRight, ExternalLink, FolderOpen, X } from 'lucide-react'
import { fileUrl } from '../../lib/files'
import { notify } from '../Notice'
import { errorText } from '../../lib/errors'

/**
 * Pictures from a conversation, full size over the app, rather than handed
 * to whatever the system opens images with. ← and → step through the
 * conversation's pictures, Esc closes, and the file is a click away in its
 * own app or its folder.
 */

const useViewer = create<{ paths: string[]; index: number }>(() => ({ paths: [], index: 0 }))

/** Opens the viewer on `path`, with `paths` (the conversation's pictures) to step through. */
export function viewImage(path: string, paths: string[] = [path]): void {
  const index = Math.max(0, paths.indexOf(path))
  useViewer.setState({ paths: paths.length ? paths : [path], index })
}

const close = (): void => useViewer.setState({ paths: [], index: 0 })

export function ImageViewer(): JSX.Element | null {
  const { paths, index } = useViewer()
  const [zoomed, setZoomed] = useState(false)
  const open = paths.length > 0
  const path = paths[index]

  useEffect(() => setZoomed(false), [path])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
      } else if (event.key === 'ArrowLeft' && index > 0) useViewer.setState({ index: index - 1 })
      else if (event.key === 'ArrowRight' && index < paths.length - 1) useViewer.setState({ index: index + 1 })
    }
    // Capture: the conversation's own Escape (an approval's Deny) must not see this one.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, index, paths.length])

  if (!open || !path) return null
  const name = path.split(/[\\/]/).pop() ?? path
  const openFile = (): void => void window.api.library.open(path).catch((error: unknown) => notify(`Couldn't open it: ${errorText(error)}`, 'error'))

  return createPortal(
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label={name} onClick={close}>
      <div className="image-viewer__bar" onClick={(e) => e.stopPropagation()}>
        <span className="image-viewer__name" title={path}>
          {name}
          {paths.length > 1 && <span className="image-viewer__count">{`${index + 1} of ${paths.length}`}</span>}
        </span>
        <button type="button" className="image-viewer__btn" onClick={openFile} aria-label="Open in its app" title="Open in its app">
          <ExternalLink size={15} strokeWidth={1.9} />
        </button>
        <button type="button" className="image-viewer__btn" onClick={() => void window.api.app.showItem(path)} aria-label="Show in folder" title="Show in folder">
          <FolderOpen size={15} strokeWidth={1.9} />
        </button>
        <button type="button" className="image-viewer__btn" onClick={close} aria-label="Close" title="Close (Esc)" autoFocus>
          <X size={16} strokeWidth={2} />
        </button>
      </div>
      {index > 0 && (
        <button
          type="button"
          className="image-viewer__step image-viewer__step--prev"
          onClick={(e) => {
            e.stopPropagation()
            useViewer.setState({ index: index - 1 })
          }}
          aria-label="Previous picture"
        >
          <ChevronLeft size={20} strokeWidth={2} />
        </button>
      )}
      <img
        key={path}
        className="image-viewer__img"
        data-zoomed={zoomed || undefined}
        src={fileUrl(path)}
        alt={name}
        onClick={(e) => {
          e.stopPropagation()
          setZoomed(!zoomed)
        }}
      />
      {index < paths.length - 1 && (
        <button
          type="button"
          className="image-viewer__step image-viewer__step--next"
          onClick={(e) => {
            e.stopPropagation()
            useViewer.setState({ index: index + 1 })
          }}
          aria-label="Next picture"
        >
          <ChevronRight size={20} strokeWidth={2} />
        </button>
      )}
    </div>,
    document.body
  )
}
