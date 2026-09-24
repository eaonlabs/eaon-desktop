import { useRef, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Archive,
  ChevronDown,
  Folder,
  FolderOpen,
  MoreHorizontal,
  PencilLine,
  RotateCw,
  Settings as SettingsIcon,
  SquarePen,
  SquareTerminal,
  TerminalSquare
} from 'lucide-react'
import { useApp } from '../../state/store'
import { CollapsedNav } from '../CollapsedNav'
import { ModeSwitch } from '../ModeSwitch'
import { MenuItem, MenuSeparator, Popover, useDisclosure } from '../ui'
import { useCode } from './codeStore'
import type { EaonSessionStats } from '@shared/eaonCode'

export const folderName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

export const formatCount = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)

const formatCost = (cost: number): string => (cost >= 1 ? `$${cost.toFixed(2)}` : cost >= 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(4)}`)

/**
 * The Code tab's top bar: the mode switch, the project folder, the session's
 * name, and on the right its context use, tokens and cost, plus the way out
 * to a real terminal.
 */
export function CodeHeader(): JSX.Element {
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const { cwd, session, stats, transcript, process } = useCode(
    useShallow((s) => ({
      cwd: s.cwd,
      session: s.session,
      stats: s.stats,
      transcript: s.transcript.items,
      process: s.process
    }))
  )
  const firstPrompt = transcript.find((item) => item.kind === 'user')
  const title = session?.sessionName || (firstPrompt?.kind === 'user' ? firstPrompt.text.split('\n')[0] : '')

  return (
    <div className="chat-header code-header" data-collapsed={!sidebarOpen || undefined}>
      {!sidebarOpen && <CollapsedNav />}
      <ModeSwitch />
      {cwd && <FolderChip />}
      {title && <span className="chat-header__title code-header__title">{title}</span>}
      <div className="chat-header__spacer" />
      <div className="chat-header__actions">
        {stats && process.state === 'running' && stats.tokens.total > 0 && <SessionStats stats={stats} />}
        {cwd && <TerminalButton />}
        {cwd && <MoreMenu />}
      </div>
    </div>
  )
}

function FolderChip(): JSX.Element {
  const { cwd, recents, chooseFolder, openFolder } = useCode(
    useShallow((s) => ({ cwd: s.cwd, recents: s.recents, chooseFolder: s.chooseFolder, openFolder: s.openFolder }))
  )
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const others = recents.filter((path) => path !== cwd)

  return (
    <>
      <button ref={anchor} className="header-btn code-folder" data-open={menu.open || undefined} onClick={menu.toggle} title={cwd ?? ''}>
        <Folder size={14} strokeWidth={1.9} />
        <span className="code-folder__name">{cwd ? folderName(cwd) : 'Choose folder'}</span>
        <ChevronDown size={13} strokeWidth={2} className="code-folder__chevron" />
      </button>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="bottom-start" width={300}>
        {cwd && (
          <>
            <div className="menu__label">Project folder</div>
            <MenuItem icon={<FolderOpen size={16} strokeWidth={1.8} />} title={folderName(cwd)} description={cwd} checked />
          </>
        )}
        {others.length > 0 && (
          <>
            <div className="menu__label">Recent</div>
            {others.map((path) => (
              <MenuItem
                key={path}
                icon={<Folder size={16} strokeWidth={1.8} />}
                title={folderName(path)}
                description={path}
                onClick={() => {
                  menu.close()
                  void openFolder(path)
                }}
              />
            ))}
          </>
        )}
        <MenuSeparator />
        <MenuItem
          title="Open another folder…"
          onClick={() => {
            menu.close()
            void chooseFolder()
          }}
        />
        {cwd && <MenuItem title="Reveal in Finder" onClick={() => void window.api.app.showItem(cwd)} />}
      </Popover>
    </>
  )
}

/** Context use as a ring, then tokens and cost; the tooltip has the breakdown. */
function SessionStats({ stats }: { stats: EaonSessionStats }): JSX.Element {
  const usage = stats.contextUsage
  const percent = usage?.percent ?? null
  const radius = 6.5
  const circumference = 2 * Math.PI * radius
  const level = percent === null ? 'unknown' : percent >= 85 ? 'high' : percent >= 60 ? 'mid' : 'low'
  const tip = [
    usage
      ? usage.tokens === null
        ? `Context: re-measured after the next reply (window ${usage.contextWindow.toLocaleString()})`
        : `Context: ${usage.tokens.toLocaleString()} of ${usage.contextWindow.toLocaleString()} tokens (${Math.round(percent ?? 0)}%)`
      : 'Context: no model selected',
    `Tokens: ${stats.tokens.input.toLocaleString()} in · ${stats.tokens.output.toLocaleString()} out` +
      (stats.tokens.cacheRead ? ` · ${stats.tokens.cacheRead.toLocaleString()} cache read` : ''),
    `Cost: ${formatCost(stats.cost)}`,
    `${stats.userMessages} prompts · ${stats.toolCalls} tool calls`
  ].join('\n')

  return (
    <div className="code-stats" title={tip} data-level={level}>
      <svg width="16" height="16" viewBox="0 0 16 16" className="code-stats__ring" aria-hidden>
        <circle cx="8" cy="8" r={radius} className="code-stats__track" />
        <circle
          cx="8"
          cy="8"
          r={radius}
          className="code-stats__fill"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - Math.min(100, percent ?? 0) / 100)}
        />
      </svg>
      <span className="code-stats__percent">{percent === null ? '—' : `${Math.round(percent)}%`}</span>
      <span className="code-stats__sep" />
      <span>{formatCount(stats.tokens.total)} tokens</span>
      {stats.cost > 0 && (
        <>
          <span className="code-stats__sep" />
          <span>{formatCost(stats.cost)}</span>
        </>
      )}
    </div>
  )
}

function TerminalButton(): JSX.Element {
  const cwd = useCode((s) => s.cwd)
  return (
    <button
      className="header-btn code-terminal-btn"
      onClick={async () => {
        if (!cwd) return
        const result = await window.api.eaonCode.openTerminal(cwd)
        if (!result.ok) useCode.setState({ toast: result.error })
      }}
      title="Open a terminal running eaon-code in this folder"
    >
      <SquareTerminal size={14} strokeWidth={1.9} />
      <span>Open in Terminal</span>
    </button>
  )
}

function MoreMenu(): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const { cwd, session, newSession, compact, start, running } = useCode(
    useShallow((s) => ({
      cwd: s.cwd,
      session: s.session,
      newSession: s.newSession,
      compact: s.compact,
      start: s.start,
      running: s.transcript.running
    }))
  )
  const setSettingsPage = useApp((s) => s.setSettingsPage)
  const act = (fn: () => void): (() => void) => () => {
    menu.close()
    fn()
  }

  return (
    <>
      <button ref={anchor} className="icon-btn" onClick={menu.toggle} aria-label="Session options" data-active={menu.open || undefined}>
        <MoreHorizontal size={16} strokeWidth={1.9} />
      </button>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={240}>
        <MenuItem icon={<SquarePen size={16} strokeWidth={1.8} />} title="New session" onClick={act(() => void newSession())} />
        <MenuItem
          icon={<PencilLine size={16} strokeWidth={1.8} />}
          title="Rename session…"
          disabled={!session}
          onClick={act(() => {
            const name = window.prompt('Name this session', session?.sessionName ?? '')
            if (name?.trim()) void useCode.getState().rename(name.trim())
          })}
        />
        <MenuItem
          icon={<Archive size={16} strokeWidth={1.8} />}
          title="Compact now"
          description="Summarise older context to free up the window"
          disabled={!session || running}
          onClick={act(() => void compact())}
        />
        <MenuSeparator />
        <MenuItem
          icon={<TerminalSquare size={16} strokeWidth={1.8} />}
          title="Continue in Terminal"
          description="Hands this session to eaon-code in a terminal"
          disabled={!cwd || !session}
          onClick={act(async () => {
            if (!cwd) return
            const result = await window.api.eaonCode.openTerminal(cwd, true)
            if (!result.ok) useCode.setState({ toast: result.error })
            else if (!result.data.continued) useCode.setState({ toast: 'This session has no saved reply yet, so the terminal started a new one.' })
          })}
        />
        <MenuItem
          icon={<RotateCw size={16} strokeWidth={1.8} />}
          title="Restart Eaon Code"
          disabled={!cwd}
          // Eaon Code writes a session file with its first reply; before that
          // there is nothing to reopen, so a restart starts fresh.
          onClick={act(() => void start(useCode.getState().stats?.assistantMessages ? session?.sessionFile : undefined))}
        />
        <MenuItem icon={<SettingsIcon size={16} strokeWidth={1.8} />} title="Eaon Code settings" onClick={act(() => setSettingsPage('eaon-code'))} />
      </Popover>
    </>
  )
}
