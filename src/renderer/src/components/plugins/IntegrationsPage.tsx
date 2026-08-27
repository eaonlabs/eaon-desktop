import { useMemo, useState } from 'react'
import { Plus, Settings, Trash2 } from 'lucide-react'
import { useApp } from '../../state/store'
import { CollapsedNav } from '../CollapsedNav'
import { BrandIcon, SkillIcon } from '../../icons/brand'
import { CORE_PLUGINS, SKILLS } from '../../lib/catalog'
import { Modal, SearchField, Switch } from '../ui'
import type { McpServer } from '@shared/types'

type Tab = 'plugins' | 'mcps' | 'skills'

export function IntegrationsPage(): JSX.Element {
  const { settings, patchSettings, mcpServers, saveMcpServers, sidebarOpen, setSettingsPage } = useApp()
  const [tab, setTab] = useState<Tab>('plugins')
  const [query, setQuery] = useState('')

  const disabledPlugins = settings?.disabledPlugins ?? []
  const disabledSkills = settings?.disabledSkills ?? []
  const q = query.trim().toLowerCase()

  const plugins = useMemo(
    () => CORE_PLUGINS.filter((p) => !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)),
    [q]
  )
  const skills = useMemo(
    () => SKILLS.filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)),
    [q]
  )
  const servers = useMemo(() => mcpServers.filter((s) => !q || s.name.toLowerCase().includes(q)), [mcpServers, q])

  const placeholder = tab === 'plugins' ? 'Search plugins' : tab === 'mcps' ? 'Search MCP servers' : 'Search skills'

  return (
    <div className="page">
      <div className="page__bar" data-collapsed={!sidebarOpen || undefined}>
        {!sidebarOpen && <CollapsedNav />}
      </div>
      <div className="page__scroll scroll">
        <div className="page__inner page__inner--narrow">
          <div className="manager__bar">
            <div className="manager__tabs">
              {(
                [
                  ['plugins', 'Plugins', CORE_PLUGINS.length],
                  ['mcps', 'MCPs', mcpServers.length],
                  ['skills', 'Skills', SKILLS.length]
                ] as const
              ).map(([value, label, count]) => (
                <button
                  key={value}
                  className="manager__tab"
                  data-active={tab === value}
                  onClick={() => setTab(value)}
                >
                  <span>{label}</span>
                  <span className="manager__tab-count">{count}</span>
                </button>
              ))}
            </div>
            <div className="manager__search">
              <SearchField value={query} onChange={setQuery} placeholder={placeholder} variant="pill" />
            </div>
          </div>

          {tab === 'plugins' &&
            plugins.map((plugin) => (
              <div key={plugin.id} className="manager__row">
                <BrandIcon id={plugin.id} size={38} />
                <div className="entry__body">
                  <span className="entry__title">{plugin.name}</span>
                  <span className="entry__desc">{plugin.description}</span>
                </div>
                <Switch
                  label={plugin.name}
                  checked={!disabledPlugins.includes(plugin.id)}
                  onChange={(on) =>
                    void patchSettings({
                      disabledPlugins: on
                        ? disabledPlugins.filter((d) => d !== plugin.id)
                        : [...disabledPlugins, plugin.id]
                    })
                  }
                />
              </div>
            ))}

          {tab === 'mcps' && (
            <>
              <div className="section-head" style={{ marginTop: 0 }}>
                <span className="section-head__title">Servers</span>
                <button className="btn" onClick={() => setSettingsPage('mcp')}>
                  <Settings size={14} strokeWidth={1.9} />
                  Manage in settings
                </button>
              </div>
              {servers.length === 0 ? (
                <div style={{ padding: '32px 0', color: 'var(--text-3)' }}>No MCP servers configured</div>
              ) : (
                <div className="card">
                  {servers.map((server) => (
                    <div key={server.id} className="card__row">
                      <div className="card__row-body">
                        <span className="card__row-title">{server.name}</span>
                        <span className="card__row-desc">
                          {server.transport === 'http' ? server.url : `${server.command} ${server.args.join(' ')}`}
                        </span>
                      </div>
                      <div className="card__row-trail">
                        <Switch
                          label={server.name}
                          checked={server.enabled}
                          onChange={(on) =>
                            void saveMcpServers(
                              mcpServers.map((s) => (s.id === server.id ? { ...s, enabled: on } : s))
                            )
                          }
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {tab === 'skills' &&
            skills.map((skill) => (
              <div key={skill.id} className="manager__row">
                <SkillIcon size={38} />
                <div className="entry__body">
                  <span className="entry__title">{skill.name}</span>
                  <span className="entry__desc">{skill.description}</span>
                </div>
                <span className="manager__row-label">Personal</span>
                <Switch
                  label={skill.name}
                  checked={!disabledSkills.includes(skill.id)}
                  onChange={(on) =>
                    void patchSettings({
                      disabledSkills: on ? disabledSkills.filter((d) => d !== skill.id) : [...disabledSkills, skill.id]
                    })
                  }
                />
              </div>
            ))}
        </div>
      </div>

    </div>
  )
}
