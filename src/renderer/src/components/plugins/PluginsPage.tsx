import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, FolderOpen, Github, PencilLine, Plug, RefreshCw, Settings, Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../../state/store'
import { TopBar } from '../TopBar'
import { SkillIcon } from '../../icons/brand'
import { MenuItem, MenuSeparator, Modal, Popover, SearchField, Segmented, Switch, useDisclosure } from '../ui'
import type { SkillInfo, SkillSource } from '@shared/skills'
import { PluginCatalog } from './PluginCatalog'
import { refreshServers, useSkills } from './usePlugins'
import './plugins.css'

const cleanError = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function PluginsPage(): JSX.Element {
  const { pluginsTab, setPluginsTab, setView, setSettingsPage } = useApp(
    useShallow((s) => ({
      pluginsTab: s.pluginsTab,
      setPluginsTab: s.setPluginsTab,
      setView: s.setView,
      setSettingsPage: s.setSettingsPage
    }))
  )
  const addAnchor = useRef<HTMLButtonElement>(null)
  const addMenu = useDisclosure()
  const [dialog, setDialog] = useState<'create' | 'install' | null>(null)
  // Bumped whenever the skills on disk may have changed, so the tab re-reads them.
  const [skillsVersion, setSkillsVersion] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      if (pluginsTab === 'skills') setSkillsVersion((v) => v + 1)
      else {
        await window.api.mcp.sync()
        await refreshServers()
      }
    } finally {
      setRefreshing(false)
    }
  }

  const openDialog = (which: 'create' | 'install'): void => {
    setPluginsTab('skills')
    setDialog(which)
  }

  const pick = (action: () => void): void => {
    addMenu.close()
    action()
  }

  return (
    <div className="page">
      <TopBar
        variant="page__bar"
        left={
          <Segmented
            value={pluginsTab}
            onChange={setPluginsTab}
            options={[
              { value: 'plugins', label: 'Plugins' },
              { value: 'skills', label: 'Skills' }
            ]}
          />
        }
        right={
          <>
            <button className="icon-btn" aria-label="Refresh" disabled={refreshing} onClick={() => void refresh()}>
              <RefreshCw size={15} strokeWidth={1.9} />
            </button>
            <button className="icon-btn" aria-label="Manage" onClick={() => setView('integrations')}>
              <Settings size={16} strokeWidth={1.9} />
            </button>
            <button ref={addAnchor} className="btn btn--primary" onClick={addMenu.toggle}>
              Add
              <ChevronDown size={14} strokeWidth={2} />
            </button>
            <Popover anchor={addAnchor} open={addMenu.open} onClose={addMenu.close} placement="bottom-end" width={220}>
              <MenuItem
                icon={<PencilLine size={15} strokeWidth={1.8} />}
                title="Create skill"
                onClick={() => pick(() => openDialog('create'))}
              />
              <MenuItem
                icon={<Github size={15} strokeWidth={1.8} />}
                title="Install skill from GitHub"
                onClick={() => pick(() => openDialog('install'))}
              />
              <MenuItem
                icon={<FolderOpen size={15} strokeWidth={1.8} />}
                title="Open skills folder"
                onClick={() => pick(() => void window.api.pluginAuth.skills.openFolder())}
              />
              <MenuSeparator />
              <MenuItem
                icon={<Plug size={15} strokeWidth={1.8} />}
                title="Custom MCP server"
                onClick={() => pick(() => setSettingsPage('mcp'))}
              />
            </Popover>
          </>
        }
      />

      <div className="page__scroll scroll">
        <div className="page__inner">
          {pluginsTab === 'plugins' ? (
            <PluginCatalog />
          ) : (
            <SkillsTab version={skillsVersion} onCreate={() => setDialog('create')} onInstall={() => setDialog('install')} />
          )}
        </div>
      </div>

      <CreateSkillDialog
        open={dialog === 'create'}
        onClose={() => setDialog(null)}
        onDone={() => {
          setDialog(null)
          setSkillsVersion((v) => v + 1)
        }}
      />
      <InstallSkillDialog
        open={dialog === 'install'}
        onClose={() => setDialog(null)}
        onDone={() => {
          setDialog(null)
          setSkillsVersion((v) => v + 1)
        }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ Skills */

const SOURCE_LABEL: Record<SkillSource, string> = {
  eaon: 'Eaon',
  claude: 'Claude Code',
  'project-eaon': 'Project',
  'project-claude': 'Project'
}

function SkillsTab({
  version,
  onCreate,
  onInstall
}: {
  version: number
  onCreate: () => void
  onInstall: () => void
}): JSX.Element {
  const { settings, patchSettings } = useApp(useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings })))
  const { skills, loaded, reload } = useSkills(version)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const disabled = settings?.disabledSkills ?? []

  const q = query.trim().toLowerCase()
  const shown = useMemo(
    () => skills.filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)),
    [skills, q]
  )
  const project = shown.filter((s) => s.source.startsWith('project'))
  const personal = shown.filter((s) => !s.source.startsWith('project'))
  const enabledCount = skills.filter((s) => !disabled.includes(s.name)).length

  const toggle = (name: string, on: boolean): void => {
    void patchSettings({ disabledSkills: on ? disabled.filter((d) => d !== name) : [...disabled, name] })
  }
  const remove = async (skill: SkillInfo): Promise<void> => {
    setError(null)
    try {
      await window.api.pluginAuth.skills.remove(skill.name)
      reload()
    } catch (err) {
      setError(cleanError(err))
    }
  }

  const list = (items: SkillInfo[]): JSX.Element => (
    <div className="skills__list">
      {items.map((skill) => (
        <SkillRow
          key={skill.path}
          skill={skill}
          enabled={!disabled.includes(skill.name)}
          onToggle={(on) => toggle(skill.name, on)}
          onRemove={() => void remove(skill)}
        />
      ))}
    </div>
  )

  return (
    <>
      <h1 className="page__title">Skills</h1>
      <p className="page__subtitle">
        Instructions the agent loads only when a task calls for them. {loaded && skills.length > 0 && `${enabledCount} of ${skills.length} on.`}
      </p>

      {skills.length > 0 && (
        <div className="skills__toolbar">
          <SearchField value={query} onChange={setQuery} placeholder="Search skills" />
        </div>
      )}
      {error && <p className="skills__error">{error}</p>}

      {loaded && skills.length === 0 && (
        <div className="skills__list">
          <div className="plugin-empty">
            No skills yet. A skill is a folder with a SKILL.md in ~/.eaon/skills, ~/.claude/skills, or your Work folder’s
            .eaon/skills.
            <div className="plugin-row__actions" style={{ justifyContent: 'center', marginTop: 14 }}>
              <button className="btn btn--primary" onClick={onCreate}>
                Create skill
              </button>
              <button className="btn" onClick={onInstall}>
                Install from GitHub
              </button>
            </div>
          </div>
        </div>
      )}

      {project.length > 0 && (
        <>
          <div className="section-head section-head--ruled">
            <span className="section-head__title">This project</span>
          </div>
          {list(project)}
        </>
      )}

      {personal.length > 0 && (
        <>
          <div className="section-head section-head--ruled">
            <span className="section-head__title">Personal</span>
          </div>
          {list(personal)}
        </>
      )}

      {skills.length > 0 && shown.length === 0 && <div className="plugin-empty">No skills match “{query.trim()}”</div>}

      {skills.length > 0 && (
        <p className="skills__note">
          Skills are used by Chat and Workers. The agent sees each one’s name and description, and reads the rest only when it needs it.
        </p>
      )}
    </>
  )
}

function SkillRow({
  skill,
  enabled,
  onToggle,
  onRemove
}: {
  skill: SkillInfo
  enabled: boolean
  onToggle: (on: boolean) => void
  onRemove: () => void
}): JSX.Element {
  return (
    <div className="skill-row" data-off={!enabled || undefined}>
      <SkillIcon size={34} />
      <div className="skill-row__body">
        <span className="skill-row__title">
          <span className="skill-row__name">{skill.name}</span>
          <span className="skill-source" data-project={skill.source.startsWith('project') || undefined}>
            {SOURCE_LABEL[skill.source]}
          </span>
        </span>
        <span className="skill-row__desc">{skill.description || 'No description'}</span>
      </div>
      <div className="skill-row__trail">
        <button
          className="icon-btn"
          aria-label={`Show ${skill.name} in folder`}
          title="Show in folder"
          onClick={() => void window.api.pluginAuth.skills.reveal(skill.path)}
        >
          <FolderOpen size={15} strokeWidth={1.8} />
        </button>
        {skill.removable && (
          <button className="icon-btn" aria-label={`Remove ${skill.name}`} title="Move to Trash" onClick={onRemove}>
            <Trash2 size={15} strokeWidth={1.8} />
          </button>
        )}
        <Switch label={skill.name} checked={enabled} onChange={onToggle} />
      </div>
    </div>
  )
}

function CreateSkillDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }): JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setName('')
    setDescription('')
    setBody('')
    setError(null)
  }, [open])

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.api.pluginAuth.skills.create({ name, description, body })
      onDone()
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={520}
      title="Create skill"
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={busy || !name.trim() || !description.trim()} onClick={() => void save()}>
            Create
          </button>
        </>
      }
    >
      <div className="skill-form">
        <div className="field-label">Name</div>
        <input className="input" value={name} autoFocus placeholder="release-notes" onChange={(e) => setName(e.target.value)} />
        <div className="field-label">When should it be used?</div>
        <input
          className="input"
          value={description}
          placeholder="Use when writing release notes from merged pull requests"
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="field-label">Instructions</div>
        <textarea
          className="input"
          value={body}
          spellCheck={false}
          placeholder={'# Release notes\n\n1. List the pull requests merged since the last tag…'}
          onChange={(e) => setBody(e.target.value)}
        />
        <p className="skills__note">Saved to ~/.eaon/skills as a SKILL.md you can keep editing in any text editor.</p>
        {error && <p className="skills__error">{error}</p>}
      </div>
    </Modal>
  )
}

function InstallSkillDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }): JSX.Element {
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setUrl('')
    setError(null)
  }, [open])

  const install = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.api.pluginAuth.skills.installFromGithub(url.trim())
      onDone()
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={520}
      title="Install skill from GitHub"
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={busy || !url.trim()} onClick={() => void install()}>
            {busy ? 'Installing…' : 'Install'}
          </button>
        </>
      }
    >
      <div className="skill-form">
        <div className="field-label">Link to the skill’s folder</div>
        <input
          className="input"
          value={url}
          autoFocus
          spellCheck={false}
          placeholder="https://github.com/anthropics/skills/tree/main/skills/pdf"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && url.trim() && !busy && void install()}
        />
        <p className="skills__note">
          The folder must contain a SKILL.md. It’s copied into ~/.eaon/skills; installing it again updates it.
        </p>
        {error && <p className="skills__error">{error}</p>}
      </div>
    </Modal>
  )
}
