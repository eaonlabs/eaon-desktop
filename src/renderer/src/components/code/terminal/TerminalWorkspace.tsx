import { memo, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ArrowLeft, ArrowRight, ArrowRightLeft, Eraser, LockOpen, Maximize2, Minimize2, MoreHorizontal, PencilLine, Plus, RotateCcw, SquareTerminal, X } from 'lucide-react'
import claudeCodeLogo from '../../../assets/providers/claude.webp'
import codexLogo from '../../../assets/providers/codex.svg'
import antigravityLogo from '../../../assets/providers/antigravity.png'
import openCodeLogo from '../../../assets/providers/opencode.svg'
import eaonLogo from '../../../assets/providers/eaon.png'
import cursorLogo from '../../../assets/providers/cursor.svg'
import geminiCliLogo from '../../../assets/providers/geminicli.svg'
import grokLogo from '../../../assets/providers/grok.svg'
import qwenLogo from '../../../assets/providers/qwen.svg'
import copilotLogo from '../../../assets/providers/githubcopilot.svg'
import ampLogo from '../../../assets/providers/amp.svg'
import droidLogo from '../../../assets/providers/droid.svg'
import kimiLogo from '../../../assets/providers/kimi.svg'
import clineLogo from '../../../assets/providers/cline.svg'
import gooseLogo from '../../../assets/providers/goose.svg'
import kiloLogo from '../../../assets/providers/kilocode.svg'
import junieLogo from '../../../assets/providers/junie.svg'
import kiroLogo from '../../../assets/providers/kiro.svg'
import openHandsLogo from '../../../assets/providers/openhands.svg'
import codeBuddyLogo from '../../../assets/providers/codebuddy.svg'
import qoderLogo from '../../../assets/providers/qoder.svg'
import traeLogo from '../../../assets/providers/trae.svg'
import mistralLogo from '../../../assets/providers/mistral.svg'
import hermesLogo from '../../../assets/providers/hermes.svg'
import openClawLogo from '../../../assets/providers/openclaw.svg'
import ollamaLogo from '../../../assets/providers/ollama.png'
import { useApp } from '../../../state/store'
import { HandoffDialog } from './HandoffDialog'
import { ContextMenu } from '../../Sidebar'
import { MenuItem, MenuSeparator, Popover, useDisclosure } from '../../ui'
import { folderName } from '../CodeHeader'
import { useCode } from '../codeStore'
import { useAdeSessions } from '../sessionsStore'
import { ageLabel, sessionTitle, type AdeConversation, type AdeSession } from '@shared/adeSessions'
import { terminals, type PaneStatus } from './registry'
import { useTerminals } from './terminalStore'
import { type TerminalAgent, type TerminalAgentId, type TerminalPaneSpec } from '@shared/terminals'
import { ThemePicker } from './ThemePicker'
import { shellQuote } from './input'
import { isRemote } from '@shared/adeRemote'
import { findTheme } from './themes'
import {
  DIVIDER_PX,
  MIN_COLUMN_PX,
  MIN_ROW_PX,
  columnDividers,
  dividerValue,
  equalSizes,
  loadSizes,
  placement,
  resizeTracks,
  rowDividers,
  saveSizes,
  shapeFor,
  template,
  type Sizes
} from './gridLayout'

/**
 * The ADE's terminal view: a grid of real terminals in the project folder,
 * each a shell or a CLI agent — Eaon Code, Claude Code, Codex, Antigravity — side by
 * side, like Eaon ADE. Panes keep running when the view is switched away.
 */
export function TerminalWorkspace(): JSX.Element {
  const cwd = useCode((s) => s.cwd)
  const { loaded, loadError, panes, agents, maximized, load, add, refreshAgents } = useTerminals(
    useShallow((s) => ({
      loaded: s.loaded,
      loadError: s.loadError,
      panes: cwd ? (s.layout[cwd] ?? EMPTY) : EMPTY,
      agents: s.agents,
      maximized: s.maximized,
      load: s.load,
      add: s.add,
      refreshAgents: s.refreshAgents
    }))
  )
  const appearance = useApp((s) => s.settings?.appearance)
  const session = useAdeSessions((s) => (cwd ? (s.sessions.find((x) => x.cwd === cwd) ?? null) : null))
  const look = useApp(useShallow((s) => ({ theme: s.settings?.ade?.theme ?? 'eaon', scenes: s.settings?.ade?.scenes ?? true })))
  const preview = useTerminals((s) => s.preview)
  // The picker previews a theme on every pane before it is kept.
  const theme = findTheme(preview ?? look.theme)

  useEffect(() => {
    void load()
  }, [load])

  // The agent cards say which CLIs are installed: asked again each time they
  // show, so one installed since the list was read can be started.
  const empty = Boolean(cwd && loaded && panes.length === 0)
  useEffect(() => {
    if (empty) void refreshAgents().catch(() => undefined)
  }, [empty, cwd, refreshAgents])

  // The terminals are painted in the ADE's theme, which by default is the
  // app's own: re-tone them when either changes.
  useEffect(() => {
    const id = requestAnimationFrame(() => terminals.setLook({ theme, scenes: look.scenes }))
    return () => cancelAnimationFrame(id)
  }, [appearance, theme, look.scenes])

  /** A theme of its own paints the panes too: their background and the text on their headers. */
  const themed: CSSProperties | undefined = theme.colors
    ? { ['--term-bg' as string]: theme.colors.background, ['--term-fg' as string]: theme.colors.foreground }
    : undefined

  if (cwd && !loaded && loadError) {
    // Loading the saved layout failed; an empty workspace here gave no way to retry.
    return (
      <div className="term-workspace term-empty" role="alert">
        <SquareTerminal size={44} strokeWidth={1.3} className="home__icon" />
        <h1 className="home__title">Couldn't open your terminals</h1>
        <p className="term-empty__text">Eaon couldn't read the terminal layout for this folder. {loadError}</p>
        <button type="button" className="btn btn--primary" onClick={() => void load()}>
          Try again
        </button>
      </div>
    )
  }
  if (!cwd || !loaded) return <div className="term-workspace" />

  if (panes.length === 0) {
    return (
      <div className="term-workspace term-empty">
        <ThemePicker />
        <SquareTerminal size={44} strokeWidth={1.3} className="home__icon" />
        <h1 className="home__title">{session ? sessionTitle(session) : `Terminals in ${folderName(cwd)}`}</h1>
        <p className="term-empty__text">
          {session?.worktree && session.branch
            ? `On ${session.branch}, in a folder of its own. Start agents here side by side; they keep running when you switch to another session.`
            : 'Run coding agents side by side, each in its own terminal in this folder. They keep running when you switch to another session.'}
        </p>
        {session && <PastConversations session={session} />}
        <div className="term-empty__agents">
          {agents.filter(offered).map((agent) => (
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

  return (
    <div className="term-workspace" data-themed={theme.colors ? '' : undefined} style={themed}>
      <ThemePicker />
      <TerminalGrid cwd={cwd} panes={shown} agents={agents} maximized={maximized} />
    </div>
  )
}

const EMPTY: TerminalPaneSpec[] = []
const NO_CONVERSATIONS: AdeConversation[] = []
/** How many past conversations an empty session lists; the sidebar has them all. */
const PAST_LISTED = 5

/**
 * A session with no terminals open can reopen one of its folder's past Claude
 * Code and Codex conversations (ones started in a terminal; not headless runs
 * or other apps'). Folded away until asked for: opening a folder used to
 * list every conversation ever had there.
 */
function PastConversations({ session }: { session: AdeSession }): JSX.Element | null {
  const { conversations, loadConversations, reopen } = useAdeSessions(
    useShallow((s) => ({ conversations: s.conversations[session.cwd] ?? NO_CONVERSATIONS, loadConversations: s.loadConversations, reopen: s.reopen }))
  )
  const [now] = useState(() => Date.now())
  const [shown, setShown] = useState(false)
  useEffect(() => {
    void loadConversations(session.cwd)
  }, [session.cwd, loadConversations])
  if (conversations.length === 0) return null
  if (!shown) {
    return (
      <button type="button" className="term-past__open" onClick={() => setShown(true)}>
        Reopen a past conversation…
      </button>
    )
  }
  const listed = conversations.slice(0, PAST_LISTED)
  return (
    <section className="term-past" aria-label="Past conversations in this folder">
      <h2 className="term-past__heading">Reopen a past conversation</h2>
      <div className="term-past__list">
        {listed.map((c) => (
          <button key={`${c.agent}:${c.id}`} type="button" className="term-past__item" title={c.title} onClick={() => reopen(session, c)}>
            <AgentMark agent={c.agent} size={16} />
            <span className="term-past__title">{c.title}</span>
            <span className="term-past__age">{ageLabel(c.touched, now)}</span>
          </button>
        ))}
      </div>
      {conversations.length > PAST_LISTED && <p className="term-past__more">The newest {PAST_LISTED} of {conversations.length}</p>}
      <h2 className="term-past__heading term-past__heading--start">Or start an agent</h2>
    </section>
  )
}

type Axis = 'cols' | 'rows'

/**
 * The terminals on a grid whose columns and rows the user can resize, by
 * dragging the dividers between them (or with the arrow keys on a focused
 * divider; a double-click evens them out). Sizes are remembered per folder
 * and grid shape. A terminal is moved by dragging its title bar onto another,
 * which trades their places.
 */
function TerminalGrid({
  cwd,
  panes,
  agents,
  maximized
}: {
  cwd: string
  panes: TerminalPaneSpec[]
  agents: TerminalAgent[]
  maximized: string | null
}): JSX.Element {
  const grid = useRef<HTMLDivElement>(null)
  const shape = shapeFor(panes.length)
  const key = `${cwd}|${shape.cols}x${shape.rows}`
  const [state, setState] = useState<{ key: string; sizes: Sizes }>(() => ({ key, sizes: loadSizes(cwd, shape) }))
  // A different folder or grid shape has sizes of its own.
  const sizes = state.key === key ? state.sizes : loadSizes(cwd, shape)

  const set = (next: Sizes, save: boolean): void => {
    setState({ key, sizes: next })
    if (save) saveSizes(cwd, shape, next)
  }

  const resize = (axis: Axis, k: number, deltaPx: number, base: Sizes, save: boolean): void => {
    const el = grid.current
    if (!el) return
    const n = base[axis].length
    const room = (axis === 'cols' ? el.clientWidth : el.clientHeight) - (n - 1) * DIVIDER_PX
    set({ ...base, [axis]: resizeTracks(base[axis], k, deltaPx, room, axis === 'cols' ? MIN_COLUMN_PX : MIN_ROW_PX) }, save)
  }

  return (
    <div ref={grid} className="term-grid" style={{ gridTemplateColumns: template(sizes.cols), gridTemplateRows: template(sizes.rows) }}>
      {panes.map((pane, index) => {
        const place = placement(index, panes.length, shape)
        return (
          <TerminalPane
            key={pane.id}
            pane={pane}
            cwd={cwd}
            agent={agents.find((a) => a.id === pane.agent)}
            maximized={maximized === pane.id}
            gridColumn={place.gridColumn}
            gridRow={place.gridRow}
            prev={panes[index - 1]?.id ?? null}
            next={panes[index + 1]?.id ?? null}
            movable={panes.length > 1}
          />
        )
      })}
      {columnDividers(panes.length, shape).map((d) => (
        <Divider key={`c${d.index}`} axis="cols" index={d.index} gridColumn={d.gridColumn} gridRow={d.gridRow} sizes={sizes} onResize={resize} onReset={() => set(equalSizes(shape), true)} />
      ))}
      {rowDividers(shape).map((d) => (
        <Divider key={`r${d.index}`} axis="rows" index={d.index} gridColumn={d.gridColumn} gridRow={d.gridRow} sizes={sizes} onResize={resize} onReset={() => set(equalSizes(shape), true)} />
      ))}
    </div>
  )
}

/** The grab line between two columns or two rows of terminals. */
function Divider({
  axis,
  index,
  gridColumn,
  gridRow,
  sizes,
  onResize,
  onReset
}: {
  axis: Axis
  index: number
  gridColumn: string
  gridRow: string
  sizes: Sizes
  onResize: (axis: Axis, k: number, deltaPx: number, base: Sizes, save: boolean) => void
  onReset: () => void
}): JSX.Element {
  const start = useRef<{ at: number; base: Sizes } | null>(null)
  const [active, setActive] = useState(false)
  const pos = (e: React.PointerEvent): number => (axis === 'cols' ? e.clientX : e.clientY)
  const end = (): void => {
    start.current = null
    setActive(false)
    delete document.body.dataset.termResizing
  }
  const label = axis === 'cols' ? `Resize columns ${index + 1} and ${index + 2}` : `Resize rows ${index + 1} and ${index + 2}`
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={axis === 'cols' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={dividerValue(sizes[axis], index)}
      className="term-divider"
      data-axis={axis}
      data-active={active || undefined}
      title="Drag to resize · double-click to make them even"
      style={{ gridColumn, gridRow }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { at: pos(e), base: sizes }
        setActive(true)
        // The terminals under the pointer would otherwise take the drag as a text selection.
        document.body.dataset.termResizing = axis
      }}
      onPointerMove={(e) => {
        const s = start.current
        if (s) onResize(axis, index, pos(e) - s.at, s.base, false)
      }}
      onPointerUp={(e) => {
        const s = start.current
        if (s) onResize(axis, index, pos(e) - s.at, s.base, true)
        end()
      }}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 96 : 24
        const keys: Record<string, number> = axis === 'cols' ? { ArrowLeft: -step, ArrowRight: step } : { ArrowUp: -step, ArrowDown: step }
        if (e.key in keys) {
          e.preventDefault()
          onResize(axis, index, keys[e.key], sizes, true)
        } else if (e.key === 'Home' || e.key === 'End' || e.key === 'Enter') {
          // Even them out again, as a double-click does.
          e.preventDefault()
          onReset()
        }
      }}
    />
  )
}

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
  gridColumn,
  gridRow,
  prev,
  next,
  movable
}: {
  pane: TerminalPaneSpec
  cwd: string
  agent: TerminalAgent | undefined
  maximized: boolean
  gridColumn: string
  gridRow: string
  /** The panes before and after it in the grid's order, for Move left/right. */
  prev: string | null
  next: string | null
  movable: boolean
}): JSX.Element {
  const screen = useRef<HTMLDivElement>(null)
  const { close, rename, toggleMaximized, add, swap, dragging, setDragging } = useTerminals(
    useShallow((s) => ({
      close: s.close,
      rename: s.rename,
      toggleMaximized: s.toggleMaximized,
      add: s.add,
      swap: s.swap,
      dragging: s.dragging,
      setDragging: s.setDragging
    }))
  )
  const [over, setOver] = useState(false)
  /** Files from Finder are over this pane. */
  const [fileOver, setFileOver] = useState(false)
  const target = dragging !== null && dragging !== pane.id
  const status = usePaneStatus(pane.id)
  const program = useTerminals((s) => (pane.agent === 'shell' ? s.programs[pane.id] : undefined))
  // What the header calls it: the agent, or the CLI a plain shell is running.
  const shown = program ?? agent?.label ?? ''
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(pane.name)
  const [handingOff, setHandingOff] = useState(false)
  const launch = { cwd, command: agent?.command ?? null, agent: pane.agent, ...(pane.resume ? { resume: pane.resume } : {}), ...(pane.prompt ? { prompt: pane.prompt } : {}) }

  useEffect(() => {
    const host = screen.current
    if (!host) return
    terminals.attach(pane.id, host, launch)
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
    <section
      className="term-pane"
      data-status={status}
      data-dragging={dragging === pane.id || undefined}
      data-file-over={fileOver || undefined}
      style={{ gridColumn, gridRow }}
      onMouseDown={() => terminals.focus(pane.id)}
    >
      <header
        className="term-pane__head"
        draggable={movable && !renaming && !maximized}
        title={movable && !maximized ? 'Drag onto another terminal to swap places' : undefined}
        onDoubleClick={() => toggleMaximized(pane.id)}
        onDragStart={(e) => {
          e.dataTransfer.setData(PANE_MIME, pane.id)
          e.dataTransfer.effectAllowed = 'move'
          setDragging(pane.id)
        }}
        onDragEnd={() => setDragging(null)}
      >
        <span className="term-pane__dot" role="img" aria-label={STATUS_LABEL[status]} title={STATUS_LABEL[status]} />
        <AgentMark agent={pane.agent} program={program} size={14} />
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
          <span className="term-pane__name" title={`${pane.name} · ${shown}`}>
            {pane.name}
          </span>
        )}
        <span className="term-pane__agent">{shown}</span>
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
      <div
        ref={screen}
        className="term-pane__screen"
        data-file-over={fileOver || undefined}
        // Files dropped from Finder land on the prompt as their paths, quoted for a shell.
        onDragOver={(e) => {
          // A path on this computer means nothing to an agent on another machine.
          if (!e.dataTransfer.types.includes('Files') || isRemote(cwd)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          if (!fileOver) setFileOver(true)
        }}
        // Moving between the terminal's own layers is not leaving it.
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFileOver(false)}
        onDrop={(e) => {
          setFileOver(false)
          if (isRemote(cwd)) return
          const paths = [...e.dataTransfer.files].map((file) => window.api.app.pathForFile(file)).filter(Boolean)
          if (paths.length === 0) return
          e.preventDefault()
          terminals.insertText(pane.id, `${paths.map(shellQuote).join(' ')} `)
        }}
      />
      {target && (
        // Over the terminal while another is dragged, so the drop lands here and not in the terminal.
        <div
          className="term-pane__drop"
          data-over={over || undefined}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(PANE_MIME)) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            if (!over) setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            const from = e.dataTransfer.getData(PANE_MIME) || dragging
            setOver(false)
            setDragging(null)
            if (from) swap(cwd, from, pane.id)
          }}
        >
          <span className="term-pane__drop-label">Swap with {pane.name}</span>
        </div>
      )}
      {status === 'exited' && (
        <div className="term-pane__actions">
          {/* macOS keeps Eaon out of this folder: the switch that lets it in, then a restart. */}
          {terminals.statusOf(pane.id).privacy && (
            <button className="term-pane__restart" onClick={() => void window.api.app.openFolderPrivacy()}>
              <LockOpen size={13} strokeWidth={2} />
              Open Privacy Settings
            </button>
          )}
          <button className="term-pane__restart" onClick={() => terminals.restart(pane.id, launch)}>
            <RotateCcw size={13} strokeWidth={2} />
            Restart {agent?.label ?? 'terminal'}
          </button>
        </div>
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
            ...(prev && !maximized ? [{ icon: <ArrowLeft size={15} strokeWidth={1.9} />, label: 'Move left', action: () => swap(cwd, pane.id, prev) }] : []),
            ...(next && !maximized ? [{ icon: <ArrowRight size={15} strokeWidth={1.9} />, label: 'Move right', action: () => swap(cwd, pane.id, next) }] : []),
            // Another model takes a fresh look from where this one stopped; this pane carries on as it is.
            ...(pane.agent !== 'shell' && !isRemote(cwd)
              ? [{ icon: <ArrowRightLeft size={15} strokeWidth={1.9} />, label: 'Hand off to another agent…', action: () => setHandingOff(true) }]
              : []),
            { icon: <RotateCcw size={15} strokeWidth={1.9} />, label: 'Restart', action: () => terminals.restart(pane.id, launch) },
            { icon: <Eraser size={15} strokeWidth={1.9} />, label: 'Clear', action: () => terminals.clear(pane.id) },
            { icon: <X size={15} strokeWidth={1.9} />, label: 'Close', danger: true, action: () => close(cwd, pane.id) }
          ]}
        />
      )}
      {handingOff && <HandoffDialog open onClose={() => setHandingOff(false)} cwd={cwd} pane={pane} from={pane.agent} fromLabel={agent?.label ?? 'This agent'} />}
    </section>
  )
})

/** What a dragged terminal carries, so other drags (files, text) are told apart. */
const PANE_MIME = 'application/x-eaon-pane'

const STATUS_LABEL: Record<PaneStatus, string> = {
  starting: 'Starting',
  working: 'Working',
  idle: 'Waiting',
  exited: 'Exited'
}

/**
 * A small mark for what runs in a pane: the agent's logo, or with a plain
 * shell, the program in its foreground (any CLI) as its initial.
 */
export function AgentMark({ agent, program, size }: { agent: TerminalAgentId; program?: string; size: number }): JSX.Element {
  if (agent === 'shell' && !program) return <SquareTerminal className="term-mark term-mark--shell" size={size} strokeWidth={2} />
  const logo = agent === 'shell' ? (PROGRAM_LOGOS[program!] ?? { letter: program!.charAt(0).toUpperCase() }) : AGENT_LOGOS[agent]
  if (typeof logo === 'string') return <img className="term-mark term-mark--img" src={logo} width={size} height={size} alt="" />
  // No logo published: its initial on a tile, sized like one.
  return (
    <span className="term-mark term-mark--letter" style={{ width: size, height: size, fontSize: Math.round(size * 0.6) }} aria-hidden="true">
      {logo.letter}
    </span>
  )
}

/**
 * Every agent's logo. A full record on purpose: an agent added to
 * TERMINAL_AGENT_IDS without one here doesn't build, so no CLI a pane
 * recognises is ever drawn as a plain shell.
 */
const AGENT_LOGOS: Record<Exclude<TerminalAgentId, 'shell'>, string | { letter: string }> = {
  claude: claudeCodeLogo,
  codex: codexLogo,
  antigravity: antigravityLogo,
  opencode: openCodeLogo,
  'eaon-code': eaonLogo,
  'eaon-cli': eaonLogo,
  cursor: cursorLogo,
  gemini: geminiCliLogo,
  grok: grokLogo,
  qwen: qwenLogo,
  copilot: copilotLogo,
  amp: ampLogo,
  droid: droidLogo,
  kimi: kimiLogo,
  cline: clineLogo,
  goose: gooseLogo,
  kilo: kiloLogo,
  junie: junieLogo,
  kiro: kiroLogo,
  openhands: openHandsLogo,
  aider: { letter: 'A' },
  crush: { letter: 'C' },
  warp: { letter: 'W' },
  codebuddy: codeBuddyLogo,
  qoder: qoderLogo,
  trae: traeLogo,
  vibe: mistralLogo,
  hermes: hermesLogo,
  openclaw: openClawLogo,
  auggie: { letter: 'A' },
  codebuff: { letter: 'C' },
  continue: { letter: 'C' },
  plandex: { letter: 'P' },
  jules: { letter: 'J' },
  qodo: { letter: 'Q' }
}

/** Programs that are no agent but have a logo of their own, by the name a pane shows. */
const PROGRAM_LOGOS: Record<string, string> = {
  ollama: ollamaLogo
}

/** Offered to start: the ADE's own agents always (greyed when missing), the other CLIs once installed. */
const offered = (agent: TerminalAgent): boolean => agent.installed || !agent.other

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
  const missing = agents.filter((a) => !a.installed && offered(a))
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
