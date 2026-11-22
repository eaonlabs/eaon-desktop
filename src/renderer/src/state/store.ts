import type { AskQuestion } from '@shared/askQuestions'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { useMemo } from 'react'
import type {
  Chat,
  ChatMessage,
  ChatToolPart,
  DownloadedModel,
  EffortLevel,
  IndexStatus,
  McpServer,
  MessageFeedback,
  ModelDownloadProgress,
  ModelInfo,
  Project,
  Provider,
  Settings,
  StreamEvent,
  StreamRequest,
  ThemePalette,
  UpdateStatus,
  Workspace
} from '@shared/types'
import { mergeRunChat } from '@shared/scheduler'
import { isLastingIssue, isLongLimit, type ProviderIssue } from '@shared/providers'
import {
  engineModelKey,
  engineOptions,
  isProviderUsable,
  modelKey,
  nativeOptions,
  resolveSelection,
  toggleFavorite,
  withRecent,
  type ModelOption,
  type ResolvedSelection
} from '@shared/modelSelection'
import { CLI_ENGINES } from '@shared/engines'
import { environmentsOf, LOCAL_ENVIRONMENT, providerOf, type SessionPlace } from '@shared/environments'
import { classifyTask, pickModel, routeRecord, type AdaptiveRoute } from '@shared/adaptive'
import { lastTurnFailed } from './chatStatus'
import { activeTab, shownTabs, sideOfChat, splitsChats, TAB_KIND, type AppTab, type ChatSide } from '@shared/tabs'
import { chatChanges, Checkpoint } from './chatSync'
import { editPlan, forkedChat, retryPlan, withFeedback } from './chatEdits'
import { cleanPlanSteps, planApprovalMessage, planChanged } from '@shared/planEdit'
import { migrateLegacySchedules } from '../components/scheduled/legacy'
import { notify } from '../components/Notice'
import { reportError } from '../components/ErrorBoundary'

export type View = 'chat' | 'plugins' | 'integrations' | 'scheduled' | 'settings' | 'pull-requests' | 'issues' | 'models' | 'library' | 'trading' | 'computers'

interface NavEntry {
  view: View
  activeChatId: string | null
}

const uid = (): string => Math.random().toString(36).slice(2, 11) + Date.now().toString(36)

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

interface AppState {
  ready: boolean
  /** Why the window couldn't start, when `init` failed before it was ready. */
  initError: string | null
  settings: Settings | null
  workspaces: Workspace[]
  projects: Project[]
  chats: Chat[]
  providers: Provider[]
  mcpServers: McpServer[]

  view: View
  settingsPage: string
  pluginsTab: 'plugins' | 'skills'
  /** Repo id showing in the Models detail view, or null for the list. Lives here
   * (rather than local component state) so re-clicking "Models" in the sidebar
   * while already viewing a model's variants returns to the list. */
  modelsRepo: string | null
  activeChatId: string | null
  pendingProjectId: string | null
  /** The start page's Temporary chat switch: the chat it starts is never saved. */
  pendingTemporary: boolean
  navPast: NavEntry[]
  navFuture: NavEntry[]
  sidebarOpen: boolean
  browserOpen: boolean
  /**
   * The replies this window is writing, by the chat they're in. Each chat
   * runs one at a time, but any number of chats can run at once: start one,
   * go to another and ask there too.
   */
  runs: Record<string, string>
  /**
   * Replies being written right now by something else — another window, a
   * scheduled task — so this window shows them as unfinished too. An id drops
   * when its run ends, or after a minute of silence (a window that missed the end).
   */
  remoteStreaming: string[]
  /**
   * Chats whose older messages are being summarised to make room, by chat
   * id: the strip above the message box shows how far it has got. A finished
   * one stays a moment to say so, then goes.
   */
  compactions: Record<string, ChatCompaction>
  /** The approval being asked now; `approvalQueue` holds any that arrived while it was open. */
  pendingApproval: PendingApproval | null
  approvalQueue: PendingApproval[]
  /** Questions the agent is asking in a pop-up (shared/askQuestions.ts), oldest first; the first is the one shown. */
  pendingQuestions: PendingQuestion[]
  /** Text waiting to be dropped into the composer (a quoted reply, a prompt from elsewhere), consumed once. */
  composerDraft: string | null
  /** The provider Settings → Model providers should open on, consumed once (see `openProviderSettings`). */
  providerFocus: string | null
  /** Bumped to ask the composer to open its model picker (a failed reply's "Choose a model"). */
  modelMenuRequest: number
  /** Text and files added to whatever is in the composer (Design Mode's notes), consumed once. */
  composerAppend: { text: string; attachments: string[] } | null
  /** One of the user's messages to edit, waiting for the composer to take it in (Edit from here), consumed once. */
  composerEdit: { messageId: string; text: string; attachments: string[] } | null
  /** Code-index progress for the chat agent's project folder. */
  indexStatus: IndexStatus | null
  /** In-flight Hugging Face model downloads, keyed by `repoId::filename`. Lives
   * here (not local to the Models page) so the header's Downloads panel can
   * show progress no matter which view is open. */
  modelDownloads: Record<string, ModelDownloadProgress>
  /** App auto-updater state — mirrors the main process, see `updater.ts`. */
  updateStatus: UpdateStatus
  /**
   * An appearance shown while the ADE's theme picker browses, before anything
   * is saved (useTheme in App.tsx prefers it). Null shows the saved one.
   */
  appearancePreview: AppearancePreview | null
  setAppearancePreview: (preview: AppearancePreview | null) => void
  /** Beta updates, a track of their own (Settings → General → Software update). */
  betaStatus: UpdateStatus

  init: () => Promise<void>
  patchSettings: (patch: DeepPartial<Settings>) => Promise<void>
  setView: (view: View) => void
  setSettingsPage: (page: string) => void
  /** Opens Settings → Model providers on one provider (to sign in again, fix its key, turn it on). */
  openProviderSettings: (providerId: string | null) => void
  setProviderFocus: (providerId: string | null) => void
  openModelMenu: () => void
  setPluginsTab: (tab: 'plugins' | 'skills') => void
  setModelsRepo: (repoId: string | null) => void
  goBack: () => void
  goForward: () => void
  canGoBack: () => boolean
  canGoForward: () => boolean
  toggleSidebar: () => void
  toggleBrowser: (open?: boolean) => void

  newChat: (projectId?: string | null) => void
  /** The start page, with the next chat it starts temporary (or not): kept in this window only, gone when it is left. */
  startTemporaryChat: () => void
  setPendingTemporary: (on: boolean) => void
  openChat: (id: string) => void
  deleteChat: (id: string) => void
  /** A chat's cloud environment changed (its VM deleted, say). */
  setChatPlace: (id: string, place: SessionPlace) => void
  archiveChat: (id: string) => void
  /** Archives these chats at once, leaving any whose reply is still being written; returns how many moved. */
  archiveChats: (ids: string[]) => number
  /** Deletes these chats at once (as `deleteChat` does each); returns how many went. */
  deleteChats: (ids: string[]) => number
  restoreChat: (id: string) => void
  renameChat: (id: string, title: string) => void
  togglePin: (id: string) => void
  /** Moves a chat into a project, where it codes in the project's folder, or out of one (null) to Chats. */
  moveChat: (id: string, projectId: string | null) => void
  send: (text: string, options?: SendOptions) => Promise<void>
  /** Stops the open chat's reply, or `chatId`'s. */
  stop: (chatId?: string) => void
  /** Plan mode: the user accepted the plan in `messageId`; run it with plan mode off. */
  approvePlan: (messageId: string) => void
  /** Replaces a pending plan's steps with the person's edits (the plan is then theirs, not the agent's). */
  editPlanSteps: (messageId: string, steps: string[]) => void
  /** A reply's thumbs and emoji, from its action bar. */
  setMessageFeedback: (messageId: string, feedback: MessageFeedback) => void
  /** Marks a coding reply's file changes undone (or redone) in the chat on screen. */
  setMessageUndone: (messageId: string, undone: boolean) => void
  /** Asks the last question again, in place of its reply. */
  retryReply: (messageId: string) => void
  /** Opens a copy of the active chat up to `messageId`, to go another way from there. */
  forkChat: (messageId: string) => void
  /** Clears or pauses the active chat's goal. */
  setGoalStatus: (status: 'paused' | 'active' | null) => void
  /** Answers the first waiting question, or the one with `requestId`. */
  /** Sends the answers to the question pop-up (one list a question), or null to dismiss it. */
  answerQuestion: (requestId: string, answers: string[][] | null) => void
  respondApproval: (approved: boolean, requestId?: string) => void
  /**
   * Switching to full access mid-turn: approves everything waiting that full
   * access would have run without asking. What can't be undone keeps waiting.
   */
  releaseApprovals: () => void
  setComposerDraft: (text: string | null) => void
  appendToComposer: (append: { text: string; attachments: string[] } | null) => void
  /** Puts one of the user's messages back in the composer to change and send again; null clears the request. */
  editMessage: (messageId: string | null) => void
  /** Sends `text` in place of the user's message `messageId`, dropping it and everything after it. */
  resendFrom: (messageId: string, text: string, options?: SendOptions) => void
  reindex: (force?: boolean) => Promise<void>

  createProject: (name: string, folder?: string | null) => Project
  updateProject: (id: string, patch: Partial<Pick<Project, 'name' | 'instructions' | 'folder' | 'extraFolders'>>) => void
  /** Deletes the project; its chats stay, moved back to Chats. */
  deleteProject: (id: string) => void
  /** This tab's project for `folder`: the one that has it, or a new one named after it. */
  projectForFolder: (folder: string) => Project
  /**
   * "Work in a project": the chat on screen codes in `folder` from now on,
   * in that folder's project, or (null) becomes an ordinary chat. On the
   * start page it is the chat about to be started.
   */
  workIn: (folder: string | null) => void
  setWorkspace: (id: string) => void
  /** Brings a top-bar tab to the front, with the chat it had open when it was left. */
  setTab: (tab: AppTab) => void

  selectModel: (modelId: string, providerId?: string) => void
  /** Stars or unstars a model; starred models head the model menu. */
  toggleFavorite: (modelId: string, providerId: string) => void
  downloadModel: (repoId: string, filename: string) => Promise<DownloadedModel>
  setEffort: (effort: EffortLevel) => void
  refreshProviders: () => Promise<void>
  saveMcpServers: (servers: McpServer[]) => Promise<void>

  availableModels: () => ModelInfo[]
  /**
   * What the composer's model choice resolves to: the chosen model, a
   * default when nothing was chosen, or why the choice can't be used (see
   * shared/modelSelection). Never another model in place of the chosen one.
   */
  modelSelection: () => ResolvedSelection
  /** The model the next turn runs on; null when the choice is unavailable or nothing is connected. */
  currentModel: () => ModelInfo | null
  activeChat: () => Chat | null
  visibleChats: () => Chat[]
  /** The sidebar's view of `visibleChats()`, which keeps its identity while only message content changes. */
  chatList: () => ChatListItem[]
  visibleProjects: () => Project[]
}

/** A question pop-up waiting for the user's answers. */
export interface PendingQuestion {
  requestId: string
  messageId: string
  questions: AskQuestion[]
}

export interface PendingApproval {
  requestId: string
  messageId: string
  tool: string
  input: Record<string, unknown>
  summary?: string
  /** Can't be undone: asked in every mode, and never released by switching to full access. */
  critical?: boolean
  /** A whole-file write: what is there now (null: nothing), so the approval shows what goes. */
  before?: string | null
  /** A swarm sub-agent's role, when it is the one asking. */
  agent?: string
}

/** The reply running in `chatId` in this window, if there is one. */
export const runIn = (s: Pick<AppState, 'runs'>, chatId: string | null | undefined): string | null => (chatId ? (s.runs[chatId] ?? null) : null)

/** Whether any chat in this window has a reply running. */
export const anyRun = (s: Pick<AppState, 'runs'>): boolean => Object.keys(s.runs).length > 0

/** `runs` without `chatId`'s. */
function withoutRun(runs: Record<string, string>, chatId: string): Record<string, string> {
  if (!(chatId in runs)) return runs
  const next = { ...runs }
  delete next[chatId]
  return next
}

/** The chat whose run `messageId` is, in this window. */
const runChat = (runs: Record<string, string>, messageId: string): string | null =>
  Object.keys(runs).find((chatId) => runs[chatId] === messageId) ?? null

/** What the sidebar shows for a chat. */
export interface ChatListItem {
  id: string
  title: string
  pinned: boolean
  failed: boolean
  /** A reply finished there while it wasn't on screen. */
  unread: boolean
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

export interface SendOptions {
  /** Files to attach, as absolute paths. */
  attachments?: string[]
  /** Goal mode: this message is a goal the agent keeps pursuing until it is done. */
  goal?: boolean
  /** With `goal`: keep working until this time (a timestamp) rather than the usual limits. */
  until?: number | null
  /** Overrides the plan-mode setting for this one turn (approving a plan runs it with plan mode off). */
  plan?: boolean
  /** Sends into this chat rather than the open one (a queued message, once its chat's reply ends), without opening it. */
  chatId?: string
}

export type WorkspaceKind = 'chat' | 'work' | 'code' | 'workers'

/**
 * `init()` runs from an effect, and StrictMode invokes effects twice in dev.
 * Binding the stream listener twice meant every token was applied twice — the
 * second handler read the already-updated state and appended the same text
 * again — so replies came out doubled and every render ran twice.
 */
let listenersBound = false

/** Identity caches for the derived selectors below — see `availableModels`. */
let modelsCache: { providers: Provider[]; models: ModelInfo[] } | null = null
let selectionCache: { providers: Provider[]; settings: Settings | null; selection: ResolvedSelection } | null = null
/** The chat each tab had open when it was last left, by workspace id, and for the chat workspace by side too. */
const lastChatByWorkspace = new Map<string, string>()
const tabKey = (workspaceId: string, side: ChatSide | null): string => (side ? `${workspaceId}:${side}` : workspaceId)
/** The project the IDE was last in, for its start page when it comes back. */
let lastIdeProject: string | null = null

let chatsCache: { chats: Chat[]; workspaceId: string | undefined; visible: Chat[] } | null = null

let listCache: { visible: Chat[]; items: ChatListItem[] } | null = null
const listItems = new WeakMap<Chat, ChatListItem>()

let saveTimer: ReturnType<typeof setTimeout> | null = null
/**
 * Each chat as main last has it: what this window saved, or what another
 * window (or a scheduled run) sent over. A chat whose object differs from
 * this is one this window changed, and only those are saved, so two windows
 * never overwrite each other's chats with stale copies.
 */
let synced = new Map<string, Chat>()

/** A step in getting a session's cloud environment ready, for the card that shows them (components/environments/PlaceSetup). */
function notePlaceStep(chatId: string, step: string): void {
  const state = useApp.getState()
  if (!state.chats.some((c) => c.id === chatId && c.place?.state === 'preparing')) return
  useApp.setState({
    chats: state.chats.map((c) => (c.id === chatId && c.place ? { ...c, place: { ...c.place, step, steps: withStep(c.place.steps, step) } } : c))
  })
}

/** The steps so far with `step` last; one that only restates the last (the same wait again) replaces it. */
export function withStep(steps: string[] | undefined, step: string): string[] {
  const list = steps ?? []
  const last = list[list.length - 1]
  if (last === step) return list
  const word = (text: string): string => text.split(' ').slice(0, 2).join(' ')
  if (last && word(last) === word(step) && /^(Waiting|Sending)/.test(step)) return [...list.slice(0, -1), step]
  return [...list, step].slice(-12)
}

/**
 * Makes a session's cloud environment ready: its machine (an exe.dev VM made
 * for it, or a folder on one) and the copy of its project. The reply that
 * waits for it says each step; a failure is that reply's error, and the next
 * message tries again. Null when it couldn't be made, or was stopped.
 */
async function preparePlace(chatId: string, messageId: string, place: SessionPlace): Promise<SessionPlace | null> {
  const patch = (next: Partial<SessionPlace> | null, message: Partial<ChatMessage> | null, clearRun = false): void =>
    useApp.setState((s) => ({
      chats: s.chats.map((c) =>
        c.id === chatId && c.place
          ? {
              ...c,
              place: next ? { ...c.place, ...next } : c.place,
              messages: message ? c.messages.map((m) => (m.id === messageId ? { ...m, ...message } : m)) : c.messages
            }
          : c
      ),
      ...(clearRun ? { runs: withoutRun(s.runs, chatId) } : {})
    }))
  patch({ state: 'preparing', step: undefined, steps: [], error: undefined }, null)
  const chat = useApp.getState().chats.find((c) => c.id === chatId)
  let result: Awaited<ReturnType<typeof window.api.environments.prepare>>
  try {
    result = await window.api.environments.prepare({ key: chatId, envId: place.envId, project: place.source ?? '', title: chat?.title ?? place.name })
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error) }
  }
  // Stopped meanwhile: the reply already says so.
  if (useApp.getState().runs[chatId] !== messageId) {
    patch({ state: 'failed', step: undefined, error: 'Stopped before it was ready' }, null)
    persistChats()
    return null
  }
  if (!result.ok) {
    patch({ state: 'failed', step: undefined, error: result.error }, { error: `Couldn’t get ${place.name} ready. ${result.error}`, finishedAt: Date.now() }, true)
    ownedRuns.delete(messageId)
    persistChats()
    return null
  }
  patch({ ...result.place, step: undefined, steps: undefined, error: undefined }, null)
  persistChats()
  return result.place
}

/** The VM that goes when this chat is deleted: one made for it alone, unless its environment keeps them. */
export function vmDeletedWith(chat: Pick<Chat, 'place'> | undefined, settings: Settings | null): string | null {
  const place = chat?.place
  if (!place?.madeVm || !place.vm) return null
  const env = environmentsOf(settings?.environments).find((e) => e.id === place.envId)
  return env?.exe?.removeWithChat === false ? null : place.vm
}

/** A deleted chat's VM, made for it alone, goes too (unless its environment keeps them). */
function releasePlace(chat: Chat | undefined, settings: Settings | null): void {
  const vm = vmDeletedWith(chat, settings)
  if (!vm) return
  void window.api.environments.removeVm(vm).then((result) => {
    if (!result.ok) notify(`The chat is deleted, but its VM ${vm} isn’t: ${result.error} Delete it in Settings → Environments.`, 'error')
  })
}

/**
 * Debounced save of the chats this window changed. It saves what the store
 * holds when the timer fires, not an array handed in earlier — a snapshot from
 * before the last change (a pin written straight to disk, say) would quietly
 * undo it.
 */
function persistChats(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(saveChatsNow, 250)
}
function saveChatsNow(checkpoint = false): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  // A regular save covers what a pending checkpoint would have saved.
  if (!checkpoint) checkpoints.cancel()
  const chats = useApp.getState().chats
  const { upserts, removed } = chatChanges(synced, chats)
  const previous = synced
  synced = new Map(chats.filter((chat) => !chat.temporary).map((chat) => [chat.id, chat]))
  if (upserts.length === 0 && removed.length === 0) return
  // A checkpoint is not broadcast: other windows watching the reply have it
  // live from the stream, and a copy a few tokens old would put theirs back.
  window.api.chats.apply(checkpoint ? upserts.map(markUnfinished) : upserts, removed, checkpoint).then(
    () => {
      saveFailing = false
    },
    (error: unknown) => {
      // A failed save used to be forgotten: `synced` already counted these as
      // written, so nothing sent them again and the changes were lost at quit
      // with no word. Put back what was believed saved so the next save
      // carries them, say so once, and try again shortly.
      for (const chat of upserts) {
        const before = previous.get(chat.id)
        if (before) synced.set(chat.id, before)
        else synced.delete(chat.id)
      }
      for (const id of removed) {
        const before = previous.get(id)
        if (before) synced.set(id, before)
      }
      if (!saveFailing) {
        saveFailing = true
        const reason = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
        notify(`Couldn't save your chats (${reason}). Eaon keeps trying; leave this window open until it works.`, 'error')
      }
      setTimeout(persistChats, 5000)
    }
  )
}
/** A save has failed and none has succeeded since; the notice is shown once per streak. */
let saveFailing = false

/** Saves the reply this window is streaming every few seconds, so a crash keeps most of it; see Checkpoint. */
const checkpoints = new Checkpoint(() => saveChatsNow(true))

/**
 * Takes in chats another window changed. The chats this window is writing
 * replies into are left alone: this window's copies are the ones being
 * written, and each is saved when its reply ends.
 */
function receiveChats(change: { upserts: Chat[]; removed: string[] }): void {
  const { getState: get, setState: set } = useApp
  const mine = get().runs
  const upserts = change.upserts.filter((chat) => !(chat.id in mine))
  const removed = new Set(change.removed.filter((id) => !(id in mine)))
  for (const chat of upserts) synced.set(chat.id, chat)
  for (const id of removed) synced.delete(id)
  set((state) => {
    const incoming = new Map(upserts.map((chat) => [chat.id, chat]))
    const known = new Set(state.chats.map((chat) => chat.id))
    const added = upserts.filter((chat) => !known.has(chat.id))
    const chats = [...added, ...state.chats.filter((chat) => !removed.has(chat.id)).map((chat) => incoming.get(chat.id) ?? chat)]
    return { chats, ...(state.activeChatId && removed.has(state.activeChatId) ? { activeChatId: null } : {}) }
  })
}

/**
 * The approval state without `messageId`'s requests. Main answers them itself
 * when a run stops or ends, so a prompt left open would only be asking about
 * something that can no longer happen.
 */
function withoutApprovals(state: AppState, messageId: string): Partial<AppState> {
  const all = state.pendingApproval ? [state.pendingApproval, ...state.approvalQueue] : state.approvalQueue
  // A question left open is likewise about a turn that has ended.
  const questions = state.pendingQuestions.some((q) => q.messageId === messageId) ? { pendingQuestions: state.pendingQuestions.filter((q) => q.messageId !== messageId) } : {}
  if (!all.some((a) => a.messageId === messageId)) return questions
  const rest = all.filter((a) => a.messageId !== messageId)
  return { pendingApproval: rest[0] ?? null, approvalQueue: rest.slice(1), ...questions }
}

/**
 * Which chat each streaming message was found in, so a batch of tokens goes
 * straight to it instead of scanning every message of every chat.
 */
const streamTargets = new Map<string, string>()

function locateMessage(chats: Chat[], messageId: string): { chatIndex: number; msgIndex: number } | null {
  // A streaming message is nearly always its chat's last, so search from the end.
  const indexIn = (chat: Chat): number => {
    for (let i = chat.messages.length - 1; i >= 0; i--) if (chat.messages[i].id === messageId) return i
    return -1
  }
  const known = streamTargets.get(messageId)
  if (known !== undefined) {
    const chatIndex = chats.findIndex((c) => c.id === known)
    const msgIndex = chatIndex === -1 ? -1 : indexIn(chats[chatIndex])
    if (msgIndex !== -1) return { chatIndex, msgIndex }
  }
  for (let chatIndex = 0; chatIndex < chats.length; chatIndex++) {
    const msgIndex = indexIn(chats[chatIndex])
    if (msgIndex === -1) continue
    streamTargets.set(messageId, chats[chatIndex].id)
    return { chatIndex, msgIndex }
  }
  return null
}

function hasRunningTool(message: ChatMessage): boolean {
  return message.parts.some((part) => part.type === 'tool' && part.status === 'running')
}

/**
 * Marks tool calls left "running" as stopped, for runs that ended without
 * reporting back — the window closed mid-run, or the app died. Otherwise the
 * transcript shows a spinner (and runs its animation) forever. `output` stays
 * null, which the next request's history already reports to the model as an
 * interrupted call. `only` limits it to one message.
 */
function sealInterrupted(chats: Chat[], only?: string): Chat[] {
  const affected = (m: ChatMessage): boolean => (!only || m.id === only) && hasRunningTool(m)
  if (!chats.some((c) => c.messages.some(affected))) return chats
  return chats.map((chat) =>
    chat.messages.some(affected)
      ? {
          ...chat,
          messages: chat.messages.map((m) =>
            affected(m)
              ? {
                  ...m,
                  parts: m.parts.map((p) =>
                    p.type === 'tool' && p.status === 'running' ? { ...p, status: 'error' as const, progress: undefined } : p
                  )
                }
              : m
          )
        }
      : chat
  )
}

/**
 * Replies this window started and hasn't seen end. Stop clears the window's
 * streaming marker at once, but the last words of the stopped reply and its
 * end still arrive — and this window is the one that saves them, not "another
 * window's" run that someone else will write.
 */
const ownedRuns = new Set<string>()

/**
 * New chats waiting on their first reply, by its message id, to be named by
 * the model they run on once it's in. The name replaces the first line of
 * the first message only while the chat still has that name: a chat renamed
 * meanwhile keeps the user's.
 */
const toName = new Map<string, { chatId: string; title: string; providerId: string; modelId: string; message: string }>()

function nameChat(messageId: string): void {
  const wanted = toName.get(messageId)
  toName.delete(messageId)
  if (!wanted) return
  const found = locateMessage(useApp.getState().chats, messageId)
  if (!found) return
  const chat = useApp.getState().chats[found.chatIndex]
  const reply = chat.messages[found.msgIndex]
  // Renamed during the reply, or the reply failed: nothing to ask for.
  if (reply.error || chat.title !== wanted.title) return
  void window.api.chat
    .title({ providerId: wanted.providerId, modelId: wanted.modelId, message: wanted.message, reply: messageText(reply) })
    .then((title) => {
      const now = useApp.getState().chats.find((c) => c.id === wanted.chatId)
      if (title && now && now.title === wanted.title && title !== now.title) useApp.getState().renameChat(now.id, title)
    })
    .catch(() => {})
}

const remoteTimers = new Map<string, ReturnType<typeof setTimeout>>()
const REMOTE_SILENCE_MS = 60_000

/** Notes that something else is (still) writing this reply, or that it finished. */
function noteRemoteRun(messageId: string, finished: boolean): void {
  const timer = remoteTimers.get(messageId)
  if (timer) clearTimeout(timer)
  remoteTimers.delete(messageId)
  const { getState: get, setState: set } = useApp
  const listed = get().remoteStreaming.includes(messageId)
  if (finished) {
    if (listed) set((s) => ({ remoteStreaming: s.remoteStreaming.filter((id) => id !== messageId) }))
    return
  }
  if (!listed) set((s) => ({ remoteStreaming: [...s.remoteStreaming, messageId] }))
  remoteTimers.set(
    messageId,
    setTimeout(() => noteRemoteRun(messageId, true), REMOTE_SILENCE_MS)
  )
}

/** A checkpoint of a reply that is still being written says so, so one found after a crash is known to be cut off. */
function markUnfinished(chat: Chat): Chat {
  if (!chat.messages.some((m) => ownedRuns.has(m.id))) return chat
  return { ...chat, messages: chat.messages.map((m) => (ownedRuns.has(m.id) ? { ...m, interrupted: true } : m)) }
}

export interface ChatCompaction {
  messageId: string
  /** 0–1, only ever forwards while it runs. */
  progress: number
  state: 'running' | 'done' | 'failed'
  /** How many earlier messages the summary stands in for. */
  covered: number
}

/** How long a finished compaction stays on screen to say how it went. */
const COMPACTION_LINGER_MS = { done: 2400, failed: 5000 }

/** Clears a chat's compaction, unless a newer one has taken its place. */
function dropCompaction(chatId: string, entry: ChatCompaction): void {
  useApp.setState((s) => {
    if (s.compactions[chatId] !== entry) return {}
    const { [chatId]: _gone, ...rest } = s.compactions
    return { compactions: rest }
  })
}

/** Applies one event from a running turn — the renderer's own, or a scheduled task's — to its message. */
function applyStreamEvent(event: StreamEvent): void {
  const { getState: get, setState: set } = useApp
  if (event.type === 'compacting') {
    const entry: ChatCompaction = { messageId: event.messageId, progress: event.progress, state: event.state, covered: event.covered }
    set((s) => ({ compactions: { ...s.compactions, [event.chatId]: entry } }))
    if (event.state !== 'running') setTimeout(() => dropCompaction(event.chatId, entry), COMPACTION_LINGER_MS[event.state])
    return
  }
  // Approval requests carry no message content — they open the confirm
  // dialog and the main process blocks on the answer, so they must be
  // handled before the message-indexing path below (which would drop them).
  if (event.type === 'question-request') {
    const question: PendingQuestion = { requestId: event.requestId, messageId: event.messageId, questions: event.questions }
    set((s) => ({ pendingQuestions: [...s.pendingQuestions, question] }))
    return
  }
  if (event.type === 'approval-request') {
    const request: PendingApproval = {
      requestId: event.requestId,
      messageId: event.messageId,
      tool: event.tool,
      input: event.input,
      summary: event.summary,
      ...(event.critical ? { critical: true } : {}),
      ...(event.before !== undefined ? { before: event.before } : {}),
      ...(event.agent ? { agent: event.agent } : {})
    }
    // Several can be waiting at once: swarm sub-agents run in parallel and
    // each may stop to ask. Replacing the open one left it unanswered, and
    // its sub-agent — so the whole turn — waiting forever.
    set((s) => (s.pendingApproval ? { approvalQueue: [...s.approvalQueue, request] } : { pendingApproval: request }))
    return
  }

  const state = get()
  const finished = event.type === 'done' || event.type === 'error'
  // A headless run (a scheduled task) streams into a chat the renderer did
  // not start, so only a run this window started is cleared from `runs`.
  const owner = runChat(state.runs, event.messageId)
  const ownsStream = owner !== null
  // Still this window's to save after Stop, until the run reports its end.
  const mine = ownsStream || ownedRuns.has(event.messageId)
  const found = locateMessage(state.chats, event.messageId)
  if (finished) {
    streamTargets.delete(event.messageId)
    ownedRuns.delete(event.messageId)
    // Stopped part-way through a summary: nothing is left to show for it.
    for (const [chatId, entry] of Object.entries(state.compactions)) {
      if (entry.messageId === event.messageId && entry.state === 'running') dropCompaction(chatId, entry)
    }
    if (event.type === 'error') toName.delete(event.messageId)
    else nameChat(event.messageId)
  }
  if (!mine) noteRemoteRun(event.messageId, finished)
  if (!found) {
    // The chat is gone (deleted mid-run), but the run still has to release
    // the stop button and any prompt it left open.
    if (finished) set((s) => ({ ...(owner ? { runs: withoutRun(s.runs, owner) } : {}), ...withoutApprovals(s, event.messageId) }))
    return
  }
  const { chatIndex, msgIndex } = found
  const target = state.chats[chatIndex]

  const message = target.messages[msgIndex]
  let nextMessage = message
  let nextChat: Partial<Chat> | null = null
  if (event.type === 'delta') nextMessage = appendPart(message, 'text', event.text)
  else if (event.type === 'reasoning') nextMessage = appendPart(message, 'reasoning', event.text)
  else if (event.type === 'notice') nextMessage = { ...message, notice: event.text }
  else if (event.type === 'error') {
    nextMessage = { ...message, error: event.error, ...(event.issue ? { errorIssue: event.issue } : {}) }
    // An expired sign-in, a rejected key or the gateway's limit for the day marks the provider in main; show it in the picker too.
    if (event.issue && (isLastingIssue(event.issue.kind) || isLongLimit(event.issue))) void state.refreshProviders()
  }
  else if (event.type === 'usage') nextMessage = { ...message, usage: event.usage }
  else if (event.type === 'plan') nextMessage = { ...message, plan: event.plan }
  else if (event.type === 'todos') nextMessage = { ...message, todos: event.todos }
  else if (event.type === 'goal') nextChat = { goal: event.goal }
  else if (event.type === 'compacted') nextChat = { summary: { text: event.summary, throughMessageId: event.throughMessageId } }
  else if (event.type === 'tool-progress' || event.type === 'subagent') {
    const partIndex = message.parts.findIndex((p) => p.type === 'tool' && p.id === event.toolId)
    if (partIndex !== -1) {
      const parts = message.parts.slice()
      const part = parts[partIndex] as ChatToolPart
      if (event.type === 'tool-progress') {
        parts[partIndex] = { ...part, progress: event.output }
      } else {
        const agents = (part.agents ?? []).slice()
        agents[event.run.index] = event.run
        parts[partIndex] = { ...part, agents }
      }
      nextMessage = { ...message, parts }
    }
  } else if (event.type === 'tool-call') {
    nextMessage = {
      ...message,
      parts: [
        ...message.parts,
        { type: 'tool', id: event.toolId, name: event.name, input: event.input, output: null, status: 'running' }
      ]
    }
  } else if (event.type === 'tool-result') {
    // Land the result on the call it belongs to. A tool part is only ever
    // written once, so replacing it in place keeps every other part's
    // identity for React.memo.
    const partIndex = message.parts.findIndex((p) => p.type === 'tool' && p.id === event.toolId)
    if (partIndex !== -1) {
      const parts = message.parts.slice()
      parts[partIndex] = {
        ...(parts[partIndex] as ChatToolPart),
        output: event.output,
        status: event.status,
        progress: undefined,
        ...(event.images ? { images: event.images } : {}),
        ...(event.before !== undefined ? { before: event.before } : {})
      }
      nextMessage = { ...message, parts }
    }
  }

  // Stamped once, when the turn ends, so its header can say how long it worked.
  if (finished && !nextMessage.finishedAt) nextMessage = { ...nextMessage, finishedAt: Date.now() }
  // A notice (a retry's wait) lasts until the model answers again, or the turn ends.
  if (nextMessage.notice && (finished || event.type === 'delta' || event.type === 'reasoning' || event.type === 'tool-call')) {
    const { notice: _notice, ...rest } = nextMessage
    nextMessage = rest
  }

  if (nextMessage === message && !finished && !nextChat) return

  // Copy only the two arrays on the path to the changed message; every other
  // chat and message keeps its identity, so React.memo can skip those rows.
  const messages = target.messages.slice()
  messages[msgIndex] = nextMessage
  const chats = state.chats.slice()
  chats[chatIndex] = {
    ...target,
    // `updatedAt` only moves when the turn ends — bumping it per token
    // reshuffled the sidebar's sort on every single token.
    ...(finished ? { updatedAt: Date.now() } : {}),
    ...(nextChat ?? {}),
    messages
  }

  // A reply that ends in a chat that isn't on screen marks it, so the sidebar shows there's something new to read.
  const unseen = finished && owner !== null && (state.activeChatId !== target.id || state.view !== 'chat')
  const ended = unseen ? chats.map((c, i) => (i === chatIndex ? { ...c, unread: true } : c)) : chats
  set({ chats: ended, ...(finished ? { ...(owner ? { runs: withoutRun(get().runs, owner) } : {}), ...withoutApprovals(state, event.messageId) } : {}) })
  // Another window's reply (or a scheduled run's) is shown as it comes, but
  // saved by whoever is writing it; here it only becomes the synced copy.
  if (!mine) synced.set(target.id, ended[chatIndex])
  else if (finished || nextChat) persistChats()
  else checkpoints.touch()
}

/**
 * True when the active tab is the agent chat — Chat, which absorbed the old
 * Work tab (a `work` workspace only survives in an install mid-migration).
 * Several components gate agent affordances on this — the goal banner, the
 * checklist, the browser panel — and each had its own copy of the lookup,
 * which is how they drift apart. Returns a boolean, so it is safe as a plain
 * selector.
 */
export const useIsWork = (): boolean =>
  useApp((s) => isAgentKind(s.workspaces.find((w) => w.id === s.settings?.activeWorkspaceId)?.kind))

export const isAgentKind = (kind: WorkspaceKind | undefined): boolean => kind === 'chat' || kind === 'work'

/** The workspace chat turns run in. Its own folder is for scheduled tasks; a chat works in its project's. */
export const agentWorkspace = (workspaces: Workspace[]): Workspace | undefined =>
  workspaces.find((w) => w.kind === 'chat') ?? workspaces.find((w) => w.kind === 'work')

type ProjectState = Pick<AppState, 'chats' | 'projects' | 'activeChatId' | 'pendingProjectId'>

/** The project of the chat on screen, or of the one about to be started on the start page. */
export const codeProject = (s: ProjectState): Project | null => {
  const projectId = s.activeChatId ? (s.chats.find((c) => c.id === s.activeChatId)?.projectId ?? null) : s.pendingProjectId
  return projectId ? (s.projects.find((p) => p.id === projectId) ?? null) : null
}

/**
 * The folder the chat on screen codes in: its project's, or for a chat in a
 * cloud environment the copy on that machine (none until it is ready). Null
 * for an ordinary chat, which has no coding tools.
 */
export const codeFolder = (s: ProjectState): string | null => {
  const place = s.activeChatId ? s.chats.find((c) => c.id === s.activeChatId)?.place : undefined
  if (place) return place.state === 'ready' ? (place.folder ?? null) : null
  return codeProject(s)?.folder ?? null
}

/** Where a new session in this project would run: the environment picked under the message box, when there is one to use. */
export function pendingPlace(settings: Settings | null, project: Project | null, now = Date.now()): SessionPlace | null {
  if (!settings || !project?.folder || project.folder.startsWith('ssh://')) return null
  const id = settings.environment ?? LOCAL_ENVIRONMENT
  if (id === LOCAL_ENVIRONMENT) return null
  const env = environmentsOf(settings.environments).find((e) => e.id === id)
  if (!env) return null
  return {
    envId: env.id,
    name: env.name,
    kind: env.kind,
    ...(providerOf(env) ? { provider: providerOf(env) } : {}),
    ...(env.provider ? { machine: env.provider.machine } : {}),
    state: 'preparing',
    source: project.folder,
    at: now
  }
}

/** Whether the chat on screen is a coding session: one in a project with a folder. */
export const useCoding = (): boolean => useApp((s) => codeFolder(s) !== null)

/** Which top-bar tab is active: Chat, Workers or ADE (`code`). */
export const useWorkspaceKind = (): WorkspaceKind =>
  useApp((s) => s.workspaces.find((w) => w.id === s.settings?.activeWorkspaceId)?.kind ?? 'chat')

/** A palette to show for one mode while previewing, without saving it. */
export interface AppearancePreview {
  mode: 'light' | 'dark' | 'system'
  light: ThemePalette
  dark: ThemePalette
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i

/** The agent CLIs' models as pickers list them, for Adaptive; none if main doesn't answer at once. */
async function cliOptions(): Promise<ModelOption[]> {
  if (!window.api.engines) return []
  const engines = CLI_ENGINES.filter((id) => id !== 'claude')
  const ask = Promise.all([window.api.engines.status(), ...engines.map((id) => window.api.engines.models(id))]).then(([statuses, ...lists]) =>
    engines.flatMap((id, i) => engineOptions(id, lists[i] ?? null, statuses.find((s) => s.id === id) ?? null))
  )
  return Promise.race([ask.catch((): ModelOption[] => []), new Promise<ModelOption[]>((resolve) => setTimeout(() => resolve([]), 1500))])
}

/**
 * Adaptive's model for a message into `chat` (null: a new chat), from what
 * the message asks and where the chat is: a chat the agent has worked in only
 * moves up. Ties go to the model selected before, then starred and recent ones.
 */
function adaptiveRoute(text: string, attachments: string[], chat: Chat | null, state: AppState, cli: ModelOption[]): AdaptiveRoute | null {
  const settings = state.settings!
  const messages = chat?.messages ?? []
  const last = messages.findLast((m) => m.role === 'assistant' && m.routed)?.routed ?? null
  const toolWork = messages.some((m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'tool'))
  const inProject = Boolean(chat ? chat.projectId : !state.pendingTemporary && state.pendingProjectId)
  const task = classifyTask(text, { images: attachments.some((path) => IMAGE.test(path)), inProject, toolWork, previous: last?.kind ?? null })
  const selected = settings.selectedEngine
    ? engineModelKey(settings.selectedEngine, settings.selectedEngineModel ?? '')
    : settings.selectedProviderId && settings.selectedModelId
      ? modelKey(settings.selectedProviderId, settings.selectedModelId)
      : null
  const prefer = [...(selected ? [selected] : []), ...(settings.favoriteModels ?? []), ...(settings.recentModels ?? [])]
  return pickModel({ task, options: [...nativeOptions(state.providers), ...cli], providers: state.providers, stay: toolWork ? last : null, prefer })
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  initError: null,
  settings: null,
  workspaces: [],
  projects: [],
  chats: [],
  providers: [],
  mcpServers: [],

  view: 'chat',
  settingsPage: 'general',
  pluginsTab: 'plugins',
  modelsRepo: null,
  activeChatId: null,
  pendingProjectId: null,
  pendingTemporary: false,
  navPast: [],
  navFuture: [],
  sidebarOpen: true,
  browserOpen: false,
  runs: {},
  remoteStreaming: [],
  compactions: {},
  pendingApproval: null,
  pendingQuestions: [],
  approvalQueue: [],
  composerDraft: null,
  providerFocus: null,
  modelMenuRequest: 0,
  composerAppend: null,
  composerEdit: null,
  indexStatus: null,
  modelDownloads: {},
  updateStatus: { state: 'idle' },
  appearancePreview: null,
  setAppearancePreview: (appearancePreview) => set({ appearancePreview }),
  betaStatus: { state: 'idle' },

  async init() {
    set({ initError: null })
    try {
      const [settings, workspaces, projects, chats, providers, mcpServers, activeRuns] = await Promise.all([
        window.api.settings.get(),
        window.api.workspaces.get(),
        window.api.projects.get(),
        window.api.chats.get(),
        window.api.providers.list(),
        window.api.mcp.get(),
        window.api.chats.activeRuns()
      ])
      // Nothing is running for this renderer yet, so a call still marked
      // running was cut off by a crash or a quit (see sealInterrupted) unless
      // another window is writing that reply right now.
      const live = new Set(activeRuns)
      const sealed = chats.map((chat) => (chat.messages.some((m) => live.has(m.id)) ? chat : sealInterrupted([chat])[0]))
      synced = new Map(chats.map((chat) => [chat.id, chat]))
      set({ settings, workspaces, projects, chats: sealed, providers, mcpServers, ready: true })
      // A window opened while another is writing a reply shows that reply as unfinished too.
      for (const id of activeRuns) noteRemoteRun(id, false)

      if (listenersBound) return
      listenersBound = true

      window.api.chat.onEvent(applyStreamEvent)
      // A cloud environment being got ready says each step, on the session and as its reply's notice.
      window.api.environments.onProgress(({ key, step }) => notePlaceStep(key, step))

      // Other windows: each keeps its own copy of these, and main passes on
      // what the others change. The open tab stays this window's own.
      window.api.chats.onChanged(receiveChats)
      window.api.projects.onChanged((projects) => set({ projects }))
      window.api.workspaces.onChanged((workspaces) => set({ workspaces }))
      window.api.settings.onChanged((next) =>
        set((state) => ({
          settings: { ...next, activeWorkspaceId: state.settings?.activeWorkspaceId ?? next.activeWorkspaceId, chatSide: state.settings ? state.settings.chatSide : next.chatSide }
        }))
      )

      // Closing the window or reloading ends this renderer, and with it the only
      // copy of the reply in flight, the pending debounced save and any approval
      // prompt the run is parked on. Main writes nothing of a chat run itself, so
      // stop it — nothing could show, approve or save what it does from here —
      // and save what has arrived so far.
      window.addEventListener('pagehide', () => {
        const running = Object.values(get().runs)
        for (const streaming of running) {
          void window.api.chat.cancel(streaming)
          // Cut off by this window closing: what was said stays, marked as unfinished.
          set((s) => ({ chats: sealInterrupted(s.chats, streaming).map(markUnfinished), ...withoutApprovals(s, streaming) }))
        }
        if (running.length) set({ runs: {} })
        if (saveTimer || running.length) saveChatsNow()
      })

      // Scheduled tasks (features/scheduler): main starts those runs, so their
      // chats arrive whole — at the start, and again when the run ends — and
      // are inserted, or merged into the copy already here. Main writes
      // chats.json itself only while no renderer has said it is ready.
      window.api.scheduler.onChat((incoming) => {
        const current = get().chats
        const index = current.findIndex((c) => c.id === incoming.id)
        const chats = index === -1 ? [incoming, ...current] : current.map((c, i) => (i === index ? mergeRunChat(c, incoming) : c))
        set({ chats })
        persistChats()
      })
      window.api.scheduler.onOpenChat((chatId) => revealChat(chatId))
      void window.api.scheduler.ready().then(() => migrateLegacySchedules())

      window.api.codeIndex.onStatus((indexStatus) => set({ indexStatus }))
      window.api.providers.onChanged(() => void get().refreshProviders())

      void window.api.updater.status().then((updateStatus) => set({ updateStatus }))
      window.api.updater.onStatus((updateStatus) => set({ updateStatus }))
      void window.api.updater.betaStatus().then((betaStatus) => set({ betaStatus }))
      window.api.updater.onBetaStatus((betaStatus) => set({ betaStatus }))

      window.api.models.onDownloadProgress((progress) => {
        const key = `${progress.repoId}::${progress.filename}`
        set((state) => ({ modelDownloads: { ...state.modelDownloads, [key]: progress } }))
      })

      // Pick up an existing index for the folder on screen, and refresh it in
      // the background so the first codebase_search of the session is not stale.
      const workCwd = codeFolder(get())
      if (workCwd) {
        set({ indexStatus: await window.api.codeIndex.status(workCwd) })
        if (settings.codeIndex.autoIndex) void get().reindex()
      }
    } catch (error) {
      const message = errorText(error)
      reportError({ message, stack: error instanceof Error ? error.stack : undefined, source: 'startup' })
      // Without settings and chats there is nothing to draw, and App would
      // show an empty window for good: it shows this instead, with Reload.
      // Once the window is up, a listener or the index check failing is
      // worth logging but not worth taking the window away for.
      if (!get().ready) set({ initError: message })
    }
  },

  async patchSettings(patch) {
    const next = await window.api.settings.patch(patch as Partial<Settings>)
    // Main's activeWorkspaceId (and chatSide) is whichever window switched tabs
    // last; this window keeps showing its own tab unless this patch is the switch.
    const mine = get().settings
    const own = mine?.activeWorkspaceId
    const tab = 'activeWorkspaceId' in patch || !own ? next : { ...next, activeWorkspaceId: own }
    set({ settings: 'chatSide' in patch || !mine ? tab : { ...tab, chatSide: mine.chatSide } })
  },

  setView: (view) => {
    const current = { view: get().view, activeChatId: get().activeChatId }
    if (current.view === view) return
    set((s) => ({ navPast: [...s.navPast, current], navFuture: [], view }))
  },
  setSettingsPage: (settingsPage) => {
    const current = { view: get().view, activeChatId: get().activeChatId }
    set((s) => ({
      navPast: current.view === 'settings' ? s.navPast : [...s.navPast, current],
      navFuture: current.view === 'settings' ? s.navFuture : [],
      settingsPage,
      view: 'settings'
    }))
  },
  openProviderSettings: (providerId) => {
    set({ providerFocus: providerId })
    get().setSettingsPage('providers')
  },
  setProviderFocus: (providerFocus) => set({ providerFocus }),
  openModelMenu: () => set((s) => ({ modelMenuRequest: s.modelMenuRequest + 1 })),
  setPluginsTab: (pluginsTab) => set({ pluginsTab }),
  setModelsRepo: (modelsRepo) => set({ modelsRepo }),

  goBack: () => {
    const { navPast } = get()
    if (navPast.length === 0) return
    const current = { view: get().view, activeChatId: get().activeChatId }
    const previous = navPast[navPast.length - 1]
    set((s) => ({
      navPast: s.navPast.slice(0, -1),
      navFuture: [current, ...s.navFuture],
      view: previous.view,
      activeChatId: previous.activeChatId
    }))
  },
  goForward: () => {
    const { navFuture } = get()
    if (navFuture.length === 0) return
    const current = { view: get().view, activeChatId: get().activeChatId }
    const next = navFuture[0]
    set((s) => ({
      navFuture: s.navFuture.slice(1),
      navPast: [...s.navPast, current],
      view: next.view,
      activeChatId: next.activeChatId
    }))
  },
  canGoBack: () => get().navPast.length > 0,
  canGoForward: () => get().navFuture.length > 0,

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleBrowser: (open) => set((s) => ({ browserOpen: open ?? !s.browserOpen })),

  newChat: (projectId = null) => {
    const current = { view: get().view, activeChatId: get().activeChatId }
    // A chat in a project is the IDE's; a new chat in the IDE is in the project it was on.
    const side = chatSideOf(get())
    if (projectId && side === 'chat') showSide('ide')
    const project = projectId ?? (side === 'ide' ? ideProject(get()) : null)
    set((s) => ({
      navPast: [...s.navPast, current],
      navFuture: [],
      activeChatId: null,
      view: 'chat',
      pendingProjectId: project,
      pendingTemporary: false
    }))
  },

  startTemporaryChat: () => {
    // Temporary chats have no project: they're Chat's.
    if (chatSideOf(get()) === 'ide') showSide('chat')
    get().newChat()
    set({ pendingTemporary: true })
  },

  // A temporary chat has no project: the folder, its tools and its checkpoints all outlive it.
  setPendingTemporary: (on) => set(on ? { pendingTemporary: true, pendingProjectId: null } : { pendingTemporary: false }),

  openChat: (id) => {
    const current = { view: get().view, activeChatId: get().activeChatId }
    // From search, a notification or a link: the chat opens in its own tab.
    const chat = get().chats.find((c) => c.id === id)
    const side = chatSideOf(get())
    if (chat && side && sideOfChat(chat) !== side) showSide(sideOfChat(chat))
    set((s) => ({
      navPast: [...s.navPast, current],
      navFuture: [],
      activeChatId: id,
      view: 'chat',
      // Only when there is something to clear: a new array re-sorts the sidebar.
      ...(s.chats.some((c) => c.id === id && c.unread) ? { chats: s.chats.map((c) => (c.id === id ? { ...c, unread: false } : c)) } : {})
    }))
  },

  // Deleting or archiving a chat whose reply is still streaming stops it. The
  // run otherwise kept going with nowhere to write, and — for a deleted chat —
  // its end never found the message, so every composer stayed on "Stop".
  setChatPlace: (id, place) => {
    set({ chats: get().chats.map((c) => (c.id === id ? { ...c, place } : c)) })
    persistChats()
  },

  deleteChat: (id) => {
    if (get().runs[id]) get().stop(id)
    dropCheckpointsOf(get().chats.find((c) => c.id === id), get().projects)
    releasePlace(get().chats.find((c) => c.id === id), get().settings)
    const chats = get().chats.filter((c) => c.id !== id)
    set({ chats, activeChatId: get().activeChatId === id ? null : get().activeChatId })
    persistChats()
  },

  deleteChats: (ids) => {
    const gone = new Set(ids)
    const { chats: all, projects, activeChatId } = get()
    const doomed = all.filter((c) => gone.has(c.id))
    for (const chat of doomed) {
      if (get().runs[chat.id]) get().stop(chat.id)
      dropCheckpointsOf(chat, projects)
      releasePlace(chat, get().settings)
    }
    if (doomed.length === 0) return 0
    set({ chats: all.filter((c) => !gone.has(c.id)), activeChatId: activeChatId && gone.has(activeChatId) ? null : activeChatId })
    persistChats()
    return doomed.length
  },

  archiveChats: (ids) => {
    const wanted = new Set(ids)
    const { chats, runs, activeChatId } = get()
    // A reply still being written would be stopped by archiving its chat; those stay as they are.
    const moving = chats.filter((c) => wanted.has(c.id) && !c.archived && !c.temporary && !runs[c.id])
    if (moving.length === 0) return 0
    const moved = new Set(moving.map((c) => c.id))
    set({ chats: chats.map((c) => (moved.has(c.id) ? { ...c, archived: true } : c)), activeChatId: activeChatId && moved.has(activeChatId) ? null : activeChatId })
    persistChats()
    return moving.length
  },

  archiveChat: (id) => {
    // Nothing to put away: a temporary chat isn't kept.
    if (get().chats.some((c) => c.id === id && c.temporary)) return get().deleteChat(id)
    if (get().runs[id]) get().stop(id)
    const chats = get().chats.map((c) => (c.id === id ? { ...c, archived: true } : c))
    set({ chats, activeChatId: get().activeChatId === id ? null : get().activeChatId })
    persistChats()
  },

  restoreChat: (id) => {
    set((s) => ({ chats: s.chats.map((c) => (c.id === id ? { ...c, archived: false } : c)) }))
    persistChats()
  },

  renameChat: (id, title) => {
    set((s) => ({ chats: s.chats.map((c) => (c.id === id ? { ...c, title } : c)) }))
    persistChats()
  },

  togglePin: (id) => {
    set((s) => ({ chats: s.chats.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)) }))
    persistChats()
  },

  moveChat: (id, projectId) => {
    set((s) => ({ chats: s.chats.map((c) => (c.id === id && !c.temporary ? { ...c, projectId } : c)) }))
    persistChats()
    // The open chat moved into a project or out of one: it goes to its new tab, and the window with it.
    const side = chatSideOf(get())
    if (id === get().activeChatId && side && side !== sideOfChat({ projectId })) showSide(sideOfChat({ projectId }))
  },

  async send(text, options = {}) {
    // Adaptive weighs the agent CLIs' models too, whose sign-ins main knows.
    const cli = get().settings?.adaptiveModel ? await cliOptions() : []
    const state = get()
    const settings = state.settings
    if (!settings || (!text.trim() && !options.attachments?.length)) return
    // Into the open chat, or the one asked for (a queued message, sent once its chat's reply ends).
    const into = options.chatId ? (state.chats.find((c) => c.id === options.chatId) ?? null) : state.activeChat()
    if (options.chatId && !into) return
    // One reply at a time in a chat: its Stop, its streaming marker and its
    // questions follow a single message, and a second would be orphaned,
    // still running with nothing left to stop it. Other chats can run.
    if (into && state.runs[into.id]) return
    // Sent into a chat that isn't on screen: it runs there, and the screen stays where it is.
    const background = Boolean(options.chatId && options.chatId !== state.activeChatId)

    const selection = state.modelSelection()
    // Adaptive: the model and effort this message needs (shared/adaptive.ts); the selected model when nothing fits.
    const route = settings.adaptiveModel ? adaptiveRoute(text, options.attachments ?? [], into, state, cli) : null
    // Chat on an agent engine (a Codex model): the engine's own model, not a provider's.
    const engine = route ? (route.option.engine === 'native' ? null : route.option.engine) : (settings.selectedEngine ?? null)
    const engineModel = route ? route.option.modelId : (settings.selectedEngineModel ?? '')
    const model = route ? route.option.model : engine ? null : selection.model
    const effort = route?.effort ?? settings.effort
    // Adaptive's picks are its own, not the user's: they don't become the selected or a recent model.
    if (model && !route) {
      // A default the user never picked becomes their choice once they use it,
      // so connecting another provider later doesn't move the chat to its model.
      // Whatever runs counts as a recent pick, newest first.
      const key = modelKey(model.providerId, model.id)
      const patch: DeepPartial<Settings> = {
        ...(selection.status === 'default' ? { selectedModelId: model.id, selectedProviderId: model.providerId } : {}),
        ...(settings.recentModels?.[0] !== key ? { recentModels: withRecent(settings.recentModels, key) } : {})
      }
      if (Object.keys(patch).length > 0) void get().patchSettings(patch)
    }
    const now = Date.now()
    const userMessage: ChatMessage = {
      id: uid(),
      role: 'user',
      parts: [{ type: 'text', text }],
      createdAt: now,
      ...(options.attachments?.length ? { attachments: options.attachments } : {})
    }
    const assistantMessage: ChatMessage = {
      id: uid(),
      role: 'assistant',
      parts: [],
      createdAt: now + 1,
      model: engine ? engineModel || engine : model?.id,
      ...(route ? { routed: routeRecord(route) } : {})
    }
    const goal = options.goal
      ? { text: text.trim(), status: 'active' as const, iterations: 0, ...(options.until && options.until > now ? { until: options.until } : {}) }
      : undefined

    let chat = into
    let chats: Chat[]
    if (!chat) {
      chat = {
        id: uid(),
        workspaceId: settings.activeWorkspaceId,
        projectId: state.pendingTemporary ? null : state.pendingProjectId,
        title: (text.trim() || options.attachments?.[0]?.split(/[\\/]/).pop() || 'New chat').split('\n')[0].slice(0, 60),
        messages: [userMessage, assistantMessage],
        createdAt: now,
        updatedAt: now,
        archived: false,
        pinned: false,
        unread: false,
        modelId: engine ? engineModel || engine : (model?.id ?? null),
        effort,
        ...(state.pendingTemporary ? { temporary: true } : {}),
        ...(goal ? { goal } : {})
      }
      // Started with a cloud environment picked: it runs there, on a copy made before its first turn.
      const place = state.pendingTemporary ? null : pendingPlace(settings, state.projects.find((p) => p.id === state.pendingProjectId) ?? null, now)
      if (place) chat = { ...chat, place }
      chats = [chat, ...state.chats]
    } else {
      const target = chat
      chats = state.chats.map((c) =>
        c.id === target.id
          ? { ...c, messages: [...c.messages, userMessage, assistantMessage], updatedAt: now, ...(goal ? { goal } : {}) }
          : c
      )
    }

    ownedRuns.add(assistantMessage.id)
    const runningIn = chat.id
    set((s) => ({
      chats,
      runs: { ...s.runs, [runningIn]: assistantMessage.id },
      ...(background ? {} : { activeChatId: runningIn, view: 'chat' as const }),
      // The switch was for the chat just started; the next one starts as usual.
      ...(into ? {} : { pendingTemporary: false })
    }))
    // Saved straight away rather than debounced: other windows need the new
    // messages before the reply's first words reach them.
    saveChatsNow()

    if (!model && !engine) {
      // The composer says this before anything is typed; a retry or an
      // approved plan can still get here, and gets the same explanation.
      const reason =
        selection.status === 'unavailable' && selection.wanted
          ? `${selection.wanted.label} is unavailable. ${selection.reason ?? ''} Choose another model, or fix it in Settings → Model providers.`
          : (selection.reason ?? 'No usable model is connected. Sign in to a supported account, add an API key, or choose a local model.')
      const issue: ProviderIssue = {
        kind: selection.status === 'unavailable' ? 'model-unavailable' : 'no-models',
        message: reason,
        action: selection.status === 'unavailable' ? 'choose-model' : 'open-settings',
        ...(selection.provider ? { providerId: selection.provider.id } : {})
      }
      const failed = chats.map((c) =>
        c.id === chat!.id
          ? {
              ...c,
              messages: c.messages.map((m) => (m.id === assistantMessage.id ? { ...m, error: reason.replace(/\s+/g, ' ').trim(), errorIssue: issue } : m))
            }
          : c
      )
      set((s) => ({ chats: failed, runs: withoutRun(s.runs, runningIn) }))
      persistChats()
      return
    }

    // A session in a cloud environment: its agent runs on that machine, so the session goes on while this
    // computer is closed. Codex and Claude Code can; Eaon's own models run here. Said before any VM is made.
    const placed = chats.find((c) => c.id === chat!.id)?.place
    if (placed && engine !== 'codex' && engine !== 'claude') {
      const reason = `${placed.name} runs Codex or Claude Code on its machine, so the session keeps working while this computer is closed. Pick Codex or Claude in the model menu, then send again.`
      const issue: ProviderIssue = { kind: 'model-unavailable', message: reason, action: 'choose-model' }
      set((s) => ({
        chats: s.chats.map((c) => (c.id === chat!.id ? { ...c, messages: c.messages.map((m) => (m.id === assistantMessage.id ? { ...m, error: reason, errorIssue: issue } : m)) } : c)),
        runs: withoutRun(s.runs, runningIn)
      }))
      ownedRuns.delete(assistantMessage.id)
      persistChats()
      return
    }
    if (placed && placed.state !== 'ready') {
      const ready = await preparePlace(runningIn, assistantMessage.id, placed)
      if (!ready) return
    }

    // The main process decides what of this to resend — it trims old tool
    // output and drops stale screenshots — so the stored transcript goes over
    // as-is. Everything a compaction summary already covers is left out.
    const current = get().chats.find((c) => c.id === chat!.id) ?? chats.find((c) => c.id === chat!.id)!
    let history = current.messages.filter((m) => m.id !== assistantMessage.id && m.role !== 'system')
    const summary = current.summary ?? null
    if (summary) {
      const cut = history.findIndex((m) => m.id === summary.throughMessageId)
      if (cut !== -1) history = history.slice(cut + 1)
    }

    const project = state.projects.find((p) => p.id === current.projectId)
    const workspace = state.workspaces.find((w) => w.id === current.workspaceId)
    // Chat is the agent: every chat turn gets the full tool set. The old
    // web-search-only mode is still what scheduled "chat" tasks and the Local
    // API Server use, but nothing in the UI sends it any more.
    const mode = isAgentKind(workspace?.kind) ? 'work' : 'chat'

    const request: StreamRequest = {
      chatId: current.id,
      // The notification for a finished task shows this: nothing of a temporary chat's words.
      chatTitle: current.temporary ? 'Temporary chat' : current.title,
      messageId: assistantMessage.id,
      providerId: engine ?? model!.providerId,
      modelId: engine ? engineModel : model!.id,
      ...(engine ? { engine } : {}),
      effort,
      mode,
      history,
      summary: summary?.text ?? null,
      projectInstructions: project?.instructions ?? '',
      // A project's chats code in its folder (a cloud environment's copy of it); an ordinary chat's agent keeps to ~/Eaon.
      cwd: mode === 'work' ? (current.place?.folder ?? project?.folder ?? null) : null,
      ...(current.place ? { cloud: true } : {}),
      // The project's other folders are on this computer, out of reach of a session elsewhere.
      ...(mode === 'work' && project?.extraFolders?.length && !current.place ? { extraRoots: project.extraFolders } : {}),
      work: {
        swarm: settings.work.swarm,
        plan: options.plan ?? settings.planMode,
        ask: Boolean(settings.askMode) && !(options.plan ?? settings.planMode)
      },
      goal: current.goal?.status === 'active' ? current.goal : null
    }
    // A chat's first turn on Eaon's own loop: its model names it once the reply is in.
    if (!engine && !current.temporary && current.messages.length === 2 && text.trim())
      toName.set(assistantMessage.id, { chatId: current.id, title: current.title, providerId: model!.providerId, modelId: model!.id, message: text })
    try {
      await window.api.chat.stream(request)
    } catch (error) {
      // The run never started, or main failed before its loop could report
      // back. Without this the reply sat on "Thinking" with Stop showing.
      if (get().runs[runningIn] !== assistantMessage.id) return
      const reason = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error)
      applyStreamEvent({ type: 'error', messageId: assistantMessage.id, error: reason })
    }
  },

  stop(chatId) {
    const chat = chatId ?? get().activeChatId
    const id = runIn(get(), chat)
    if (!chat || !id) return
    void window.api.chat.cancel(id)
    // Still getting its cloud environment ready: that stops too (a VM made for it is deleted).
    if (get().chats.some((c) => c.id === chat && c.place?.state === 'preparing')) void window.api.environments.cancel(chat)
    // Marked, so the reply says it was stopped rather than looking finished.
    set((s) => ({
      runs: withoutRun(s.runs, chat),
      ...withoutApprovals(s, id),
      chats: s.chats.map((c) => (c.id === chat ? { ...c, messages: c.messages.map((m) => (m.id === id ? { ...m, stopped: true } : m)) } : c))
    }))
    // What was said so far is saved now, not only when the run reports back.
    persistChats()
  },

  setMessageFeedback(messageId, feedback) {
    const chat = get().activeChat()
    if (!chat) return
    const next = withFeedback(chat, messageId, feedback)
    if (next === chat) return
    set({ chats: get().chats.map((c) => (c.id === chat.id ? next : c)) })
    persistChats()
  },

  setMessageUndone(messageId, undone) {
    const chat = get().activeChat()
    if (!chat) return
    const messages = chat.messages.map((m) => (m.id === messageId ? { ...m, undone: undone || undefined } : m))
    set({ chats: get().chats.map((c) => (c.id === chat.id ? { ...c, messages } : c)) })
    persistChats()
  },

  retryReply(messageId) {
    const chat = get().activeChat()
    if (!chat || get().runs[chat.id]) return
    const plan = retryPlan(chat, messageId)
    if (!plan) return
    set({ chats: get().chats.map((c) => (c.id === chat.id ? { ...c, messages: plan.messages } : c)) })
    void get().send(plan.text, plan.attachments ? { attachments: plan.attachments } : {})
  },

  forkChat(messageId) {
    const chat = get().activeChat()
    if (!chat) return
    const fork = forkedChat(chat, messageId, uid(), Date.now())
    if (!fork) return
    set((s) => ({ chats: [fork, ...s.chats], activeChatId: fork.id, view: 'chat' }))
    persistChats()
  },

  approvePlan(messageId) {
    const chat = get().activeChat()
    if (!chat) return
    const chats = get().chats.map((c) =>
      c.id === chat.id
        ? {
            ...c,
            messages: c.messages.map((m) =>
              m.id === messageId && m.plan ? { ...m, plan: { ...m.plan, status: 'approved' as const } } : m
            )
          }
        : c
    )
    set({ chats })
    persistChats()
    // Plan mode stays on for the next task; this one runs with it off.
    const plan = chat.messages.find((m) => m.id === messageId)?.plan
    void get().send(plan ? planApprovalMessage(plan) : planApprovalMessage({ title: '', steps: [] }), { plan: false })
  },

  editPlanSteps(messageId, steps) {
    const chat = get().activeChat()
    if (!chat) return
    const cleaned = cleanPlanSteps(steps)
    if (cleaned.length === 0) return
    const chats = get().chats.map((c) =>
      c.id === chat.id
        ? {
            ...c,
            messages: c.messages.map((m) =>
              m.id === messageId && m.plan && m.plan.status === 'pending'
                ? { ...m, plan: { ...m.plan, steps: cleaned, edited: m.plan.edited || planChanged(m.plan.steps, cleaned) } }
                : m
            )
          }
        : c
    )
    set({ chats })
    persistChats()
  },

  setGoalStatus(status) {
    const chat = get().activeChat()
    if (!chat) return
    // A goal pursued right now lives in the main process too; pausing only
    // here would be overwritten by the loop's next "still working" event.
    const streaming = get().runs[chat.id]
    if (status !== 'active' && streaming) void window.api.chat.pauseGoal(streaming)
    const chats = get().chats.map((c) =>
      c.id === chat.id ? { ...c, goal: status && c.goal ? { ...c.goal, status, ...(status === 'active' ? { summary: undefined } : {}) } : null } : c
    )
    set({ chats })
    persistChats()
  },

  answerQuestion(requestId, answers) {
    if (!get().pendingQuestions.some((q) => q.requestId === requestId)) return
    void window.api.chat.answerQuestion(requestId, answers)
    set((s) => ({ pendingQuestions: s.pendingQuestions.filter((q) => q.requestId !== requestId) }))
  },

  respondApproval(approved, requestId) {
    const { pendingApproval, approvalQueue } = get()
    const waiting = pendingApproval ? [pendingApproval, ...approvalQueue] : approvalQueue
    // Several chats can each be asking; each answers its own.
    const asked = requestId ? waiting.find((a) => a.requestId === requestId) : waiting[0]
    if (!asked) return
    void window.api.chat.approve(asked.requestId, approved)
    const rest = waiting.filter((a) => a !== asked)
    set({ pendingApproval: rest[0] ?? null, approvalQueue: rest.slice(1) })
  },

  releaseApprovals() {
    const { pendingApproval, approvalQueue } = get()
    const waiting = pendingApproval ? [pendingApproval, ...approvalQueue] : approvalQueue
    if (waiting.length === 0) return
    for (const ask of waiting) if (!ask.critical) void window.api.chat.approve(ask.requestId, true)
    const kept = waiting.filter((ask) => ask.critical)
    set({ pendingApproval: kept[0] ?? null, approvalQueue: kept.slice(1) })
  },

  setComposerDraft(text) {
    set({ composerDraft: text })
  },

  appendToComposer(append) {
    set({ composerAppend: append })
  },

  editMessage(messageId) {
    const chat = get().activeChat()
    const plan = chat && messageId ? editPlan(chat, messageId) : null
    set({ composerEdit: plan && messageId ? { messageId, text: plan.text, attachments: plan.attachments } : null })
  },

  resendFrom(messageId, text, options = {}) {
    const chat = get().activeChat()
    if (!chat || get().runs[chat.id]) return
    const plan = editPlan(chat, messageId)
    if (!plan) return
    set({ chats: get().chats.map((c) => (c.id === chat.id ? plan.chat : c)) })
    void get().send(text, options)
  },

  async reindex(force = false) {
    const cwd = codeFolder(get())
    // The code index reads this computer's disk; a project on another machine has none.
    if (!cwd || cwd.startsWith('ssh://')) return
    set({ indexStatus: await window.api.codeIndex.build(cwd, force) })
  },

  createProject(name, folder = null) {
    const settings = get().settings
    const project: Project = {
      id: uid(),
      workspaceId: settings?.activeWorkspaceId ?? 'work',
      name,
      instructions: '',
      createdAt: Date.now(),
      folder
    }
    const projects = [...get().projects, project]
    set({ projects })
    void window.api.projects.save(projects)
    return project
  },

  updateProject(id, patch) {
    const projects = get().projects.map((p) => (p.id === id ? { ...p, ...patch } : p))
    set({ projects })
    void window.api.projects.save(projects)
  },

  deleteProject(id) {
    const projects = get().projects.filter((p) => p.id !== id)
    const orphaned = get().chats.some((c) => c.projectId === id)
    set({
      projects,
      ...(orphaned ? { chats: get().chats.map((c) => (c.projectId === id ? { ...c, projectId: null } : c)) } : {}),
      ...(get().pendingProjectId === id ? { pendingProjectId: null } : {})
    })
    void window.api.projects.save(projects)
    if (orphaned) persistChats()
  },

  projectForFolder(folder) {
    const workspaceId = get().settings?.activeWorkspaceId
    const found = get().projects.find((p) => p.workspaceId === workspaceId && p.folder === folder)
    return found ?? get().createProject(folder.split(/[\\/]/).filter(Boolean).pop() ?? folder, folder)
  },

  workIn(folder) {
    const projectId = folder ? get().projectForFolder(folder).id : null
    const chatId = get().activeChatId
    if (chatId) get().moveChat(chatId, projectId)
    else set({ pendingProjectId: projectId, ...(projectId ? { pendingTemporary: false } : {}) })
    set({ indexStatus: null })
    // A folder new to the agent has no index yet, and its search tools are
    // useless until it does — so start building it now.
    if (folder && get().settings?.codeIndex.autoIndex !== false) void get().reindex()
  },

  setWorkspace(id) {
    const kind = get().workspaces.find((w) => w.id === id)?.kind
    const tabs = shownTabs(get().settings?.general.tabs)
    const tab: AppTab = kind === 'workers' ? 'workers' : kind === 'code' ? 'ade' : activeTab('chat', get().settings?.chatSide, tabs)
    get().setTab(tab)
  },

  setTab(tab) {
    const state = get()
    const settings = state.settings
    const target = state.workspaces.find((w) => w.kind === TAB_KIND[tab]) ?? (TAB_KIND[tab] === 'chat' ? state.workspaces.find((w) => w.kind === 'work') : undefined)
    if (!settings || !target) return
    const split = splitsChats(shownTabs(settings.general.tabs))
    const leavingSide = chatSideOf(state)
    const side: ChatSide | null = split && TAB_KIND[tab] === 'chat' ? (tab as ChatSide) : null
    if (settings.activeWorkspaceId === target.id && leavingSide === side) return
    // Each tab keeps the chat that was open when it was left, so coming back
    // from the ADE lands there rather than on a fresh chat.
    const leaving = tabKey(settings.activeWorkspaceId, leavingSide)
    if (state.activeChatId) lastChatByWorkspace.set(leaving, state.activeChatId)
    else lastChatByWorkspace.delete(leaving)
    const back = lastChatByWorkspace.get(tabKey(target.id, side))
    const kept = back && state.chats.some((c) => c.id === back && c.workspaceId === target.id && !c.archived && (!side || sideOfChat(c) === side)) ? back : null
    // Shown at once, then saved: what the tab opens on below lands in the same frame.
    const patch = { activeWorkspaceId: target.id, ...(tab === 'chat' || tab === 'ide' ? { chatSide: tab } : {}) }
    set({ settings: { ...settings, ...patch } })
    void state.patchSettings(patch)
    // The IDE's start page is in a project: the one it was last in. Chat's is in none.
    set({ activeChatId: kept, ...(kept ? {} : side === 'ide' ? { pendingProjectId: state.pendingProjectId ?? ideProject(state), pendingTemporary: false } : side === 'chat' ? { pendingProjectId: null } : {}) })
  },

  selectModel(modelId, providerId) {
    const model = get()
      .availableModels()
      .find((m) => m.id === modelId && (!providerId || m.providerId === providerId))
    const chosenProvider = model?.providerId ?? providerId ?? null
    // The effort stays as chosen: each request clamps it to what the model
    // takes (shared/effort.ts), so switching to a model without Max and back
    // does not quietly lose the Max the user picked.
    void get().patchSettings({
      selectedModelId: modelId,
      selectedProviderId: chosenProvider,
      // A provider's model: Chat no longer runs on an engine, nor picks for itself.
      selectedEngine: null,
      adaptiveModel: false,
      ...(chosenProvider ? { recentModels: withRecent(get().settings?.recentModels, modelKey(chosenProvider, modelId)) } : {})
    })
  },

  toggleFavorite(modelId, providerId) {
    void get().patchSettings({ favoriteModels: toggleFavorite(get().settings?.favoriteModels, modelKey(providerId, modelId)) })
  },

  setEffort(effort) {
    void get().patchSettings({ effort })
  },

  async refreshProviders() {
    set({ providers: await window.api.providers.list() })
  },

  async downloadModel(repoId, filename) {
    const key = `${repoId}::${filename}`
    try {
      return await window.api.models.download(repoId, filename)
    } finally {
      // The main process's last progress event and this promise settling can
      // race; clearing here (rather than relying on a 'done' event) guarantees
      // the entry disappears from the Downloads panel exactly when the button
      // that started it stops waiting, whether it succeeded or failed.
      set((state) => {
        const next = { ...state.modelDownloads }
        delete next[key]
        return { modelDownloads: next }
      })
    }
  },

  async saveMcpServers(servers) {
    set({ mcpServers: servers })
    await window.api.mcp.save(servers)
  },

  availableModels() {
    const providers = get().providers
    // Cached on the providers array's identity. These derived selectors run on
    // every store change — including every batch of streamed tokens — and
    // returning a stable array also lets subscribers bail out on reference
    // equality instead of walking the list.
    if (modelsCache && modelsCache.providers === providers) return modelsCache.models
    const models = providers.filter(isProviderUsable).flatMap((p) => p.models)
    modelsCache = { providers, models }
    return models
  },

  modelSelection() {
    const { providers, settings } = get()
    // Cached like `availableModels`: settings change identity on every patch, providers on every refresh.
    if (selectionCache && selectionCache.providers === providers && selectionCache.settings === settings) return selectionCache.selection
    const selection = resolveSelection(
      { providerId: settings?.selectedProviderId ?? null, modelId: settings?.selectedModelId ?? null },
      providers,
      { favorites: settings?.favoriteModels, recents: settings?.recentModels }
    )
    selectionCache = { providers, settings, selection }
    return selection
  },

  currentModel() {
    return get().modelSelection().model
  },

  activeChat() {
    const { chats, activeChatId } = get()
    return chats.find((c) => c.id === activeChatId) ?? null
  },

  visibleChats() {
    const { chats, settings } = get()
    const workspaceId = settings?.activeWorkspaceId
    if (chatsCache && chatsCache.chats === chats && chatsCache.workspaceId === workspaceId) return chatsCache.visible
    const visible = chats
      .filter((c) => !c.archived && !c.temporary && c.workspaceId === workspaceId)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
    chatsCache = { chats, workspaceId, visible }
    return visible
  },

  chatList() {
    const visible = get().visibleChats()
    if (listCache && listCache.visible === visible) return listCache.items
    // `visibleChats()` changes identity on every batch of streamed tokens,
    // since the streaming chat is a new object each time. The sidebar only
    // shows a title, a pin and an error mark, so an item is rebuilt only for a
    // chat object it has not seen, reused if nothing it shows changed, and the
    // previous array is returned when every item is the same — the sidebar
    // then does not re-render at all while a reply streams.
    const previous = listCache?.items ?? []
    const items = visible.map((chat, index) => {
      const cached = listItems.get(chat)
      if (cached) return cached
      const failed = lastTurnFailed(chat.messages)
      const before = previous[index]
      const item =
        before && before.id === chat.id && before.title === chat.title && before.pinned === chat.pinned && before.failed === failed && before.unread === Boolean(chat.unread)
          ? before
          : { id: chat.id, title: chat.title, pinned: chat.pinned, failed, unread: Boolean(chat.unread) }
      listItems.set(chat, item)
      return item
    })
    const unchanged = items.length === previous.length && items.every((item, index) => item === previous[index])
    listCache = { visible, items: unchanged ? previous : items }
    return listCache.items
  },

  visibleProjects() {
    const { projects, settings } = get()
    return projects.filter((p) => p.workspaceId === settings?.activeWorkspaceId)
  }
}))

/**
 * Which of Chat and the IDE is in front, or null when another tab is, or
 * when only one of them is a tab and so has every chat (shared/tabs.ts).
 */
export function chatSideOf(s: Pick<AppState, 'settings' | 'workspaces'>): ChatSide | null {
  const settings = s.settings
  if (!settings || !splitsChats(shownTabs(settings.general.tabs))) return null
  if (!isAgentKind(s.workspaces.find((w) => w.id === settings.activeWorkspaceId)?.kind)) return null
  return settings.chatSide === 'ide' ? 'ide' : 'chat'
}

/** Brings Chat or the IDE to the front at once, then saves it: a chat opened in its tab shows there in the same frame. */
function showSide(side: ChatSide): void {
  const app = useApp.getState()
  if (!app.settings) return
  useApp.setState({ settings: { ...app.settings, chatSide: side } })
  void app.patchSettings({ chatSide: side })
}

/** The project the IDE's start page is in: the one it was in last, else the one most recently worked in, else the newest. */
function ideProject(s: Pick<AppState, 'projects' | 'chats' | 'workspaces'>): string | null {
  const workspace = agentWorkspace(s.workspaces)?.id
  const projects = s.projects.filter((p) => p.workspaceId === workspace && p.folder)
  if (lastIdeProject && projects.some((p) => p.id === lastIdeProject)) return lastIdeProject
  const ids = new Set(projects.map((p) => p.id))
  let best: string | null = null
  let at = -Infinity
  for (const chat of s.chats) {
    if (chat.projectId && !chat.archived && ids.has(chat.projectId) && chat.updatedAt > at) {
      best = chat.projectId
      at = chat.updatedAt
    }
  }
  return best ?? [...projects].sort((a, b) => b.createdAt - a.createdAt)[0]?.id ?? null
}

// The IDE comes back to the project it was in.
useApp.subscribe((state, prev) => {
  if (state.activeChatId === prev.activeChatId && state.pendingProjectId === prev.pendingProjectId) return
  const id = state.activeChatId ? state.chats.find((c) => c.id === state.activeChatId)?.projectId : state.pendingProjectId
  if (id) lastIdeProject = id
})

/**
 * At launch and whenever the tabs change: the window moves off a tab that
 * isn't shown any more, and Chat or the IDE in front holds what it should,
 * the open chat moving to its own tab and the IDE's start page in a project.
 */
export function settleTabs(): void {
  const app = useApp.getState()
  if (!app.settings) return
  const tabs = shownTabs(app.settings.general.tabs)
  const kind = app.workspaces.find((w) => w.id === app.settings?.activeWorkspaceId)?.kind
  if (!tabs.includes(activeTab(kind === 'work' ? 'chat' : kind, app.settings.chatSide, tabs))) return app.setTab(tabs[0])
  const side = chatSideOf(app)
  if (!side) return
  const chat = app.activeChat()
  if (chat) {
    if (sideOfChat(chat) !== side) showSide(sideOfChat(chat))
  } else if (side === 'ide') {
    useApp.setState({ pendingProjectId: app.pendingProjectId ?? ideProject(app), pendingTemporary: false })
  } else if (app.pendingProjectId) {
    useApp.setState({ pendingProjectId: null })
  }
}

/** The top bar's tabs as set, which one is in front, and whether Chat and the IDE split the chats between them. */
export function useTabs(): { tabs: AppTab[]; active: AppTab; split: boolean } {
  const { setting, kind, side } = useApp(
    useShallow((s) => ({
      setting: s.settings?.general.tabs,
      kind: s.workspaces.find((w) => w.id === s.settings?.activeWorkspaceId)?.kind,
      side: s.settings?.chatSide
    }))
  )
  const tabs = useMemo(() => shownTabs(setting), [setting])
  return { tabs, active: activeTab(kind === 'work' ? 'chat' : kind, side, tabs), split: splitsChats(tabs) }
}

/** Chat or the IDE, when they split the chats and one of them is in front; null shows every chat. */
export const useChatSide = (): ChatSide | null => useApp((s) => chatSideOf(s))

/**
 * Opens a chat in whichever tab it belongs to (added for scheduled tasks). The
 * sidebar only lists the active workspace's chats, and a scheduled run's chat
 * can be a Chat or a Work chat whatever tab is showing — a notification click
 * or a run-history row has to land on it either way.
 */
export function revealChat(chatId: string): void {
  const state = useApp.getState()
  const chat = state.chats.find((c) => c.id === chatId)
  if (!chat) return
  const active = state.settings?.activeWorkspaceId
  // Its tab at once (openChat then puts it in Chat or the IDE, whichever holds it).
  if (active && chat.workspaceId !== active && state.workspaces.some((w) => w.id === chat.workspaceId)) state.setWorkspace(chat.workspaceId)
  useApp.getState().openChat(chatId)
}

/**
 * A temporary chat lasts while it is the open chat. Once the window moves on
 * (another chat, the start page, another tab), it is dropped, and its reply
 * stopped if one is still being written. It was never sent to main, so there
 * is nothing else to remove.
 */
useApp.subscribe((state, prev) => {
  if (state.activeChatId === prev.activeChatId || !prev.activeChatId) return
  const left = state.chats.find((c) => c.id === prev.activeChatId)
  if (left?.temporary) state.deleteChat(left.id)
})

/** A coding chat's checkpoints (refs in its project's repository) go with it when it is deleted. */
function dropCheckpointsOf(chat: Chat | undefined, projects: Project[]): void {
  const folder = chat?.projectId ? projects.find((p) => p.id === chat.projectId)?.folder : null
  const replies = chat?.messages.filter((m) => m.role === 'assistant').map((m) => m.id) ?? []
  if (folder && replies.length) void window.api.chatCode.dropCheckpoints(folder, replies).catch(() => {})
}

function appendPart(message: ChatMessage, type: 'text' | 'reasoning', text: string): ChatMessage {
  const parts = [...message.parts]
  const last = parts[parts.length - 1]
  // Only coalesce into a text part of the same kind — a tool call sitting at the
  // end must stay its own part, and separates the text either side of it.
  if (last && last.type !== 'tool' && last.type === type) {
    parts[parts.length - 1] = { ...last, text: last.text + text }
  } else {
    parts.push({ type, text })
  }
  return { ...message, parts }
}

export function messageText(message: ChatMessage, type: 'text' | 'reasoning' = 'text'): string {
  const parts = message.parts
  // Streaming coalesces consecutive same-type parts, so a message usually holds
  // a single part — return it directly rather than allocating two arrays and a
  // join for every call on a growing reply.
  if (parts.length === 1) return parts[0].type === type ? parts[0].text : ''
  let out = ''
  for (const part of parts) if (part.type !== 'tool' && part.type === type) out += part.text
  return out
}
