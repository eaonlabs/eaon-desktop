import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Activity,
  Archive,
  Chrome,
  Code2,
  SquareTerminal,
  Gamepad2,
  ArrowLeft,
  Binary,
  Cable,
  AppWindow,
  AtSign,
  BarChart3,
  Users,
  Cpu,
  KeyRound,
  Plug,
  Server,
  Settings as SettingsIcon,
  ShieldCheck,
  Lock,
  Smartphone,
  SquarePlus,
  Sun,
  Wand2, Gauge, Bot, Search } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp, useIsWork } from '../../state/store'
import { THEMES } from '../../lib/themes'
import { SearchField } from '../ui'
import { SignInPrompt } from '../account/ToknAccount'
import { ErrorBoundary } from '../ErrorBoundary'
import { SettingsPageError } from '../CrashScreen'
import { WorkersGlyph } from '../ModeSwitch'
import { GeneralPage } from './pages/General'
import { AppearancePage } from './pages/Appearance'
import { ConfigurationPage } from './pages/Configuration'
import { ShortcutsPage } from './pages/Shortcuts'
import { ProvidersPage } from './pages/Providers'
import { ArchivedPage } from './pages/Archived'
import { BrowserSettingsPage } from './pages/Misc'
import { ComputerUsePage } from './pages/ComputerUse'
import { PluginsSettingsPage } from './pages/Plugins'
import { LocalServerPage } from './pages/LocalServer'
import { RemoteDevicesPage } from './pages/RemoteDevices'
import { SystemMonitorPage } from './pages/SystemMonitor'
import { McpServersPage } from './pages/McpServers'
import { ConnectAppsPage } from './pages/ConnectApps'
import { CodeIndexPage } from './pages/CodeIndex'
import { BrowserControlPage } from './pages/BrowserControl'
import { EaonCodePage } from './pages/EaonCode'
import { AdePage } from './pages/Ade'
import { DiscordPage } from './pages/Discord'
import { UsagePage } from './pages/Usage'
import { UsageLimitsPage } from './pages/UsageLimits'
import { AgentProvidersPage } from './pages/AgentProviders'
import { AccountsPage } from './pages/Accounts'
import { WORKER_TABS, WorkersPage } from './pages/Workers'
import { EnginesPage } from './pages/Engines'
import { SecurityPage } from './pages/Security'
import type { PolicyFeature } from '@shared/enterprise'

interface NavEntry {
  id: string
  label: string
  icon: ReactNode
  group: string
  /** A tab of another page: listed only when a search finds it. */
  parent?: string
}

const size = 16
const stroke = 1.9

/**
 * What people search for that isn't a page's name, so "dark mode" finds
 * Appearance and "api key" finds Model providers instead of a blank list.
 * Each word searched for has to be somewhere in a page's name or its words,
 * in any order. Keep these to what the page really has: a word that leads
 * to a page without it is worse than no match.
 */
const KEYWORDS: Record<string, string> = {
  general:
    'update updates beta stable version launch login startup open on launch sleep prevent awake suggested prompts full access permissions approval approvals approve without asking tour take the tour what’s new whats new documentation docs help resources release notes license star github report issue bug other ai apps',
  appearance: `theme themes dark light mode system color colour font size text zoom accent icon app icon motion reduce contrast glass blur transparency transparent frosted translucent sidebar see-through see through wallpaper picture background tint ${THEMES.map((t) => t.name).join(' ')}`.toLowerCase(),
  configuration: 'web search search engine internet',
  shortcuts: 'keyboard hotkey hotkeys keys key bindings',
  usage: 'tokens cost spend limits tokn activity streak',
  'usage-limits': 'quota limit remaining reset codex claude cursor copilot grok opencode devin credits balance rings header meter',
  accounts: 'claude code codex sign in login plan limit limits switch account usage meter alerts',
  providers:
    'api key keys openai anthropic claude gemini google openrouter ollama lm studio model models free credits event code hackathon eaon free eaon lite sign in custom provider base url endpoint logo fallback speech to text voice dictation whisper transcribe',
  engines: 'claude code codex copilot gemini cli agent engine sandbox subscription',
  'agent-providers': 'cli coding agents claude codex cursor opencode droid grok antigravity gemini copilot install update version picker order hide priority',
  'computer-use': 'screen mouse keyboard accessibility screen recording permissions emergency stop screenshot',
  payments: 'card purchase buy money spending limit',
  'browser-control': 'chrome extension browser',
  plugins: 'skills mcp extensions',
  'eaon-code': 'coding agent cli terminal binary path',
  ade: 'terminal theme shell worktree worktrees coding scenes hold to talk dictation voice push to talk sessions',
  workers: 'background agents',
  'chat-apps': 'telegram slack whatsapp discord imessage messages bot',
  email: 'agentmail inbox mail domain',
  discord: 'rich presence status activity',
  browser: 'homepage search engine tabs',
  mcp: 'model context protocol tools servers timeout',
  'connect-apps': 'import openclaw hermes cline apps claude plan claude code tools mcp',
  'code-index': 'embedding semantic search index repository goal goal mode continuations time limit token limit',
  'local-server': 'port api server openai compatible gateway key',
  'remote-devices': 'phone mobile remote web rc github',
  system: 'cpu memory ram gpu performance monitor',
  security: 'audit log policy enterprise organization verify integrity records',
  archived: 'archive restore deleted chats history'
}

/** Whether every word of `query` is in `haystack`. */
const matchesAll = (query: string, haystack: string): boolean => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const text = haystack.toLowerCase().replace(/[’']/g, '')
  return words.every((word) => text.includes(word.replace(/[’']/g, '')))
}

const NAV: NavEntry[] = [
  { id: 'general', label: 'General', icon: <SettingsIcon size={size} strokeWidth={stroke} />, group: 'Personal' },
  { id: 'appearance', label: 'Appearance', icon: <Sun size={size} strokeWidth={stroke} />, group: 'Personal' },
  { id: 'configuration', label: 'Configuration', icon: <ShieldCheck size={size} strokeWidth={stroke} />, group: 'Personal' },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: <SquarePlus size={size} strokeWidth={stroke} />, group: 'Personal' },
  { id: 'usage', label: 'Usage', icon: <BarChart3 size={size} strokeWidth={stroke} />, group: 'Personal' },
  { id: 'usage-limits', label: 'Usage & limits', icon: <Gauge size={size} strokeWidth={stroke} />, group: 'Personal' },
  { id: 'accounts', label: 'Accounts', icon: <Users size={size} strokeWidth={stroke} />, group: 'Personal' },

  { id: 'providers', label: 'Model providers', icon: <KeyRound size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'agent-providers', label: 'Agent providers', icon: <Bot size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'engines', label: 'Agent engines', icon: <Cpu size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'computer-use', label: 'Computer use', icon: <Wand2 size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'browser-control', label: 'Browser control', icon: <Chrome size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'plugins', label: 'Plugins', icon: <AtSign size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'eaon-code', label: 'Eaon Code', icon: <Code2 size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'ade', label: 'ADE', icon: <SquareTerminal size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'workers', label: 'Workers', icon: <WorkersGlyph size={size} strokeWidth={stroke} />, group: 'Integrations' },
  ...WORKER_TABS.map((tab) => ({ id: tab.id, label: tab.label, icon: <tab.icon size={size} strokeWidth={stroke} />, group: 'Integrations', parent: 'workers' })),
  { id: 'discord', label: 'Discord', icon: <Gamepad2 size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'browser', label: 'Browser', icon: <AppWindow size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'mcp', label: 'MCP Servers', icon: <Plug size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'connect-apps', label: 'Connect apps', icon: <Cable size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'code-index', label: 'Code index', icon: <Binary size={size} strokeWidth={stroke} />, group: 'Integrations' },

  { id: 'local-server', label: 'Local API Server', icon: <Server size={size} strokeWidth={stroke} />, group: 'Advanced' },
  { id: 'remote-devices', label: 'Remote devices', icon: <Smartphone size={size} strokeWidth={stroke} />, group: 'Advanced' },
  { id: 'system', label: 'System Monitor', icon: <Activity size={size} strokeWidth={stroke} />, group: 'Advanced' },
  { id: 'security', label: 'Security', icon: <Lock size={size} strokeWidth={stroke} />, group: 'Advanced' },

  { id: 'archived', label: 'Archived chats', icon: <Archive size={size} strokeWidth={stroke} />, group: 'Archived' }
]

/** Only meaningful when a project folder is open, which is an Eaon Work
    concept — Browser drives `BrowserPanel` (Eaon Work only, see App.tsx) and
    Code index powers `codebase_search` over that folder. */
const WORK_ONLY_PAGES = new Set(['browser', 'code-index'])

/** Pages for surfaces an organization's policy can turn off; hidden when it does. */
const POLICY_PAGES: Record<string, PolicyFeature> = {
  'remote-devices': 'remoteAccess',
  'local-server': 'localApiServer',
  'computer-use': 'computerUse',
  payments: 'payments',
  'chat-apps': 'channels',
  email: 'email',
  'browser-control': 'browserUse',
  discord: 'discordPresence'
}

/** The page a tab belongs to, for the tabs that are part of a page. */
const PARENT: Record<string, string> = Object.fromEntries(NAV.filter((entry) => entry.parent).map((entry) => [entry.id, entry.parent!]))

const PAGES: Record<string, (props: { blocked: ReadonlySet<string> }) => JSX.Element> = {
  general: GeneralPage,
  appearance: AppearancePage,
  configuration: ConfigurationPage,
  shortcuts: ShortcutsPage,
  usage: UsagePage,
  'usage-limits': UsageLimitsPage,
  accounts: AccountsPage,
  providers: ProvidersPage,
  engines: EnginesPage,
  'agent-providers': AgentProvidersPage,
  'computer-use': ComputerUsePage,
  'browser-control': BrowserControlPage,
  'eaon-code': EaonCodePage,
  ade: AdePage,
  discord: DiscordPage,
  workers: WorkersPage,
  plugins: PluginsSettingsPage,
  browser: BrowserSettingsPage,
  mcp: McpServersPage,
  'connect-apps': ConnectAppsPage,
  'code-index': CodeIndexPage,
  'local-server': LocalServerPage,
  'remote-devices': RemoteDevicesPage,
  system: SystemMonitorPage,
  security: SecurityPage,
  archived: ArchivedPage
}

export function SettingsShell(): JSX.Element {
  const { settingsPage, setSettingsPage, setView } = useApp(
    useShallow((s) => ({ settingsPage: s.settingsPage, setSettingsPage: s.setSettingsPage, setView: s.setView }))
  )
  const isWork = useIsWork()
  const [query, setQuery] = useState('')
  // A narrow window's icon rail opened into the whole panel, to search (settings.css).
  const [expanded, setExpanded] = useState(false)
  const nav = useRef<HTMLElement>(null)
  const collapse = (): void => {
    setExpanded(false)
    setQuery('')
  }
  useEffect(() => {
    if (!expanded) return
    nav.current?.querySelector<HTMLInputElement>('.settings__search input')?.focus()
    const onDown = (event: PointerEvent): void => {
      if (!nav.current?.contains(event.target as Node)) collapse()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') collapse()
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [expanded])

  // A page can be open from before Eaon Work was last disabled; send it
  // somewhere real rather than rendering a page with no matching nav item.
  useEffect(() => {
    if (!isWork && WORK_ONLY_PAGES.has(settingsPage)) setSettingsPage('general')
  }, [isWork, settingsPage, setSettingsPage])

  // Features the organization's policy turned off (enterprise:status).
  const [blocked, setBlocked] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    void window.api.enterprise
      .status()
      .then(({ policy }) => {
        const features = policy.policy?.features ?? {}
        setBlocked(new Set(Object.entries(POLICY_PAGES).filter(([, feature]) => features[feature] === false).map(([page]) => page)))
      })
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    if (blocked.has(settingsPage)) setSettingsPage('security')
  }, [blocked, settingsPage, setSettingsPage])

  const visibleNav = useMemo(
    () => NAV.filter((entry) => (isWork || !WORK_ONLY_PAGES.has(entry.id)) && !blocked.has(entry.id)),
    [isWork, blocked]
  )

  // A page's tabs are only listed when a search finds them; otherwise the page stands for them.
  const entries = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? visibleNav.filter((entry) => matchesAll(q, `${entry.label} ${KEYWORDS[entry.id] ?? ''}`)) : visibleNav.filter((entry) => !entry.parent)
  }, [query, visibleNav])

  // The open tab's own row when a search lists it, otherwise its page's.
  const current = entries.some((entry) => entry.id === settingsPage) ? settingsPage : (PARENT[settingsPage] ?? settingsPage)

  const groups = useMemo(() => {
    const map = new Map<string, NavEntry[]>()
    for (const entry of entries) {
      const list = map.get(entry.group) ?? []
      list.push(entry)
      map.set(entry.group, list)
    }
    return [...map.entries()]
  }, [entries])

  // A tab is drawn by its page, which stays in place (no replayed entrance) while its tabs change.
  const page = PARENT[settingsPage] ?? settingsPage
  const Page = PAGES[page] ?? GeneralPage
  const scroll = useRef<HTMLDivElement>(null)

  // Each settings page starts at the top rather than inheriting the last scroll.
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0
  }, [settingsPage])

  return (
    <div className="settings">
      <nav ref={nav} className="settings__nav" data-expanded={expanded || undefined}>
        <div className="settings__nav-panel">
        <div className="settings__nav-top" />
        <button className="settings__back" onClick={() => setView('chat')} aria-label="Back to app" title="Back to app">
          <ArrowLeft size={16} strokeWidth={1.9} />
          <span>Back to app</span>
        </button>
        {/* Signed out: Tokn's sign-in, first thing in Settings. Signed in, the account is under Usage. */}
        <SignInPrompt />
        <button className="settings__search-btn" onClick={() => setExpanded(true)} aria-label="Search settings" title="Search settings">
          <Search size={16} strokeWidth={1.9} />
        </button>
        <div className="settings__search">
          <SearchField value={query} onChange={setQuery} placeholder="Search settings..." variant="sm" />
        </div>
        <div className="settings__nav-body scroll">
          {groups.length === 0 && <div className="settings__no-match">No settings match “{query.trim()}”.</div>}
          {groups.map(([group, items]) => (
            <div key={group}>
              <div className="settings__group">{group}</div>
              {items.map((entry) => (
                <button
                  key={entry.id}
                  className="nav-item"
                  data-active={entry.id === current || undefined}
                  aria-current={entry.id === current ? 'page' : undefined}
                  aria-label={entry.parent ? `${entry.label}, in ${NAV.find((e) => e.id === entry.parent)?.label}` : entry.label}
                  title={entry.label}
                  onClick={() => {
                    setSettingsPage(entry.id)
                    if (expanded) collapse()
                  }}
                >
                  <span className="nav-item__icon">{entry.icon}</span>
                  <span className="nav-item__label">{entry.label}</span>
                  {entry.parent && <span className="nav-item__where">{NAV.find((e) => e.id === entry.parent)?.label}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
        </div>
      </nav>

      <div className="settings__body">
        <div className="settings__titlebar" />
        {/* One page failing shows an error in its place; the navigation, and every other page, keep working. */}
        {page === 'providers' ? (
          <div key={page} className="settings__full settings__page">
            <PageBoundary page={page}>
              <Page blocked={blocked} />
            </PageBoundary>
          </div>
        ) : (
          <div ref={scroll} className="settings__scroll scroll">
            <div key={page} className="settings__inner settings__page">
              <PageBoundary page={page}>
                <Page blocked={blocked} />
              </PageBoundary>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Around one Settings page, so a page that can't be drawn shows an error in its own place. */
function PageBoundary({ page, children }: { page: string; children: ReactNode }): JSX.Element {
  return (
    <ErrorBoundary resetKey={page} area={`settings: ${page}`} fallback={(error, retry) => <SettingsPageError error={error} retry={retry} />}>
      {children}
    </ErrorBoundary>
  )
}
