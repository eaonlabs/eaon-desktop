import { useEffect, useRef, useSyncExternalStore, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { SquareTerminal, X } from 'lucide-react'
import { terminals } from '../code/terminal/registry'
import { ScriptGlyph, ScriptsButton } from './CodeTools'
import { folderTabs, groupOf, useChatCode, type DrawerTab } from './chatCodeStore'
import { TerminalGroup, TerminalToolbar, useTerminalLook } from './TerminalPanes'

/**
 * The terminal under a chat: real shells in the chat's folder, edge to edge
 * under the conversation. The shell in front fills it, with a small bar over
 * its corner to split it, open another or close it; with more than one, a
 * list down the right side picks between them (split shells listed under
 * their group). Project scripts each run in one of their own. It drags taller
 * from its top edge, ⌘J hides and shows it, and selected output goes into
 * the message box.
 */
export function TerminalDrawer(): JSX.Element | null {
  const { open, height, all, active, setHeight, newTab, splitTab, closeTab, setActiveTab } = useChatCode(
    useShallow((s) => ({
      open: s.drawerOpen,
      height: s.drawerHeight,
      all: s.tabs,
      active: s.activeTab,
      setHeight: s.setDrawerHeight,
      newTab: s.newTab,
      splitTab: s.splitTab,
      closeTab: s.closeTab,
      setActiveTab: s.setActiveTab
    }))
  )
  const folder = useChatCode((s) => s.folder)
  const drawer = useRef<HTMLDivElement>(null)
  // This project's shells only: another's stay in its folder, out of sight.
  const tabs = folderTabs(all, folder)
  const themed = useTerminalLook(open)

  // Opened before the folder was known, or open on coming to a project with none yet: the first shell.
  useEffect(() => {
    if (open && folder && tabs.length === 0) newTab()
  }, [open, folder, tabs.length, newTab])

  if (!open || tabs.length === 0) return null
  const tab = tabs.find((t) => t.id === active) ?? tabs[0]
  const group = groupOf(tab)
  const panes = tabs.filter((t) => groupOf(t) === group)
  const groups = [...new Set(tabs.map(groupOf))].map((id) => tabs.filter((t) => groupOf(t) === id))

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const startY = event.clientY
    const startH = drawer.current?.offsetHeight ?? height
    // Leaves the conversation room above it.
    const max = Math.max(160, window.innerHeight - 260)
    const move = (e: PointerEvent): void => setHeight(Math.min(max, startH + startY - e.clientY))
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.removeAttribute('data-resizing')
    }
    document.body.setAttribute('data-resizing', 'drawer')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <section ref={drawer} className="term-drawer" style={{ ...themed, height }} aria-label="Terminal">
      <div className="term-drawer__resize" onPointerDown={startResize} aria-hidden />
      <div className="term-drawer__main">
        <TerminalGroup key={group} panes={panes} active={tab.id} onFocus={setActiveTab} />
        <TerminalToolbar
          pane={tab}
          extra={<ScriptsButton place="tool" />}
          onSplit={(dir) => splitTab(tab.id, dir)}
          onNew={() => newTab()}
          onClose={() => closeTab(tab.id)}
        />
      </div>
      {groups.length > 1 && (
        <nav className="term-list scroll" aria-label="Terminals">
          {groups.map((members) =>
            members.map((member, i) => (
              <ListRow key={member.id} tab={member} nested={i > 0} active={member.id === tab.id} onSelect={() => setActiveTab(member.id)} onClose={() => closeTab(member.id)} />
            ))
          )}
        </nav>
      )}
    </section>
  )
}

function ListRow({ tab, nested, active, onSelect, onClose }: { tab: DrawerTab; nested: boolean; active: boolean; onSelect: () => void; onClose: () => void }): JSX.Element {
  useSyncExternalStore(terminals.subscribe, terminals.getVersion)
  const { status } = terminals.statusOf(tab.id)
  const icon = useChatCode((s) => s.scripts.find((x) => x.id === tab.scriptId)?.icon)
  return (
    <div className="term-list__row" data-nested={nested || undefined} data-active={active || undefined} data-status={status} title={tab.command ?? tab.cwd}>
      <button type="button" className="term-list__open" onClick={onSelect} onAuxClick={(e) => e.button === 1 && onClose()} aria-current={active || undefined}>
        {icon ? <ScriptGlyph icon={icon} size={13} /> : <SquareTerminal size={13} strokeWidth={1.8} />}
        <span className="term-list__name">{tab.title}</span>
        {status === 'working' && <span className="term-list__dot" aria-label="Running" />}
      </button>
      <button type="button" className="term-list__close" aria-label={`Close ${tab.title}`} title="Close" onClick={onClose}>
        <X size={12} strokeWidth={2.1} />
      </button>
    </div>
  )
}
