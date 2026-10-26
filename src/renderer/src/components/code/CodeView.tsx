import { useEffect, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Folder, FolderOpen, X } from 'lucide-react'
import { CodeHeader, folderName } from './CodeHeader'
import { useCode } from './codeStore'
import { TerminalWorkspace } from './terminal/TerminalWorkspace'
import { ReviewPanel, useReview } from './ReviewPanel'
import { useAdeDock } from '../ide/adeDock'

/**
 * The ADE: a grid of real terminals in one project folder, each running a
 * shell or a CLI coding agent (Eaon Code, Claude Code, Codex…) as itself.
 */
export function CodeView(): JSX.Element {
  const { cwd, initialised } = useCode(useShallow((s) => ({ cwd: s.cwd, initialised: s.initialised })))
  const reviewing = useReview((s) => s.open)

  useEffect(() => {
    void useCode.getState().init()
  }, [])

  // Review and the dock take turns beside the terminals: both at once left
  // them about 90px wide, and their shells kept the prompts that width broke.
  useEffect(() => {
    const offReview = useReview.subscribe((state, prev) => {
      if (state.open && !prev.open && useAdeDock.getState().open) useAdeDock.getState().setOpen(false)
    })
    const offDock = useAdeDock.subscribe((state, prev) => {
      if (state.open && !prev.open && useReview.getState().open) useReview.getState().close()
    })
    return () => {
      offReview()
      offDock()
    }
  }, [])

  return (
    <>
      <CodeHeader />
      {cwd ? (
        <div className="code-body">
          <TerminalWorkspace />
          {/* Keyed by folder: one session's diff, drafts and half-written PR never show in another's. */}
          {reviewing && <ReviewPanel key={cwd} cwd={cwd} />}
        </div>
      ) : initialised ? (
        <NoFolder />
      ) : (
        <div className="code-fill" />
      )}
      <Toast />
    </>
  )
}

function NoFolder(): JSX.Element {
  const { recents, chooseFolder, openFolder } = useCode(
    useShallow((s) => ({ recents: s.recents, chooseFolder: s.chooseFolder, openFolder: s.openFolder }))
  )
  return (
    <div className="home code-home">
      <FolderOpen size={44} strokeWidth={1.3} className="home__icon" />
      <h1 className="home__title code-home__title--tight">Open a project</h1>
      <p className="code-home__lede">
        The ADE runs your coding agents side by side in real terminals, all in one project folder.
      </p>
      <button className="btn btn--accent code-home__cta" onClick={() => void chooseFolder()}>
        <Folder size={14} strokeWidth={2} />
        Choose folder…
      </button>
      {recents.length > 0 && (
        <div className="code-recents">
          <div className="code-recents__label">Recent</div>
          {recents.map((path) => (
            <button key={path} className="code-recents__row" onClick={() => void openFolder(path)}>
              <Folder size={15} strokeWidth={1.8} />
              <span className="code-recents__name">{folderName(path)}</span>
              <span className="code-recents__path">{path}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Toast(): JSX.Element | null {
  const toast = useCode((s) => s.toast)
  const dismiss = useCode((s) => s.dismissToast)
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(dismiss, 6000)
    return () => clearTimeout(timer)
  }, [toast, dismiss])
  if (!toast) return null
  return (
    <div className="code-toast" role="status">
      <span>{toast}</span>
      <button className="icon-btn" onClick={dismiss} aria-label="Dismiss">
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  )
}
