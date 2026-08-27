import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  ArrowUp,
  ChevronDown,
  CircleAlert,
  CircleDot,
  ExternalLink,
  Folder,
  Hand,
  Laptop,
  Lightbulb,
  Loader2,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  ShieldCheck,
  Square,
  Target,
  AppWindow,
  AtSign
} from 'lucide-react'
import { useApp, useIsWork } from '../state/store'
import { MenuItem, MenuSearch, MenuSeparator, Popover, useDisclosure } from './ui'
import { BrandIcon } from '../icons/brand'
import { CORE_PLUGINS } from '../lib/catalog'
import type { EffortLevel, ModelInfo } from '@shared/types'

const EFFORT_LABEL: Record<EffortLevel, string> = {
  light: 'Light',
  medium: 'Medium',
  high: 'High',
  'extra-high': 'Extra High',
  ultra: 'Ultra'
}

export function Composer({ variant = 'home' }: { variant?: 'home' | 'chat' }): JSX.Element {
  const { settings, streamingMessageId, send, stop, workspaces, composerDraft, setComposerDraft, setWorkCwd } = useApp(useShallow((s) => ({ settings: s.settings, streamingMessageId: s.streamingMessageId, send: s.send, stop: s.stop, workspaces: s.workspaces, composerDraft: s.composerDraft, setComposerDraft: s.setComposerDraft, setWorkCwd: s.setWorkCwd })))
  const [text, setText] = useState('')
  const textarea = useRef<HTMLTextAreaElement>(null)
  const workWorkspace = workspaces.find((w) => w.kind === 'work')
  const isWork = useIsWork()

  const plusAnchor = useRef<HTMLButtonElement>(null)
  const approvalAnchor = useRef<HTMLButtonElement>(null)
  const modelAnchor = useRef<HTMLButtonElement>(null)
  const pluginsAnchor = useRef<HTMLButtonElement>(null)

  const plusMenu = useDisclosure()
  const approvalMenu = useDisclosure()
  const modelMenu = useDisclosure()
  const pluginsMenu = useDisclosure()

  const model = useApp((s) => s.currentModel())
  const streaming = Boolean(streamingMessageId)

  useEffect(() => {
    const node = textarea.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 320)}px`
  }, [text])

  // A suggestion card on the Eaon Work home screen drops its prompt here.
  useEffect(() => {
    if (composerDraft === null) return
    setText(composerDraft)
    setComposerDraft(null)
    textarea.current?.focus()
  }, [composerDraft, setComposerDraft])

  const chooseFolder = async (): Promise<void> => {
    const paths = await window.api.app.openFiles({ properties: ['openDirectory'] })
    if (paths[0]) setWorkCwd(paths[0])
  }

  const submit = (): void => {
    if (streaming) {
      stop()
      return
    }
    if (!text.trim()) return
    void send(text)
    setText('')
  }

  return (
    <div className={`composer-stack ${variant === 'chat' ? 'composer-stack--chat' : ''}`}>
      {variant === 'home' && isWork && (
        <div className="project-bar">
          <button className="project-bar__pick" onClick={() => void chooseFolder()}>
            <Folder size={15} strokeWidth={1.8} />
            <span className="project-bar__label">
              {workWorkspace?.cwd ? workWorkspace.cwd.split('/').pop() : 'Choose project'}
            </span>
          </button>
          {workWorkspace?.cwd && <IndexBadge />}
        </div>
      )}
      <div className="composer">
        <textarea
          ref={textarea}
          className="composer__input"
          placeholder={isWork ? 'Do anything' : 'Work with Eaon'}
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />

        <div className="composer__toolbar">
          <button
            ref={plusAnchor}
            className="composer__round"
            data-open={plusMenu.open || undefined}
            onClick={plusMenu.toggle}
            aria-label="Add context"
          >
            <Plus size={18} strokeWidth={1.9} />
          </button>

          {/* Approvals gate the local file/command tools, which only exist in
              Eaon Work — in chat mode there is nothing to approve. */}
          {isWork && (
          <button
            ref={approvalAnchor}
            className="chip"
            data-open={approvalMenu.open || undefined}
            onClick={approvalMenu.toggle}
          >
            <span className="chip__icon">
              {settings?.approvalMode === 'auto' ? (
                <ShieldCheck size={16} strokeWidth={1.8} />
              ) : (
                <Hand size={16} strokeWidth={1.8} />
              )}
            </span>
            <span className="chip__label">
              {settings?.approvalMode === 'auto' ? 'Approve for me' : 'Ask for approval'}
            </span>
          </button>
          )}

          <div className="composer__spacer" />

          <button
            ref={modelAnchor}
            className="chip chip--model"
            data-open={modelMenu.open || undefined}
            onClick={modelMenu.toggle}
          >
            <span className="chip__model">{model?.label ?? 'No model'}</span>
            {(model?.efforts?.length ?? 0) > 0 && (
              <span className="chip__effort">{EFFORT_LABEL[settings?.effort ?? 'light']}</span>
            )}
          </button>

          <button
            className={`send ${streaming ? 'send--stop' : ''}`}
            disabled={!streaming && !text.trim()}
            onClick={submit}
            aria-label={streaming ? 'Stop' : 'Send'}
          >
            {streaming ? (
              <Square size={11} strokeWidth={0} fill="currentColor" />
            ) : (
              <ArrowUp size={17} strokeWidth={2.2} />
            )}
          </button>
        </div>
      </div>

      {/* Eaon Work only. The plugin/browser tray used to be the reverse — shown
          in chat mode and suppressed in Eaon Work — but the plugins belong to
          the coding product, so the chat home stays clean. */}
      {variant === 'home' && isWork && (
      <div className="tray">
        <button
          ref={pluginsAnchor}
          className="tray__btn"
          data-open={pluginsMenu.open || undefined}
          onClick={pluginsMenu.toggle}
        >
          <span className="plugin-stack">
            {CORE_PLUGINS.slice(0, 3).map((plugin) => (
              <BrandIcon key={plugin.id} id={plugin.id} size={17} />
            ))}
          </span>
          <span className="chip__label">Plugins</span>
        </button>

        <div className="tray__spacer" />

        <button
          className="tray__btn"
          onClick={() => useApp.getState().toggleBrowser()}
          aria-label="Toggle browser panel"
          title="Browser"
        >
          <Laptop size={16} strokeWidth={1.8} />
        </button>
      </div>
      )}

      <AddMenu anchor={plusAnchor} open={plusMenu.open} onClose={plusMenu.close} />
      <ApprovalMenu anchor={approvalAnchor} open={approvalMenu.open} onClose={approvalMenu.close} />
      <ModelMenu anchor={modelAnchor} open={modelMenu.open} onClose={modelMenu.close} />
      <PluginsMenu anchor={pluginsAnchor} open={pluginsMenu.open} onClose={pluginsMenu.close} />
    </div>
  )
}

/* -------------------------------------------------------------- Index badge */

/**
 * Live state of the code index next to the project name. This is the only
 * place the user learns whether `codebase_search` will actually work, so it
 * distinguishes "semantic" (vectors built) from "keywords" (no embedding
 * model configured) rather than just saying "ready".
 */
function IndexBadge(): JSX.Element {
  const status = useApp((s) => s.indexStatus)
  const reindex = useApp((s) => s.reindex)
  const setSettingsPage = useApp((s) => s.setSettingsPage)

  if (status?.state === 'indexing') {
    return (
      <span className="project-bar__status">
        <Loader2 size={13} strokeWidth={2} className="spinner" />
        {status.phase ?? 'Indexing…'}
      </span>
    )
  }

  if (status?.state === 'error') {
    return (
      <button className="project-bar__status" data-error="true" onClick={() => void reindex(true)} title={status.error}>
        <CircleAlert size={13} strokeWidth={2} />
        Index failed — retry
      </button>
    )
  }

  if (status?.state === 'ready') {
    return (
      <button
        className="project-bar__status"
        onClick={() => setSettingsPage('code-index')}
        title={`${status.chunks.toLocaleString()} chunks · ${
          status.embedded ? 'semantic search' : 'keyword search only'
        }`}
      >
        {status.embedded ? <Sparkles size={13} strokeWidth={2} /> : <Search size={13} strokeWidth={2} />}
        {status.files.toLocaleString()} files · {status.embedded ? 'semantic' : 'keywords'}
      </button>
    )
  }

  return (
    <button className="project-bar__status" onClick={() => void reindex()}>
      <RefreshCw size={13} strokeWidth={2} />
      Index project
    </button>
  )
}

/* ------------------------------------------------------------------ + menu */

function AddMenu({
  anchor,
  open,
  onClose
}: {
  anchor: React.RefObject<HTMLElement>
  open: boolean
  onClose: () => void
}): JSX.Element {
  const { settings, patchSettings, setView } = useApp(useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings, setView: s.setView })))
  const installed = CORE_PLUGINS.filter((p) => settings?.installedPlugins.includes(p.id))

  const inline = (title: string, hint: string): JSX.Element => (
    <>
      <span>{title}</span>
      <span style={{ color: 'var(--text-3)', marginLeft: 8 }}>{hint}</span>
    </>
  )

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="bottom-start" width={470}>
      <div className="menu__label">Add</div>
      <MenuItem
        icon={<Paperclip size={16} strokeWidth={1.8} />}
        title="Files and folders"
        onClick={() => {
          void window.api.app.openFiles({ properties: ['openFile', 'openDirectory', 'multiSelections'] })
          onClose()
        }}
      />
      <MenuItem icon={<AppWindow size={16} strokeWidth={1.8} />} title="Attach app window" onClick={onClose} />
      <MenuItem
        icon={<Folder size={16} strokeWidth={1.8} />}
        title={inline('Work in a project', 'Start a chat in a project')}
        onClick={onClose}
      />
      <MenuItem icon={<Target size={16} strokeWidth={1.8} />} title={inline('Goal', 'Set a goal to keep pursuing')} onClick={onClose} />
      <MenuItem
        icon={<Lightbulb size={16} strokeWidth={1.8} />}
        title={inline('Plan mode', settings?.planMode ? 'Turn plan mode off' : 'Turn plan mode on')}
        onClick={() => {
          void patchSettings({ planMode: !settings?.planMode })
          onClose()
        }}
      />
      <MenuItem
        icon={<CircleDot size={16} strokeWidth={1.8} />}
        title="Record a skill"
        onClick={() => {
          setView('plugins')
          useApp.getState().setPluginsTab('skills')
          onClose()
        }}
      />
      <div className="menu__label">Plugins</div>
      {installed.map((plugin) => (
        <MenuItem
          key={plugin.id}
          icon={<BrandIcon id={plugin.id} size={17} />}
          title={inline(plugin.name, plugin.description)}
          onClick={onClose}
        />
      ))}
    </Popover>
  )
}

/* ------------------------------------------------------------ Approval menu */

function ApprovalMenu({
  anchor,
  open,
  onClose
}: {
  anchor: React.RefObject<HTMLElement>
  open: boolean
  onClose: () => void
}): JSX.Element {
  const { settings, patchSettings } = useApp(useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings })))
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="bottom-start" width={380}>
      <div className="menu__header">
        <span>How should actions be approved?</span>
      </div>
      <MenuItem
        icon={<Hand size={16} strokeWidth={1.8} />}
        title="Ask for approval"
        description="Always ask to edit external files and use the internet"
        checked={settings?.approvalMode === 'ask'}
        onClick={() => {
          void patchSettings({ approvalMode: 'ask' })
          onClose()
        }}
      />
      <MenuItem
        icon={<ShieldCheck size={16} strokeWidth={1.8} />}
        title="Approve for me"
        description="Only ask for actions detected as potentially unsafe"
        checked={settings?.approvalMode === 'auto'}
        onClick={() => {
          void patchSettings({ approvalMode: 'auto' })
          onClose()
        }}
      />
    </Popover>
  )
}

/* --------------------------------------------------------------- Model menu */

function ModelMenu({
  anchor,
  open,
  onClose
}: {
  anchor: React.RefObject<HTMLElement>
  open: boolean
  onClose: () => void
}): JSX.Element {
  const { settings, selectModel, setEffort, setSettingsPage } = useApp(useShallow((s) => ({ settings: s.settings, selectModel: s.selectModel, setEffort: s.setEffort, setSettingsPage: s.setSettingsPage })))
  const models = useApp(useShallow((s) => s.availableModels()))
  const current = useApp((s) => s.currentModel())

  const modelRow = useRef<HTMLDivElement>(null)
  const effortRow = useRef<HTMLDivElement>(null)
  const [sub, setSub] = useState<'model' | 'effort' | null>(null)

  // Only offer effort levels the selected model actually accepts, intersected
  // with what the user has enabled in Configuration. A model with no effort
  // control at all (gpt-4o, Haiku 4.5, most local models) gets the row disabled
  // rather than a picker whose value the request would ignore or reject.
  const modelEfforts = current?.efforts ?? []
  const supportsEffort = modelEfforts.length > 0
  const enabled = settings?.configuration.availableEfforts ?? []
  const visibleEfforts = modelEfforts
    .filter((e) => enabled.includes(e))
    .filter((e) => e !== 'ultra' || settings?.configuration.ultraInPicker !== false)

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="bottom-end" width={212}>
      <button className="menu__item" onClick={() => setSettingsPage('configuration')}>
        <span className="menu__item-body">
          <span className="menu__item-title" style={{ color: 'var(--text-3)' }}>
            Advanced
          </span>
        </span>
        <span className="menu__item-check" style={{ color: 'var(--text-3)' }}>
          <ChevronDown size={14} strokeWidth={2} />
        </span>
      </button>

      <div ref={modelRow} onMouseEnter={() => setSub('model')}>
        <MenuItem
          title="Model"
          hint={current?.label ?? 'None'}
          submenu
          open={sub === 'model'}
          onClick={() => setSub(sub === 'model' ? null : 'model')}
        />
      </div>
      <div ref={effortRow} onMouseEnter={() => supportsEffort && setSub('effort')}>
        <MenuItem
          title="Effort"
          hint={supportsEffort ? EFFORT_LABEL[settings?.effort ?? 'light'] : 'Not supported'}
          submenu={supportsEffort}
          disabled={!supportsEffort}
          open={sub === 'effort'}
          onClick={() => supportsEffort && setSub(sub === 'effort' ? null : 'effort')}
        />
      </div>

      <ModelSubmenu
        anchor={modelRow}
        open={sub === 'model'}
        models={models}
        currentId={current?.id}
        onPick={(modelId) => {
          selectModel(modelId)
          setSub(null)
          onClose()
        }}
        onAddKey={() => {
          setSettingsPage('providers')
          onClose()
        }}
        onClose={() => setSub(null)}
      />

      <Popover
        anchor={effortRow}
        open={sub === 'effort'}
        onClose={() => setSub(null)}
        placement="right-start"
        width={250}
      >
        <div className="menu__label">Effort</div>
        {visibleEfforts.length === 0 && (
          <div className="menu__empty">No effort levels enabled in Configuration.</div>
        )}
        {visibleEfforts.map((effort) => (
          <MenuItem
            key={effort}
            title={EFFORT_LABEL[effort]}
            description={effort === 'ultra' ? 'Consumes usage limits faster' : undefined}
            checked={effort === settings?.effort}
            onClick={() => {
              setEffort(effort)
              setSub(null)
              onClose()
            }}
          />
        ))}
      </Popover>
    </Popover>
  )
}

/**
 * The model list, in its own component so it can hold search state.
 *
 * A provider that has been refreshed can expose well over a hundred models.
 * Capping the menu height stops that running off-screen, but scrolling a
 * capped list of a hundred entries is its own problem — so the filter appears
 * once the list is long enough to actually need one.
 */
function ModelSubmenu({
  anchor,
  open,
  models,
  currentId,
  onPick,
  onAddKey,
  onClose
}: {
  anchor: React.RefObject<HTMLElement>
  open: boolean
  models: ModelInfo[]
  currentId?: string
  onPick: (modelId: string) => void
  onAddKey: () => void
  onClose: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const searchable = models.length > 8

  const q = query.trim().toLowerCase()
  const results = q ? models.filter((m) => `${m.label} ${m.id}`.toLowerCase().includes(q)) : models

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="right-start" width={230}>
      {models.length === 0 ? (
        <>
          <div className="menu__empty">No models available</div>
          <MenuSeparator />
          <MenuItem title="Add an API key…" onClick={onAddKey} />
        </>
      ) : (
        <>
          {searchable && <MenuSearch value={query} onChange={setQuery} placeholder="Search models" />}
          {results.length === 0 ? (
            <div className="menu__empty">No models match “{query.trim()}”</div>
          ) : (
            results.map((model) => (
              <MenuItem
                key={`${model.providerId}:${model.id}`}
                title={model.label}
                checked={model.id === currentId}
                onClick={() => onPick(model.id)}
              />
            ))
          )}
        </>
      )}
    </Popover>
  )
}

/* ------------------------------------------------------------- Plugins menu */

function PluginsMenu({
  anchor,
  open,
  onClose
}: {
  anchor: React.RefObject<HTMLElement>
  open: boolean
  onClose: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const { settings, patchSettings, setView } = useApp(useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings, setView: s.setView })))
  const connectRow = useRef<HTMLDivElement>(null)
  const [subOpen, setSubOpen] = useState(false)

  const installed = CORE_PLUGINS.filter((p) => settings?.installedPlugins.includes(p.id))
  const results = installed.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()))
  const disabled = settings?.disabledPlugins ?? []

  const toggle = (id: string): void => {
    const next = disabled.includes(id) ? disabled.filter((d) => d !== id) : [...disabled, id]
    void patchSettings({ disabledPlugins: next })
  }

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="top-start" width={215}>
      <MenuSearch value={query} onChange={setQuery} placeholder="Search plugins..." />
      {results.map((plugin) => (
        <MenuItem
          key={plugin.id}
          icon={<BrandIcon id={plugin.id} size={18} />}
          title={plugin.name}
          checked={!disabled.includes(plugin.id)}
          onClick={() => toggle(plugin.id)}
        />
      ))}
      {results.length === 0 && <div className="menu__empty">No plugins found</div>}

      <div ref={connectRow} onMouseEnter={() => setSubOpen(true)}>
        <MenuItem
          icon={<AtSign size={16} strokeWidth={1.8} />}
          title="Connect plugins"
          submenu
          open={subOpen}
          onClick={() => setSubOpen((v) => !v)}
        />
      </div>

      <Popover
        anchor={connectRow}
        open={subOpen}
        onClose={() => setSubOpen(false)}
        placement="right-start"
        width={272}
      >
        <MenuItem
          icon={<Laptop size={16} strokeWidth={1.8} />}
          title="Computer Use"
          hint={<Plus size={15} strokeWidth={2} />}
          onClick={() => {
            useApp.getState().setSettingsPage('computer-use')
            onClose()
          }}
        />
        <MenuItem
          icon={<BrandIcon id="chrome" size={17} />}
          title="Chrome"
          hint={<Plus size={15} strokeWidth={2} />}
          onClick={() => {
            useApp.getState().toggleBrowser(true)
            onClose()
          }}
        />
        <MenuSeparator />
        <MenuItem
          title="Browse all plugins"
          hint={<ExternalLink size={14} strokeWidth={2} />}
          onClick={() => {
            setView('plugins')
            onClose()
          }}
        />
      </Popover>
    </Popover>
  )
}
