import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  ArrowUp,
  ChevronDown,
  ExternalLink,
  FileText,
  Folder,
  Globe,
  Hand,
  Laptop,
  Lightbulb,
  Network,
  Paperclip,
  Plus,
  ShieldCheck,
  Square,
  Target,
  AtSign,
  Clock3,
  X,
  Zap
} from 'lucide-react'
import { agentWorkspace, useApp, useIsWork } from '../state/store'
import { MenuItem, MenuSearch, MenuSeparator, Popover, useDisclosure } from './ui'
import { mcpCatalogEntry } from '@shared/mcpCatalog'
import { PluginLogo } from './plugins/PluginLogo'
import { useMcpStatuses } from './plugins/usePlugins'
import { fileName, fileUrl, isImagePath } from '../lib/files'
import type { EffortLevel, ModelInfo } from '@shared/types'
import { clampEffort, EFFORT_LABEL } from '@shared/effort'

/** A line under the levels that need one. */
const EFFORT_NOTE: Partial<Record<EffortLevel, string>> = {
  none: 'Answers without thinking first',
  ultra: 'Most thinking, most tokens'
}

/**
 * The chat box. Deliberately plain — a + button, the text, the model and
 * send — because Chat is for everyone. Everything that made it feel like a
 * cockpit (approvals, Plan / Swarm / Goal, the work folder, plugins, the
 * browser) lives behind +, and whatever is switched on shows as a small chip
 * that turns it off again, so nothing is hidden that is actually in effect.
 *
 * Memoised: it sits in the conversation view, which re-renders on every batch
 * of streamed tokens, and takes nothing from it but `variant`.
 */
export const Composer = memo(function Composer({ variant = 'home' }: { variant?: 'home' | 'chat' }): JSX.Element {
  const { settings, streamingChatId, activeChatId, send, stop, composerDraft, setComposerDraft, setWorkCwd, patchSettings } = useApp(
    useShallow((s) => ({
      settings: s.settings,
      streamingChatId: s.streamingChatId,
      activeChatId: s.activeChatId,
      send: s.send,
      stop: s.stop,
      composerDraft: s.composerDraft,
      setComposerDraft: s.setComposerDraft,
      setWorkCwd: s.setWorkCwd,
      patchSettings: s.patchSettings
    }))
  )
  const cwd = useApp((s) => agentWorkspace(s.workspaces)?.cwd ?? null)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  // Goal mode is armed per message: the next send becomes a goal the agent
  // keeps pursuing, then the composer drops back to normal.
  const [goalArmed, setGoalArmed] = useState(false)
  // How long a goal may run: until it is done, or until a time the user picks.
  const [goalUntil, setGoalUntil] = useState<GoalEnd>({ kind: 'none' })
  const [dragging, setDragging] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const isAgent = useIsWork()

  const plusAnchor = useRef<HTMLButtonElement>(null)
  const modelAnchor = useRef<HTMLButtonElement>(null)
  const plusMenu = useDisclosure()
  const modelMenu = useDisclosure()

  const model = useApp((s) => s.currentModel())
  // What the request will actually use: the chosen effort, clamped to the model.
  const effort = clampEffort(settings?.effort, model?.efforts)
  // Stop belongs to the chat whose reply is streaming. Anywhere else — another
  // chat, a new one — it stopped a reply the user could not see, and Enter
  // with a message typed did the same; there, sending waits instead.
  const streaming = streamingChatId !== null && streamingChatId === activeChatId
  const busyElsewhere = streamingChatId !== null && !streaming

  useEffect(() => {
    const node = textarea.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 320)}px`
  }, [text])

  // A suggestion chip on the home screen drops its prompt here.
  useEffect(() => {
    if (composerDraft === null) return
    setText(composerDraft)
    setComposerDraft(null)
    const node = textarea.current
    node?.focus()
    // Caret at the end, ready for the rest of the sentence.
    requestAnimationFrame(() => node?.setSelectionRange(composerDraft.length, composerDraft.length))
  }, [composerDraft, setComposerDraft])

  const addAttachments = (paths: string[]): void => {
    if (paths.length === 0) return
    setAttachments((current) => [...new Set([...current, ...paths])].slice(0, 12))
    textarea.current?.focus()
  }

  const submit = (): void => {
    if (streaming) {
      stop()
      return
    }
    if (busyElsewhere || (!text.trim() && attachments.length === 0)) return
    void send(text, { attachments, goal: isAgent && goalArmed, until: isAgent && goalArmed ? goalEndAt(goalUntil) : null })
    setText('')
    setAttachments([])
    setGoalArmed(false)
    setGoalUntil({ kind: 'none' })
  }

  const planOn = isAgent && Boolean(settings?.planMode)
  const swarmOn = isAgent && Boolean(settings?.work.swarm)
  const autoApprove = isAgent && settings?.approvalMode === 'auto'
  const fullAutonomy = isAgent && settings?.approvalMode === 'full'
  const hasChips = Boolean(cwd) || planOn || swarmOn || goalArmed || autoApprove || fullAutonomy

  return (
    <div
      className={`composer-stack ${variant === 'chat' ? 'composer-stack--chat' : ''}`}
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
        addAttachments([...e.dataTransfer.files].map((file) => window.api.app.pathForFile(file)).filter(Boolean))
      }}
    >
      <div className="composer" data-goal={goalArmed || undefined}>
        {attachments.length > 0 && (
          <div className="composer__attachments">
            {attachments.map((path) => (
              <span key={path} className="attachment-chip" title={path}>
                {isImagePath(path) ? (
                  <img className="attachment-chip__thumb" src={fileUrl(path)} alt="" />
                ) : (
                  <FileText size={14} strokeWidth={1.8} />
                )}
                <span className="attachment-chip__name">{fileName(path)}</span>
                <button
                  className="attachment-chip__remove"
                  aria-label={`Remove ${path}`}
                  onClick={() => setAttachments((current) => current.filter((p) => p !== path))}
                >
                  <X size={12} strokeWidth={2.2} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textarea}
          className="composer__input"
          placeholder={
            goalArmed
              ? 'Describe the goal — Eaon keeps working until it is done'
              : planOn
                ? 'Describe the task — Eaon researches and proposes a plan first'
                : variant === 'home' && isAgent
                  ? 'Ask anything, or give Eaon a task'
                  : 'Ask anything'
          }
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
            aria-label="Add files and more"
            title="Add files, tools and modes"
          >
            <Plus size={18} strokeWidth={1.9} />
          </button>

          {hasChips && (
            <div className="composer__chips">
              {cwd && (
                <ActiveChip icon={<Folder size={13} strokeWidth={2} />} label={fileName(cwd)} title={`Working in ${cwd}`} onClear={() => setWorkCwd(null)} clearLabel="Stop using this folder" />
              )}
              {goalArmed && <ActiveChip icon={<Target size={13} strokeWidth={2} />} label="Goal" title="The next message is a goal Eaon keeps working on until it is done" onClear={() => setGoalArmed(false)} clearLabel="Turn off Goal" />}
              {goalArmed && <GoalEndChip value={goalUntil} onChange={setGoalUntil} />}
              {planOn && <ActiveChip icon={<Lightbulb size={13} strokeWidth={2} />} label="Plan" title="Eaon researches and proposes a plan before changing anything" onClear={() => void patchSettings({ planMode: false })} clearLabel="Turn off Plan mode" />}
              {swarmOn && <ActiveChip icon={<Network size={13} strokeWidth={2} />} label="Swarm" title="Eaon can split work across parallel sub-agents" onClear={() => void patchSettings({ work: { swarm: false } })} clearLabel="Turn off Swarm" />}
              {autoApprove && <ActiveChip icon={<ShieldCheck size={13} strokeWidth={2} />} label="Auto-approve" title="Eaon only asks before actions that look unsafe" onClear={() => void patchSettings({ approvalMode: 'ask' })} clearLabel="Ask before every action again" />}
              {fullAutonomy && <ActiveChip icon={<Zap size={13} strokeWidth={2} />} label="Full autonomy" title="Eaon runs any command and change on its own, and only stops for what can't be undone" onClear={() => void patchSettings({ approvalMode: 'ask' })} clearLabel="Ask before every action again" />}
            </div>
          )}

          <div className="composer__spacer" />

          <button
            ref={modelAnchor}
            className="chip chip--model"
            data-open={modelMenu.open || undefined}
            onClick={modelMenu.toggle}
          >
            <span className="chip__model">{model?.label ?? 'No model'}</span>
            {effort && <span className="chip__effort">{EFFORT_LABEL[effort]}</span>}
            <ChevronDown size={13} strokeWidth={2} className="chip__chevron" />
          </button>

          <button
            className={`send ${streaming ? 'send--stop' : ''}`}
            disabled={busyElsewhere || (!streaming && !text.trim() && attachments.length === 0)}
            onClick={submit}
            aria-label={streaming ? 'Stop' : 'Send'}
            title={busyElsewhere ? 'Eaon is still replying in another chat' : undefined}
          >
            {streaming ? (
              <Square size={11} strokeWidth={0} fill="currentColor" />
            ) : (
              <ArrowUp size={17} strokeWidth={2.2} />
            )}
          </button>
        </div>
      </div>

      <AddMenu
        anchor={plusAnchor}
        open={plusMenu.open}
        onClose={plusMenu.close}
        onAttach={addAttachments}
        goalArmed={goalArmed}
        onGoal={() => {
          setGoalArmed(!goalArmed)
          textarea.current?.focus()
        }}
      />
      <ModelMenu anchor={modelAnchor} open={modelMenu.open} onClose={modelMenu.close} />
    </div>
  )
})

/** A mode or setting that is on, shown in the toolbar with a way to turn it off. */
function ActiveChip({
  icon,
  label,
  title,
  onClear,
  clearLabel
}: {
  icon: JSX.Element
  label: string
  title: string
  onClear: () => void
  clearLabel: string
}): JSX.Element {
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

/* ---------------------------------------------------------- goal end time */

/** How long a goal runs: until it's done (the usual limits), for a while, or until a clock time. */
type GoalEnd = { kind: 'none' } | { kind: 'for'; minutes: number } | { kind: 'at'; time: string }

/** The goal's end as a timestamp, worked out when the message is sent. A clock time already past today means tomorrow. */
function goalEndAt(end: GoalEnd, now = Date.now()): number | null {
  if (end.kind === 'for') return now + end.minutes * 60_000
  if (end.kind !== 'at') return null
  const [hours, minutes] = end.time.split(':').map(Number)
  const at = new Date(now)
  at.setHours(hours, minutes, 0, 0)
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime()
}

function goalEndLabel(end: GoalEnd): string {
  if (end.kind === 'for') return end.minutes < 60 ? `For ${end.minutes} min` : `For ${end.minutes / 60} h`
  if (end.kind === 'at') {
    const at = goalEndAt(end)!
    return `Until ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
  }
  return 'Until done'
}

const GOAL_SPANS = [30, 60, 180, 480]

/**
 * Beside the Goal chip: when the goal stops. "Until done" keeps the usual
 * limits (Settings → Configuration); a span or a clock time keeps Eaon on it
 * until then, with the computer kept awake.
 */
function GoalEndChip({ value, onChange }: { value: GoalEnd; onChange: (value: GoalEnd) => void }): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const [time, setTime] = useState(value.kind === 'at' ? value.time : defaultEndTime())
  return (
    <>
      <button ref={anchor} className="composer-chip composer-chip--button" onClick={menu.toggle} title="When Eaon stops working on the goal">
        <Clock3 size={13} strokeWidth={2} />
        <span className="composer-chip__label">{goalEndLabel(value)}</span>
        <ChevronDown size={11} strokeWidth={2.4} />
      </button>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="top-start" width={260}>
        <div className="menu__label">Keep working on the goal</div>
        <MenuItem
          title="Until it's done"
          description="Stops when the goal is met, or at the usual limits"
          checked={value.kind === 'none'}
          onClick={() => {
            onChange({ kind: 'none' })
            menu.close()
          }}
        />
        {GOAL_SPANS.map((minutes) => (
          <MenuItem
            key={minutes}
            title={minutes < 60 ? `For ${minutes} minutes` : `For ${minutes / 60} hour${minutes === 60 ? '' : 's'}`}
            checked={value.kind === 'for' && value.minutes === minutes}
            onClick={() => {
              onChange({ kind: 'for', minutes })
              menu.close()
            }}
          />
        ))}
        <div className="goal-end__at">
          <span>Until</span>
          <input
            className="input goal-end__time"
            type="time"
            value={time}
            aria-label="End time"
            onChange={(e) => setTime(e.target.value)}
          />
          <button
            className="btn btn--sm"
            disabled={!/^\d{2}:\d{2}$/.test(time)}
            onClick={() => {
              onChange({ kind: 'at', time })
              menu.close()
            }}
          >
            Set
          </button>
        </div>
      </Popover>
    </>
  )
}

/** Two hours from now, on the hour — a sensible first guess for the time field. */
function defaultEndTime(): string {
  const at = new Date(Date.now() + 2 * 60 * 60_000)
  return `${String(at.getHours()).padStart(2, '0')}:00`
}

/* ------------------------------------------------------------------ + menu */

/**
 * Everything the composer does not show: attachments, the work folder, the
 * agent's modes, its tools and how it asks for approval. Descriptions say what
 * each one does in plain words — this menu is also where people discover how
 * much Chat can do.
 */
function AddMenu({
  anchor,
  open,
  onClose,
  onAttach,
  goalArmed,
  onGoal
}: {
  anchor: React.RefObject<HTMLElement>
  open: boolean
  onClose: () => void
  onAttach: (paths: string[]) => void
  goalArmed: boolean
  onGoal: () => void
}): JSX.Element {
  const { settings, patchSettings, setWorkCwd, setSettingsPage, toggleBrowser } = useApp(
    useShallow((s) => ({
      settings: s.settings,
      patchSettings: s.patchSettings,
      setWorkCwd: s.setWorkCwd,
      setSettingsPage: s.setSettingsPage,
      toggleBrowser: s.toggleBrowser
    }))
  )
  const cwd = useApp((s) => agentWorkspace(s.workspaces)?.cwd ?? null)
  const isAgent = useIsWork()
  const pluginsRow = useRef<HTMLDivElement>(null)
  const approvalRow = useRef<HTMLDivElement>(null)
  const [sub, setSub] = useState<'plugins' | 'approval' | null>(null)
  const connected = useApp((s) => s.mcpServers.filter((m) => m.enabled).length)

  const close = (): void => {
    setSub(null)
    onClose()
  }

  return (
    <Popover anchor={anchor} open={open} onClose={close} placement="bottom-start" width={isAgent ? 280 : 240} className="menu--tall">
      <MenuItem
        icon={<Paperclip size={16} strokeWidth={1.8} />}
        title="Add photos and files"
        onMouseEnter={() => setSub(null)}
        onClick={() => {
          close()
          void window.api.app
            .openFiles({ properties: isAgent ? ['openFile', 'openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'] })
            .then(onAttach)
        }}
      />
      {isAgent && (
        <>
          <MenuItem
            icon={<Folder size={16} strokeWidth={1.8} />}
            title="Work in a folder"
            hint={cwd ? fileName(cwd) : fileName(settings?.work.defaultFolder ?? '~/Eaon')}
            onMouseEnter={() => setSub(null)}
            onClick={() => {
              close()
              void window.api.app.openFiles({ properties: ['openDirectory'] }).then((paths) => paths[0] && setWorkCwd(paths[0]))
            }}
          />

          <div className="menu__label">Modes</div>
          <MenuItem
            icon={<Target size={16} strokeWidth={1.8} />}
            title="Goal"
            hint={goalArmed ? undefined : 'Work until done'}
            checked={goalArmed}
            onMouseEnter={() => setSub(null)}
            onClick={() => {
              onGoal()
              close()
            }}
          />
          <MenuItem
            icon={<Lightbulb size={16} strokeWidth={1.8} />}
            title="Plan first"
            hint={settings?.planMode ? undefined : 'Approve a plan'}
            checked={settings?.planMode}
            onMouseEnter={() => setSub(null)}
            onClick={() => {
              void patchSettings({ planMode: !settings?.planMode })
              close()
            }}
          />
          <MenuItem
            icon={<Network size={16} strokeWidth={1.8} />}
            title="Swarm"
            hint={settings?.work.swarm ? undefined : 'Parallel helpers'}
            checked={settings?.work.swarm}
            onMouseEnter={() => setSub(null)}
            onClick={() => {
              void patchSettings({ work: { swarm: !settings?.work.swarm } })
              close()
            }}
          />

          <div className="menu__label">Tools</div>
          <MenuItem
            icon={<Globe size={16} strokeWidth={1.8} />}
            title="Browser"
            hint="Browse and click"
            onMouseEnter={() => setSub(null)}
            onClick={() => {
              toggleBrowser(true)
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
          <div ref={approvalRow} onMouseEnter={() => setSub('approval')}>
            <MenuItem
              icon={
                settings?.approvalMode === 'full' ? (
                  <Zap size={16} strokeWidth={1.8} />
                ) : settings?.approvalMode === 'auto' ? (
                  <ShieldCheck size={16} strokeWidth={1.8} />
                ) : (
                  <Hand size={16} strokeWidth={1.8} />
                )
              }
              title="Permissions"
              hint={settings?.approvalMode === 'full' ? 'Full autonomy' : settings?.approvalMode === 'auto' ? 'Auto-approve' : 'Ask first'}
              submenu
              open={sub === 'approval'}
              onClick={() => setSub(sub === 'approval' ? null : 'approval')}
            />
          </div>

          <PluginsSubmenu anchor={pluginsRow} open={open && sub === 'plugins'} onClose={() => setSub(null)} onDone={close} />
          <ApprovalMenu anchor={approvalRow} open={open && sub === 'approval'} onClose={() => setSub(null)} onDone={close} />
        </>
      )}
    </Popover>
  )
}

/* ------------------------------------------------------------ Approval menu */

function ApprovalMenu({
  anchor,
  open,
  onClose,
  onDone
}: {
  anchor: React.RefObject<HTMLElement>
  open: boolean
  onClose: () => void
  onDone: () => void
}): JSX.Element {
  const { settings, patchSettings } = useApp(useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings })))
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="right-start" width={330}>
      <div className="menu__label">When Eaon wants to change something</div>
      <MenuItem
        icon={<Hand size={16} strokeWidth={1.8} />}
        title="Ask first"
        description="Ask before editing files, running commands or acting in apps"
        checked={settings?.approvalMode === 'ask'}
        onClick={() => {
          void patchSettings({ approvalMode: 'ask' })
          onDone()
        }}
      />
      <MenuItem
        icon={<ShieldCheck size={16} strokeWidth={1.8} />}
        title="Auto-approve"
        description="Only ask for actions that look unsafe"
        checked={settings?.approvalMode === 'auto'}
        onClick={() => {
          void patchSettings({ approvalMode: 'auto' })
          onDone()
        }}
      />
      <MenuItem
        icon={<Zap size={16} strokeWidth={1.8} />}
        title="Full autonomy"
        description="Run any command and make any change on its own, anywhere on this computer. Still asks before sudo, erasing disks, force-pushing, passwords or payments"
        checked={settings?.approvalMode === 'full'}
        onClick={() => {
          void patchSettings({ approvalMode: 'full' })
          onDone()
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

  // Exactly the levels this model takes (from the catalog), so the menu never
  // offers a setting the request would ignore. A model without effort control
  // (Haiku 4.5, most local models) gets the row disabled instead.
  const efforts = current?.efforts ?? []
  const effort = clampEffort(settings?.effort, efforts)

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="bottom-end" width={212}>
      <div ref={modelRow} onMouseEnter={() => setSub('model')}>
        <MenuItem
          title="Model"
          hint={current?.label ?? 'None'}
          submenu
          open={sub === 'model'}
          onClick={() => setSub(sub === 'model' ? null : 'model')}
        />
      </div>
      <div ref={effortRow} onMouseEnter={() => setSub(effort ? 'effort' : null)}>
        <MenuItem
          title="Effort"
          hint={effort ? EFFORT_LABEL[effort] : 'Not supported'}
          submenu={Boolean(effort)}
          disabled={!effort}
          open={sub === 'effort'}
          onClick={() => effort && setSub(sub === 'effort' ? null : 'effort')}
        />
      </div>

      <ModelSubmenu
        anchor={modelRow}
        open={sub === 'model'}
        models={models}
        favorites={settings?.favoriteModels ?? []}
        currentKey={current ? `${current.providerId}:${current.id}` : undefined}
        onPick={(modelId, providerId) => {
          selectModel(modelId, providerId)
          setSub(null)
          onClose()
        }}
        onManage={() => {
          setSettingsPage('providers')
          onClose()
        }}
        onClose={() => setSub(null)}
      />

      <Popover anchor={effortRow} open={sub === 'effort'} onClose={() => setSub(null)} placement="right-start" width={230}>
        {efforts.map((level) => (
          <MenuItem
            key={level}
            title={EFFORT_LABEL[level]}
            description={EFFORT_NOTE[level]}
            checked={level === effort}
            onClick={() => {
              setEffort(level)
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
 * once the list is long enough to actually need one, and starred models
 * (Settings → Model providers) sit at the top.
 */
function ModelSubmenu({
  anchor,
  open,
  models,
  favorites,
  currentKey,
  onPick,
  onManage,
  onClose
}: {
  anchor: React.RefObject<HTMLElement>
  open: boolean
  models: ModelInfo[]
  favorites: string[]
  currentKey?: string
  onPick: (modelId: string, providerId: string) => void
  onManage: () => void
  onClose: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const searchable = models.length > 8
  const providers = useApp((s) => s.providers)
  // The same model can come from several places (an OpenAI key, a ChatGPT
  // sign-in, Copilot); those rows say which one they are.
  const duplicated = useMemo(() => {
    const seen = new Map<string, number>()
    for (const m of models) seen.set(m.id, (seen.get(m.id) ?? 0) + 1)
    return new Set([...seen].filter(([, n]) => n > 1).map(([id]) => id))
  }, [models])

  const key = (m: ModelInfo): string => `${m.providerId}:${m.id}`
  const q = query.trim().toLowerCase()
  const results = q ? models.filter((m) => `${m.label} ${m.id}`.toLowerCase().includes(q)) : models
  const starred = new Set(favorites)
  const top = q ? [] : results.filter((m) => starred.has(key(m)))
  const rest = q ? results : results.filter((m) => !starred.has(key(m)))

  const row = (model: ModelInfo): JSX.Element => (
    <MenuItem
      key={key(model)}
      title={model.label}
      hint={duplicated.has(model.id) ? providers.find((p) => p.id === model.providerId)?.name : undefined}
      checked={key(model) === currentKey}
      onClick={() => onPick(model.id, model.providerId)}
    />
  )

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="right-start" width={250}>
      {models.length === 0 ? (
        <>
          <div className="menu__empty">No models available</div>
          <MenuSeparator />
          <MenuItem title="Add an API key…" onClick={onManage} />
        </>
      ) : (
        <>
          {searchable && <MenuSearch value={query} onChange={setQuery} placeholder="Search models" />}
          {top.length > 0 && (
            <>
              <div className="menu__label">Starred</div>
              {top.map(row)}
              <MenuSeparator />
            </>
          )}
          {results.length === 0 ? <div className="menu__empty">No models match “{query.trim()}”</div> : rest.map(row)}
          <MenuSeparator />
          <MenuItem title="Manage models…" onClick={onManage} />
        </>
      )}
    </Popover>
  )
}

/* ------------------------------------------------------------- Plugins menu */

/**
 * Every configured plugin with a switch, connected catalog plugins first.
 * Toggling one switches its connection on or off, which is what decides
 * whether the agent gets its tools.
 */
function PluginsSubmenu({
  anchor,
  open,
  onClose,
  onDone
}: {
  anchor: React.RefObject<HTMLElement>
  open: boolean
  onClose: () => void
  onDone: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const { mcpServers, saveMcpServers, setView } = useApp(
    useShallow((s) => ({ mcpServers: s.mcpServers, saveMcpServers: s.saveMcpServers, setView: s.setView }))
  )
  const statuses = useMcpStatuses()
  const servers = [...mcpServers].sort((a, b) => Number(Boolean(b.pluginId)) - Number(Boolean(a.pluginId)))
  const results = servers.filter((s) => s.name.toLowerCase().includes(query.trim().toLowerCase()))

  const toggle = (id: string): void => {
    void saveMcpServers(mcpServers.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)))
  }

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="right-start" width={250}>
      {servers.length > 6 && <MenuSearch value={query} onChange={setQuery} placeholder="Search plugins" />}
      {results.map((server) => {
        const entry = server.pluginId ? mcpCatalogEntry(server.pluginId) : undefined
        const state = statuses.find((s) => s.serverId === server.id)?.state
        return (
          <MenuItem
            key={server.id}
            icon={<PluginLogo logo={entry?.logoAssetName} name={server.name} size={18} />}
            title={server.name}
            hint={server.enabled && state === 'needs-auth' ? 'Sign in' : server.enabled && state === 'error' ? 'Error' : undefined}
            checked={server.enabled}
            onClick={() => toggle(server.id)}
          />
        )
      })}
      {results.length === 0 && (
        <div className="menu__empty">{mcpServers.length === 0 ? 'No plugins connected yet' : 'No plugins found'}</div>
      )}
      <MenuSeparator />
      <MenuItem
        title="Browse plugins"
        description="Notion, GitHub, Slack, Linear and more"
        hint={<ExternalLink size={14} strokeWidth={2} />}
        onClick={() => {
          setView('plugins')
          onDone()
        }}
      />
    </Popover>
  )
}
