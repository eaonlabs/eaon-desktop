import { ArrowRight, PanelLeft, SquarePen } from 'lucide-react'
import { useApp } from '../state/store'
import { DownloadsButton } from './DownloadsPanel'

/**
 * The window-controls cluster shown at the top-left of every screen once the
 * sidebar is hidden. Rendered inline as the first child of the existing
 * draggable header row for that screen — never as a second, separately
 * positioned drag region, which is what silently ate clicks before: Electron
 * computes draggable regions by aggregating every element that declares
 * `-webkit-app-region`, and two overlapping rows disagreeing about the same
 * screen pixels produces unreliable hit-testing.
 */
export function CollapsedNav(): JSX.Element {
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const newChat = useApp((s) => s.newChat)
  const goForward = useApp((s) => s.goForward)
  const canGoForward = useApp((s) => s.canGoForward())

  return (
    <span className="collapsed-nav">
      <DownloadsButton />
      <button className="icon-btn" onClick={toggleSidebar} aria-label="Show sidebar" title="Show sidebar">
        <PanelLeft size={16} strokeWidth={1.9} />
      </button>
      {canGoForward && (
        <button className="icon-btn" onClick={goForward} aria-label="Forward" title="Forward">
          <ArrowRight size={16} strokeWidth={1.9} />
        </button>
      )}
      <button className="icon-btn" onClick={() => newChat()} aria-label="New chat" title="New chat">
        <SquarePen size={16} strokeWidth={1.9} />
      </button>
    </span>
  )
}
