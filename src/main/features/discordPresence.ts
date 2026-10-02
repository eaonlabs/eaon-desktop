import type { WebContents } from 'electron'
import {
  artUrl,
  DISCORD_APP_ID,
  DISCORD_BUTTON_LABEL,
  DISCORD_DOWNLOAD_URL,
  presenceText,
  STATUS_LABEL,
  type DiscordConnection,
  type DiscordSnapshot
} from '@shared/discordPresence'
import { DiscordRpc, DiscordUnavailable, type Activity } from './discord/rpc'
import type { Feature, FeatureContext } from './types'

/**
 * Discord Rich Presence: shows "Playing Eaon Desktop" on the user's Discord
 * profile while Eaon's window is open, with the animated art, what Eaon is
 * doing and a download button.
 *
 * The main window is the only place that knows what the app is doing, so it
 * streams a snapshot here; null, or the window closing, ends the presence.
 * This side owns the socket: it waits for Discord to start,
 * reconnects when Discord restarts, and holds updates to Discord's rate limit.
 */

/** How often to look for Discord while it is not running. */
const RETRY_MS = 15_000
/** After Discord refused the app outright (a bad application id), try again rarely. */
const REFUSED_RETRY_MS = 5 * 60_000
/** Discord accepts five activity updates per 20 seconds; stay at that pace. */
const MIN_GAP_MS = 4_000

let send: FeatureContext['send'] = () => undefined
let snapshot: DiscordSnapshot | null = null
/** When this stretch of presence began; the elapsed timer counts from it. */
let startedAt = 0
let rpc: DiscordRpc | null = null
/** Display name of the signed-in Discord user, for the settings page. */
let connectedAs = ''
let connecting = false
let connection: DiscordConnection = { state: 'off' }
let retryTimer: NodeJS.Timeout | null = null
let pushTimer: NodeJS.Timeout | null = null
let lastSentAt = 0
/** The activity Discord last accepted, so an unchanged snapshot is not resent. */
let lastSent = ''
/**
 * The clickable-image field is newer than the rest of the activity object; an
 * older Discord that rejects it gets the activity without it.
 */
let withImageLink = true
const watched = new WeakSet<WebContents>()

function setConnection(next: DiscordConnection): void {
  connection = next
  send('discord:status', next)
}

function buildActivity(s: DiscordSnapshot): Activity {
  const { details, state } = presenceText(s)
  return {
    type: 0,
    ...(details ? { details } : {}),
    ...(state ? { state } : {}),
    ...(s.showElapsed ? { timestamps: { start: startedAt } } : {}),
    assets: {
      large_image: artUrl('presence'),
      large_text: 'Eaon Desktop — every model, on your machine',
      ...(withImageLink ? { large_url: DISCORD_DOWNLOAD_URL } : {}),
      ...(s.showStatus ? { small_image: artUrl(s.status), small_text: STATUS_LABEL[s.status] } : {})
    },
    ...(s.showButton ? { buttons: [{ label: DISCORD_BUTTON_LABEL, url: DISCORD_DOWNLOAD_URL }] } : {}),
    instance: false
  }
}

function clearTimer(timer: NodeJS.Timeout | null): null {
  if (timer) clearTimeout(timer)
  return null
}

function scheduleRetry(ms: number): void {
  retryTimer = clearTimer(retryTimer)
  retryTimer = setTimeout(() => {
    retryTimer = null
    void connect()
  }, ms)
}

/** Sends the current activity now, or as soon as the rate limit allows. */
function schedulePush(): void {
  if (!rpc || pushTimer) return
  const wait = lastSentAt + MIN_GAP_MS - Date.now()
  if (wait > 0) {
    pushTimer = setTimeout(() => {
      pushTimer = null
      void push()
    }, wait)
    return
  }
  void push()
}

async function push(): Promise<void> {
  const client = rpc
  if (!client || !snapshot) return
  const activity = buildActivity(snapshot)
  const key = JSON.stringify(activity)
  if (key === lastSent) return
  lastSentAt = Date.now()
  try {
    await client.setActivity(activity)
    lastSent = key
    if (connection.state === 'error' && client === rpc) {
      setConnection({ state: 'connected', user: connectedAs, since: startedAt })
    }
  } catch (error) {
    if (client !== rpc) return
    if (withImageLink) {
      withImageLink = false
      schedulePush()
      return
    }
    setConnection({ state: 'error', message: `Discord didn't accept the activity: ${(error as Error).message}` })
  }
}

async function connect(): Promise<void> {
  if (rpc || connecting || !snapshot) return
  connecting = true
  // Stay on "waiting" while retrying rather than flickering through "connecting".
  if (connection.state !== 'no-discord') setConnection({ state: 'connecting' })
  try {
    const client = await DiscordRpc.connect(DISCORD_APP_ID)
    connecting = false
    if (!snapshot) {
      client.close()
      return
    }
    rpc = client
    lastSent = ''
    lastSentAt = 0
    client.onClose = () => {
      if (rpc !== client) return
      rpc = null
      pushTimer = clearTimer(pushTimer)
      setConnection({ state: 'no-discord' })
      scheduleRetry(RETRY_MS)
    }
    connectedAs = client.user?.global_name || client.user?.username || 'Discord'
    setConnection({ state: 'connected', user: connectedAs, since: startedAt })
    schedulePush()
  } catch (error) {
    connecting = false
    if (!snapshot) return
    if (error instanceof DiscordUnavailable) {
      setConnection({ state: 'no-discord' })
      scheduleRetry(RETRY_MS)
    } else {
      setConnection({ state: 'error', message: `Discord refused the connection: ${(error as Error).message}` })
      scheduleRetry(REFUSED_RETRY_MS)
    }
  }
}

function disconnect(): void {
  retryTimer = clearTimer(retryTimer)
  pushTimer = clearTimer(pushTimer)
  const client = rpc
  rpc = null
  if (!client) return
  // Discord drops an app's activity when its connection closes, but clearing
  // first makes it go at once rather than whenever Discord notices.
  void client
    .setActivity(null)
    .catch(() => undefined)
    .finally(() => client.close())
}

function sync(next: DiscordSnapshot | null): void {
  const wasOn = snapshot !== null
  snapshot = next
  if (!next) {
    disconnect()
    if (connection.state !== 'off') setConnection({ state: 'off' })
    return
  }
  if (!wasOn) startedAt = Date.now()
  if (rpc) schedulePush()
  else void connect()
}

export const discordPresenceFeature: Feature = {
  id: 'discord-presence',
  register: (ctx) => {
    send = ctx.send
    ctx.ipcMain.on('discord:sync', (event, next: DiscordSnapshot | null) => {
      // The presence belongs to the window that set it: when that window
      // closes (macOS keeps the app running), stop showing Eaon as in use.
      if (!watched.has(event.sender)) {
        watched.add(event.sender)
        event.sender.once('destroyed', () => sync(null))
      }
      sync(next)
    })
    ctx.ipcMain.handle('discord:status', (): DiscordConnection => connection)
  },
  dispose: () => {
    snapshot = null
    retryTimer = clearTimer(retryTimer)
    pushTimer = clearTimer(pushTimer)
    rpc?.close()
    rpc = null
  }
}
