import { useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, CircleDot, Package, RefreshCw, Settings } from 'lucide-react'
import { useApp } from '../../state/store'
import { CollapsedNav } from '../CollapsedNav'
import { SkillIcon } from '../../icons/brand'
import { SKILLS, type SkillEntry } from '../../lib/catalog'
import { MenuItem, Popover, SearchField, Segmented, useDisclosure } from '../ui'
import { PluginCatalog } from './PluginCatalog'

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
        <div className="page__inner">{pluginsTab === 'plugins' ? <PluginCatalog /> : <SkillsTab />}</div>
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
