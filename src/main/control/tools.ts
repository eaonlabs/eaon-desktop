import { statSync } from 'node:fs'
import os from 'node:os'
import { app } from 'electron'
import { CONTROL_TARGETS, type ControlAction, type ControlRisk, type ControlTarget, type ControlToolInfo } from '@shared/control'
import { TERMINAL_AGENT_IDS, type TerminalAgentId, type TerminalLayout } from '@shared/terminals'
import { fitFor, formatContext, formatModelSize, pickVariant, type LibraryModel } from '@shared/modelLibrary'
import type { ChatMessage, ModelDownloadProgress } from '@shared/types'
import { RecentFolders } from '../features/eaonCode/recents'
import { workersService } from '../features/workers'
import { findLocalModel, isEmbeddingModel, localModels, runtimeModel } from '../llama/models'
import { llamaRuntime } from '../llama/runtime'
import { LIBRARY, libraryState, pullLibraryVariant, removeInstalledModel } from '../modelLibrary'
import { findLibraryModel } from '../modelLibrary/catalog'
import { listProviders } from '../providers'
import { store } from '../store'

/**
 * The tools behind Eaon's control API (`/control`). Each is a name, a plain
 * description a small model can act on, a JSON Schema for its arguments and
 * the function that does it. They wrap what the app already does — the model
 * library, the llama runtime, the workers engine, the ADE — and never hand
 * out a key, a token or a card: provider keys stay in the vault, and the
 * only settings that can be read or changed are the ones listed in SETTINGS.
 */

/** What the window does for the tools; the feature fills it in, a test fakes it. */
export interface ControlHost {
  /** Carries out an action in the window. Rejects when there is no window. */
  act: (action: ControlAction) => void
  /** Sends a message to every window (download progress, for the Downloads panel). */
  send: (channel: string, payload: unknown) => void
  /** Where the ADE's grid of terminals is kept; read to say what is open. */
  readLayout?: () => TerminalLayout
}

export interface ControlTool extends ControlToolInfo {
  run: (args: Record<string, unknown>) => unknown | Promise<unknown>
}

type Schema = Record<string, unknown>
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})
const string = (description: string, extra: Schema = {}): Schema => ({ type: 'string', description, ...extra })
const number = (description: string, extra: Schema = {}): Schema => ({ type: 'number', description, ...extra })

function text(args: Record<string, unknown>, key: string, required = true): string {
  const value = args[key]
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (required) throw new Error(`\`${key}\` is required.`)
  return ''
}

const gb = (bytes: number): string => formatModelSize(bytes)

/** The settings a tool may read or change, with what each accepts. Nothing here is a secret. */
const SETTINGS: Record<string, { read: (s: ReturnType<typeof store.getSettings>) => unknown; check?: (value: unknown) => string | null; patch?: (value: unknown) => Record<string, unknown> }> = {
  'appearance.mode': {
    read: (s) => s.appearance.mode,
    check: (v) => (['system', 'light', 'dark'].includes(v as string) ? null : 'must be "system", "light" or "dark"'),
    patch: (v) => ({ appearance: { mode: v } })
  },
  'appearance.fontSize': {
    read: (s) => s.appearance.fontSize,
    check: (v) => (typeof v === 'number' && v >= 10 && v <= 24 ? null : 'must be a number from 10 to 24'),
    patch: (v) => ({ appearance: { fontSize: v } })
  },
  'appearance.reduceMotion': {
    read: (s) => s.appearance.reduceMotion,
    check: (v) => (['system', 'on', 'off'].includes(v as string) ? null : 'must be "system", "on" or "off"'),
    patch: (v) => ({ appearance: { reduceMotion: v } })
  },
  'general.suggestedPrompts': {
    read: (s) => s.general.suggestedPrompts,
    check: (v) => (typeof v === 'boolean' ? null : 'must be true or false'),
    patch: (v) => ({ general: { suggestedPrompts: v } })
  },
  'general.showInMenuBar': {
    read: (s) => s.general.showInMenuBar,
    check: (v) => (typeof v === 'boolean' ? null : 'must be true or false'),
    patch: (v) => ({ general: { showInMenuBar: v } })
  },
  'general.preventSleep': {
    read: (s) => s.general.preventSleep,
    check: (v) => (typeof v === 'boolean' ? null : 'must be true or false'),
    patch: (v) => ({ general: { preventSleep: v } })
  },
  'localServer.port': { read: (s) => s.localServer.port }
}

function messageText(message: ChatMessage): string {
  return message.parts
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}…` : value)

function describeModel(model: LibraryModel, ramBytes: number, installedIds: Set<string>): Record<string, unknown> {
  const pick = pickVariant(model, ramBytes)
  return {
    id: model.id,
    name: model.name,
    by: model.org,
    params: model.params,
    capabilities: model.capabilities,
    context: formatContext(model.contextLength),
    license: model.license.name,
    // What Eaon would download on this computer, and how well it fits.
    recommended: { variant: pick.variant.id, quant: pick.variant.quant, size: gb(pick.variant.sizeBytes), fit: pick.fit },
    variants: model.variants.map((v) => ({ id: v.id, quant: v.quant, size: gb(v.sizeBytes), fit: fitFor(v.sizeBytes, ramBytes), downloaded: installedIds.has(`${model.id}:${v.id}`) })),
    ...(model.unsupported ? { unsupported: model.unsupported } : {})
  }
}

interface Download {
  model: string
  variant: string
  state: 'downloading' | 'done' | 'failed'
  receivedBytes: number
  totalBytes: number
  error?: string
  modelId?: string
}

export function createControlTools(host: ControlHost): ControlTool[] {
  const downloads = new Map<string, Download>()
  let loadError: string | null = null
  let loading: string | null = null

  const act = (action: ControlAction): void => host.act(action)

  const tools: ControlTool[] = [
    {
      name: 'status',
      description: 'Eaon desktop app overview: version, this computer, the model loaded in memory, how many models are downloaded, and downloads in progress.',
      risk: 'read',
      input: object({}),
      run: async () => {
        const runtime = await llamaRuntime.status()
        return {
          app: 'Eaon',
          version: app.getVersion(),
          computer: { platform: process.platform, arch: process.arch, memory: gb(os.totalmem()) },
          loaded: runtime.chat ? { model: runtime.chat.modelId, state: runtime.chat.state } : null,
          downloaded: localModels().filter((m) => !isEmbeddingModel(m)).length,
          downloading: [...downloads.values()].filter((d) => d.state === 'downloading').length
        }
      }
    },
    {
      name: 'models_downloaded',
      description: 'Open-source models downloaded in Eaon, which Eaon CLI can use. Each id is what you pass to model_load or model_delete.',
      risk: 'read',
      input: object({}),
      run: async () => {
        const runtime = await llamaRuntime.status()
        return (await libraryState()).installed
          .filter((m) => !m.embedding)
          .map((m) => ({ id: m.id, name: m.label, size: gb(m.sizeBytes), vision: m.vision, loaded: runtime.chat?.modelId === m.id }))
      }
    },
    {
      name: 'models_library',
      description:
        "Open-source models Eaon can download, with the variant that fits this computer's memory. Filter by words in the name or by a capability (tools, vision, reasoning, coding). Download one with model_download.",
      risk: 'read',
      input: object({
        query: string('Words to look for in the model name, maker or family.'),
        capability: string('Only models with this capability.', { enum: ['tools', 'vision', 'reasoning', 'coding'] }),
        limit: number('How many to list (default 12).', { minimum: 1, maximum: 40 })
      }),
      run: async (args) => {
        const query = text(args, 'query', false).toLowerCase()
        const capability = text(args, 'capability', false)
        const limit = typeof args.limit === 'number' ? Math.min(40, Math.max(1, Math.floor(args.limit))) : 12
        const ram = os.totalmem()
        const installed = new Set((await libraryState()).installed.flatMap((m) => (m.library ? [`${m.library.modelId}:${m.library.variantId}`] : [])))
        const hits = LIBRARY.filter((m) => !m.capabilities.includes('embedding'))
          .filter((m) => !query || `${m.name} ${m.org} ${m.family} ${m.id}`.toLowerCase().includes(query))
          .filter((m) => !capability || (m.capabilities as string[]).includes(capability))
        return { total: hits.length, models: hits.slice(0, limit).map((m) => describeModel(m, ram, installed)) }
      }
    },
    {
      name: 'model_download',
      description:
        'Start downloading a library model (id from models_library). It runs in the background, since models are gigabytes; check downloads for progress. Leave `variant` out to get the one that fits this computer.',
      risk: 'write',
      input: object({ model: string('Library model id, such as "minicpm5-2b".'), variant: string('Variant id, such as "q4_k_m".') }, ['model']),
      run: async (args) => {
        const id = text(args, 'model')
        const model = findLibraryModel(id)
        if (!model) throw new Error(`No library model "${id}". Use models_library to see the ids.`)
        if (model.unsupported) throw new Error(`${model.name} can't run yet: ${model.unsupported}`)
        const variantId = text(args, 'variant', false) || pickVariant(model, os.totalmem()).variant.id
        const variant = model.variants.find((v) => v.id === variantId)
        if (!variant) throw new Error(`${model.name} has no variant "${variantId}". It has: ${model.variants.map((v) => v.id).join(', ')}.`)
        const key = `${model.id}:${variant.id}`
        if (downloads.get(key)?.state === 'downloading') return { started: false, note: 'Already downloading.', ...downloads.get(key) }
        const entry: Download = { model: model.id, variant: variant.id, state: 'downloading', receivedBytes: 0, totalBytes: variant.sizeBytes }
        downloads.set(key, entry)
        void pullLibraryVariant(model.id, variant.id, (channel, progress: ModelDownloadProgress) => {
          entry.receivedBytes = progress.receivedBytes
          entry.totalBytes = progress.totalBytes
          host.send(channel, progress)
        })
          .then(({ id: modelId }) => {
            entry.state = 'done'
            entry.modelId = modelId
          })
          .catch((error) => {
            entry.state = 'failed'
            entry.error = error instanceof Error ? error.message : String(error)
          })
        return { started: true, model: model.name, variant: variant.quant, size: gb(variant.sizeBytes), note: 'Check downloads for progress.' }
      }
    },
    {
      name: 'downloads',
      description: 'Progress of model downloads started with model_download, and how each ended. A finished one gives the id to use with Eaon CLI.',
      risk: 'read',
      input: object({}),
      run: () =>
        [...downloads.values()].map((d) => ({
          model: d.model,
          variant: d.variant,
          state: d.state,
          progress: d.totalBytes ? `${Math.round((d.receivedBytes / d.totalBytes) * 100)}%` : '0%',
          ...(d.modelId ? { id: d.modelId } : {}),
          ...(d.error ? { error: d.error } : {})
        }))
    },
    {
      name: 'runtime',
      description:
        "Eaon's local model runtime: which llama.cpp build it runs and which model is in memory. Only one chat model is in memory at a time; the next request for another swaps it.",
      risk: 'read',
      input: object({}),
      run: async () => {
        const status = await llamaRuntime.status()
        return {
          available: status.binary !== null,
          version: status.version,
          loaded: status.chat,
          ...(loading ? { loading } : {}),
          ...(loadError ? { lastLoadError: loadError } : {})
        }
      }
    },
    {
      name: 'model_load',
      description:
        'Load a downloaded model into memory ahead of use, so the first reply is not slow. This replaces the model currently in memory, including the one Eaon CLI is talking to. Returns at once; check runtime.',
      risk: 'write',
      input: object({ id: string('Downloaded model id from models_downloaded.') }, ['id']),
      run: (args) => {
        const id = text(args, 'id')
        const model = findLocalModel(id)
        if (!model) throw new Error(`${id} isn't downloaded. Use models_downloaded to see what is.`)
        loading = id
        loadError = null
        void llamaRuntime
          .ensure(runtimeModel(model))
          .catch((error) => (loadError = error instanceof Error ? error.message : String(error)))
          .finally(() => (loading = null))
        return { started: true, id, note: 'Check runtime.' }
      }
    },
    {
      name: 'model_unload',
      description: 'Free the memory the loaded model holds. It loads again by itself the next time something asks for it.',
      risk: 'write',
      input: object({}),
      run: () => {
        llamaRuntime.unload()
        return { unloaded: true }
      }
    },
    {
      name: 'model_delete',
      description: "Delete a downloaded model's files from this computer. It has to be downloaded again to use it.",
      risk: 'danger',
      input: object({ id: string('Downloaded model id from models_downloaded.') }, ['id']),
      run: async (args) => {
        const id = text(args, 'id')
        await removeInstalledModel(id)
        return { deleted: id }
      }
    },
    {
      name: 'providers',
      description: 'Model providers set up in Eaon (cloud and local): whether each is on, has a key, and how many models it offers. Keys are never shown.',
      risk: 'read',
      input: object({}),
      run: () =>
        listProviders().map((p) => ({ id: p.id, name: p.name, enabled: p.enabled, hasKey: p.hasKey, local: p.local, models: p.models.length }))
    },
    {
      name: 'navigate',
      description: `Switch the Eaon window to a tab or page: ${CONTROL_TARGETS.join(', ')}. For settings, \`settingsPage\` picks the page (general, appearance, …).`,
      risk: 'write',
      input: object({ to: string('Where to go.', { enum: [...CONTROL_TARGETS] }), settingsPage: string('Settings page id, only with to=settings.') }, ['to']),
      run: (args) => {
        const to = text(args, 'to') as ControlTarget
        if (!CONTROL_TARGETS.includes(to)) throw new Error(`Can't go to "${to}". Choose from: ${CONTROL_TARGETS.join(', ')}.`)
        act({ type: 'navigate', to, ...(typeof args.settingsPage === 'string' ? { settingsPage: args.settingsPage } : {}) })
        return { went: to }
      }
    },
    {
      name: 'ade_state',
      description: "The ADE: the folder it has open, the folders opened recently, and the terminals in each folder with what each runs.",
      risk: 'read',
      input: object({}),
      run: () => {
        const layout = host.readLayout?.() ?? store.getJson<TerminalLayout>('ade-terminals.json', {})
        return {
          current: store.getSettings().eaonCode.lastCwd,
          recent: RecentFolders.at(app.getPath('userData')).list(),
          terminals: Object.fromEntries(Object.entries(layout).map(([folder, panes]) => [folder, panes.map((p) => ({ name: p.name, agent: p.agent }))]))
        }
      }
    },
    {
      name: 'ade_open_folder',
      description: 'Open a folder in the ADE and switch to it. Its terminals come back as they were.',
      risk: 'write',
      input: object({ path: string('Absolute path of an existing folder.') }, ['path']),
      run: (args) => {
        const path = text(args, 'path')
        let isDir = false
        try {
          isDir = statSync(path).isDirectory()
        } catch {
          /* not there */
        }
        if (!isDir) throw new Error(`${path} isn't a folder that exists.`)
        act({ type: 'open-folder', path })
        return { opened: path }
      }
    },
    {
      name: 'ade_new_terminal',
      description: `Open a new terminal pane in the ADE, running a coding agent or a plain shell: ${TERMINAL_AGENT_IDS.join(', ')}. \`folder\` opens it in that folder (default: the one the ADE has open).`,
      risk: 'write',
      input: object({ agent: string('What runs in the pane.', { enum: [...TERMINAL_AGENT_IDS] }), folder: string('Absolute path of the folder.') }),
      run: (args) => {
        const agent = (text(args, 'agent', false) || 'shell') as TerminalAgentId
        if (!TERMINAL_AGENT_IDS.includes(agent)) throw new Error(`No agent "${agent}". Choose from: ${TERMINAL_AGENT_IDS.join(', ')}.`)
        const folder = text(args, 'folder', false)
        act({ type: 'new-terminal', agent, ...(folder ? { folder } : {}) })
        return { opened: agent, ...(folder ? { folder } : {}) }
      }
    },
    {
      name: 'workers',
      description: "Eaon's workers (always-on agents): name, what each is for, whether it is paused, and its folder.",
      risk: 'read',
      input: object({}),
      run: () =>
        (workersService()?.engine.list() ?? []).map((w) => ({ id: w.id, name: w.name, purpose: clip(w.purpose, 200), paused: w.paused, access: w.access, folder: w.folder }))
    },
    {
      name: 'worker_thread',
      description: "The latest messages in a worker's thread.",
      risk: 'read',
      input: object({ id: string('Worker id from workers.'), limit: number('How many messages (default 10).', { minimum: 1, maximum: 50 }) }, ['id']),
      run: (args) => {
        const service = workersService()
        if (!service) throw new Error('Workers are not running.')
        const limit = typeof args.limit === 'number' ? Math.min(50, Math.max(1, Math.floor(args.limit))) : 10
        const thread = service.engine.getThread(text(args, 'id'))
        return thread.messages.slice(-limit).map((m) => ({ role: m.role, at: new Date(m.createdAt).toISOString(), text: clip(messageText(m), 1500) }))
      }
    },
    {
      name: 'worker_send',
      description: 'Send a message to a worker. It wakes and works on it using its own model, which may be a cloud model that costs money.',
      risk: 'write',
      input: object({ id: string('Worker id from workers.'), message: string('What to tell it.') }, ['id', 'message']),
      run: (args) => {
        const service = workersService()
        if (!service) throw new Error('Workers are not running.')
        service.engine.send(text(args, 'id'), text(args, 'message'))
        return { sent: true }
      }
    },
    {
      name: 'worker_pause',
      description: 'Pause a worker, or let a paused one run again.',
      risk: 'write',
      input: object({ id: string('Worker id from workers.'), paused: { type: 'boolean', description: 'true to pause, false to resume.' } }, ['id', 'paused']),
      run: (args) => {
        const service = workersService()
        if (!service) throw new Error('Workers are not running.')
        if (typeof args.paused !== 'boolean') throw new Error('`paused` must be true or false.')
        const worker = service.engine.setPaused(text(args, 'id'), args.paused)
        return { id: worker.id, paused: worker.paused }
      }
    },
    {
      name: 'chats',
      description: "Recent chats in Eaon's Chat tab: title, when it was last used, and how many messages.",
      risk: 'read',
      input: object({ limit: number('How many (default 10).', { minimum: 1, maximum: 50 }) }),
      run: (args) => {
        const limit = typeof args.limit === 'number' ? Math.min(50, Math.max(1, Math.floor(args.limit))) : 10
        return store
          .getChats()
          .filter((c) => !c.archived)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, limit)
          .map((c) => ({ id: c.id, title: c.title, updated: new Date(c.updatedAt).toISOString(), messages: c.messages.length }))
      }
    },
    {
      name: 'chat_read',
      description: 'The latest messages of a chat from chats.',
      risk: 'read',
      input: object({ id: string('Chat id from chats.'), limit: number('How many messages (default 10).', { minimum: 1, maximum: 50 }) }, ['id']),
      run: (args) => {
        const id = text(args, 'id')
        const chat = store.getChats().find((c) => c.id === id)
        if (!chat) throw new Error(`No chat ${id}.`)
        const limit = typeof args.limit === 'number' ? Math.min(50, Math.max(1, Math.floor(args.limit))) : 10
        return { title: chat.title, messages: chat.messages.slice(-limit).map((m) => ({ role: m.role, text: clip(messageText(m), 1500) })) }
      }
    },
    {
      name: 'settings_get',
      description: `The few Eaon settings the control API can read and change: ${Object.keys(SETTINGS).join(', ')}.`,
      risk: 'read',
      input: object({}),
      run: () => {
        const settings = store.getSettings()
        return Object.fromEntries(Object.entries(SETTINGS).map(([key, entry]) => [key, entry.read(settings)]))
      }
    },
    {
      name: 'settings_set',
      description: 'Change one Eaon setting from settings_get. The window updates at once.',
      risk: 'write',
      input: object({ setting: string('The setting, such as "appearance.mode".', { enum: Object.entries(SETTINGS).filter(([, e]) => e.patch).map(([k]) => k) }), value: { description: 'The new value.' } }, ['setting', 'value']),
      run: (args) => {
        const key = text(args, 'setting')
        const entry = SETTINGS[key]
        if (!entry?.patch || !entry.check) throw new Error(`"${key}" can't be changed here. Settable: ${Object.entries(SETTINGS).filter(([, e]) => e.patch).map(([k]) => k).join(', ')}.`)
        const problem = entry.check(args.value)
        if (problem) throw new Error(`${key} ${problem}.`)
        act({ type: 'settings', patch: entry.patch(args.value) })
        return { set: key, value: args.value }
      }
    }
  ]
  return tools
}

export const RISK_ORDER: ControlRisk[] = ['read', 'write', 'danger']

export function toolInfo(tool: ControlTool): ControlToolInfo {
  return { name: tool.name, description: tool.description, risk: tool.risk, input: tool.input }
}

