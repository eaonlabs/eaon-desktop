import { memo, useEffect, useRef, useState } from 'react'
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
  ListPlus,
  Mic,
  Network,
  Paperclip,
  PencilLine,
  Plus,
  ShieldCheck,
  Square,
  Target,
  AtSign,
  Clock3,
  MessageSquarePlus,
  Sparkles,
  X,
  Zap
} from 'lucide-react'
import { codeFolder, useApp, useIsWork } from '../state/store'
import { MenuItem, MenuSearch, MenuSeparator, Popover, useDisclosure } from './ui'
import { mcpCatalogEntry } from '@shared/mcpCatalog'
import { PluginLogo } from './plugins/PluginLogo'
import { useMcpStatuses } from './plugins/usePlugins'
import { useSkills } from './plugins/usePlugins'
import { fileName, fileUrl, isImagePath } from '../lib/files'
import type { McpServer } from '@shared/types'
import { useSuggest, type SuggestItem, type SuggestSources } from './composer/SuggestMenu'
import { fileMentionItems, liveMentions, permissionItems, pluginItems, skillItems, toolMentionItems, type Mention } from './composer/sources'
import { removeMention } from './composer/suggest'
import { clampEffort, EFFORT_LABEL } from '@shared/effort'
import { ENGINE_LABEL } from '@shared/engines'
import { ModelPicker } from './composer/ModelPicker'
import { ModelNotice } from './composer/ModelNotice'
import { useChatEngine } from './composer/chatEngine'
import { EngineNotice } from './composer/EngineNotice'
import { ENGINE_MARK, ProviderMark } from './composer/ProviderMark'
import { joinTranscript, useDictation } from './composer/useDictation'
import { VoiceBar } from './composer/VoiceBar'
import { PermissionPicker, ProjectPicker } from './composer/ComposerBits'
import { BranchPicker } from './chatCode/BranchPicker'
import { useChatCode, watchChatCode } from './chatCode/chatCodeStore'
import { notify } from './Notice'
import { errorText } from '../lib/errors'
import { sentPrompts } from '../state/chatEdits'
import { enqueue, holdQueue, watchQueue } from '../state/queue'
import { QueuedMessages } from './chat/QueuedMessages'
import { ContextMeter } from './chat/ContextMeter'

// Queued follow-ups go out as each reply ends (state/queue.ts).
watchQueue()
watchChatCode()

/**
 * What was typed in each chat's box and not sent yet, by chat id. The box is
 * keyed on the chat (ChatView), so switching chats starts a fresh one; this is
 * what brings a half-written message back on returning, instead of it
 * following the user into whichever chat they opened next. Kept for this
 * window's session only.
 */
const drafts = new Map<string, { text: string; attachments: string[] }>()

/** Image types a pasted image can be saved as (main/features/library.ts). */
const PASTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

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
  const { settings, streamingChatId, activeChatId, send, stop, composerDraft, setComposerDraft, composerAppend, appendToComposer, workIn, patchSettings } = useApp(
    useShallow((s) => ({
      settings: s.settings,
      streamingChatId: s.streamingChatId,
      activeChatId: s.activeChatId,
      send: s.send,
      stop: s.stop,
      composerDraft: s.composerDraft,
      setComposerDraft: s.setComposerDraft,
      composerAppend: s.composerAppend,
      appendToComposer: s.appendToComposer,
      workIn: s.workIn,
      patchSettings: s.patchSettings
    }))
  )
  const { mcpServers, saveMcpServers, toggleBrowser, setSettingsPage, setView, newChat, composerEdit, editMessage, resendFrom } = useApp(
    useShallow((s) => ({
      mcpServers: s.mcpServers,
      saveMcpServers: s.saveMcpServers,
      toggleBrowser: s.toggleBrowser,
      setSettingsPage: s.setSettingsPage,
      setView: s.setView,
      newChat: s.newChat,
      composerEdit: s.composerEdit,
      editMessage: s.editMessage,
      resendFrom: s.resendFrom
    }))
  )
  const statuses = useMcpStatuses()
  const { skills } = useSkills()
  // Plugins pulled in with "@", shown as chips while their "@Name" is in the text.
  const [mentions, setMentions] = useState<Mention[]>([])
  const cwd = useApp((s) => codeFolder(s))
  // The chat this box belongs to, fixed for its life (it is keyed on it); home has none.
  const [draftId] = useState(() => (variant === 'chat' ? activeChatId : null))
  const [text, setText] = useState(() => (draftId ? (drafts.get(draftId)?.text ?? '') : ''))
  const [attachments, setAttachments] = useState<string[]>(() => (draftId ? (drafts.get(draftId)?.attachments ?? []) : []))
  // Goal mode is armed per message: the next send becomes a goal the agent
  // keeps pursuing, then the composer drops back to normal.
  const [goalArmed, setGoalArmed] = useState(false)
  // How long a goal may run: until it is done, or until a time the user picks.
  const [goalUntil, setGoalUntil] = useState<GoalEnd>({ kind: 'none' })
  const [dragging, setDragging] = useState(false)
  // Edit from here: the user message being rewritten. Sending puts the new
  // text in its place and drops everything after it.
  const [editing, setEditing] = useState<string | null>(null)
  // ↑ and ↓ through what was sent in this chat. `draft` is what was in the
  // box before the first ↑, put back after the newest; `recalled` is what ↑
  // put there, so typing over it ends the walk.
  const history = useRef<{ index: number; draft: string; recalled: string } | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const isAgent = useIsWork()
  // Dictation: what is said lands at the end of the message, ready to edit, never sent by itself.
  const dictation = useDictation((spoken) => {
    setText((current) => joinTranscript(current, spoken))
    requestAnimationFrame(() => {
      const node = textarea.current
      node?.focus()
      node?.setSelectionRange(node.value.length, node.value.length)
    })
  })
  const dictating = dictation.state !== 'idle'

  const plusAnchor = useRef<HTMLButtonElement>(null)
  const modelAnchor = useRef<HTMLButtonElement>(null)
  const plusMenu = useDisclosure()
  const modelMenu = useDisclosure()

  const selection = useApp((s) => s.modelSelection())
  // A Codex model picked for Chat: its own label, levels and readiness.
  const engineChoice = useChatEngine()
  const model = engineChoice ? null : selection.model
  // Nothing connected, or the chosen model can't be used: the notice above
  // says why before anything is typed, and sending waits with the draft kept.
  const noModel = engineChoice ? !engineChoice.ready : selection.status === 'none' || selection.status === 'unavailable'
  // What the request will actually use: the chosen effort, clamped to the model.
  const effort = clampEffort(settings?.effort, engineChoice ? engineChoice.efforts : model?.efforts)
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

  useEffect(() => {
    if (!draftId) return
    if (text || attachments.length > 0) drafts.set(draftId, { text, attachments })
    else drafts.delete(draftId)
  }, [draftId, text, attachments])

  // Ready to type when it appears: after the first message from Home (the
  // conversation's box replaces Home's), on New chat, and on switching chats.
  // Not while a dialog is up, which keeps focus for itself, and not when the
  // user is already typing in another field.
  useEffect(() => {
    const node = textarea.current
    if (!node || document.querySelector('[aria-modal="true"]')) return
    const active = document.activeElement
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || (active instanceof HTMLElement && active.isContentEditable)) return
    node.focus({ preventScroll: true })
    node.setSelectionRange(node.value.length, node.value.length)
  }, [])

  // A failed reply's "Choose a model" opens the picker here. Only a new
  // request does: the count stays in the store, and acting on whatever it was
  // when the box mounted reopened the picker on every chat switch and send.
  const modelMenuRequest = useApp((s) => s.modelMenuRequest)
  const seenModelMenuRequest = useRef(modelMenuRequest)
  useEffect(() => {
    if (modelMenuRequest === seenModelMenuRequest.current) return
    seenModelMenuRequest.current = modelMenuRequest
    modelMenu.setOpen(true)
  }, [modelMenuRequest]) // eslint-disable-line react-hooks/exhaustive-deps

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

  // Edit from here, on one of the user's messages: its text and files come back here to change.
  useEffect(() => {
    if (composerEdit === null || variant !== 'chat') return
    editMessage(null)
    setText(composerEdit.text)
    setAttachments(composerEdit.attachments)
    setEditing(composerEdit.messageId)
    history.current = null
    const node = textarea.current
    node?.focus()
    requestAnimationFrame(() => node?.setSelectionRange(composerEdit.text.length, composerEdit.text.length))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerEdit])

  /** A queued message taken back to change: in the box, after anything already typed. */
  const takeBack = (queuedText: string, queuedFiles: string[]): void => {
    setText((current) => (current.trim() ? `${current.trimEnd()}\n\n${queuedText}` : queuedText))
    setAttachments((current) => [...new Set([...current, ...queuedFiles])].slice(0, 12))
    requestAnimationFrame(() => {
      const node = textarea.current
      node?.focus()
      node?.setSelectionRange(node.value.length, node.value.length)
    })
  }

  const addAttachments = (paths: string[]): void => {
    if (paths.length === 0) return
    setAttachments((current) => [...new Set([...current, ...paths])].slice(0, 12))
    textarea.current?.focus()
  }

  // Design Mode's notes from the browser: added after what is already typed, never in place of it.
  useEffect(() => {
    if (composerAppend === null) return
    appendToComposer(null)
    setText((current) => (current.trim() ? `${current.trimEnd()}\n\n${composerAppend.text}` : composerAppend.text))
    addAttachments(composerAppend.attachments)
    const node = textarea.current
    node?.focus()
    requestAnimationFrame(() => node && node.setSelectionRange(node.value.length, node.value.length))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerAppend, appendToComposer])

  const submit = (): void => {
    if (streaming) {
      // Stopping is a moment to look again: whatever is queued waits.
      if (activeChatId) holdQueue(activeChatId)
      stop()
      return
    }
    if (busyElsewhere || noModel || (!text.trim() && attachments.length === 0)) return
    const options = { attachments, goal: isAgent && goalArmed, until: isAgent && goalArmed ? goalEndAt(goalUntil) : null }
    if (editing) resendFrom(editing, text, options)
    else void send(text, options)
    clearBox()
  }

  /** While a reply is being written: the message waits, under the conversation, to go after it. */
  const queueMessage = (): void => {
    if (!activeChatId || noModel || editing || (!text.trim() && attachments.length === 0)) return
    enqueue(activeChatId, text, attachments)
    clearBox()
  }

  const clearBox = (): void => {
    history.current = null
    setEditing(null)
    setText('')
    setAttachments([])
    setMentions([])
    setGoalArmed(false)
    setGoalUntil({ kind: 'none' })
  }

  /**
   * Files and images on the clipboard become attachments, as dropping them
   * does. A file copied in Finder or Explorer has a path; a screenshot or an
   * image copied from a page has only its bytes, so main saves those first.
   * Anything else pastes as it always did.
   */
  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...event.clipboardData.files]
    if (files.length === 0) return
    const paths = files.map((file) => window.api.app.pathForFile(file)).filter(Boolean)
    if (paths.length > 0) {
      event.preventDefault()
      addAttachments(paths)
      return
    }
    // Text wins over a picture of it: Excel, Word and Keynote put an image of
    // the selection on the clipboard beside its text.
    if (event.clipboardData.getData('text/plain')) return
    const images = files.filter((file) => PASTED_IMAGE_TYPES.has(file.type))
    if (images.length === 0) return
    event.preventDefault()
    for (const image of images) {
      void image
        .arrayBuffer()
        .then((data) => window.api.app.savePastedImage(new Uint8Array(data), image.type))
        .then((path) => addAttachments([path]))
        .catch((error: unknown) => notify(`Couldn't attach the pasted image: ${errorText(error)}`, 'error'))
    }
  }

  const pickFiles = (): void =>
    void window.api.app
      .openFiles({ properties: isAgent ? ['openFile', 'openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'] })
      .then(addAttachments)

  /**
   * ↑ on the first line of an empty box brings back the last message sent in
   * this chat, and again the one before; ↓ on the last line goes the other
   * way, back to what was being typed. Typing over a recalled message makes
   * it a draft like any other. True when the key was used.
   */
  const recall = (step: -1 | 1, event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (variant !== 'chat' || editing || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false
    const node = event.currentTarget
    if (node.selectionStart !== node.selectionEnd) return false
    const walking = history.current !== null && history.current.recalled === text
    if (!walking) history.current = null
    if (step === -1) {
      if (text && !walking) return false
      if (text.slice(0, node.selectionStart).includes('\n')) return false
    } else {
      if (!walking || text.slice(node.selectionEnd).includes('\n')) return false
    }
    const prompts = sentPrompts(useApp.getState().activeChat())
    const at = history.current ? history.current.index + step : step === -1 ? prompts.length - 1 : -1
    if (step === 1 && at >= prompts.length) {
      setText(history.current?.draft ?? '')
      history.current = null
    } else {
      const prompt = prompts[at]
      if (prompt === undefined) return false
      history.current = { index: at, draft: history.current?.draft ?? text, recalled: prompt }
      setText(prompt)
    }
    event.preventDefault()
    requestAnimationFrame(() => {
      const box = textarea.current
      if (box) box.setSelectionRange(box.value.length, box.value.length)
    })
    return true
  }

  const cancelEdit = (): void => {
    setEditing(null)
    setText('')
    setAttachments([])
  }

  /**
   * The "/" and "@" menus. "/" runs what the + menu offers, plus skills; "@"
   * pulls in a plugin, the browser or the computer. Chat has no "@worker":
   * workers are their own tab with their own composer.
   */
  // The project's files for "@": read when the menu first asks (loadFiles only reads, then sets later).
  const projectFiles = useChatCode((s) => (isAgent ? s.files : null))
  const sources: SuggestSources = {
    '/': () => {
      const items: SuggestItem[] = [
        { id: 'attach', title: 'Add photos and files', keywords: 'attach file image upload', section: 'Add', icon: <Paperclip size={16} strokeWidth={1.8} />, run: pickFiles }
      ]
      if (isAgent) {
        items.push(
          {
            id: 'folder',
            title: 'Work in a project',
            keywords: 'folder directory project cwd code',
            section: 'Add',
            icon: <Folder size={16} strokeWidth={1.8} />,
            hint: cwd ? fileName(cwd) : undefined,
            run: () => void window.api.app.openFiles({ properties: ['openDirectory'] }).then((paths) => paths[0] && workIn(paths[0]))
          },
          { id: 'goal', title: 'Goal', keywords: 'goal until done', description: 'Keep working until it is done', section: 'Modes', icon: <Target size={16} strokeWidth={1.8} />, checked: goalArmed, run: () => setGoalArmed(!goalArmed) },
          { id: 'plan', title: 'Plan first', keywords: 'plan approve', description: 'Research, then ask you to approve a plan', section: 'Modes', icon: <Lightbulb size={16} strokeWidth={1.8} />, checked: Boolean(settings?.planMode), run: () => void patchSettings({ planMode: !settings?.planMode }) },
          { id: 'swarm', title: 'Swarm', keywords: 'swarm parallel helpers sub-agents', description: 'Split work across parallel helpers', section: 'Modes', icon: <Network size={16} strokeWidth={1.8} />, checked: Boolean(settings?.work.swarm), run: () => void patchSettings({ work: { swarm: !settings?.work.swarm } }) },
          ...permissionItems(
            [
              { id: 'ask' as const, title: 'Ask first', keywords: 'ask', icon: <Hand size={16} strokeWidth={1.8} /> },
              { id: 'auto' as const, title: 'Auto-approve', keywords: 'auto', icon: <ShieldCheck size={16} strokeWidth={1.8} /> },
              { id: 'full' as const, title: 'Full autonomy', keywords: 'full autonomy', icon: <Zap size={16} strokeWidth={1.8} /> }
            ],
            settings?.approvalMode,
            (approvalMode) => {
              void patchSettings({ approvalMode })
              // As the permission picker does: what full access would have run stops waiting.
              if (approvalMode === 'full') useApp.getState().releaseApprovals()
            }
          ),
          { id: 'browser', title: 'Browser', keywords: 'web browse', section: 'Tools', icon: <Globe size={16} strokeWidth={1.8} />, run: () => toggleBrowser(true) },
          { id: 'computer', title: 'Computer use', keywords: 'computer screen mouse', section: 'Tools', icon: <Laptop size={16} strokeWidth={1.8} />, hint: settings?.computerUse.enabled ? 'On' : 'Off', run: () => setSettingsPage('computer-use') },
          { id: 'plugins', title: 'Browse plugins', keywords: 'plugins mcp integrations', section: 'Tools', icon: <AtSign size={16} strokeWidth={1.8} />, run: () => setView('plugins') }
        )
      }
      items.push(
        { id: 'model', title: 'Model', keywords: 'model effort switch', section: 'Chat', icon: <Sparkles size={16} strokeWidth={1.8} />, hint: engineChoice ? engineChoice.label : model?.label, run: () => modelMenu.setOpen(true) },
        { id: 'new', title: 'New chat', keywords: 'new clear reset', section: 'Chat', icon: <MessageSquarePlus size={16} strokeWidth={1.8} />, run: () => newChat() }
      )
      return isAgent ? [...items, ...skillItems(skills, settings?.disabledSkills ?? [])] : items
    },
    ...(isAgent
      ? {
          '@': (query: string) => {
            useChatCode.getState().loadFiles()
            return [
              ...pluginItems(mcpServers, statuses, (server: McpServer) => {
                // The + menu's toggle: on everywhere, which is how plugins work.
                if (!server.enabled) void saveMcpServers(mcpServers.map((m) => (m.id === server.id ? { ...m, enabled: true } : m)))
                setMentions((current) => (current.some((m) => m.id === server.id) ? current : [...current, { id: server.id, name: server.name, pluginId: server.pluginId }]))
              }),
              ...toolMentionItems({
                computerOn: Boolean(settings?.computerUse.enabled),
                onBrowser: () => toggleBrowser(true),
                onComputerSettings: () => setSettingsPage('computer-use')
              }),
              ...fileMentionItems(projectFiles ?? [], query)
            ]
          }
        }
      : {})
  }
  const suggest = useSuggest({ text, setText, textarea, sources, label: { '/': 'Commands', '@': 'Files, plugins and tools' } })
  const shownMentions = liveMentions(mentions, text)

  const planOn = isAgent && Boolean(settings?.planMode)
  const swarmOn = isAgent && Boolean(settings?.work.swarm)
  const hasChips = planOn || swarmOn || goalArmed || shownMentions.length > 0

  // The box's parts, laid out per variant below: on the home screen the text
  // sits over a toolbar; in a conversation it is one line between + and send,
  // with the permission and the model on a quiet row under the box.
  const input = dictating ? (
    <VoiceBar dictation={dictation} />
  ) : (
    <textarea
      ref={textarea}
      className="composer__input"
      placeholder={
        editing
          ? 'Edit your message'
          : goalArmed
          ? 'Describe the goal — Eaon keeps working until it is done'
          : planOn
            ? 'Describe the task — Eaon researches and proposes a plan first'
            : variant === 'chat'
              ? 'Ask for follow-up changes'
              : isAgent
                ? 'Ask Eaon to do anything'
                : 'Ask anything'
      }
      value={text}
      rows={1}
      onChange={(e) => {
        setText(e.target.value)
        suggest.onCaret()
      }}
      onSelect={suggest.onCaret}
      onPaste={onPaste}
      onKeyDown={(e) => {
        if (suggest.onKeyDown(e)) return
        if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && recall(e.key === 'ArrowUp' ? -1 : 1, e)) return
        if (e.key === 'Escape' && editing) {
          e.preventDefault()
          cancelEdit()
          return
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault()
          // While a reply streams, ⏎ queues the message to go after it. It
          // used to press Stop, so a follow-up typed during a reply ended
          // the run, and so did the ⏎ meant for an approval card. Kept
          // from the card's own ⏎ handler too (ChatView, on document): a
          // message typed here must not approve a command nobody read.
          // Stop is the button; the card has its own focused buttons.
          if (streaming) {
            e.stopPropagation()
            queueMessage()
            return
          }
          submit()
        }
      }}
    />
  )
  const plusButton = (
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
  )
  const chips = hasChips && (
    <div className="composer__chips">
      {goalArmed && <ActiveChip icon={<Target size={13} strokeWidth={2} />} label="Goal" title="The next message is a goal Eaon keeps working on until it is done" onClear={() => setGoalArmed(false)} clearLabel="Turn off Goal" />}
      {goalArmed && <GoalEndChip value={goalUntil} onChange={setGoalUntil} />}
      {planOn && <ActiveChip icon={<Lightbulb size={13} strokeWidth={2} />} label="Plan" title="Eaon researches and proposes a plan before changing anything" onClear={() => void patchSettings({ planMode: false })} clearLabel="Turn off Plan mode" />}
      {swarmOn && <ActiveChip icon={<Network size={13} strokeWidth={2} />} label="Swarm" title="Eaon can split work across parallel sub-agents" onClear={() => void patchSettings({ work: { swarm: false } })} clearLabel="Turn off Swarm" />}
      {shownMentions.map((mention) => (
        <ActiveChip
          key={mention.id}
          icon={
            <span className="composer-chip__logo">
              <PluginLogo logo={mention.pluginId ? mcpCatalogEntry(mention.pluginId)?.logoAssetName : undefined} name={mention.name} size={13} />
            </span>
          }
          label={mention.name}
          title={`${mention.name} is mentioned in this message`}
          onClear={() => {
            setMentions((current) => current.filter((m) => m.id !== mention.id))
            setText(removeMention(text, mention.name))
          }}
          clearLabel={`Remove @${mention.name}`}
        />
      ))}
    </div>
  )
  const modelButton = (
    <button
      ref={modelAnchor}
      className="chip chip--model"
      data-open={modelMenu.open || undefined}
      data-unavailable={(engineChoice ? !engineChoice.ready : selection.status === 'unavailable') || undefined}
      onClick={modelMenu.toggle}
      title={
        engineChoice
          ? engineChoice.ready
            ? `${engineChoice.label}. Runs on ${ENGINE_LABEL[engineChoice.engine]}, with your ${ENGINE_LABEL[engineChoice.engine]} sign-in and plan`
            : `Unavailable — ${engineChoice.reason ?? ''}`
          : selection.status === 'unavailable'
            ? `Unavailable — ${selection.reason ?? ''}`
            : undefined
      }
    >
      {engineChoice ? <ProviderMark providerId={ENGINE_MARK[engineChoice.engine]} size={15} /> : model && <ProviderMark providerId={model.providerId} size={15} />}
      <span className="chip__model">{engineChoice ? engineChoice.label : (model?.label ?? selection.wanted?.label ?? 'No model')}</span>
      {effort && <span className="chip__effort">{EFFORT_LABEL[effort]}</span>}
      <ChevronDown size={13} strokeWidth={2} className="chip__chevron" />
    </button>
  )
  const micButton = (
    <button
      className="composer__round composer__mic"
      data-active={dictating || undefined}
      // While recording, the mic finishes: what was said is written out,
      // as the voice bar's own Done does. Throwing it away is the bar's
      // Discard (or Esc); only a recording still starting is cancelled.
      onClick={() =>
        dictation.state === 'recording' ? dictation.finish() : dictating ? dictation.cancel() : void dictation.start()
      }
      disabled={dictation.state === 'transcribing'}
      aria-label={dictating ? 'Stop dictating' : 'Dictate'}
      title={dictating ? 'Stop dictating' : 'Dictate a message'}
    >
      <Mic size={16} strokeWidth={1.9} />
    </button>
  )
  // During a reply, with something typed: queue it, beside Stop.
  const queueButton = streaming && !editing && (text.trim() || attachments.length > 0) && (
    <button
      className="composer__round composer__queue"
      onClick={queueMessage}
      disabled={noModel}
      aria-label="Queue message"
      title="Queue — sent when Eaon finishes (⏎)"
    >
      <ListPlus size={17} strokeWidth={1.9} />
    </button>
  )
  const sendButton = (
    <button
      className={`send ${streaming ? 'send--stop' : ''}`}
      disabled={busyElsewhere || (!streaming && (noModel || dictating || (!text.trim() && attachments.length === 0)))}
      onClick={submit}
      aria-label={streaming ? 'Stop' : 'Send'}
      title={busyElsewhere ? 'Eaon is still replying in another chat' : !streaming && noModel ? 'Connect a model first — see above' : undefined}
    >
      {streaming ? (
        <Square size={11} strokeWidth={0} fill="currentColor" />
      ) : (
        <ArrowUp size={17} strokeWidth={2.2} />
      )}
    </button>
  )

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
        setDragging(false)
        // Dragged text drops into the box as text, the browser's own way;
        // only files are taken over and attached.
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        addAttachments([...e.dataTransfer.files].map((file) => window.api.app.pathForFile(file)).filter(Boolean))
      }}
    >
      {engineChoice ? (
        !engineChoice.ready && <EngineNotice choice={engineChoice} onChooseModel={() => modelMenu.setOpen(true)} />
      ) : (
        <ModelNotice selection={selection} onChooseModel={() => modelMenu.setOpen(true)} />
      )}
      {/* In a conversation the folder, branch and changes are in the workspace card beside it. */}
      {isAgent && variant !== 'chat' && (
        <div className="composer__above">
          <ProjectPicker />
          <BranchPicker />
        </div>
      )}
      {variant === 'chat' && draftId && <QueuedMessages chatId={draftId} onEdit={takeBack} />}
      {editing && (
        <div className="composer-editing" role="status">
          <PencilLine size={13} strokeWidth={2} />
          <span>Editing a message — sending it replaces that message and everything after it</span>
          <button type="button" className="composer-editing__cancel" onClick={cancelEdit}>
            Cancel
          </button>
        </div>
      )}
      <div className="composer" data-variant={variant} data-goal={goalArmed || undefined} data-editing={editing ? true : undefined}>
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
        {dictation.error && (
          <div className="voice-error" role="alert">
            <span className="voice-error__text">{dictation.error}</span>
            <button onClick={dictation.dismissError} aria-label="Dismiss">
              <X size={12} strokeWidth={2.2} />
            </button>
          </div>
        )}

        {variant === 'chat' ? (
          <div className="composer__row">
            {plusButton}
            {input}
            {micButton}
            {queueButton}
            {sendButton}
          </div>
        ) : (
          <>
            {input}
            <div className="composer__toolbar">
              {plusButton}
              {isAgent && <PermissionPicker />}
              {chips}
              <div className="composer__spacer" />
              {modelButton}
              {micButton}
              {sendButton}
            </div>
          </>
        )}
      </div>

      {variant === 'chat' && (
        <div className="composer__meta">
          {isAgent && <PermissionPicker />}
          {chips}
          <div className="composer__spacer" />
          {!engineChoice && <ContextMeter contextWindow={model?.contextWindow} />}
          {modelButton}
        </div>
      )}

      {suggest.menu}
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
      <ModelPicker anchor={modelAnchor} open={modelMenu.open} onClose={modelMenu.close} />
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
export type GoalEnd = { kind: 'none' } | { kind: 'for'; minutes: number } | { kind: 'at'; time: string }

/** The goal's end as a timestamp, worked out when the message is sent. A clock time already past today means tomorrow. */
export function goalEndAt(end: GoalEnd, now = Date.now()): number | null {
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
export function GoalEndChip({
  value,
  onChange,
  who = 'Eaon',
  doneHint = 'Stops when the goal is met, or at the usual limits',
  spans = GOAL_SPANS
}: {
  value: GoalEnd
  onChange: (value: GoalEnd) => void
  /** Who works on it, for the tooltip: Eaon, or a worker's name. */
  who?: string
  /** What "Until it's done" means where this chip is. */
  doneHint?: string
  spans?: number[]
}): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const [time, setTime] = useState(value.kind === 'at' ? value.time : defaultEndTime())
  return (
    <>
      <button ref={anchor} className="composer-chip composer-chip--button" onClick={menu.toggle} title={`When ${who} stops working on the goal`}>
        <Clock3 size={13} strokeWidth={2} />
        <span className="composer-chip__label">{goalEndLabel(value)}</span>
        <ChevronDown size={11} strokeWidth={2.4} />
      </button>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="top-start" width={260}>
        <div className="menu__label">Keep working on the goal</div>
        <MenuItem
          title="Until it's done"
          description={doneHint}
          checked={value.kind === 'none'}
          onClick={() => {
            onChange({ kind: 'none' })
            menu.close()
          }}
        />
        {spans.map((minutes) => (
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
  const { settings, patchSettings, workIn, setSettingsPage, toggleBrowser } = useApp(
    useShallow((s) => ({
      settings: s.settings,
      patchSettings: s.patchSettings,
      workIn: s.workIn,
      setSettingsPage: s.setSettingsPage,
      toggleBrowser: s.toggleBrowser
    }))
  )
  const cwd = useApp((s) => codeFolder(s))
  const isAgent = useIsWork()
  const pluginsRow = useRef<HTMLDivElement>(null)
  const [sub, setSub] = useState<'plugins' | null>(null)
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
            title="Work in a project"
            hint={cwd ? fileName(cwd) : undefined}
            onMouseEnter={() => setSub(null)}
            onClick={() => {
              close()
              void window.api.app.openFiles({ properties: ['openDirectory'] }).then((paths) => paths[0] && workIn(paths[0]))
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

          <PluginsSubmenu anchor={pluginsRow} open={open && sub === 'plugins'} onClose={() => setSub(null)} onDone={close} />
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
export function PluginsSubmenu({
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
