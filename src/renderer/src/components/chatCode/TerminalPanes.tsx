import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type JSX, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Columns2, MessageSquareQuote, Plus, Rows2, Trash2 } from 'lucide-react'
import { terminals } from '../code/terminal/registry'
import { findTheme } from '../code/terminal/themes'
import { useApp } from '../../state/store'
import { notify } from '../Notice'
import { ConfirmDialog } from '../ui'
import { useIde } from '../ide/ideStore'
import { useChatCode, type DrawerTab } from './chatCodeStore'
import { colOf, columnsOf, type SplitDir } from './terminalLayout'

/**
 * Chat's terminals as panes: a group of shells split side by side or one over
 * the other, the one in use outlined, and over its top right corner a small
 * bar to split it, open another, or close it. Shared by the drawer under the
 * conversation and the dock's Terminal surface.
 */

/** Past this many lines, a selection is cut to its end: the newest output is what a question is about. */
const MAX_LINES = 400

/** The terminal theme, applied while `on`; the background to paint behind the panes. */
export function useTerminalLook(on: boolean): CSSProperties | undefined {
  // The ADE's terminal theme (by default the app's own colours), re-applied when either changes:
  // the ADE does this while it is on screen, and Chat's terminals are the same terminals.
  const appearance = useApp((s) => s.settings?.appearance)
  const themeId = useApp((s) => s.settings?.ade?.theme ?? 'eaon')
  const scenes = useApp((s) => s.settings?.ade?.scenes ?? true)
  const theme = findTheme(themeId)
  useEffect(() => {
    if (!on) return
    const id = requestAnimationFrame(() => terminals.setLook({ theme, scenes }))
    return () => cancelAnimationFrame(id)
  }, [on, appearance, theme, scenes])
  return theme.colors ? ({ '--term-bg': theme.colors.background } as CSSProperties) : undefined
}

/**
 * A group's panes in columns, side by side, each column's panes one over the
 * other; the one in `active` takes the keyboard when it mounts.
 */
export function TerminalGroup({ panes, active, onFocus }: { panes: DrawerTab[]; active: string | null; onFocus: (id: string) => void }): JSX.Element {
  const columns = columnsOf(panes)
  return (
    <div className="term-group">
      {columns.map((column, c) => (
        <Fragment key={colOf(column[0])}>
          {c > 0 && <div className="term-group__rule" aria-hidden />}
          <div className="term-group__col">
            {column.map((pane, i) => (
              <Fragment key={pane.id}>
                {i > 0 && <div className="term-group__rule term-group__rule--row" aria-hidden />}
                <TerminalHost tab={pane} focused={pane.id === active} split={panes.length > 1} onFocus={() => onFocus(pane.id)} />
              </Fragment>
            ))}
          </div>
        </Fragment>
      ))}
    </div>
  )
}

function TerminalHost({ tab, focused, split, onFocus }: { tab: DrawerTab; focused: boolean; split: boolean; onFocus: () => void }): JSX.Element {
  const screen = useRef<HTMLDivElement>(null)
  useSyncExternalStore(terminals.subscribe, terminals.getVersion)
  const { status } = terminals.statusOf(tab.id)
  useEffect(() => {
    const host = screen.current
    if (!host) return
    terminals.attach(tab.id, host, { cwd: tab.cwd, command: tab.command })
    return () => terminals.detach(tab.id, host)
    // A tab's command runs once, when its shell starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id])
  // In front: the keyboard, two frames on so the shell has been placed.
  useEffect(() => {
    if (!focused) return
    const id = requestAnimationFrame(() => requestAnimationFrame(() => terminals.focus(tab.id)))
    return () => cancelAnimationFrame(id)
  }, [focused, tab.id])
  return (
    <div className="cterm-pane" data-active={(split && focused) || undefined} data-status={status} onPointerDown={onFocus} onFocusCapture={onFocus}>
      <div ref={screen} className="cterm-pane__screen" data-find-skip />
    </div>
  )
}

/**
 * The bar over a terminal's corner: split right, split down, a new one,
 * close (after asking; closing stops what runs in it). `extra` goes first:
 * the drawer's scripts.
 */
export function TerminalToolbar({
  pane,
  onSplit,
  onNew,
  onClose,
  extra
}: {
  pane: DrawerTab
  onSplit: (dir: SplitDir) => void
  onNew: () => void
  onClose: () => void
  extra?: ReactNode
}): JSX.Element {
  const [confirm, setConfirm] = useState(false)
  return (
    <div className="term-tools" role="toolbar" aria-label="Terminal">
      <SelectionToChat paneId={pane.id} />
      {extra}
      <button type="button" className="term-tools__btn" title="Split right" aria-label="Split right" onClick={() => onSplit('right')}>
        <Columns2 size={14} strokeWidth={1.9} />
      </button>
      <button type="button" className="term-tools__btn" title="Split down" aria-label="Split down" onClick={() => onSplit('down')}>
        <Rows2 size={14} strokeWidth={1.9} />
      </button>
      <button type="button" className="term-tools__btn" title="New terminal" aria-label="New terminal" onClick={onNew}>
        <Plus size={15} strokeWidth={1.9} />
      </button>
      <button type="button" className="term-tools__btn" data-tone="danger" title="Close terminal" aria-label="Close terminal" onClick={() => setConfirm(true)}>
        <Trash2 size={14} strokeWidth={1.9} />
      </button>
      <ConfirmDialog
        open={confirm}
        title={`Close terminal “${pane.title}”?`}
        confirmLabel="Close"
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false)
          onClose()
        }}
      >
        This stops the running process and clears its history.
      </ConfirmDialog>
    </div>
  )
}

/** "Add to message": shown while output is selected; puts it in the message box as a fenced block. */
function SelectionToChat({ paneId }: { paneId: string }): JSX.Element | null {
  const [has, setHas] = useState(false)
  useEffect(() => {
    setHas(Boolean(terminals.selection(paneId).trim()))
    // The pane's terminal exists once it is attached, a frame or two after mounting.
    let off: () => void = () => undefined
    const timer = window.setTimeout(() => {
      off = terminals.onSelection(paneId, () => setHas(Boolean(terminals.selection(paneId).trim())))
    }, 50)
    return () => {
      window.clearTimeout(timer)
      off()
    }
  }, [paneId])
  if (!has) return null

  const add = (): void => {
    const lines = terminals.selection(paneId).replace(/\s+$/, '').split('\n')
    if (!lines.join('').trim()) return
    const text = lines.slice(-MAX_LINES).map((l) => l.trimEnd()).join('\n')
    useApp.getState().appendToComposer({ text: `\`\`\`console\n${text}\n\`\`\`\n\n`, attachments: [] })
    notify(lines.length > MAX_LINES ? `Added the last ${MAX_LINES} lines to your message` : 'Added to your message')
  }
  return (
    <button type="button" className="term-tools__btn term-tools__btn--text" title="Put the selected output in your message" onMouseDown={(e) => e.preventDefault()} onClick={add}>
      <MessageSquareQuote size={13} strokeWidth={1.9} />
      Add to message
    </button>
  )
}

/** The dock's Terminal surface: its own shells, split as it likes. */
export function DockTerminal({ surfaceId, title, onNew }: { surfaceId: string; title: string; onNew: () => void }): JSX.Element {
  const folder = useChatCode((s) => s.folder)
  const panes = useChatCode(useShallow((s) => s.tabs.filter((t) => t.dock === surfaceId)))
  const [active, setActive] = useState<string | null>(null)
  const themed = useTerminalLook(true)
  useEffect(() => {
    if (folder) useChatCode.getState().openDockTerminal(surfaceId, title)
  }, [folder, surfaceId, title])
  const current = panes.find((p) => p.id === active) ?? panes[0]
  if (!current) return <div className="dock-term dock-term--empty">{folder ? null : 'Pick a folder for this chat to open a terminal in it.'}</div>
  return (
    <div className="dock-term" style={themed}>
      <TerminalGroup panes={panes} active={current.id} onFocus={setActive} />
      <TerminalToolbar
        pane={current}
        onSplit={(d) => {
          const id = useChatCode.getState().splitTab(current.id, d)
          if (id) setActive(id)
        }}
        onNew={onNew}
        onClose={() => {
          // The surface goes with its last shell.
          if (panes.length === 1) return useIde.getState().closeSurface(surfaceId)
          const index = panes.findIndex((p) => p.id === current.id)
          useChatCode.getState().closeTab(current.id)
          setActive(panes[index + 1]?.id ?? panes[index - 1]?.id ?? null)
        }}
      />
    </div>
  )
}
