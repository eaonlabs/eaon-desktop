import type { ChannelKind, ChannelStatus, WhatsAppGroup } from '@shared/channels'

/**
 * What every chat app looks like to the channels service. A connector turns
 * the app's own events into `IncomingMessage`s and sends text and files back;
 * who may say what, and to which worker, is the service's business.
 */

export interface IncomingFile {
  name: string
  /** Bytes, when the app says; checked again after download. */
  size: number | null
  download: () => Promise<Buffer>
}

export interface IncomingMessage {
  chatId: string
  /** "Direct message", "#general", "Weekend plans". */
  chatName: string
  isGroup: boolean
  senderId: string
  senderName: string
  messageId: string
  /** With the bot's own @-mention taken out. */
  text: string
  /** @-mentioned the bot, replied to one of its messages, or (Telegram) sent a bot command. */
  mentioned: boolean
  /** WhatsApp: written by the linked account itself — the user, or another of their devices. */
  fromSelf?: boolean
  /** WhatsApp: the user's own "Message yourself" chat. */
  selfChat?: boolean
  files: IncomingFile[]
  /** Something sent that the worker can't read yet: "a voice message", "a sticker". */
  unsupported?: string
}

export interface ConnectorEvents {
  message: (message: IncomingMessage) => void
  status: (status: Omit<ChannelStatus, 'linkId'>) => void
  /** Who the bot is, once the app says: shown in Settings, and the WhatsApp owner. */
  account: (info: { account: string; appId?: string; selfId?: string; selfName?: string }) => void
}

export interface Connector {
  readonly kind: ChannelKind
  /** Connects, and keeps reconnecting until `stop()`. Never throws; problems arrive as status. */
  start: () => void
  stop: () => Promise<void>
  /** Sends Markdown, formatted and split for the app. `replyTo` quotes that message where the app can. */
  send: (chatId: string, markdown: string, replyTo?: string) => Promise<void>
  sendFile: (chatId: string, path: string, caption?: string) => Promise<void>
  typing: (chatId: string, on: boolean) => Promise<void>
  /** How often `typing` must be repeated to stay visible. */
  readonly typingEveryMs: number
  /** The chat to write to a person privately. */
  directChat: (userId: string) => Promise<string>
  /** WhatsApp: the groups the linked account is in. */
  groups?: () => Promise<WhatsAppGroup[]>
  /** WhatsApp: unlink this device from the phone. */
  logout?: () => Promise<void>
}
