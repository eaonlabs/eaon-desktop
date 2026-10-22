import { app } from 'electron'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChannelKind, ChannelLevel, ChannelLink, ChannelLinkPatch } from '@shared/channels'
import { registerToolSource } from '../agent/tools'
import { secrets } from '../secrets'
import { store } from '../store'
import { DiscordConnector, verifyDiscordToken } from './channels/discord'
import { MatrixConnector, verifyMatrixCredentials } from './channels/matrix'
import { MattermostConnector, verifyMattermostCredentials } from './channels/mattermost'
import { SlackConnector, verifySlackCredentials } from './channels/slack'
import { ZulipConnector, verifyZulipCredentials } from './channels/zulip'
import { ChannelsService } from './channels/service'
import { TelegramConnector, verifyTelegramToken } from './channels/telegram'
import { channelsToolSource } from './channels/tools'
import type { Connector, ConnectorEvents } from './channels/types'
import { readAuthFiles, WhatsAppConnector, writeAuthFiles } from './channels/whatsapp'
import type { Feature, FeatureContext } from './types'
import { workersService } from './workers'
import type { WorkersService } from './workers/service'

/**
 * Chat apps: a worker answering in Discord, Telegram, WhatsApp, Slack,
 * Matrix, Mattermost and Zulip, controlled
 * by the user from their phone and open to the friends and groups they let
 * in. The service (`channels/service.ts`) decides who may say what; the
 * connectors speak each app's protocol. Built on the workers engine, so it
 * registers after it. Bot tokens live in the secrets vault under
 * `channel:<id>`; a WhatsApp session is its own encrypted folder.
 */

const LINKS_FILE = 'channels.json'
/** Lets the window load first; nothing here is needed to paint it. */
const START_DELAY_MS = 3000

const tokenKey = (id: string): string => `channel:${id}`

/** Checks what Settings sent for a bot app: a token, or (for the apps that need more) its credentials as JSON. */
function verify(kind: Exclude<ChannelKind, 'whatsapp'>, token: string): Promise<{ account: string; id: string; token?: string }> {
  switch (kind) {
    case 'discord':
      return verifyDiscordToken(token)
    case 'telegram':
      return verifyTelegramToken(token)
    case 'slack':
      return verifySlackCredentials(token)
    case 'matrix':
      return verifyMatrixCredentials(token)
    case 'mattermost':
      return verifyMattermostCredentials(token)
    case 'zulip':
      return verifyZulipCredentials(token)
  }
}

function connectorFor(link: ChannelLink, token: string | null, events: ConnectorEvents): Connector {
  switch (link.kind) {
    case 'discord':
      return new DiscordConnector(token ?? '', events)
    case 'telegram':
      return new TelegramConnector(token ?? '', events)
    case 'whatsapp':
      return new WhatsAppConnector(join(app.getPath('userData'), 'channels', `whatsapp-${link.id}`), events)
    case 'slack':
      return new SlackConnector(token ?? '', events)
    case 'matrix':
      return new MatrixConnector(token ?? '', events)
    case 'mattermost':
      return new MattermostConnector(token ?? '', events)
    case 'zulip':
      return new ZulipConnector(token ?? '', events)
  }
}

/** Everything that makes up the chat apps on one computer, to move them to another (a worker computer, and back). */
export interface ChannelsData {
  links: unknown[]
  /** Bot tokens, by link id. */
  tokens: Record<string, string>
  /** WhatsApp sessions' files, decrypted, by link id. */
  whatsapp: Record<string, Record<string, string>>
}

export interface ChannelsHandle {
  service: ChannelsService
  /** Every IPC channel `registerIpc` serves, so a worker computer can answer them instead. */
  readonly channels: readonly string[]
  registerIpc: () => void
  /** Starts the bots once the window has had a moment, unless they are suspended by then. */
  start: () => void
  /**
   * Stops every bot here while chat apps run on a linked worker computer
   * (two of the same bot fight over its messages). `resume` reads them from
   * storage again and starts them.
   */
  suspend: () => Promise<void>
  resume: () => void
  readonly suspended: boolean
  /** The chat apps as stored here; suspend first, so a WhatsApp session isn't changing underneath. */
  exportData: () => Promise<ChannelsData>
  /** Replaces the chat apps stored here with `data`; while suspended. */
  importData: (data: ChannelsData) => Promise<void>
  /** Forgets every chat app here, without signing anything out: they run on another computer now. */
  clear: () => Promise<void>
  stop: () => Promise<void>
}

/** A link id as it names a vault entry and a folder: nothing that could reach outside either. */
const safeId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,64}$/.test(id)

/** Chat apps on this computer, answering for `workers`. The desktop and a worker computer each make one. */
export function createChannels(ctx: FeatureContext, workers: WorkersService): ChannelsHandle {
  const channels = new ChannelsService({
    engine: workers.engine,
    loadLinks: () => store.getJson<unknown>(LINKS_FILE, []),
    saveLinks: (links) => store.setJson(LINKS_FILE, links),
    getToken: (id) => secrets.get(tokenKey(id)),
    setToken: (id, token) => secrets.set(tokenKey(id), token ?? ''),
    verifyToken: verify,
    createConnector: connectorFor,
    onChange: (links) => ctx.send('channels:changed', links),
    onStatus: (statuses) => ctx.send('channels:status', statuses)
  })
  channels.load()
  registerToolSource(channelsToolSource(channels))

  const names: string[] = []
  const registerIpc = (): void => {
    const ipcMain = {
      handle: (channel: string, handler: Parameters<FeatureContext['ipcMain']['handle']>[1]): void => {
        if (!names.includes(channel)) names.push(channel)
        ctx.ipcMain.handle(channel, handler)
      }
    }
    ipcMain.handle('channels:list', () => ({ links: channels.list(), statuses: channels.statusList() }))
    ipcMain.handle('channels:create', (_e, kind: ChannelKind, workerId: string | null) => channels.create(kind, workerId))
    ipcMain.handle('channels:set-token', (_e, id: string, token: string) => channels.setToken(id, String(token ?? '')))
    ipcMain.handle('channels:update', (_e, id: string, patch: ChannelLinkPatch) => channels.update(id, patch ?? {}))
    ipcMain.handle('channels:remove', (_e, id: string) => channels.remove(id))
    ipcMain.handle('channels:allow', (_e, id: string, code: string) => channels.allow(id, String(code ?? '')))
    ipcMain.handle('channels:dismiss', (_e, id: string, code: string) => channels.dismiss(id, String(code ?? '')))
    ipcMain.handle('channels:set-person-level', (_e, id: string, personId: string, level: ChannelLevel) => channels.setPersonLevel(id, personId, level))
    ipcMain.handle('channels:remove-person', (_e, id: string, personId: string) => channels.removePerson(id, personId))
    ipcMain.handle('channels:add-chat', (_e, id: string, chatId: string, name: string) => channels.addChat(id, chatId, name))
    ipcMain.handle('channels:remove-chat', (_e, id: string, chatId: string) => channels.removeChat(id, chatId))
    ipcMain.handle('channels:reset-owner', (_e, id: string) => channels.resetOwner(id))
    ipcMain.handle('channels:whatsapp-groups', (_e, id: string) => channels.whatsappGroups(id))
  }

  let suspended = false
  let running = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const run = (): void => {
    if (running || suspended) return
    running = true
    channels.start()
  }
  const halt = async (): Promise<void> => {
    if (timer) clearTimeout(timer)
    timer = null
    if (!running) return
    running = false
    await channels.stop()
  }
  const whatsappDir = (id: string): string => join(app.getPath('userData'), 'channels', `whatsapp-${id}`)
  const linkIds = (): string[] => channels.list().map((l) => l.id)

  return {
    service: channels,
    channels: names,
    registerIpc,
    start: () => {
      if (timer || running) return
      timer = setTimeout(() => {
        timer = null
        run()
      }, START_DELAY_MS)
      timer.unref?.()
    },
    suspend: async () => {
      suspended = true
      await halt()
    },
    resume: () => {
      if (!suspended) return
      suspended = false
      channels.load()
      run()
    },
    get suspended() {
      return suspended
    },
    exportData: async () => {
      await store.flushWrites()
      const links = store.getJson<unknown[]>(LINKS_FILE, [])
      const data: ChannelsData = { links: Array.isArray(links) ? links : [], tokens: {}, whatsapp: {} }
      for (const link of data.links) {
        const { id, kind } = (link ?? {}) as { id?: unknown; kind?: unknown }
        if (!safeId(id)) continue
        const token = secrets.get(tokenKey(id))
        if (token) data.tokens[id] = token
        if (kind === 'whatsapp') data.whatsapp[id] = await readAuthFiles(whatsappDir(id))
      }
      return data
    },
    importData: async (data) => {
      if (!suspended) throw new Error('Chat apps are running here; stop them before replacing them.')
      const links = Array.isArray(data?.links) ? data.links.filter((l) => safeId((l as { id?: unknown } | null)?.id)) : []
      const incoming = new Set(links.map((l) => (l as { id: string }).id))
      const vault: Record<string, string> = {}
      // Tokens of links that aren't coming over go, so nothing is left behind for a bot no longer here.
      for (const id of linkIds()) if (!incoming.has(id)) vault[tokenKey(id)] = ''
      for (const id of incoming) vault[tokenKey(id)] = typeof data.tokens?.[id] === 'string' ? data.tokens[id] : ''
      secrets.setMany(vault)
      for (const id of linkIds()) if (!incoming.has(id)) await rm(whatsappDir(id), { recursive: true, force: true })
      for (const [id, files] of Object.entries(data.whatsapp ?? {})) {
        if (incoming.has(id) && files && typeof files === 'object') await writeAuthFiles(whatsappDir(id), files)
      }
      store.setJson(LINKS_FILE, links)
      channels.load()
    },
    clear: async () => {
      await halt()
      const ids = linkIds()
      secrets.setMany(Object.fromEntries(ids.map((id) => [tokenKey(id), ''])))
      for (const id of ids) await rm(whatsappDir(id), { recursive: true, force: true })
      store.setJson(LINKS_FILE, [])
      channels.load()
    },
    stop: halt
  }
}

let handle: ChannelsHandle | null = null

/** The desktop's chat apps, for the worker computer to move with the workers. Null before registration. */
export function channelsHandle(): ChannelsHandle | null {
  return handle
}

export const channelsFeature: Feature = {
  id: 'channels',
  register: (ctx) => {
    const workers = workersService()
    if (!workers) {
      console.error('[channels] the workers feature is not registered; chat apps are off')
      return
    }
    handle = createChannels(ctx, workers)
    handle.registerIpc()
    handle.start()
  },
  shutdown: async () => {
    await handle?.stop()
  }
}
