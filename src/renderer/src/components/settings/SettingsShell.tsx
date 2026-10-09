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
  Smartphone,
  SquarePlus,
  Sun,
  Wand2
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp, useIsWork } from '../../state/store'
import { SearchField } from '../ui'
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
import { ChatAppsPage } from './pages/ChatApps'
import { EmailPage } from './pages/Email'
import { UsagePage } from './pages/Usage'
import { AccountsPage } from './pages/Accounts'
import { PaymentsPage } from './pages/Payments'
import { EnginesPage } from './pages/Engines'

interface NavEntry {
  id: string
  label: string
  icon: ReactNode
  group: string
}

const size = 16
const stroke = 1.9

const NAV: NavEntry[] = [
  { id: 'general', label: 'General', icon: <SettingsIcon size={size} strokeWidth={stroke} />, group: 'Personal' },
  { id: 'appearance', label: 'Appearance', icon: <Sun size={size} strokeWidth={stroke} />, group: 'Personal' },
  { id: 'configuration', label: 'Configuration', icon: <ShieldCheck size={size} strokeWidth={stroke} />, group: 'Personal' },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: <SquarePlus size={size} strokeWidth={stroke} />, group: 'Personal' },
  { id: 'usage', label: 'Usage', icon: <BarChart3 size={size} strokeWidth={stroke} />, group: 'Personal' },
  { id: 'accounts', label: 'Accounts', icon: <Users size={size} strokeWidth={stroke} />, group: 'Personal' },

  { id: 'providers', label: 'Model providers', icon: <KeyRound size={size} strokeWidth={stroke} />, group: 'Integrations' },
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
  { id: 'system', label: 'System Monitor', icon: <Activity size={size} strokeWidth={stroke} />, group: 'Advanced' },

  { id: 'archived', label: 'Archived chats', icon: <Archive size={size} strokeWidth={stroke} />, group: 'Archived' }
]

/** Only meaningful when a project folder is open, which is an Eaon Work
    concept — Browser drives `BrowserPanel` (Eaon Work only, see App.tsx) and
    Code index powers `codebase_search` over that folder. */
const WORK_ONLY_PAGES = new Set(['browser', 'code-index'])

const PAGES: Record<string, () => JSX.Element> = {
  general: GeneralPage,
  appearance: AppearancePage,
  configuration: ConfigurationPage,
  shortcuts: ShortcutsPage,
  usage: UsagePage,
  accounts: AccountsPage,
  providers: ProvidersPage,
  engines: EnginesPage,
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
  system: SystemMonitorPage,
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

  const visibleNav = useMemo(() => (isWork ? NAV : NAV.filter((entry) => !WORK_ONLY_PAGES.has(entry.id))), [isWork])

  const entries = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? visibleNav.filter((entry) => entry.label.toLowerCase().includes(q)) : visibleNav
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
        <div className="settings__search">
          <SearchField value={query} onChange={setQuery} placeholder="Search settings..." variant="sm" />
        </div>
        <div className="settings__nav-body scroll">
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
        {settingsPage === 'providers' ? (
          <div className="settings__full">
            <Page />
          </div>
        ) : (
          <div ref={scroll} className="settings__scroll scroll">
            <div className="settings__inner">
              <Page />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
