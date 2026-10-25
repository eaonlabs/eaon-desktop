import { useEffect, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  ChevronDown,
  FileDiff,
  FolderTree,
  Globe,
  Link2,
  Maximize2,
  Minimize2,
  MonitorPlay,
  PanelBottom,
  PanelRight,
  Plus,
  Smartphone,
  SquareTerminal,
  GitPullRequest,
  X
} from 'lucide-react'
import { useApp } from '../../state/store'
import { FileIcon, splitPath } from '../agent/FileIcon'
import { useAgentBrowser } from '../agentBrowser/agentBrowserStore'
import { AgentBrowserSurface } from '../agentBrowser/AgentBrowserPanel'
import { BrowserPanel } from '../browser/BrowserPanel'
import { BROWSER_REVEAL, useBrowser } from '../browser/browserStore'
import { ChangesPane } from '../chatCode/ChangesPane'
import { useChatCode } from '../chatCode/chatCodeStore'
import { DockTerminal } from '../chatCode/TerminalPanes'
import { Popover } from '../ui'
import { useChatChanges } from './changes'
import { isDirty, useIde, type Surface, type SurfaceKind } from './ideStore'
import { DeviceSurface, useBrowserPage } from './surfaces/DeviceSurface'
import { FileSurface } from './surfaces/FileSurface'
import { FilesView } from './surfaces/FilesView'
import { LinkedPullsSurface, PullRequestSurface, useLinkedPulls } from './surfaces/PullRequests'

/**
 * The dock to the right of a conversation. Everything about the work that
 * isn't the conversation opens in it as a tab, a "surface": a page in the
 * browser, a terminal, the folder's files, a file, the diff of what changed,
 * the branch's pull request, the pull requests the chat links to, the page
 * on a phone, and Eaon's own browser while it browses. Empty, it lists what
 * it can open, each with its letter; + lists the same from anywhere. Its top
 * right fills the window with it, shows the terminal under the conversation,
 * and puts it away.
 */

type Action = 'browser' | 'agent' | 'terminal' | 'files' | 'diff' | 'pr' | 'linked' | 'device'

interface Choice {
  action: Action
  label: string
  letter: string
  icon: ReactNode
  /** Why it can't open now; undefined when it can. */
  unavailable?: string
}

/** What the dock can open, and which of it can open now. */
function useChoices(): Choice[] {
  const { folder, repo, remote } = useChatCode(useShallow((s) => ({ folder: s.folder, repo: Boolean(s.status?.repo), remote: Boolean(s.status?.remote) })))
  const linked = useLinkedPulls().length
  const page = useBrowserPage()
  const noFolder = 'Pick a folder for this chat first'
  return [
    { action: 'browser', label: 'Browser', letter: 'B', icon: <Globe size={15} strokeWidth={1.8} /> },
    { action: 'terminal', label: 'Terminal', letter: 'T', icon: <SquareTerminal size={15} strokeWidth={1.8} />, unavailable: folder ? undefined : noFolder },
    { action: 'files', label: 'Files', letter: 'F', icon: <FolderTree size={15} strokeWidth={1.8} />, unavailable: folder ? undefined : noFolder },
    { action: 'diff', label: 'Diff', letter: 'D', icon: <FileDiff size={15} strokeWidth={1.8} />, unavailable: folder ? undefined : noFolder },
    {
      action: 'pr',
      label: 'Pull request',
      letter: 'P',
      icon: <GitPullRequest size={15} strokeWidth={1.8} />,
      unavailable: !folder ? noFolder : !repo ? 'This folder isn’t a git repository' : !remote ? 'This repository has no GitHub remote' : undefined
    },
    {
      action: 'linked',
      label: 'Linked pull requests',
      letter: 'L',
      icon: <Link2 size={15} strokeWidth={1.8} />,
      unavailable: linked ? undefined : 'No pull requests linked in this chat yet'
    },
    { action: 'device', label: 'Device', letter: 'M', icon: <Smartphone size={15} strokeWidth={1.8} />, unavailable: page ? undefined : 'Open a page in the browser first' }
  ]
}

/** The browser in the chat: opened, or a new tab when it is. */
function openBrowser(): void {
  const app = useApp.getState()
  if (app.browserOpen) useBrowser.getState().newTab('chat')
  else app.toggleBrowser(true)
  window.dispatchEvent(new Event(BROWSER_REVEAL))
}

function run(action: Action): void {
  if (action === 'browser') return openBrowser()
  if (action === 'agent') {
    useAgentBrowser.getState().setOpen(true, useApp.getState().activeChatId)
    useIde.getState().openSurface('agent')
    return
  }
  useIde.getState().openSurface(action as SurfaceKind)
}

/**
 * Keeps the dock and the browsers in step: the in-app browser's pages are
 * the dock's browser tabs while it is open, a page opened from anywhere
 * comes to the front, and Eaon's browser has a tab while it is showing.
 */
export function useDockBridge(on: boolean): void {
  const browserOpen = useApp((s) => s.browserOpen)
  const agentOpen = useAgentBrowser((s) => s.open)
  const tabIds = useBrowser(useShallow((s) => (s.scopes.chat?.tabs ?? []).map((t) => t.id)))
  const activeTab = useBrowser((s) => s.scopes.chat?.activeId ?? null)
  const reveal = useRef(false)

  useEffect(() => {
    if (!on) return
    const onReveal = (): void => {
      reveal.current = true
      bringForward()
    }
    window.addEventListener(BROWSER_REVEAL, onReveal)
    return () => window.removeEventListener(BROWSER_REVEAL, onReveal)
  }, [on])

  const bringForward = (): void => {
    const ide = useIde.getState()
    const scope = useBrowser.getState().scopes.chat
    const surface = ide.surfaces.find((s) => s.kind === 'browser' && s.tabId === scope?.activeId)
    if (!surface) return
    reveal.current = false
    if (!ide.open) ide.setOpen(true)
    ide.setActiveSurface(surface.id)
  }

  // The pages as tabs, while the browser is open.
  useEffect(() => {
    if (!on) return
    if (browserOpen) useBrowser.getState().ensure('chat')
    useIde.getState().syncBrowserTabs(browserOpen ? tabIds : [])
    if (reveal.current) bringForward()
  }, [on, browserOpen, tabIds])

  // Opened, or another page in front: the dock shows it.
  useEffect(() => {
    if (on && browserOpen) bringForward()
  }, [on, browserOpen, activeTab])

  // Eaon's browser: a tab while it shows.
  useEffect(() => {
    if (!on) return
    const ide = useIde.getState()
    const surface = ide.surfaces.find((s) => s.kind === 'agent')
    if (agentOpen && !surface) ide.openSurface('agent')
    else if (!agentOpen && surface) ide.closeSurface(surface.id)
  }, [on, agentOpen])
}

export function Dock({ closing = false }: { closing?: boolean }): JSX.Element {
  const { surfaces, activeSurface, width, maximized, setOpen, setWidth, setMaximized, setActiveSurface } = useIde(
    useShallow((s) => ({
      surfaces: s.surfaces,
      activeSurface: s.activeSurface,
      width: s.width,
      maximized: s.maximized,
      setOpen: s.setOpen,
      setWidth: s.setWidth,
      setMaximized: s.setMaximized,
      setActiveSurface: s.setActiveSurface
    }))
  )
  const browserOpen = useApp((s) => s.browserOpen)
  const panel = useRef<HTMLElement>(null)
  useFollowAgent()
  const active = surfaces.find((s) => s.id === activeSurface) ?? null

  // Leaving the window full puts it back beside the conversation next time.
  useEffect(() => () => useIde.getState().setMaximized(false), [])

  const select = (surface: Surface): void => {
    setActiveSurface(surface.id)
    if (surface.kind === 'browser' && surface.tabId) useBrowser.getState().activate('chat', surface.tabId)
  }

  const close = (surface: Surface): void => {
    if (surface.kind === 'browser') {
      // The last page closes the browser; its tab goes with it.
      const pages = useIde.getState().surfaces.filter((s) => s.kind === 'browser')
      if (pages.length <= 1) useApp.getState().toggleBrowser(false)
      else if (surface.tabId) useBrowser.getState().closeTab('chat', surface.tabId)
      return
    }
    if (surface.kind === 'agent') useAgentBrowser.getState().setOpen(false, useApp.getState().activeChatId)
    useIde.getState().closeSurface(surface.id)
  }

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || maximized) return
    event.preventDefault()
    const startX = event.clientX
    const startW = panel.current?.offsetWidth ?? width
    // As far as leaves the chat 520px beside the sidebar (ide.css caps it the same way).
    const sidebar = document.querySelector<HTMLElement>('.sidebar')?.offsetWidth ?? 0
    const max = Math.max(360, window.innerWidth - 520 - sidebar)
    const move = (e: PointerEvent): void => setWidth(Math.min(max, Math.max(360, startW + startX - e.clientX)))
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.removeAttribute('data-resizing')
    }
    document.body.setAttribute('data-resizing', 'ide')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <aside
      ref={panel}
      className="ide dock"
      style={{ '--ide-w': `${width}px` } as CSSProperties}
      data-closing={closing || undefined}
      data-max={maximized || undefined}
      aria-label="Dock"
    >
      {!maximized && <div className="ide__resize" onPointerDown={startResize} aria-hidden />}
      {/* Full width from the first frame of the slide, so nothing inside (a terminal above all) reflows as the column grows. */}
      <div className="dock__frame">
        <div className="dock__bar">
          <AddMenu />
          <div className="dock__tabs" role="tablist" aria-label="Open in the dock">
            {surfaces.map((surface) => (
              <SurfaceTab key={surface.id} surface={surface} active={surface.id === active?.id} onSelect={() => select(surface)} onClose={() => close(surface)} />
            ))}
          </div>
          <div className="dock__tools">
            <button
              type="button"
              className="dock-tool"
              aria-label={maximized ? 'Back beside the conversation' : 'Fill the window'}
              title={maximized ? 'Back beside the conversation' : 'Fill the window'}
              onClick={() => setMaximized(!maximized)}
            >
              {maximized ? <Minimize2 size={14} strokeWidth={1.9} /> : <Maximize2 size={14} strokeWidth={1.9} />}
            </button>
            <DrawerToggle />
            <button type="button" className="dock-tool" data-active aria-label="Close the dock" title="Close the dock" onClick={() => setOpen(false)}>
              <PanelRight size={15} strokeWidth={1.8} />
            </button>
          </div>
        </div>
        <div className="dock__body">
          {/* Kept mounted while the browser is open, so its pages keep their place behind other tabs. */}
          {browserOpen && (
            <div className="dock__surface" hidden={active?.kind !== 'browser'}>
              <BrowserPanel embedded />
            </div>
          )}
          {active && active.kind !== 'browser' ? <SurfaceBody key={active.id} surface={active} /> : !active && <Launcher />}
        </div>
      </div>
    </aside>
  )
}

function SurfaceBody({ surface }: { surface: Surface }): JSX.Element {
  return (
    <div className="dock__surface" data-kind={surface.kind}>
      {surface.kind === 'terminal' ? (
        <DockTerminal surfaceId={surface.id} title={surface.title ?? 'Terminal'} onNew={() => run('terminal')} />
      ) : surface.kind === 'files' ? (
        <FilesView />
      ) : surface.kind === 'file' ? (
        <FileSurface surface={surface} />
      ) : surface.kind === 'diff' ? (
        <div className="dock__diff">
          <ChangesPane />
        </div>
      ) : surface.kind === 'pr' ? (
        <PullRequestSurface />
      ) : surface.kind === 'linked' ? (
        <LinkedPullsSurface />
      ) : surface.kind === 'device' ? (
        <DeviceSurface />
      ) : (
        <AgentBrowserSurface />
      )}
    </div>
  )
}

/** A tab's name and mark. */
function useSurfaceLook(surface: Surface): { label: string; icon: ReactNode; dirty?: boolean; live?: boolean } {
  const page = useBrowser((s) => (surface.kind === 'browser' ? s.scopes.chat?.tabs.find((t) => t.id === surface.tabId) : undefined))
  const dirty = useIde((s) => (surface.kind === 'file' ? s.tabs.some((t) => t.path === surface.path && isDirty(t)) : false))
  const agentWorking = useAgentBrowser((s) => surface.kind === 'agent' && s.open)
  switch (surface.kind) {
    case 'browser':
      return {
        label: page?.title || 'New tab',
        icon: page?.favicon ? (
          <img
            className="dock-tab__favicon"
            src={page.favicon}
            alt=""
            width={14}
            height={14}
            // A page's icon the app can't load: the globe instead.
            onError={() => surface.tabId && useBrowser.getState().patchTab('chat', surface.tabId, { favicon: null })}
          />
        ) : (
          <Globe size={14} strokeWidth={1.8} />
        ),
        live: page?.loading
      }
    case 'terminal':
      return { label: surface.title ?? 'Terminal', icon: <SquareTerminal size={14} strokeWidth={1.8} /> }
    case 'files':
      return { label: 'Files', icon: <FolderTree size={14} strokeWidth={1.8} /> }
    case 'file': {
      const name = splitPath(surface.path ?? '').name
      return { label: name, icon: <FileIcon file={name} size={14} />, dirty }
    }
    case 'diff':
      return { label: 'Diff', icon: <FileDiff size={14} strokeWidth={1.8} /> }
    case 'pr':
      return { label: 'Pull request', icon: <GitPullRequest size={14} strokeWidth={1.8} /> }
    case 'linked':
      return { label: 'Linked pull requests', icon: <Link2 size={14} strokeWidth={1.8} /> }
    case 'device':
      return { label: 'Device', icon: <Smartphone size={14} strokeWidth={1.8} /> }
    case 'agent':
      return { label: 'Eaon’s browser', icon: <MonitorPlay size={14} strokeWidth={1.8} />, live: agentWorking }
  }
}

function SurfaceTab({ surface, active, onSelect, onClose }: { surface: Surface; active: boolean; onSelect: () => void; onClose: () => void }): JSX.Element {
  const { label, icon, dirty, live } = useSurfaceLook(surface)
  const tab = useRef<HTMLDivElement>(null)
  // The tab in front stays in view in a crowded strip.
  useEffect(() => {
    if (active) tab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])
  return (
    <div ref={tab} className="dock-tab" data-active={active || undefined} title={surface.path ?? label}>
      <button type="button" role="tab" aria-selected={active} className="dock-tab__open" onClick={onSelect} onAuxClick={(e) => e.button === 1 && onClose()}>
        <span className="dock-tab__icon">{icon}</span>
        <span className="dock-tab__label">{label}</span>
        {surface.kind === 'diff' && <DiffCount />}
        {live && <span className="dock-tab__live" aria-label="Loading" />}
      </button>
      <button type="button" className="dock-tab__close" data-dirty={dirty || undefined} aria-label={`Close ${label}`} onClick={onClose}>
        <X size={12} strokeWidth={2.2} />
      </button>
    </div>
  )
}

/** How many files the chat changed, on the Diff tab. */
function DiffCount(): JSX.Element | null {
  const files = useChatChanges().files
  return files > 0 ? <span className="dock-tab__count">{files}</span> : null
}

/** The bottom terminal's switch, here and in the conversation's top bar. */
export function DrawerToggle(): JSX.Element {
  const { open, toggle } = useChatCode(useShallow((s) => ({ open: s.drawerOpen, toggle: s.toggleDrawer })))
  const mac = navigator.platform.startsWith('Mac')
  return (
    <button
      type="button"
      className="dock-tool"
      data-active={open || undefined}
      aria-pressed={open}
      aria-label="Terminal panel"
      title={`${open ? 'Hide' : 'Show'} the terminal (${mac ? '⌘J' : 'Ctrl+J'})`}
      onClick={() => toggle()}
    >
      <PanelBottom size={15} strokeWidth={1.8} />
    </button>
  )
}

/** The conversation's top bar switch for the dock. */
export function DockToggle(): JSX.Element {
  const { open, setOpen } = useIde(useShallow((s) => ({ open: s.open, setOpen: s.setOpen })))
  return (
    <button
      type="button"
      className="dock-tool"
      data-active={open || undefined}
      aria-pressed={open}
      aria-label="Dock"
      title={open ? 'Close the dock' : 'Open the dock: browser, terminal, files, diff, pull request'}
      onClick={() => setOpen(!open)}
    >
      <PanelRight size={15} strokeWidth={1.8} />
    </button>
  )
}

/** Picks a choice by its letter. */
function byLetter(choices: Choice[], event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): Choice | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return null
  const choice = choices.find((c) => c.letter.toLowerCase() === event.key.toLowerCase())
  return choice && !choice.unavailable ? choice : null
}

/** An empty dock: what it can open. */
function Launcher(): JSX.Element {
  const choices = useChoices()
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current?.focus({ preventScroll: true })
  }, [])
  const onKey = (event: ReactKeyboardEvent): void => {
    const choice = byLetter(choices, event)
    if (!choice) return
    event.preventDefault()
    run(choice.action)
  }
  return (
    <div className="dock-launch">
      <div ref={list} className="dock-launch__card" tabIndex={-1} onKeyDown={onKey} aria-label="Open a surface">
        <div className="dock-launch__title">Open a surface</div>
        {choices.map((choice) => (
          <ChoiceRow key={choice.action} choice={choice} onPick={() => run(choice.action)} />
        ))}
      </div>
    </div>
  )
}

function ChoiceRow({ choice, onPick, menu = false }: { choice: Choice; onPick: () => void; menu?: boolean }): JSX.Element {
  const [more, setMore] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const agentUsed = useAgentBrowserUsed()
  const isBrowser = choice.action === 'browser'
  return (
    <div ref={anchor} className="dock-choice" data-menu={menu || undefined}>
      <button
        type="button"
        role={menu ? 'menuitem' : undefined}
        className="dock-choice__main"
        disabled={Boolean(choice.unavailable)}
        title={choice.unavailable}
        onClick={onPick}
      >
        <span className="dock-choice__icon">{choice.icon}</span>
        <span className="dock-choice__label">{choice.label}</span>
        {!isBrowser && <kbd className="dock-choice__key">{choice.letter}</kbd>}
      </button>
      {isBrowser && (
        <>
          <button type="button" className="dock-choice__more" aria-label="More browsers" title="More browsers" data-open={more || undefined} onClick={() => setMore(!more)}>
            <ChevronDown size={13} strokeWidth={2} />
          </button>
          <kbd className="dock-choice__key">{choice.letter}</kbd>
          <Popover anchor={anchor} open={more} onClose={() => setMore(false)} placement="bottom-end" width={240}>
            <button
              type="button"
              role="menuitem"
              className="menu__item"
              onClick={() => {
                setMore(false)
                run('browser')
              }}
            >
              <span className="menu__item-icon">
                <Globe size={15} strokeWidth={1.8} />
              </span>
              <span className="menu__item-body">
                <span className="menu__item-title">New tab</span>
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="menu__item menu__item--tall"
              disabled={!agentUsed}
              onClick={() => {
                setMore(false)
                run('agent')
              }}
            >
              <span className="menu__item-icon">
                <MonitorPlay size={15} strokeWidth={1.8} />
              </span>
              <span className="menu__item-body">
                <span className="menu__item-title">Eaon’s browser</span>
                <span className="menu__item-desc">{agentUsed ? 'Watch the pages Eaon works in' : 'Once Eaon browses in this chat'}</span>
              </span>
            </button>
          </Popover>
        </>
      )}
    </div>
  )
}

/** Whether Eaon has used its own browser in this chat. */
function useAgentBrowserUsed(): boolean {
  const chatId = useApp((s) => s.activeChatId)
  const usedHere = useApp((s) => s.activeChat()?.messages.some((m) => m.parts.some((p) => p.type === 'tool' && p.name === 'web_browser')) ?? false)
  const used = useAgentBrowser((s) => s.used)
  return usedHere || Boolean(chatId && used.has(chatId))
}

/** + at the start of the tabs: the launcher's list as a menu. */
function AddMenu(): JSX.Element {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const choices = useChoices()
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      const choice = byLetter(choices, event)
      if (!choice) return
      event.preventDefault()
      setOpen(false)
      run(choice.action)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, choices])
  return (
    <>
      <button ref={anchor} type="button" className="dock-tool dock__add" aria-label="Open a surface" title="Open a surface" data-active={open || undefined} onClick={() => setOpen(!open)}>
        <Plus size={15} strokeWidth={1.9} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-start" width={260} className="dock-add">
        <div className="menu__label">Open a surface</div>
        {choices.map((choice) => (
          <ChoiceRow
            key={choice.action}
            menu
            choice={choice}
            onPick={() => {
              setOpen(false)
              run(choice.action)
            }}
          />
        ))}
      </Popover>
    </>
  )
}

/** Calls that change files on disk; when one finishes, the tree reads again. */
const CHANGES_FILES = new Set(['edit_file', 'write_file', 'delete_file', 'move_file', 'run_command', 'generate_image'])

function useFollowAgent(): void {
  const finished = useApp((s) => {
    let n = 0
    for (const message of s.activeChat()?.messages ?? []) {
      for (const part of message.parts) if (part.type === 'tool' && part.status !== 'running' && CHANGES_FILES.has(part.name)) n++
    }
    return n
  })
  const refresh = useIde((s) => s.refresh)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    void refresh()
  }, [finished, refresh])
  // Back from another app: what changed there shows here.
  useEffect(() => {
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])
}
