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
  CreditCard,
  Cpu,
  KeyRound,
  Mail,
  MessagesSquare,
  Plug,
  Server,
  Settings as SettingsIcon,
  ShieldCheck,
  Lock,
  Smartphone,
  HardDrive,
  SquarePlus,
  Sun,
  Wand2, Gauge, Bot, CircleUser } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp, useIsWork } from '../../state/store'
import { SearchField } from '../ui'
import { SignInPrompt } from '../account/ToknAccount'
import { ErrorBoundary } from '../ErrorBoundary'
import { SettingsPageError } from '../CrashScreen'
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
import { WorkerComputerPage } from './pages/WorkerComputer'
import { SystemMonitorPage } from './pages/SystemMonitor'
import { McpServersPage } from './pages/McpServers'
import { ConnectAppsPage } from './pages/ConnectApps'
import { CodeIndexPage } from './pages/CodeIndex'
import { BrowserControlPage } from './pages/BrowserControl'
import { EaonCodePage } from './pages/EaonCode'
import { AdePage } from './pages/Ade'
import { DiscordPage } from './pages/Discord'
import { ChatAppsPage } from './pages/ChatApps'
import { EmailPage } from './pages/Email'
import { UsagePage } from './pages/Usage'
import { UsageLimitsPage } from './pages/UsageLimits'
import { AgentProvidersPage } from './pages/AgentProviders'
import { ProfilePage } from './pages/Profile'
import { AccountsPage } from './pages/Accounts'
import { PaymentsPage } from './pages/Payments'
import { EnginesPage } from './pages/Engines'
import { SecurityPage } from './pages/Security'
import type { PolicyFeature } from '@shared/enterprise'

interface NavEntry {
  id: string
  label: string
  icon: ReactNode
  group: string
}

const size = 16
const stroke = 1.9

/**
 * What people search for that isn't a page's name, so "dark mode" finds
 * Appearance and "api key" finds Model providers instead of a blank list.
 */
const KEYWORDS: Record<string, string> = {
  profile: 'profile avatar name handle share activity streak heatmap tokens insights model usage card',
  general: 'update beta version launch login startup sleep language suggested prompts contributors',
  appearance: 'theme dark light mode color colour font size text zoom accent icon motion contrast',
  configuration: 'approval autonomy sandbox permissions web search agent',
  shortcuts: 'keyboard hotkey keys',
  usage: 'tokens cost spend limits tokn activity streak',
  'usage-limits': 'quota limit remaining reset codex claude cursor copilot grok opencode devin credits balance rings sidebar',
  accounts: 'claude code codex sign in login plan limit switch account',
  providers: 'api key keys openai anthropic claude gemini google openrouter ollama lm studio model free credits event code hackathon eaon free sign in',
  engines: 'claude code codex agent engine cli',
  'agent-providers': 'cli coding agents claude codex cursor opencode droid grok antigravity gemini copilot install update version picker order hide priority',
  'computer-use': 'screen mouse keyboard accessibility screen recording permissions',
  payments: 'card purchase buy money spending limit',
  'browser-control': 'chrome extension browser',
  plugins: 'skills mcp extensions',
  'eaon-code': 'coding agent cli terminal',
  ade: 'terminal theme shell worktree coding',
  'chat-apps': 'telegram slack whatsapp discord imessage messages bot',
  email: 'agentmail inbox mail',
  discord: 'rich presence status activity',
  browser: 'homepage search engine tabs',
  mcp: 'model context protocol tools servers timeout',
  'connect-apps': 'import openclaw hermes cline apps',
  'code-index': 'embedding semantic search index repository',
  'local-server': 'port api server openai compatible gateway key',
  'remote-devices': 'phone mobile remote web rc github',
  system: 'cpu memory gpu performance monitor',
  security: 'audit log policy enterprise organization',
  archived: 'archive restore deleted chats history'
}

const NAV: NavEntry[] = [
  { id: 'profile', label: 'Profile', icon: <CircleUser size={size} strokeWidth={stroke} />, group: 'Personal' },
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
  { id: 'payments', label: 'Payments', icon: <CreditCard size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'browser-control', label: 'Browser control', icon: <Chrome size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'plugins', label: 'Plugins', icon: <AtSign size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'eaon-code', label: 'Eaon Code', icon: <Code2 size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'ade', label: 'ADE', icon: <SquareTerminal size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'chat-apps', label: 'Chat apps', icon: <MessagesSquare size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'email', label: 'Email', icon: <Mail size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'discord', label: 'Discord', icon: <Gamepad2 size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'browser', label: 'Browser', icon: <AppWindow size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'mcp', label: 'MCP Servers', icon: <Plug size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'connect-apps', label: 'Connect apps', icon: <Cable size={size} strokeWidth={stroke} />, group: 'Integrations' },
  { id: 'code-index', label: 'Code index', icon: <Binary size={size} strokeWidth={stroke} />, group: 'Integrations' },

  { id: 'local-server', label: 'Local API Server', icon: <Server size={size} strokeWidth={stroke} />, group: 'Advanced' },
  { id: 'remote-devices', label: 'Remote devices', icon: <Smartphone size={size} strokeWidth={stroke} />, group: 'Advanced' },
  { id: 'worker-computer', label: 'Worker computer', icon: <HardDrive size={size} strokeWidth={stroke} />, group: 'Advanced' },
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

const PAGES: Record<string, () => JSX.Element> = {
  profile: ProfilePage,
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
  payments: PaymentsPage,
  'browser-control': BrowserControlPage,
  'eaon-code': EaonCodePage,
  ade: AdePage,
  discord: DiscordPage,
  'chat-apps': ChatAppsPage,
  email: EmailPage,
  plugins: PluginsSettingsPage,
  browser: BrowserSettingsPage,
  mcp: McpServersPage,
  'connect-apps': ConnectAppsPage,
  'code-index': CodeIndexPage,
  'local-server': LocalServerPage,
  'remote-devices': RemoteDevicesPage,
  'worker-computer': WorkerComputerPage,
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

  const entries = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? visibleNav.filter((entry) => `${entry.label} ${KEYWORDS[entry.id] ?? ''}`.toLowerCase().includes(q)) : visibleNav
  }, [query, visibleNav])

  const groups = useMemo(() => {
    const map = new Map<string, NavEntry[]>()
    for (const entry of entries) {
      const list = map.get(entry.group) ?? []
      list.push(entry)
      map.set(entry.group, list)
    }
    return [...map.entries()]
  }, [entries])

  const Page = PAGES[settingsPage] ?? GeneralPage
  const scroll = useRef<HTMLDivElement>(null)

  // Each settings page starts at the top rather than inheriting the last scroll.
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0
  }, [settingsPage])

  return (
    <div className="settings">
      <nav className="settings__nav">
        <div className="settings__nav-panel">
        <div className="settings__nav-top" />
        <button className="settings__back" onClick={() => setView('chat')} aria-label="Back to app" title="Back to app">
          <ArrowLeft size={16} strokeWidth={1.9} />
          <span>Back to app</span>
        </button>
        {/* Signed out: Tokn's sign-in, first thing in Settings. Signed in, the account is under Usage. */}
        <SignInPrompt />
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
                  data-active={entry.id === settingsPage || undefined}
                  aria-current={entry.id === settingsPage ? 'page' : undefined}
                  aria-label={entry.label}
                  title={entry.label}
                  onClick={() => setSettingsPage(entry.id)}
                >
                  <span className="nav-item__icon">{entry.icon}</span>
                  <span className="nav-item__label">{entry.label}</span>
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
        {settingsPage === 'providers' ? (
          <div key={settingsPage} className="settings__full settings__page">
            <PageBoundary page={settingsPage}>
              <Page />
            </PageBoundary>
          </div>
        ) : (
          <div ref={scroll} className="settings__scroll scroll">
            <div key={settingsPage} className="settings__inner settings__page">
              <PageBoundary page={settingsPage}>
                <Page />
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
