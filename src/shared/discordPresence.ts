/**
 * Discord Rich Presence: the "Playing Eaon Desktop" card on the user's
 * Discord profile. Shared by the main process, which talks to Discord, and
 * the settings page, which previews the same card.
 */

/**
 * The Application ID of the "Eaon Desktop" app in the Discord Developer Portal.
 * Its name is what Discord shows after "Playing". Rich Presence needs only this
 * public id — never put the app's client secret in the app.
 */
export const DISCORD_APP_ID = '1554698208846938112'

export const DISCORD_DOWNLOAD_URL = 'https://eaon.dev/download#desktop'
export const DISCORD_BUTTON_LABEL = 'Get Eaon Desktop'

/**
 * Discord only animates images it loads from a URL — assets uploaded to the
 * developer portal stay still — so the art is served from eaon.dev. Its media
 * proxy caches by URL: bump this with VERSION in scripts/discord-art.py after
 * changing the art, and publish the new files before shipping.
 */
export const DISCORD_ART_VERSION = 1
const ART_BASE = 'https://eaon.dev/img/discord'

export type DiscordStatus = 'ready' | 'thinking' | 'working' | 'away'
/** The workspace tab; 'work' is the retired agent tab, which old data may still name. */
export type DiscordPlace = 'chat' | 'work' | 'code' | 'workers'

/** Sent renderer → main whenever any of it changes; null ends the presence. */
export interface DiscordSnapshot {
  status: DiscordStatus
  place: DiscordPlace
  showStatus: boolean
  showElapsed: boolean
  showButton: boolean
}

export type DiscordConnection =
  | { state: 'off' }
  | { state: 'connecting' }
  | { state: 'no-discord' }
  | { state: 'connected'; user: string; since: number }
  | { state: 'error'; message: string }

export const artUrl = (name: 'presence' | DiscordStatus): string => `${ART_BASE}/${name}-v${DISCORD_ART_VERSION}.gif`

const STATUS_TEXT: Record<DiscordStatus, string> = {
  ready: 'Ready for the next prompt',
  thinking: 'Thinking through a reply',
  working: 'Running tools',
  away: 'Away'
}

const PLACE_TEXT: Record<DiscordPlace, string> = {
  chat: 'In a chat',
  work: 'In a chat',
  code: 'In the ADE',
  workers: 'Managing Workers'
}

/** A workspace kind as a place on the card; a kind added later reads as a chat until named here. */
export function discordPlace(kind: string): DiscordPlace {
  return kind in PLACE_TEXT ? (kind as DiscordPlace) : 'chat'
}

/** Short names for the status badge's hover text. */
export const STATUS_LABEL: Record<DiscordStatus, string> = {
  ready: 'Ready',
  thinking: 'Thinking',
  working: 'Running tools',
  away: 'Away'
}

/** The lines of the card, as both Discord and the settings preview show them. */
export function presenceText(snapshot: Pick<DiscordSnapshot, 'status' | 'place' | 'showStatus'>): {
  details?: string
  state?: string
} {
  if (!snapshot.showStatus) return {}
  return { details: STATUS_TEXT[snapshot.status], state: PLACE_TEXT[snapshot.place] }
}
