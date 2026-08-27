import { useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, CircleDot, Package, RefreshCw, Settings, UserRoundCog } from 'lucide-react'
import { useApp } from '../../state/store'
import { CollapsedNav } from '../CollapsedNav'
import { BrandIcon, SkillIcon } from '../../icons/brand'
import { CORE_PLUGINS, DIRECTORY, SKILLS, type PluginEntry, type SkillEntry } from '../../lib/catalog'
import { MenuItem, Popover, SearchField, Segmented, useDisclosure } from '../ui'

export function PluginsPage(): JSX.Element {
  const { pluginsTab, setPluginsTab, setView, refreshProviders, sidebarOpen } = useApp()
  const addAnchor = useRef<HTMLButtonElement>(null)
  const addMenu = useDisclosure()

  return (
    <div className="page">
      <div className="page__bar" data-collapsed={!sidebarOpen || undefined}>
        {!sidebarOpen && <CollapsedNav />}
        <Segmented
          value={pluginsTab}
          onChange={setPluginsTab}
          options={[
            { value: 'plugins', label: 'Plugins' },
            { value: 'skills', label: 'Skills' }
          ]}
        />
        <div className="page__bar-spacer" />
        <button className="icon-btn" aria-label="Refresh" onClick={() => void refreshProviders()}>
          <RefreshCw size={15} strokeWidth={1.9} />
        </button>
        <button className="icon-btn" aria-label="Manage" onClick={() => setView('integrations')}>
          <Settings size={16} strokeWidth={1.9} />
        </button>
        <button ref={addAnchor} className="btn btn--primary" onClick={addMenu.toggle}>
          Add
          <ChevronDown size={14} strokeWidth={2} />
        </button>
        <Popover anchor={addAnchor} open={addMenu.open} onClose={addMenu.close} placement="bottom-end" width={190}>
          <MenuItem icon={<Package size={15} strokeWidth={1.8} />} title="Create skill" onClick={addMenu.close} />
          <MenuItem icon={<CircleDot size={15} strokeWidth={1.8} />} title="Record a skill" onClick={addMenu.close} />
        </Popover>
      </div>

      <div className="page__scroll scroll">
        <div className="page__inner">{pluginsTab === 'plugins' ? <PluginsTab /> : <SkillsTab />}</div>
      </div>
    </div>
  )
}

function PluginsTab(): JSX.Element {
  const { settings, patchSettings, setView } = useApp()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'public' | 'personal'>('public')

  const installed = settings?.installedPlugins ?? []
  const matches = (entry: PluginEntry): boolean =>
    entry.name.toLowerCase().includes(query.trim().toLowerCase()) ||
    entry.description.toLowerCase().includes(query.trim().toLowerCase())

  const featured = DIRECTORY.filter((e) => e.category === 'featured' && matches(e))
  const productivity = DIRECTORY.filter((e) => e.category === 'productivity' && matches(e))
  const more = DIRECTORY.filter((e) => e.category === 'more')

  const install = (id: string): void => {
    const next = installed.includes(id) ? installed.filter((p) => p !== id) : [...installed, id]
    void patchSettings({ installedPlugins: next })
  }

  return (
    <>
      <h1 className="page__title">Plugins</h1>
      <p className="page__subtitle">Work with your assistant across your favorite tools</p>
      <SearchField value={query} onChange={setQuery} placeholder="Search plugins" />

      <div className="section-head">
        <span className="section-head__title">Installed</span>
        <button className="icon-btn" aria-label="Manage installed" onClick={() => setView('integrations')}>
          <Settings size={15} strokeWidth={1.9} />
        </button>
      </div>
      <div className="installed-row">
        {CORE_PLUGINS.map((plugin) => (
          <button
            key={plugin.id}
            title={plugin.name}
            onClick={() => install(plugin.id)}
            style={{ borderRadius: 11, display: 'grid', placeItems: 'center', opacity: installed.includes(plugin.id) ? 1 : 0.4 }}
          >
            <BrandIcon id={plugin.id} size={40} />
          </button>
        ))}
      </div>

      <div style={{ marginTop: 26 }}>
        <Segmented
          value={scope}
          onChange={setScope}
          options={[
            { value: 'public', label: 'Public' },
            { value: 'personal', label: 'Personal' }
          ]}
        />
      </div>

      {scope === 'personal' ? (
        <div style={{ padding: '48px 0', color: 'var(--text-3)', fontSize: 'var(--fs-base)' }}>
          No personal plugins yet. Connect an MCP server to add your own.
        </div>
      ) : (
        <>
          <div className="section-head section-head--ruled">
            <span className="section-head__title">Featured</span>
          </div>
          <div className="grid-2">
            {featured.map((entry) => (
              <PluginRow key={entry.id} entry={entry} installed={installed.includes(entry.id)} onInstall={install} />
            ))}
          </div>

          <div className="more-line">
            <span className="avatar-stack">
              {more.map((entry) => (
                <BrandIcon key={entry.id} id={entry.id} size={22} />
              ))}
              <BrandIcon id="granola" size={22} />
            </span>
            See {more.map((e) => e.name).join(', ')}, and more
          </div>

          <div className="section-head section-head--ruled">
            <span className="section-head__title">Productivity</span>
          </div>
          <div className="grid-2">
            {productivity.map((entry) => (
              <PluginRow key={entry.id} entry={entry} installed={installed.includes(entry.id)} onInstall={install} />
            ))}
          </div>
        </>
      )}
    </>
  )
}

function PluginRow({
  entry,
  installed,
  onInstall
}: {
  entry: PluginEntry
  installed: boolean
  onInstall: (id: string) => void
}): JSX.Element {
  return (
    <div className="entry">
      <BrandIcon id={entry.id} size={40} />
      <div className="entry__body">
        <span className="entry__title">{entry.name}</span>
        <span className="entry__desc">{entry.description}</span>
      </div>
      <div className="entry__trail">
        {entry.access === 'managed' ? (
          <span title="Managed by your workspace admin">
            <UserRoundCog size={16} strokeWidth={1.8} />
          </span>
        ) : (
          <button className="btn btn--sm" onClick={() => onInstall(entry.id)}>
            {installed ? 'Remove' : 'Install'}
          </button>
        )}
      </div>
    </div>
  )
}

function SkillsTab(): JSX.Element {
  const { settings, patchSettings } = useApp()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'personal' | 'system'>('personal')
  const disabled = settings?.disabledSkills ?? []

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return SKILLS
    return SKILLS.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
  }, [query])

  const toggle = (id: string): void => {
    const next = disabled.includes(id) ? disabled.filter((d) => d !== id) : [...disabled, id]
    void patchSettings({ disabledSkills: next })
  }

  const shown = results.slice(0, 6)
  const rest = results.length - shown.length

  return (
    <>
      <h1 className="page__title">Skills</h1>
      <p className="page__subtitle">Extend your assistant with task-specific skills</p>
      <SearchField value={query} onChange={setQuery} placeholder="Search skills" />

      <div className="section-head section-head--ruled">
        <span className="section-head__title">Installed</span>
      </div>
      <div className="grid-2">
        {shown.map((entry) => (
          <SkillRow key={entry.id} entry={entry} enabled={!disabled.includes(entry.id)} onToggle={toggle} />
        ))}
      </div>
      {rest > 0 && (
        <div className="more-line">
          See {results.slice(6, 8).map((s) => s.name).join(', ')}, and {rest - 2} more
        </div>
      )}

      <div style={{ marginTop: 8, marginBottom: 8 }}>
        <Segmented
          value={scope}
          onChange={setScope}
          options={[
            { value: 'personal', label: 'Personal' },
            { value: 'system', label: 'System' }
          ]}
        />
      </div>

      <div className="grid-2">
        {results.slice(0, 6).map((entry) => (
          <SkillRow
            key={`${scope}-${entry.id}`}
            entry={entry}
            enabled={!disabled.includes(entry.id)}
            onToggle={toggle}
          />
        ))}
      </div>
      {results.length > 6 && (
        <div className="more-line">
          See {results.slice(6, 8).map((s) => s.name).join(', ')}, and {Math.max(results.length - 8, 0)} more
        </div>
      )}
    </>
  )
}

function SkillRow({
  entry,
  enabled,
  onToggle
}: {
  entry: SkillEntry
  enabled: boolean
  onToggle: (id: string) => void
}): JSX.Element {
  return (
    <button className="entry" onClick={() => onToggle(entry.id)}>
      <SkillIcon size={40} />
      <div className="entry__body">
        <span className="entry__title">{entry.name}</span>
        <span className="entry__desc">{entry.description}</span>
      </div>
      <div className="entry__trail">
        {enabled && <Check size={16} strokeWidth={2} color="var(--text-2)" />}
      </div>
    </button>
  )
}
