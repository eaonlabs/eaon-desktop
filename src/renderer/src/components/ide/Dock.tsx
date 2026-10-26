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
import { useAdePlace } from './adeDock'
import { DockPlaceProvider, useChatPlace, useDockPlace, type DockPlace } from './dockPlace'
import { isDirty, useIde, type DockStore, type Surface, type SurfaceKind } from './ideStore'
import { DeviceSurface, useBrowserPage } from './surfaces/DeviceSurface'
import { FileSurface } from './surfaces/FileSurface'
import { FilesView } from './surfaces/FilesView'
import { LinkedPullsSurface, PullRequestSurface, useLinkedPulls } from './surfaces/PullRequests'

/**
 * The dock to the right of a conversation, or of the ADE's terminals.
 * Everything about the work that isn't the conversation opens in it as a
 * tab, a "surface": a page in the browser, a terminal, the folder's files, a
 * file, the diff of what changed, the branch's pull request, the pull
 * requests linked to, the page on a phone, and Eaon's own browser while it
 * browses. Empty, it lists what it can open, each with its letter; + lists
 * the same from anywhere. Its top right fills the window with it, shows
 * Chat's terminal under the conversation, and puts it away. In the ADE it
 * has no terminal (the ADE is terminals) and no Eaon's browser (Chat's
 * agent browses, not the ADE's). Where it is comes from dockPlace.
 */

type Action = 'browser' | 'agent' | 'terminal' | 'files' | 'diff' | 'pr' | 'linked' | 'device'

/** What only a coding chat's dock has: an ordinary chat, in no project, keeps the browser and the device. */
const CODE_KINDS = new Set<string>(['terminal', 'files', 'file', 'diff', 'pr', 'linked'])

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
  const place = useDockPlace()
  const { missing } = place
  const repo = Boolean(place.status?.repo)
  const remote = Boolean(place.status?.remote)
  const linked = useLinkedPulls().length
  const page = useBrowserPage(place.browser)
  const choices: (Choice | false)[] = [
    { action: 'browser', label: 'Browser', letter: 'B', icon: <Globe size={15} strokeWidth={1.8} /> },
    place.id === 'chat' && { action: 'terminal', label: 'Terminal', letter: 'T', icon: <SquareTerminal size={15} strokeWidth={1.8} />, unavailable: missing },
    { action: 'files', label: 'Files', letter: 'F', icon: <FolderTree size={15} strokeWidth={1.8} />, unavailable: missing },
    { action: 'diff', label: 'Diff', letter: 'D', icon: <FileDiff size={15} strokeWidth={1.8} />, unavailable: missing },
    {
      action: 'pr',
      label: 'Pull request',
      letter: 'P',
      icon: <GitPullRequest size={15} strokeWidth={1.8} />,
      unavailable: missing ?? (!repo ? 'This folder isn’t a git repository' : !remote ? 'This repository has no GitHub remote' : undefined)
    },
    {
      action: 'linked',
      label: 'Linked pull requests',
      letter: 'L',
      icon: <Link2 size={15} strokeWidth={1.8} />,
      unavailable: linked ? undefined : place.id === 'chat' ? 'No pull requests linked in this chat yet' : 'No pull requests in this session’s terminals yet'
    },
    { action: 'device', label: 'Device', letter: 'M', icon: <Smartphone size={15} strokeWidth={1.8} />, unavailable: page ? undefined : 'Open a page in the browser first' }
  ]
  return choices.filter((c): c is Choice => c !== false && (place.coding || !CODE_KINDS.has(c.action)))
}

/** The browser in the dock: opened, or a new tab when it is. */
function openBrowser(scope: string): void {
  const app = useApp.getState()
  if (app.browserOpen) useBrowser.getState().newTab(scope)
  else app.toggleBrowser(true)
  window.dispatchEvent(new CustomEvent(BROWSER_REVEAL, { detail: scope }))
}

function run(action: Action, place: DockPlace): void {
  if (action === 'browser') return openBrowser(place.browser)
  if (action === 'agent') {
    useAgentBrowser.getState().setOpen(true, useApp.getState().activeChatId)
    place.store.getState().openSurface('agent')
    return
  }
  place.store.getState().openSurface(action as SurfaceKind)
}

/**
 * Keeps a dock and the browsers in step: the in-app browser's pages (in
 * `browser`, its scope) are the dock's browser tabs while it is open, a page
 * opened from anywhere comes to the front, and with `agent`, Eaon's browser
 * has a tab while it is showing.
 */
export function useDockBridge(on: boolean, { store, browser, agent }: { store: DockStore; browser: string; agent: boolean }): void {
  const browserOpen = useApp((s) => s.browserOpen)
  const agentOpen = useAgentBrowser((s) => s.open)
  const tabIds = useBrowser(useShallow((s) => (s.scopes[browser]?.tabs ?? []).map((t) => t.id)))
  const activeTab = useBrowser((s) => s.scopes[browser]?.activeId ?? null)
  const reveal = useRef(false)

  useEffect(() => {
    if (!on) return
    const onReveal = (event: Event): void => {
      if ((event as CustomEvent<string>).detail !== browser) return
      reveal.current = true
      bringForward()
    }
    window.addEventListener(BROWSER_REVEAL, onReveal)
    return () => window.removeEventListener(BROWSER_REVEAL, onReveal)
  }, [on, browser])

  const bringForward = (): void => {
    const ide = store.getState()
    const scope = useBrowser.getState().scopes[browser]
    const surface = ide.surfaces.find((s) => s.kind === 'browser' && s.tabId === scope?.activeId)
    if (!surface) return
    reveal.current = false
    if (!ide.open) ide.setOpen(true)
    ide.setActiveSurface(surface.id)
  }

  // The pages as tabs, while the browser is open.
  useEffect(() => {
    if (!on) return
    if (browserOpen) useBrowser.getState().ensure(browser)
    store.getState().syncBrowserTabs(browserOpen ? tabIds : [])
    if (reveal.current) bringForward()
  }, [on, browserOpen, tabIds])

  // Opened, or another page in front: the dock shows it. Coming back to this
  // view, or to another session's pages, isn't either, so a dock closed
  // with a page open stays closed.
  const shown = useRef<{ open: boolean; tab: string | null; scope: string } | null>(null)
  useEffect(() => {
    const last = shown.current
    shown.current = { open: browserOpen, tab: activeTab, scope: browser }
    if (!on || !browserOpen) return
    if (!last || (last.scope === browser && (!last.open || last.tab !== activeTab))) bringForward()
  }, [on, browserOpen, activeTab, browser])

  // Eaon's browser: a tab while it shows.
  useEffect(() => {
    if (!on || !agent) return
    const ide = store.getState()
    const surface = ide.surfaces.find((s) => s.kind === 'agent')
    if (agentOpen && !surface) ide.openSurface('agent')
    else if (!agentOpen && surface) ide.closeSurface(surface.id)
  }, [on, agent, agentOpen])
}

/** Chat's dock, beside a conversation. */
export function ChatDock({ closing = false }: { closing?: boolean }): JSX.Element {
  return (
    <DockPlaceProvider place={useChatPlace()}>
      <Dock closing={closing} />
    </DockPlaceProvider>
  )
}

/** The ADE's dock, beside its terminals. */
export function AdeDock({ closing = false }: { closing?: boolean }): JSX.Element {
  return (
    <DockPlaceProvider place={useAdePlace()}>
      <Dock closing={closing} />
    </DockPlaceProvider>
  )
}

function Dock({ closing }: { closing: boolean }): JSX.Element {
  const place = useDockPlace()
  // In the ADE it sits beside the terminals, not a conversation.
  const beside = place.id === 'chat' ? 'Back beside the chat' : 'Back beside the terminals'
  const { surfaces, activeSurface, width, maximized, setOpen, setWidth, setMaximized, setActiveSurface } = place.store(
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
  useFollowWork(place)
  // An ordinary chat's dock keeps a coding chat's terminals and files open, out of sight, for going back to it.
  const shown = place.coding ? surfaces : surfaces.filter((s) => !CODE_KINDS.has(s.kind))
  const current = surfaces.find((s) => s.id === activeSurface) ?? null
  const active = current && !shown.includes(current) ? (shown[0] ?? null) : current

  // Leaving the window full puts it back beside the conversation next time.
  useEffect(() => () => place.store.getState().setMaximized(false), [place.store])

  const select = (surface: Surface): void => {
    setActiveSurface(surface.id)
    if (surface.kind === 'browser' && surface.tabId) useBrowser.getState().activate(place.browser, surface.tabId)
  }

  const close = (surface: Surface): void => {
    if (surface.kind === 'browser') {
      // The last page closes the browser; its tab goes with it.
      const pages = place.store.getState().surfaces.filter((s) => s.kind === 'browser')
      if (pages.length <= 1) useApp.getState().toggleBrowser(false)
      else if (surface.tabId) useBrowser.getState().closeTab(place.browser, surface.tabId)
      return
    }
    if (surface.kind === 'agent') useAgentBrowser.getState().setOpen(false, useApp.getState().activeChatId)
    place.store.getState().closeSurface(surface.id)
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
      data-place={place.id}
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
            {shown.map((surface) => (
              <SurfaceTab key={surface.id} surface={surface} active={surface.id === active?.id} onSelect={() => select(surface)} onClose={() => close(surface)} />
            ))}
          </div>
          <div className="dock__tools">
            <button
              type="button"
              className="dock-tool"
              aria-label={maximized ? beside : 'Fill the window'}
              title={maximized ? beside : 'Fill the window'}
              onClick={() => setMaximized(!maximized)}
            >
              {maximized ? <Minimize2 size={14} strokeWidth={1.9} /> : <Maximize2 size={14} strokeWidth={1.9} />}
            </button>
            {place.id === 'chat' && place.coding && <DrawerToggle />}
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
  const place = useDockPlace()
  return (
    <div className="dock__surface" data-kind={surface.kind}>
      {surface.kind === 'terminal' ? (
        <DockTerminal surfaceId={surface.id} title={surface.title ?? 'Terminal'} onNew={() => run('terminal', place)} />
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
  const place = useDockPlace()
  const page = useBrowser((s) => (surface.kind === 'browser' ? s.scopes[place.browser]?.tabs.find((t) => t.id === surface.tabId) : undefined))
  const dirty = place.store((s) => (surface.kind === 'file' ? s.tabs.some((t) => t.path === surface.path && isDirty(t)) : false))
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
            onError={() => surface.tabId && useBrowser.getState().patchTab(place.browser, surface.tabId, { favicon: null })}
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

/** How many files the chat changed, or how many are uncommitted in the ADE, on the Diff tab. */
function DiffCount(): JSX.Element | null {
  const place = useDockPlace()
  return place.id === 'chat' ? <ChatDiffCount /> : <Count files={place.status?.changes?.files ?? 0} />
}

function ChatDiffCount(): JSX.Element | null {
  return <Count files={useChatChanges().files} />
}

function Count({ files }: { files: number }): JSX.Element | null {
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

/** A top bar's switch for its dock: the conversation's, or the ADE's (`store`, and what it holds there). */
export function DockToggle({ store = useIde, holds = 'browser, terminal, files, diff, pull request' }: { store?: DockStore; holds?: string }): JSX.Element {
  const { open, setOpen } = store(useShallow((s) => ({ open: s.open, setOpen: s.setOpen })))
  return (
    <button
      type="button"
      className="dock-tool"
      data-active={open || undefined}
      aria-pressed={open}
      aria-label="Dock"
      title={open ? 'Close the dock' : `Open the dock: ${holds}`}
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
  const place = useDockPlace()
  const choices = useChoices()
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current?.focus({ preventScroll: true })
  }, [])
  const onKey = (event: ReactKeyboardEvent): void => {
    const choice = byLetter(choices, event)
    if (!choice) return
    event.preventDefault()
    run(choice.action, place)
  }
  return (
    <div className="dock-launch">
      <div ref={list} className="dock-launch__card" tabIndex={-1} onKeyDown={onKey} aria-label="Open a surface">
        <div className="dock-launch__title">Open a surface</div>
        {choices.map((choice) => (
          <ChoiceRow key={choice.action} choice={choice} onPick={() => run(choice.action, place)} />
        ))}
      </div>
    </div>
  )
}

function ChoiceRow({ choice, onPick, menu = false }: { choice: Choice; onPick: () => void; menu?: boolean }): JSX.Element {
  const place = useDockPlace()
  const [more, setMore] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const agentUsed = useAgentBrowserUsed()
  // Chat's browser row also offers Eaon's browser; the ADE has only the one.
  const isBrowser = choice.action === 'browser' && place.id === 'chat'
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
                run('browser', place)
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
                run('agent', place)
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
  const place = useDockPlace()
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
      run(choice.action, place)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, choices, place])
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
              run(choice.action, place)
            }}
          />
        ))}
      </Popover>
    </>
  )
}

/** Calls that change files on disk; when one finishes, the tree reads again. */
const CHANGES_FILES = new Set(['edit_file', 'write_file', 'delete_file', 'move_file', 'run_command', 'generate_image'])

/** How often the ADE's dock reads its files again: its agents' edits come with no call to wait for. */
const ADE_FILES_EVERY_MS = 4000

/** Keeps the tree and the open files in step with the disk as the agent works. */
function useFollowWork(place: DockPlace): void {
  const chat = place.id === 'chat'
  const finished = useApp((s) => {
    if (!chat) return 0
    let n = 0
    for (const message of s.activeChat()?.messages ?? []) {
      for (const part of message.parts) if (part.type === 'tool' && part.status !== 'running' && CHANGES_FILES.has(part.name)) n++
    }
    return n
  })
  const refresh = place.store((s) => s.refresh)
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
  // The ADE's agents write in their terminals: a look every few seconds while the window is in view.
  useEffect(() => {
    if (chat) return
    const timer = window.setInterval(() => document.visibilityState === 'visible' && void refresh(), ADE_FILES_EVERY_MS)
    return () => window.clearInterval(timer)
  }, [chat, refresh])
}
