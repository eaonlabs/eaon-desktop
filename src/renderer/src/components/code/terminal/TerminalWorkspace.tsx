import { memo, useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Eraser, Maximize2, Minimize2, MoreHorizontal, PencilLine, Plus, RotateCcw, SquareTerminal, X } from 'lucide-react'
import claudeCodeLogo from '../../../assets/providers/claudecode.svg'
import codexLogo from '../../../assets/providers/codex.svg'
import geminiCliLogo from '../../../assets/providers/geminicli.svg'
import openCodeLogo from '../../../assets/providers/opencode.svg'
import eaonLogo from '../../../assets/providers/eaon.png'
import { useApp } from '../../../state/store'
import { ContextMenu } from '../../Sidebar'
import { MenuItem, MenuSeparator, Popover, useDisclosure } from '../../ui'
import { folderName } from '../CodeHeader'
import { useCode } from '../codeStore'
import { terminals, type PaneStatus } from './registry'
import { useTerminals } from './terminalStore'
import { gridColumns, type TerminalAgent, type TerminalAgentId, type TerminalPaneSpec } from '@shared/terminals'

/**
 * The ADE's terminal view: a grid of real terminals in the project folder,
 * each a shell or a CLI agent — Eaon Code, Claude Code, Codex, Gemini — side by
 * side, like Eaon ADE. Panes keep running when the view is switched away.
 */
export function TerminalWorkspace(): JSX.Element {
  const cwd = useCode((s) => s.cwd)
  const { loaded, panes, agents, maximized, load, add } = useTerminals(
    useShallow((s) => ({
      loaded: s.loaded,
      panes: cwd ? (s.layout[cwd] ?? EMPTY) : EMPTY,
      agents: s.agents,
      maximized: s.maximized,
      load: s.load,
      add: s.add
    }))
  )
  const appearance = useApp((s) => s.settings?.appearance)

  useEffect(() => {
    void load()
  }, [load])

  // The terminals are painted in the app's theme; re-tone them when it changes.
  useEffect(() => {
    const id = requestAnimationFrame(() => terminals.applyTheme())
    return () => cancelAnimationFrame(id)
  }, [appearance])

  if (!cwd || !loaded) return <div className="term-workspace" />

  if (panes.length === 0) {
    return (
      <div className="term-workspace term-empty">
        <SquareTerminal size={44} strokeWidth={1.3} className="home__icon" />
        <h1 className="home__title">Terminals in {folderName(cwd)}</h1>
        <p className="term-empty__text">Run coding agents side by side, each in its own terminal in this folder. They keep running when you switch back to the agent view.</p>
        <div className="term-empty__agents">
          {agents.map((agent) => (
            <button
              key={agent.id}
              className="term-agent-card"
              disabled={!agent.installed}
              title={agent.installed ? `Open ${agent.label}` : `Not installed — ${agent.installHint ?? ''}`}
              onClick={() => add(cwd, agent.id)}
            >
              <AgentMark agent={agent.id} size={22} />
              <span className="term-agent-card__label">{agent.label}</span>
              {!agent.installed && <span className="term-agent-card__hint">Not installed</span>}
            </button>
          ))}
        </div>
      </div>
    )
  }

  const shown = maximized && panes.some((p) => p.id === maximized) ? panes.filter((p) => p.id === maximized) : panes
  const cols = gridColumns(shown.length)
  const rows = Math.ceil(shown.length / cols)

  return (
    <div className="term-workspace">
      <div className="term-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
        {shown.map((pane, index) => (
          <TerminalPane
            key={pane.id}
            pane={pane}
            cwd={cwd}
            agent={agents.find((a) => a.id === pane.agent)}
            maximized={maximized === pane.id}
            // A short last row stretches its final pane across what is left.
            span={index === shown.length - 1 ? cols * rows - shown.length + 1 : 1}
          />
        ))}
      </div>
    </div>
  )
}

const EMPTY: TerminalPaneSpec[] = []

/** Watches one pane's status in the registry; re-renders only when some pane's status changes. */
function usePaneStatus(paneId: string): PaneStatus {
  useSyncExternalStore(terminals.subscribe, terminals.getVersion)
  return terminals.statusOf(paneId).status
}

const TerminalPane = memo(function TerminalPane({
  pane,
  cwd,
  agent,
  maximized,
  span
}: {
  pane: TerminalPaneSpec
  cwd: string
  agent: TerminalAgent | undefined
  maximized: boolean
  span: number
}): JSX.Element {
  const screen = useRef<HTMLDivElement>(null)
  const { close, rename, toggleMaximized, add } = useTerminals(
    useShallow((s) => ({ close: s.close, rename: s.rename, toggleMaximized: s.toggleMaximized, add: s.add }))
  )
  const status = usePaneStatus(pane.id)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(pane.name)
  const launch = { cwd, command: agent?.command ?? null, agent: pane.agent }

  useEffect(() => {
    const host = screen.current
    if (!host) return
    terminals.attach(pane.id, host, { cwd, command: agent?.command ?? null, agent: pane.agent })
    return () => terminals.detach(pane.id, host)
    // The command is read once, when the shell starts; re-attaching for a new
    // one would not change what is already running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, cwd])

  const commitRename = (): void => {
    setRenaming(false)
    if (draft.trim() && draft.trim() !== pane.name) rename(cwd, pane.id, draft.trim())
    else setDraft(pane.name)
  }

  return (
    <section className="term-pane" data-status={status} style={span > 1 ? { gridColumn: `span ${span}` } : undefined} onMouseDown={() => terminals.focus(pane.id)}>
      <header className="term-pane__head" onDoubleClick={() => toggleMaximized(pane.id)}>
        <span className="term-pane__dot" title={STATUS_LABEL[status]} />
        <AgentMark agent={pane.agent} size={14} />
        {renaming ? (
          <input
            autoFocus
            className="term-pane__rename"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') {
                setDraft(pane.name)
                setRenaming(false)
              }
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="term-pane__name" title={`${pane.name} · ${agent?.label ?? pane.agent}`}>
            {pane.name}
          </span>
        )}
        <span className="term-pane__agent">{agent?.label ?? ''}</span>
        <span className="term-pane__spacer" />
        <button
          className="term-pane__btn"
          aria-label="Pane options"
          title="Options"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setMenu({ x: rect.left, y: rect.bottom + 2 })
          }}
        >
          <MoreHorizontal size={14} strokeWidth={2} />
        </button>
        <button className="term-pane__btn" aria-label={maximized ? 'Restore' : 'Maximise'} title={maximized ? 'Back to the grid' : 'Fill the view'} onClick={() => toggleMaximized(pane.id)}>
          {maximized ? <Minimize2 size={13} strokeWidth={2} /> : <Maximize2 size={13} strokeWidth={2} />}
        </button>
        <button className="term-pane__btn" aria-label="New terminal like this one" title={`Another ${agent?.label ?? 'terminal'}`} onClick={() => add(cwd, pane.agent)}>
          <Plus size={14} strokeWidth={2} />
        </button>
        <button className="term-pane__btn term-pane__btn--close" aria-label={`Close ${pane.name}`} title="Close — ends what is running in it" onClick={() => close(cwd, pane.id)}>
          <X size={14} strokeWidth={2} />
        </button>
      </header>
      <div ref={screen} className="term-pane__screen" />
      {status === 'exited' && (
        <button className="term-pane__restart" onClick={() => terminals.restart(pane.id, launch)}>
          <RotateCcw size={13} strokeWidth={2} />
          Restart {agent?.label ?? 'terminal'}
        </button>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              icon: <PencilLine size={15} strokeWidth={1.9} />,
              label: 'Rename',
              action: () => {
                setDraft(pane.name)
                setRenaming(true)
              }
            },
            { icon: <RotateCcw size={15} strokeWidth={1.9} />, label: 'Restart', action: () => terminals.restart(pane.id, launch) },
            { icon: <Eraser size={15} strokeWidth={1.9} />, label: 'Clear', action: () => terminals.clear(pane.id) },
            { icon: <X size={15} strokeWidth={1.9} />, label: 'Close', danger: true, action: () => close(cwd, pane.id) }
          ]}
        />
      )}
    </section>
  )
})

const STATUS_LABEL: Record<PaneStatus, string> = {
  starting: 'Starting',
  working: 'Working',
  idle: 'Waiting',
  exited: 'Exited'
}

/** A small mark for what runs in a pane. */
export function AgentMark({ agent, size }: { agent: TerminalAgentId; size: number }): JSX.Element {
  const src = AGENT_LOGOS[agent]
  if (src) return <img className="term-mark term-mark--img" src={src} width={size} height={size} alt="" />
  return <SquareTerminal className="term-mark term-mark--shell" size={size} strokeWidth={2} />
}

const AGENT_LOGOS: Partial<Record<TerminalAgentId, string>> = {
  claude: claudeCodeLogo,
  codex: codexLogo,
  gemini: geminiCliLogo,
  opencode: openCodeLogo,
  'eaon-code': eaonLogo
}

/** "New terminal" in the ADE's top bar: pick what runs in it. */
export function NewTerminalButton(): JSX.Element | null {
  const cwd = useCode((s) => s.cwd)
  const { agents, add, load, refreshAgents } = useTerminals(
    useShallow((s) => ({ agents: s.agents, add: s.add, load: s.load, refreshAgents: s.refreshAgents }))
  )
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  useEffect(() => {
    void load()
  }, [load])
  if (!cwd) return null
  const installed = agents.filter((a) => a.installed)
  const missing = agents.filter((a) => !a.installed)
  return (
    <>
      <button
        ref={anchor}
        className="header-btn"
        data-open={menu.open || undefined}
        onClick={() => {
          void refreshAgents()
          menu.toggle()
        }}
      >
        <Plus size={14} strokeWidth={2} />
        <span>New terminal</span>
      </button>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={260}>
        <div className="menu__label">Open in {folderName(cwd)}</div>
        {installed.map((agent) => (
          <MenuItem
            key={agent.id}
            icon={<AgentMark agent={agent.id} size={16} />}
            title={agent.label}
            onClick={() => {
              add(cwd, agent.id)
              menu.close()
            }}
          />
        ))}
        {missing.length > 0 && (
          <>
            <MenuSeparator />
            <div className="menu__label">Not installed</div>
            {missing.map((agent) => (
              <MenuItem key={agent.id} icon={<AgentMark agent={agent.id} size={16} />} title={agent.label} description={agent.installHint} disabled />
            ))}
          </>
        )}
      </Popover>
    </>
  )
}
