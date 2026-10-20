import { app } from 'electron'
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
import { WhatsAppConnector } from './channels/whatsapp'
import type { Feature } from './types'
import { workersService } from './workers'

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

let service: ChannelsService | null = null
let startTimer: ReturnType<typeof setTimeout> | null = null

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

export const channelsFeature: Feature = {
  id: 'channels',
  register: (ctx) => {
    const workers = workersService()
    if (!workers) {
      console.error('[channels] the workers feature is not registered; chat apps are off')
      return
    }
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
    service = channels
    channels.load()
    registerToolSource(channelsToolSource(channels))

    const { ipcMain } = ctx
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

    startTimer = setTimeout(() => {
      startTimer = null
      channels.start()
    }, START_DELAY_MS)
    startTimer.unref?.()
  },
  shutdown: async () => {
    if (startTimer) clearTimeout(startTimer)
    startTimer = null
    await service?.stop()
  }
}
