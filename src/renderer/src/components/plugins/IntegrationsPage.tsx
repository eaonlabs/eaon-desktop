import { useMemo, useState } from 'react'
import { Settings } from 'lucide-react'
import { useApp } from '../../state/store'
import { TopBar } from '../TopBar'
import { SkillIcon } from '../../icons/brand'
import { SearchField, Switch } from '../ui'
import { PluginLogo } from './PluginLogo'
import { useConnectedPlugins, useSkills } from './usePlugins'

type Tab = 'plugins' | 'mcps' | 'skills'

export function IntegrationsPage(): JSX.Element {
  const { settings, patchSettings, mcpServers, saveMcpServers, sidebarOpen, setSettingsPage } = useApp()
  const [tab, setTab] = useState<Tab>('plugins')
  const [query, setQuery] = useState('')

  const disabledSkills = settings?.disabledSkills ?? []
  const q = query.trim().toLowerCase()
  const connected = useConnectedPlugins()
  const { skills: allSkills } = useSkills()

  // Connected plugins only: this page switches them on and off. Connecting
  // new ones happens on the Plugins page, where each one's sign-in lives.
  const plugins = useMemo(
    () =>
      connected.filter(
        ({ entry }) => !q || entry.displayName.toLowerCase().includes(q) || entry.summary.toLowerCase().includes(q)
      ),
    [connected, q]
  )
  const skills = useMemo(
    () => allSkills.filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)),
    [allSkills, q]
  )
  const servers = useMemo(() => mcpServers.filter((s) => !q || s.name.toLowerCase().includes(q)), [mcpServers, q])

  const placeholder = tab === 'plugins' ? 'Search plugins' : tab === 'mcps' ? 'Search MCP servers' : 'Search skills'

  return (
    <div className="page">
      <TopBar variant="page__bar" />
      <div className="page__scroll scroll">
        <div className="page__inner page__inner--narrow">
          <div className="manager__bar">
            <div className="manager__tabs">
              {(
                [
                  ['plugins', 'Plugins', connected.length],
                  ['mcps', 'MCPs', mcpServers.length],
                  ['skills', 'Skills', allSkills.length]
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

          {tab === 'plugins' && plugins.length === 0 && (
            <div style={{ padding: '32px 0', color: 'var(--text-3)' }}>
              {q ? 'No connected plugins match' : 'No plugins connected yet — connect them on the Plugins page'}
            </div>
          )}
          {tab === 'plugins' &&
            plugins.map(({ entry, server }) => (
              <div key={entry.id} className="manager__row">
                <PluginLogo logo={entry.logoAssetName} name={entry.displayName} size={38} />
                <div className="entry__body">
                  <span className="entry__title">{entry.displayName}</span>
                  <span className="entry__desc">{entry.summary}</span>
                </div>
                <Switch
                  label={entry.displayName}
                  checked={server.enabled}
                  onChange={(on) =>
                    void saveMcpServers(mcpServers.map((s) => (s.id === server.id ? { ...s, enabled: on } : s)))
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
              <div key={skill.path} className="manager__row">
                <SkillIcon size={38} />
                <div className="entry__body">
                  <span className="entry__title">{skill.name}</span>
                  <span className="entry__desc">{skill.description}</span>
                </div>
                <span className="manager__row-label">{skill.source.startsWith('project') ? 'Project' : 'Personal'}</span>
                <Switch
                  label={skill.name}
                  checked={!disabledSkills.includes(skill.name)}
                  onChange={(on) =>
                    void patchSettings({
                      disabledSkills: on ? disabledSkills.filter((d) => d !== skill.name) : [...disabledSkills, skill.name]
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
