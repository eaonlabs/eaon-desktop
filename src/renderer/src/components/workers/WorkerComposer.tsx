import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ArrowUp, AtSign, Eye, FileText, Globe, Laptop, Mic, Paperclip, Plus, ShieldCheck, Square, Target, X, Zap } from 'lucide-react'
import { useApp } from '../../state/store'
import { useWorkers } from './workersStore'
import { WorkerFace } from './WorkerFace'
import { MenuItem, MenuSeparator, Popover, useDisclosure } from '../ui'
import { PluginsSubmenu } from '../Composer'
import { PluginLogo } from '../plugins/PluginLogo'
import { useMcpStatuses, useSkills } from '../plugins/usePlugins'
import { useSuggest, type SuggestItem, type SuggestSources } from '../composer/SuggestMenu'
import { liveMentions, permissionItems, pluginItems, skillItems, toolMentionItems, type Mention } from '../composer/sources'
import { removeMention } from '../composer/suggest'
import { joinTranscript, useDictation } from '../composer/useDictation'
import { VoiceBar } from '../composer/VoiceBar'
import { ModelSelect } from '../composer/ModelSelect'
import { ENGINE_LABEL } from '@shared/engines'
import { fileName, fileUrl, isImagePath } from '../../lib/files'
import { mcpCatalogEntry } from '@shared/mcpCatalog'
import { MAIN_THREAD, mentionedWorkers, WORKER_ACCESS, type Worker, type WorkerAccess } from '@shared/workers'
import type { McpServer } from '@shared/types'

const ACCESS_ICON: Record<WorkerAccess, typeof Zap> = { autonomous: Zap, safe: ShieldCheck, 'read-only': Eye }

/**
 * Writing to a worker: text and files, plus what Chat's + menu offers that
 * makes sense for a worker — making the message its goal, plugins, its
 * browser, computer use and how much it may do alone. Swarm is left out on
 * purpose: workers already split work between themselves. While it is busy,
 * messages queue and arrive with its next turn.
 *
 * "@" mentions colleagues (they get their own copy of the message, see
 * engine.send), plugins and tools; "/" runs the + menu's commands.
 */
/**
 * `threadId` is the thread being written to: the main one, another of the
 * worker's threads, or `'new'` to start a task that runs beside the rest.
 * Goal belongs to the main thread only.
 */
export function WorkerComposer({ worker, threadId = MAIN_THREAD }: { worker: Worker; threadId?: string }): JSX.Element {
  const { send, stop, save, workers } = useWorkers(useShallow((s) => ({ send: s.send, stop: s.stop, save: s.save, workers: s.workers })))
  const { settings, mcpServers, saveMcpServers, setSettingsPage, setView } = useApp(
    useShallow((s) => ({
      settings: s.settings,
      mcpServers: s.mcpServers,
      saveMcpServers: s.saveMcpServers,
      setSettingsPage: s.setSettingsPage,
      setView: s.setView
    }))
  )
  const statuses = useMcpStatuses()
  const { skills } = useSkills()
  const [text, setText] = useState('')
  const [files, setFiles] = useState<string[]>([])
  // Armed per message, like Chat's Goal: the next send becomes the worker's goal.
  const [goalArmed, setGoalArmed] = useState(false)
  const [mentions, setMentions] = useState<Mention[]>([])
  const [dragging, setDragging] = useState(false)
  const [hasBrowser, setHasBrowser] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  // Dictation: what is said lands at the end of the message, ready to edit, never sent by itself.
  const dictation = useDictation((spoken) => {
    setText((current) => joinTranscript(current, spoken))
    requestAnimationFrame(() => {
      const node = box.current
      node?.focus()
      node?.setSelectionRange(node.value.length, node.value.length)
    })
  })
  const dictating = dictation.state !== 'idle'
  const plusAnchor = useRef<HTMLButtonElement>(null)
  const plusMenu = useDisclosure()
  const info = worker.threads.find((t) => t.id === threadId)
  const isMain = threadId === MAIN_THREAD
  const working = isMain ? worker.runningMessageId !== null : Boolean(info?.runningMessageId)

  useEffect(() => {
    const node = box.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 260)}px`
  }, [text])

  // Its browser opens the first time it browses; until then there is nothing to show.
  useEffect(() => {
    let live = true
    void window.api.workers.hasBrowser(worker.id).then((has) => live && setHasBrowser(has))
    return () => {
      live = false
    }
  }, [worker.id, plusMenu.open, text.includes('@')])

  const addFiles = (paths: string[]): void => setFiles((current) => [...new Set([...current, ...paths])].slice(0, 12))
  const pickFiles = (): void =>
    void window.api.app.openFiles({ properties: ['openFile', 'openDirectory', 'multiSelections'] }).then(addFiles)
  const showBrowser = (): void => void window.api.workers.showBrowser(worker.id)
  const setAccess = (access: WorkerAccess): void => {
    if (access === worker.access) return
    void save({ id: worker.id, name: worker.name, color: worker.color, personality: worker.personality, purpose: worker.purpose, access })
  }
  const pullInPlugin = (server: McpServer): void => {
    // The + menu's toggle: plugins are on or off everywhere, workers included.
    if (!server.enabled) void saveMcpServers(mcpServers.map((m) => (m.id === server.id ? { ...m, enabled: true } : m)))
    setMentions((current) => (current.some((m) => m.id === server.id) ? current : [...current, { id: server.id, name: server.name, pluginId: server.pluginId }]))
  }

  const colleagues = workers.filter((w) => w.id !== worker.id)
  const sources: SuggestSources = {
    '/': () => [
      { id: 'attach', title: 'Add photos and files', keywords: 'attach file image upload', section: 'Add', icon: <Paperclip size={16} strokeWidth={1.8} />, run: pickFiles },
      ...(isMain
        ? [
            {
              id: 'goal',
              title: 'Goal',
              keywords: 'goal aim objective',
              description: `Make this message ${worker.name}'s goal`,
              section: 'Modes',
              icon: <Target size={16} strokeWidth={1.8} />,
              checked: goalArmed,
              run: () => setGoalArmed(!goalArmed)
            }
          ]
        : []),
      ...permissionItems(
        WORKER_ACCESS.map((a) => {
          const Icon = ACCESS_ICON[a.id]
          return { id: a.id, title: a.label, keywords: `${a.id} freedom`, icon: <Icon size={16} strokeWidth={1.8} /> }
        }),
        worker.access,
        setAccess
      ),
      // Only once it has opened one: before that there is nothing to watch.
      ...(hasBrowser
        ? [{ id: 'browser', title: 'Its browser', keywords: 'browser web watch sign in', description: 'Watch it, or sign it in', section: 'Tools', icon: <Globe size={16} strokeWidth={1.8} />, run: showBrowser }]
        : []),
      { id: 'computer', title: 'Computer use', keywords: 'computer screen mouse', section: 'Tools', icon: <Laptop size={16} strokeWidth={1.8} />, hint: settings?.computerUse.enabled ? 'On' : 'Off', run: () => setSettingsPage('computer-use') },
      { id: 'plugins', title: 'Browse plugins', keywords: 'plugins mcp integrations', section: 'Tools', icon: <AtSign size={16} strokeWidth={1.8} />, run: () => setView('plugins') },
      { id: 'wake', title: 'Check in now', keywords: 'wake check in now', section: worker.name, icon: <Zap size={16} strokeWidth={1.8} />, run: () => void window.api.workers.wake(worker.id) },
      ...skillItems(skills, settings?.disabledSkills ?? [])
    ],
    '@': () => [
      ...colleagues.map(
        (w): SuggestItem => ({
          id: `worker:${w.id}`,
          title: w.name,
          keywords: `${w.purpose} worker`,
          description: w.purpose ? (w.purpose.length > 70 ? `${w.purpose.slice(0, 67)}…` : w.purpose) : undefined,
          section: 'Workers',
          icon: <WorkerFace color={w.color} size={18} />,
          hint: 'Gets it too',
          insert: `@${w.name}`
        })
      ),
      ...pluginItems(mcpServers, statuses, pullInPlugin),
      ...toolMentionItems({
        computerOn: Boolean(settings?.computerUse.enabled),
        onBrowser: hasBrowser ? showBrowser : undefined,
        onComputerSettings: () => setSettingsPage('computer-use'),
        browserHint: `${worker.name}'s own`
      })
    ]
  }
  const suggest = useSuggest({ text, setText, textarea: box, sources, label: { '/': 'Commands', '@': 'Workers, plugins and tools' } })
  const copiedTo = mentionedWorkers(text, colleagues, worker.id)
  const shownMentions = liveMentions(mentions, text)
  const hasChips = goalArmed || copiedTo.length > 0 || shownMentions.length > 0

  const submit = (): void => {
    if (!text.trim() && files.length === 0) return
    void send(worker.id, text.trim(), files, {
      ...(isMain && goalArmed && text.trim() ? { goal: true } : {}),
      ...(isMain ? {} : { threadId })
    })
    setText('')
    setFiles([])
    setMentions([])
    setGoalArmed(false)
  }

  return (
    <div
      className="composer-stack composer-stack--chat"
      data-dragging={dragging || undefined}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        addFiles([...e.dataTransfer.files].map((file) => window.api.app.pathForFile(file)).filter(Boolean))
      }}
    >
      <div className="composer" data-goal={goalArmed || undefined}>
        {files.length > 0 && (
          <div className="composer__attachments">
            {files.map((path) => (
              <span key={path} className="attachment-chip" title={path}>
                {isImagePath(path) ? <img className="attachment-chip__thumb" src={fileUrl(path)} alt="" /> : <FileText size={14} strokeWidth={1.8} />}
                <span className="attachment-chip__name">{fileName(path)}</span>
                <button className="attachment-chip__remove" aria-label={`Remove ${path}`} onClick={() => setFiles((c) => c.filter((p) => p !== path))}>
                  <X size={12} strokeWidth={2.2} />
                </button>
              </span>
            ))}
          </div>
        )}
        {dictating ? (
          <VoiceBar dictation={dictation} />
        ) : (
        <textarea
          ref={box}
          className="composer__input"
          rows={1}
          value={text}
          placeholder={
            worker.paused
              ? `${worker.name} is paused — messages wait until you resume it`
              : threadId === 'new'
                ? `Describe a task for ${worker.name} — it runs beside everything else`
                : goalArmed
                  ? `Describe ${worker.name}'s goal`
                  : info
                    ? `Message ${worker.name} in “${info.title}”`
                    : `Message ${worker.name}`
          }
          onChange={(e) => {
            setText(e.target.value)
            suggest.onCaret()
          }}
          onSelect={suggest.onCaret}
          onKeyDown={(e) => {
            if (suggest.onKeyDown(e)) return
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        )}
        {dictation.error && (
          <div className="voice-error" role="alert">
            <span className="voice-error__text">{dictation.error}</span>
            <button onClick={dictation.dismissError} aria-label="Dismiss">
              <X size={12} strokeWidth={2.2} />
            </button>
          </div>
        )}
        <div className="composer__toolbar">
          <button
            ref={plusAnchor}
            className="composer__round"
            data-open={plusMenu.open || undefined}
            onClick={plusMenu.toggle}
            aria-label="Add files and more"
            title="Add files, plugins and more"
          >
            <Plus size={18} strokeWidth={1.9} />
          </button>
          {hasChips && (
            <div className="composer__chips">
              {goalArmed && (
                <Chip icon={<Target size={13} strokeWidth={2} />} label="Goal" title={`This message becomes ${worker.name}'s goal`} onClear={() => setGoalArmed(false)} clearLabel="Turn off Goal" />
              )}
              {copiedTo.map((w) => (
                <Chip
                  key={w.id}
                  icon={<WorkerFace color={w.color} size={14} />}
                  label={w.name}
                  title={`${w.name} gets this message too`}
                  onClear={() => setText(removeMention(text, w.name))}
                  clearLabel={`Remove @${w.name}`}
                />
              ))}
              {shownMentions.map((m) => (
                <Chip
                  key={m.id}
                  icon={
                    <span className="composer-chip__logo">
                      <PluginLogo logo={m.pluginId ? mcpCatalogEntry(m.pluginId)?.logoAssetName : undefined} name={m.name} size={13} />
                    </span>
                  }
                  label={m.name}
                  title={`${m.name} is mentioned in this message`}
                  onClear={() => {
                    setMentions((current) => current.filter((x) => x.id !== m.id))
                    setText(removeMention(text, m.name))
                  }}
                  clearLabel={`Remove @${m.name}`}
                />
              ))}
            </div>
          )}
          <div className="composer__spacer" />
          {/* The model this worker thinks with, chosen here as in Chat (it was only in Edit worker). */}
          <ModelSelect
            variant="chip"
            engine={worker.engine ?? 'native'}
            label={`${worker.name}’s model`}
            value={worker.model}
            defaultLabel={worker.engine && worker.engine !== 'native' ? `${ENGINE_LABEL[worker.engine]}’s default` : 'Chat’s model'}
            onChange={(ref) =>
              void save({
                id: worker.id,
                name: worker.name,
                color: worker.color,
                personality: worker.personality,
                purpose: worker.purpose,
                model: ref && ref.modelId ? { providerId: ref.providerId ?? worker.engine ?? 'native', modelId: ref.modelId } : null
              })
            }
          />
          {working && (
            <button
              className="chip worker-stop"
              onClick={() => void stop(worker.id, threadId)}
              title={isMain ? `Stop what ${worker.name} is doing in this conversation; its other tasks carry on` : `Stop this task; ${worker.name}'s other work carries on`}
            >
              <Square size={10} strokeWidth={0} fill="currentColor" />
              <span className="chip__label">Stop</span>
            </button>
          )}
          <button
            className="composer__round composer__mic"
            data-active={dictating || undefined}
            onClick={() => (dictating ? dictation.cancel() : void dictation.start())}
            disabled={dictation.state === 'transcribing'}
            aria-label={dictating ? 'Stop dictating' : 'Dictate'}
            title={dictating ? 'Stop dictating' : 'Dictate a message'}
          >
            <Mic size={16} strokeWidth={1.9} />
          </button>
          <button className="send" disabled={dictating || (!text.trim() && files.length === 0)} onClick={submit} aria-label="Send">
            <ArrowUp size={17} strokeWidth={2.2} />
          </button>
        </div>
      </div>
      {suggest.menu}
      <WorkerAddMenu
        worker={worker}
        anchor={plusAnchor}
        open={plusMenu.open}
        onClose={plusMenu.close}
        onAttach={pickFiles}
        goalArmed={goalArmed}
        canGoal={isMain}
        onGoal={() => {
          setGoalArmed(!goalArmed)
          box.current?.focus()
        }}
        hasBrowser={hasBrowser}
        onBrowser={showBrowser}
        onAccess={setAccess}
      />
    </div>
  )
}

function Chip({ icon, label, title, onClear, clearLabel }: { icon: JSX.Element; label: string; title: string; onClear: () => void; clearLabel: string }): JSX.Element {
  return (
    <span className="composer-chip" title={title}>
      {icon}
      <span className="composer-chip__label">{label}</span>
      <button className="composer-chip__clear" onClick={onClear} aria-label={clearLabel} title={clearLabel}>
        <X size={11} strokeWidth={2.4} />
      </button>
    </span>
  )
}

/**
 * A worker's + menu: Chat's, minus Swarm and Plan. A worker coordinates
 * with its team instead of spawning helpers, and it runs unattended, where a
 * plan would wait on an approval nobody is there to give. Permissions are
 * the worker's own setting (the editor's "Freedom"), not the app's.
 */
function WorkerAddMenu({
  worker,
  anchor,
  open,
  onClose,
  onAttach,
  goalArmed,
  canGoal,
  onGoal,
  hasBrowser,
  onBrowser,
  onAccess
}: {
  worker: Worker
  anchor: React.RefObject<HTMLElement>
  open: boolean
  onClose: () => void
  onAttach: () => void
  goalArmed: boolean
  /** Goal is for the main conversation; a side thread has none. */
  canGoal: boolean
  onGoal: () => void
  hasBrowser: boolean
  onBrowser: () => void
  onAccess: (access: WorkerAccess) => void
}): JSX.Element {
  const { settings, setSettingsPage } = useApp(useShallow((s) => ({ settings: s.settings, setSettingsPage: s.setSettingsPage })))
  const connected = useApp((s) => s.mcpServers.filter((m) => m.enabled).length)
  const pluginsRow = useRef<HTMLDivElement>(null)
  const accessRow = useRef<HTMLDivElement>(null)
  const [sub, setSub] = useState<'plugins' | 'access' | null>(null)
  const access = WORKER_ACCESS.find((a) => a.id === worker.access)
  const AccessIcon = ACCESS_ICON[worker.access]

  const close = (): void => {
    setSub(null)
    onClose()
  }

  return (
    <Popover anchor={anchor} open={open} onClose={close} placement="bottom-start" width={280} className="menu--tall">
      <MenuItem
        icon={<Paperclip size={16} strokeWidth={1.8} />}
        title="Add photos and files"
        onMouseEnter={() => setSub(null)}
        onClick={() => {
          close()
          onAttach()
        }}
      />

      {canGoal && (
        <>
          <div className="menu__label">Modes</div>
          <MenuItem
            icon={<Target size={16} strokeWidth={1.8} />}
            title="Goal"
            hint={goalArmed ? undefined : `Set ${worker.name}'s goal`}
            checked={goalArmed}
            onMouseEnter={() => setSub(null)}
            onClick={() => {
              onGoal()
              close()
            }}
          />
        </>
      )}

      <div className="menu__label">Tools</div>
      <MenuItem
        icon={<Globe size={16} strokeWidth={1.8} />}
        title="Its browser"
        hint={hasBrowser ? 'Watch or sign in' : 'Not opened yet'}
        disabled={!hasBrowser}
        onMouseEnter={() => setSub(null)}
        onClick={() => {
          onBrowser()
          close()
        }}
      />
      <MenuItem
        icon={<Laptop size={16} strokeWidth={1.8} />}
        title="Computer use"
        hint={settings?.computerUse.enabled ? 'On' : 'Off'}
        onMouseEnter={() => setSub(null)}
        onClick={() => {
          setSettingsPage('computer-use')
          close()
        }}
      />
      <div ref={pluginsRow} onMouseEnter={() => setSub('plugins')}>
        <MenuItem
          icon={<AtSign size={16} strokeWidth={1.8} />}
          title="Plugins"
          hint={connected > 0 ? `${connected} on` : undefined}
          submenu
          open={sub === 'plugins'}
          onClick={() => setSub(sub === 'plugins' ? null : 'plugins')}
        />
      </div>

      <MenuSeparator />
      <div ref={accessRow} onMouseEnter={() => setSub('access')}>
        <MenuItem
          icon={<AccessIcon size={16} strokeWidth={1.8} />}
          title="Permissions"
          hint={access?.label}
          submenu
          open={sub === 'access'}
          onClick={() => setSub(sub === 'access' ? null : 'access')}
        />
      </div>

      <PluginsSubmenu anchor={pluginsRow} open={open && sub === 'plugins'} onClose={() => setSub(null)} onDone={close} />
      <Popover anchor={accessRow} open={open && sub === 'access'} onClose={() => setSub(null)} placement="right-start" width={330}>
        <div className="menu__label">How much {worker.name} may do alone</div>
        {WORKER_ACCESS.map((level) => {
          const Icon = ACCESS_ICON[level.id]
          return (
            <MenuItem
              key={level.id}
              icon={<Icon size={16} strokeWidth={1.8} />}
              title={level.label}
              description={level.description}
              checked={worker.access === level.id}
              onClick={() => {
                onAccess(level.id)
                close()
              }}
            />
          )
        })}
      </Popover>
    </Popover>
  )
}
