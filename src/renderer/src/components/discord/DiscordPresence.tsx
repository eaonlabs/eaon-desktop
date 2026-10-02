import { useEffect } from 'react'
import { discordPlace, type DiscordStatus } from '@shared/discordPresence'
import { useApp, useWorkspaceKind } from '../../state/store'
import { useAppActivity, type AppActivity } from './useAppActivity'

/** The app's activity, narrowed to what the Discord card says. */
export function discordStatus(activity: AppActivity): DiscordStatus {
  if (activity === 'thinking' || activity === 'working') return activity
  if (activity === 'asleep') return 'away'
  return 'ready'
}

/**
 * Feeds Discord Rich Presence from the main window, which is the only place
 * that can see what the app is doing. Renders nothing; the main process owns
 * the connection and paces the updates to Discord's rate limit.
 */
export function DiscordPresence(): JSX.Element | null {
  const enabled = useApp((s) => Boolean(s.settings?.discord?.enabled))

  useEffect(() => {
    if (!enabled) window.api.discord.sync(null)
  }, [enabled])

  return enabled ? <ActivePresence /> : null
}

function ActivePresence(): null {
  const discord = useApp((s) => s.settings!.discord)
  const place = discordPlace(useWorkspaceKind())
  const status = discordStatus(useAppActivity())
  const { showStatus, showElapsed, showButton } = discord

  useEffect(() => {
    window.api.discord.sync({ status, place, showStatus, showElapsed, showButton })
  }, [status, place, showStatus, showElapsed, showButton])

  return null
}
