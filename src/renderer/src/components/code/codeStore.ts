import { create } from 'zustand'
import type {
  EaonCodeStatus,
  EaonCommand,
  EaonEvent,
  EaonModel,
  EaonProcessInfo,
  EaonResult,
  EaonSessionInfo,
  EaonSessionState,
  EaonSessionStats,
  EaonSlashCommand,
  EaonSnapshot,
  EaonThinkingLevel,
  EaonUiResponse
} from '@shared/eaonCode'
import { useApp } from '../../state/store'
import { applyEvents, emptyTranscript, transcriptFromMessages, type Item, type Transcript } from './transcript'

/**
 * The Code tab's state. Its own store rather than a slice of `state/store.ts`:
 * the tab talks to a different backend (an Eaon Code process, not the app's
 * provider layer) and none of this is shared with Chat or Work.
 */

/** Client-side commands, handled here rather than sent to Eaon Code, which only runs extension/prompt/skill commands over RPC. */
export const BUILTIN_COMMANDS: EaonSlashCommand[] = [
  { name: 'new', description: 'Start a new session in this folder', source: 'builtin' },
  { name: 'compact', description: 'Summarise older context to free up the window', source: 'builtin' },
  { name: 'name', description: 'Name this session', source: 'builtin' }
]

interface CodeState {
  initialised: boolean
  status: EaonCodeStatus | null
  checking: boolean
  cwd: string | null
  recents: string[]
  sessions: EaonSessionInfo[]
  process: EaonProcessInfo
  starting: boolean
  /** Why the last start failed, shown in place of the transcript. */
  startError: string | null
  session: EaonSessionState | null
  models: EaonModel[]
  thinkingLevels: EaonThinkingLevel[]
  commands: EaonSlashCommand[]
  stats: EaonSessionStats | null
  transcript: Transcript
  /** A prompt was sent and nothing has come back yet. */
  awaiting: boolean
  /** Modes the user wants; re-sent to every process started this run. */
  modes: { plan: boolean; swarm: boolean }
  /** Text to drop into the composer (a cleared queue, an extension's set_editor_text), consumed once. */
  draft: { text: string; nonce: number } | null
  /** A transient error that has no better home. */
  toast: string | null

  init: () => Promise<void>
  refreshStatus: (refresh?: boolean) => Promise<EaonCodeStatus>
  chooseFolder: () => Promise<void>
  openFolder: (cwd: string) => Promise<void>
  forgetFolder: (cwd: string) => Promise<void>
  start: (sessionPath?: string) => Promise<boolean>
  newSession: () => Promise<void>
  resume: (sessionPath: string) => Promise<void>
  send: (text: string, behavior?: 'steer' | 'followUp') => Promise<void>
  abort: () => Promise<void>
  clearQueue: () => Promise<void>
  setModel: (model: EaonModel) => Promise<void>
  setThinkingLevel: (level: EaonThinkingLevel) => Promise<void>
  setMode: (mode: 'plan' | 'swarm', enabled: boolean) => Promise<void>
  compact: (instructions?: string) => Promise<void>
  rename: (name: string) => Promise<void>
  runBash: (command: string, excludeFromContext: boolean) => Promise<void>
  respondDialog: (id: string, response: EaonUiResponse) => void
  refreshSessions: () => Promise<void>
  refreshStats: () => Promise<void>
  takeDraft: () => string | null
  dismissToast: () => void
}

const api = (): typeof window.api.eaonCode => window.api.eaonCode

async function call<T>(command: EaonCommand): Promise<T> {
  const result = (await api().command<T>(command)) as EaonResult<T>
  if (!result.ok) throw new Error(result.error)
  return result.data
}

let listenersBound = false
let draftNonce = 0

/** A notice the app adds itself (a failed command), in the transcript where it happened. */
function withNotice(t: Transcript, tone: 'info' | 'warning' | 'error', text: string, detail?: string): Transcript {
  const seq = t.seq + 1
  const item: Item = { kind: 'notice', id: `n${seq}`, tone, icon: tone === 'error' ? 'stop' : 'info', text, ...(detail ? { detail } : {}) }
  return { ...t, seq, items: [...t.items, item] }
}

export const useCode = create<CodeState>((set, get) => {
  const applySnapshot = (snapshot: EaonSnapshot, transcript: Transcript): void => {
    set({
      session: snapshot.state,
      models: snapshot.models,
      thinkingLevels: snapshot.thinkingLevels,
      commands: snapshot.commands,
      stats: snapshot.stats,
      transcript,
      awaiting: false,
      startError: null
    })
  }

  /** Session state, stats and the session list, after anything that could change them. */
  const refreshAfterTurn = async (): Promise<void> => {
    try {
      const [state, stats] = await Promise.all([
        call<EaonSessionState>({ type: 'get_state' }),
        call<EaonSessionStats>({ type: 'get_session_stats' })
      ])
      set({ session: state, stats })
    } catch {
      /* the process may have gone; onProcess reports that */
    }
    void get().refreshSessions()
  }

  const onEvents = (events: EaonEvent[]): void => {
    const state = get()
    let session = state.session
    let settled = false
    for (const event of events) {
      if (event.type === 'thinking_level_changed' && session) session = { ...session, thinkingLevel: event.level as EaonThinkingLevel }
      if (event.type === 'session_info_changed' && session) session = { ...session, sessionName: (event.name as string) || undefined }
      if (event.type === 'agent_settled' || event.type === 'compaction_end') settled = true
    }
    const transcript = applyEvents(state.transcript, events)
    const replied = events.some((e) => e.type === 'agent_start' || e.type === 'message_start' || e.type === 'agent_settled')
    set({
      transcript,
      session,
      awaiting: state.awaiting && !replied,
      ...(transcript.editorText !== null ? { draft: { text: transcript.editorText, nonce: ++draftNonce } } : {})
    })
    if (transcript.editorText !== null) set({ transcript: { ...get().transcript, editorText: null } })
    if (settled) void refreshAfterTurn()
  }

  return {
    initialised: false,
    status: null,
    checking: false,
    cwd: null,
    recents: [],
    sessions: [],
    process: { state: 'idle', cwd: null, stderr: '' },
    starting: false,
    startError: null,
    session: null,
    models: [],
    thinkingLevels: [],
    commands: [],
    stats: null,
    transcript: emptyTranscript(),
    awaiting: false,
    modes: { plan: false, swarm: false },
    draft: null,
    toast: null,

    async init() {
      if (get().initialised) return
      set({ initialised: true })
      if (!listenersBound) {
        listenersBound = true
        api().onEvents(onEvents)
        api().onProcess((info) => set({ process: info }))
      }
      const [status, recents, info] = await Promise.all([api().status(), api().recents(), api().process()])
      const cwd = useApp.getState().settings?.eaonCode.lastCwd ?? recents[0] ?? null
      set({ status, recents, process: info, cwd })
      if (status.state !== 'ready' || !cwd) return
      void get().refreshSessions()
      // A renderer reload finds the process still running: rebuild from it
      // rather than killing the session the user was in.
      if (info.state === 'running' && info.cwd === cwd) {
        try {
          const [state, models, levels, commands, stats, messages] = await Promise.all([
            call<EaonSessionState>({ type: 'get_state' }),
            call<{ models: EaonModel[] }>({ type: 'get_available_models' }).then((d) => d.models),
            call<{ levels: EaonThinkingLevel[] }>({ type: 'get_available_thinking_levels' }).then((d) => d.levels),
            call<{ commands: EaonSlashCommand[] }>({ type: 'get_commands' }).then((d) => d.commands),
            call<EaonSessionStats>({ type: 'get_session_stats' }),
            call<{ messages: unknown[] }>({ type: 'get_messages' }).then((d) => d.messages)
          ])
          applySnapshot({ state, models, thinkingLevels: levels, commands, stats, messages }, transcriptFromMessages(messages))
          set({ modes: { plan: state.planMode === true, swarm: state.swarmMode === true } })
          return
        } catch {
          /* fall through to a fresh start */
        }
      }
      await get().start()
    },

    async refreshStatus(refresh = true) {
      set({ checking: true })
      try {
        const status = await api().status(refresh)
        set({ status })
        return status
      } finally {
        set({ checking: false })
      }
    },

    async chooseFolder() {
      const picked = await api().pickFolder()
      if (picked) await get().openFolder(picked)
    },

    async openFolder(cwd) {
      set({ cwd, sessions: [], transcript: emptyTranscript(), session: null, stats: null, startError: null })
      void get().refreshSessions()
      await get().start()
    },

    async forgetFolder(cwd) {
      set({ recents: await api().forgetRecent(cwd) })
    },

    async start(sessionPath) {
      const { cwd, modes, status } = get()
      if (!cwd || status?.state !== 'ready') return false
      set({ starting: true, startError: null, awaiting: false })
      try {
        const result = await api().start(cwd, { sessionPath, planMode: modes.plan, swarmMode: modes.swarm })
        // A folder switch while this was starting makes it stale.
        if (get().cwd !== cwd) return false
        if (!result.ok) {
          if (!/Superseded/.test(result.error)) set({ startError: result.error })
          return false
        }
        applySnapshot(result.data, sessionPath ? transcriptFromMessages(result.data.messages) : emptyTranscript())
        // The main process records the folder as recent on every successful start.
        void api()
          .recents()
          .then((recents) => set({ recents }))
        return true
      } finally {
        if (get().cwd === cwd) set({ starting: false })
      }
    },

    async newSession() {
      const { process, cwd } = get()
      if (!cwd) return
      if (process.state !== 'running' || process.cwd !== cwd) {
        await get().start()
        return
      }
      try {
        const result = await call<{ cancelled: boolean }>({ type: 'new_session' })
        if (result.cancelled) {
          set({ toast: 'An extension cancelled the new session.' })
          return
        }
        set({ transcript: emptyTranscript(), awaiting: false })
        await refreshAfterTurn()
      } catch (error) {
        set({ toast: (error as Error).message })
      }
    },

    async resume(sessionPath) {
      const { process, cwd, session } = get()
      if (!cwd || session?.sessionFile === sessionPath) return
      if (process.state !== 'running' || process.cwd !== cwd) {
        await get().start(sessionPath)
        return
      }
      try {
        const result = await call<{ cancelled: boolean }>({ type: 'switch_session', sessionPath })
        if (result.cancelled) {
          set({ toast: 'An extension cancelled switching sessions.' })
          return
        }
        const [state, messages, stats, levels] = await Promise.all([
          call<EaonSessionState>({ type: 'get_state' }),
          call<{ messages: unknown[] }>({ type: 'get_messages' }).then((d) => d.messages),
          call<EaonSessionStats>({ type: 'get_session_stats' }),
          call<{ levels: EaonThinkingLevel[] }>({ type: 'get_available_thinking_levels' }).then((d) => d.levels)
        ])
        set({ session: state, stats, thinkingLevels: levels, transcript: transcriptFromMessages(messages), awaiting: false })
      } catch (error) {
        set({ toast: (error as Error).message })
      }
    },

    async send(raw, behavior) {
      const text = raw.trim()
      if (!text) return
      const state = get()

      if (text.startsWith('!')) {
        const exclude = text.startsWith('!!')
        await get().runBash(text.slice(exclude ? 2 : 1).trim(), exclude)
        return
      }
      const builtin = /^\/(new|compact|name)(?:\s+([\s\S]*))?$/.exec(text)
      if (builtin) {
        const [, name, rest] = builtin
        if (name === 'new') await get().newSession()
        else if (name === 'compact') await get().compact(rest?.trim() || undefined)
        else if (rest?.trim()) await get().rename(rest.trim())
        else set({ toast: 'Usage: /name <session name>' })
        return
      }

      if (state.process.state !== 'running' || state.process.cwd !== state.cwd) {
        if (!(await get().start())) return
      }
      const running = get().transcript.running
      try {
        if (running && behavior === 'followUp') await call({ type: 'follow_up', message: text })
        else if (running) await call({ type: 'steer', message: text })
        else {
          set({ awaiting: true })
          await call({ type: 'prompt', message: text })
        }
      } catch (error) {
        set({ awaiting: false, transcript: withNotice(get().transcript, 'error', (error as Error).message) })
      }
    },

    async abort() {
      // Eaon Code's documented Esc behaviour: take the queue back first, so
      // abort does not go on to run it, and put its text back in the editor.
      try {
        const queued = await call<{ steering: string[]; followUp: string[] }>({ type: 'clear_queue' })
        const restored = [...queued.steering, ...queued.followUp].join('\n\n')
        if (restored) set({ draft: { text: restored, nonce: ++draftNonce } })
      } catch {
        /* older builds without clear_queue still abort */
      }
      try {
        await call({ type: 'abort' })
      } catch (error) {
        set({ toast: (error as Error).message })
      }
      set({ awaiting: false })
    },

    async clearQueue() {
      try {
        const queued = await call<{ steering: string[]; followUp: string[] }>({ type: 'clear_queue' })
        const restored = [...queued.steering, ...queued.followUp].join('\n\n')
        if (restored) set({ draft: { text: restored, nonce: ++draftNonce } })
      } catch (error) {
        set({ toast: (error as Error).message })
      }
    },

    async setModel(model) {
      try {
        await call({ type: 'set_model', provider: model.provider, modelId: model.id })
        const [state, levels] = await Promise.all([
          call<EaonSessionState>({ type: 'get_state' }),
          call<{ levels: EaonThinkingLevel[] }>({ type: 'get_available_thinking_levels' }).then((d) => d.levels)
        ])
        set({ session: state, thinkingLevels: levels })
        void get().refreshStats()
      } catch (error) {
        set({ toast: (error as Error).message })
      }
    },

    async setThinkingLevel(level) {
      try {
        await call({ type: 'set_thinking_level', level })
        const session = get().session
        if (session) set({ session: { ...session, thinkingLevel: level } })
      } catch (error) {
        set({ toast: (error as Error).message })
      }
    },

    async setMode(mode, enabled) {
      const session = get().session
      const supported = typeof (mode === 'plan' ? session?.planMode : session?.swarmMode) === 'boolean'
      if (!supported) return
      try {
        const result = await call<{ enabled: boolean }>({ type: mode === 'plan' ? 'set_plan_mode' : 'set_swarm_mode', enabled })
        const current = get().session
        set({
          modes: { ...get().modes, [mode]: result.enabled },
          ...(current ? { session: { ...current, [mode === 'plan' ? 'planMode' : 'swarmMode']: result.enabled } } : {})
        })
      } catch (error) {
        set({ toast: (error as Error).message })
      }
    },

    async compact(instructions) {
      try {
        await call({ type: 'compact', ...(instructions ? { customInstructions: instructions } : {}) })
        await get().refreshStats()
      } catch (error) {
        set({ transcript: withNotice(get().transcript, 'error', `Could not compact: ${(error as Error).message}`) })
      }
    },

    async rename(name) {
      try {
        await call({ type: 'set_session_name', name })
        const session = get().session
        if (session) set({ session: { ...session, sessionName: name } })
        void get().refreshSessions()
      } catch (error) {
        set({ toast: (error as Error).message })
      }
    },

    async runBash(command, excludeFromContext) {
      if (!command) return
      const state = get()
      if (state.process.state !== 'running' || state.process.cwd !== state.cwd) {
        if (!(await get().start())) return
      }
      const id = `bash-${Date.now().toString(36)}`
      const t = get().transcript
      set({
        transcript: {
          ...t,
          items: [...t.items, { kind: 'bash', id, command, output: '', running: true, excluded: excludeFromContext }]
        }
      })
      const finish = (fields: Partial<Extract<Item, { kind: 'bash' }>>): void => {
        const current = get().transcript
        set({
          transcript: {
            ...current,
            items: current.items.map((item) => (item.id === id && item.kind === 'bash' ? { ...item, running: false, ...fields } : item))
          }
        })
      }
      try {
        const result = await call<{ output: string; exitCode?: number; cancelled: boolean; truncated: boolean }>({
          type: 'bash',
          command,
          excludeFromContext,
          id
        })
        finish({ output: result.output, exitCode: result.exitCode ?? null, cancelled: result.cancelled, truncated: result.truncated })
      } catch (error) {
        finish({ output: (error as Error).message, exitCode: null })
      }
    },

    respondDialog(id, response) {
      void api().respondUi(id, response)
      const t = get().transcript
      set({ transcript: { ...t, dialogs: t.dialogs.filter((dialog) => dialog.id !== id) } })
    },

    async refreshSessions() {
      const cwd = get().cwd
      if (!cwd) return
      const result = await api().sessions(cwd)
      if (result.ok && get().cwd === cwd) set({ sessions: result.data })
    },

    async refreshStats() {
      try {
        set({ stats: await call<EaonSessionStats>({ type: 'get_session_stats' }) })
      } catch {
        /* not running */
      }
    },

    takeDraft() {
      const draft = get().draft
      if (!draft) return null
      set({ draft: null })
      return draft.text
    },

    dismissToast() {
      set({ toast: null })
    }
  }
})
