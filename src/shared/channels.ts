import type { WorkerAccess } from './workers'

/**
 * Chat apps: a worker answering in Discord, Telegram or WhatsApp.
 *
 * Each connection ("link") is one bot — a Discord bot, a Telegram bot, or a
 * WhatsApp account linked as a device — pointed at one worker. The user
 * pairs their own account with it once and becomes its owner: they can talk
 * to the worker from their phone and control it with commands. Anyone else
 * — friends in a DM, everyone in a group the owner allowed — is a guest. A
 * guest's message runs with at most `guestAccess`, whatever the worker
 * itself may do, and never changes the worker's schedule, memory or team.
 *
 * Main owns links (`features/channels/`); tokens live in the secrets vault
 * and never reach the renderer.
 */

export type ChannelKind = 'discord' | 'telegram' | 'whatsapp'

export const CHANNEL_LABEL: Record<ChannelKind, string> = {
  discord: 'Discord',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp'
}

/**
 * What a guest's message may make the worker do. `talk` answers and
 * searches the web only; the others are the worker access levels, and never
 * more than the worker itself has.
 */
export type GuestAccess = 'talk' | WorkerAccess

export const GUEST_ACCESS: { id: GuestAccess; label: string; description: string }[] = [
  { id: 'talk', label: 'Talk only', description: 'Answers and searches the web. It can’t open files or use your computer.' },
  { id: 'read-only', label: 'Look only', description: 'Can also read files and look things up with its tools. It never changes anything, sees your screen or uses your browsers.' },
  { id: 'safe', label: 'Careful', description: 'Can make ordinary changes. Anything risky is refused, and it never sees your screen or uses your browsers.' },
  { id: 'autonomous', label: 'Same as you', description: 'Whatever the worker may do for you. Only for people you trust with your computer.' }
]

/** Weakest first. A turn runs at the weakest level any message in it allows. */
export const ACCESS_ORDER: GuestAccess[] = ['talk', 'read-only', 'safe', 'autonomous']

export function weakerAccess(a: GuestAccess, b: GuestAccess): GuestAccess {
  return ACCESS_ORDER.indexOf(a) <= ACCESS_ORDER.indexOf(b) ? a : b
}

/** `chat` may talk to the worker; `control` may also stop, pause, resume and wake it. */
export type ChannelLevel = 'chat' | 'control'

export interface ChannelPerson {
  /** The platform's id for them: a Discord or Telegram user id, a WhatsApp JID. */
  id: string
  name: string
  level: ChannelLevel
  addedAt: number
}

/** A group, server channel or WhatsApp group the owner let the worker answer in. */
export interface ChannelChat {
  id: string
  name: string
  addedAt: number
}

/**
 * Someone the worker doesn't know wrote to it, or it was called on in a chat
 * nobody allowed. The owner lets them in with the code, in Eaon or by sending
 * `/allow CODE`.
 */
export interface ChannelRequest {
  code: string
  kind: 'person' | 'chat'
  id: string
  name: string
  /** What they wrote first, so the owner knows who it is. */
  preview: string
  at: number
}

/** When the worker answers in a group: when it is called on, or to everything. */
export type GroupReplies = 'mention' | 'all'

export interface ChannelLink {
  id: string
  kind: ChannelKind
  /** The worker this bot speaks for; null once that worker is deleted. */
  workerId: string | null
  enabled: boolean
  createdAt: number
  /** The bot's own name once connected: "@NovaBot", "Nova#0421", "+44 7700 900123". */
  account: string | null
  /** Discord: the application id, for the invite link. */
  appId: string | null
  /** The user's own account on this app, once paired; null until then. */
  owner: { id: string; name: string } | null
  /** Sent as `/pair CODE` from the user's own account to claim the bot. */
  pairCode: string
  people: ChannelPerson[]
  chats: ChannelChat[]
  requests: ChannelRequest[]
  groupReplies: GroupReplies
  guestAccess: GuestAccess
  /** Forward the worker's questions and alerts to the owner here. */
  forwardAlerts: boolean
  /**
   * WhatsApp only. `personal`: the linked number is the user's own, so the
   * worker answers only when called by name (or in "Message yourself") and
   * never replies to strangers. `dedicated`: a number just for the worker,
   * which behaves like a bot.
   */
  whatsappMode: 'personal' | 'dedicated'
}

export type ChannelState =
  /** Switched off, or not set up yet. */
  | 'off'
  | 'connecting'
  | 'connected'
  /** WhatsApp: waiting for the user to scan `qr` with their phone. */
  | 'scan'
  | 'error'

export interface ChannelStatus {
  linkId: string
  state: ChannelState
  message?: string
  /** WhatsApp: the text to show as a QR code while `state` is `scan`. */
  qr?: string
  /** Discord: false when "Message Content Intent" is off, so group messages that don't mention the bot arrive empty. */
  readsAllMessages?: boolean
  /** A Discord or Telegram link that is on but has no token in the vault (a reset keychain): paste it again. */
  needsToken?: boolean
}

/** What the renderer may change directly; main validates every field. */
export type ChannelLinkPatch = Partial<
  Pick<ChannelLink, 'workerId' | 'enabled' | 'groupReplies' | 'guestAccess' | 'forwardAlerts' | 'whatsappMode'>
>

export interface WhatsAppGroup {
  id: string
  name: string
  size: number
}

/** Most characters one message may carry on each app. */
export const MAX_MESSAGE_CHARS: Record<ChannelKind, number> = {
  discord: 2000,
  telegram: 4096,
  whatsapp: 4000
}

/** Files larger than this that someone sends the worker are skipped. */
export const MAX_INCOMING_FILE_BYTES = 20 * 1024 * 1024
/** At most this many people and chats per link, and pending requests. */
export const MAX_PEOPLE = 50
export const MAX_CHATS = 25
export const MAX_REQUESTS = 20
/** A guest may send the worker this many messages an hour; the owner has no limit. */
export const GUEST_MESSAGES_PER_HOUR = 20

/** Discord permissions the invite asks for: view channels, send messages (and in threads), attach files, read history. */
export const DISCORD_INVITE_PERMISSIONS = String((1n << 10n) | (1n << 11n) | (1n << 15n) | (1n << 16n) | (1n << 38n))

export function discordInviteUrl(appId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(appId)}&scope=bot&permissions=${DISCORD_INVITE_PERMISSIONS}`
}

/** The commands every chat app understands, for /help and Telegram's command menu. */
export const CHANNEL_COMMANDS: { name: string; args?: string; description: string; who: 'anyone' | 'control' | 'owner' }[] = [
  { name: 'help', description: 'What you can do here', who: 'anyone' },
  { name: 'status', description: 'What the worker is doing', who: 'anyone' },
  { name: 'stop', description: 'Stop what it is doing now', who: 'control' },
  { name: 'pause', description: 'Pause it: no heartbeats, messages wait', who: 'control' },
  { name: 'resume', description: 'Let it work again', who: 'control' },
  { name: 'wake', description: 'Have it check in now', who: 'control' },
  { name: 'workers', description: 'Your whole team and what each is doing', who: 'owner' },
  { name: 'use', args: 'name', description: 'Point this bot at another worker', who: 'owner' },
  { name: 'asks', description: 'Questions the worker is waiting on', who: 'owner' },
  { name: 'answer', args: 'text', description: 'Answer its oldest question', who: 'owner' },
  { name: 'approve', args: 'code', description: 'Approve the action it asked about (the code is in its message)', who: 'owner' },
  { name: 'decline', args: 'code', description: 'Decline the action it asked about', who: 'owner' },
  { name: 'allow', args: 'code', description: 'Let someone (or a group) talk to it', who: 'owner' },
  { name: 'pair', args: 'code', description: 'Claim this bot as yours', who: 'anyone' }
]
