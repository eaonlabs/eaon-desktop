import { useEffect, useState, type JSX } from 'react'
import { Gamepad2, MoreHorizontal } from 'lucide-react'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Segmented, Switch } from '../../ui'
import {
  DISCORD_BUTTON_LABEL,
  DISCORD_DOWNLOAD_URL,
  presenceText,
  STATUS_LABEL,
  type DiscordConnection,
  type DiscordPlace,
  type DiscordStatus
} from '@shared/discordPresence'
import presenceArt from '../../../assets/discord/presence-v1.gif'
import thinkingArt from '../../../assets/discord/thinking-v1.gif'
import workingArt from '../../../assets/discord/working-v1.gif'
import readyArt from '../../../assets/discord/ready-v1.gif'
import awayArt from '../../../assets/discord/away-v1.gif'

const BADGES: Record<DiscordStatus, string> = {
  ready: readyArt,
  thinking: thinkingArt,
  working: workingArt,
  away: awayArt
}

const PREVIEW_STATUSES: { value: DiscordStatus; label: string }[] = (
  ['ready', 'thinking', 'working', 'away'] as const
).map((value) => ({ value, label: STATUS_LABEL[value] }))

function useDiscordConnection(): DiscordConnection {
  const [connection, setConnection] = useState<DiscordConnection>({ state: 'off' })
  useEffect(() => {
    void window.api.discord.status().then(setConnection)
    return window.api.discord.onStatus(setConnection)
  }, [])
  return connection
}

function statusLine(connection: DiscordConnection): { state: string; label: string; detail: string } {
  switch (connection.state) {
    case 'connected':
      return {
        state: 'on',
        label: `Connected as ${connection.user}`,
        detail:
          "Eaon Desktop is on your profile. If friends can't see it, turn on Share my activity in Discord's Activity Privacy settings."
      }
    case 'no-discord':
      return {
        state: 'waiting',
        label: 'Waiting for Discord',
        detail: 'Open the Discord desktop app and Eaon will appear on your profile. Discord in a browser can’t show activity from apps.'
      }
    case 'error':
      return { state: 'error', label: 'Couldn’t connect', detail: connection.message }
    default:
      return { state: 'waiting', label: 'Connecting…', detail: 'Looking for the Discord desktop app on this computer.' }
  }
}

/** HH:MM:SS once past an hour, MM:SS before — as Discord shows it. */
function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

function Elapsed({ since }: { since: number }): JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return <span className="dc-card__time-value">{elapsed(now - since)}</span>
}

/**
 * The "Playing" card as Discord draws it on a profile, in Discord's own dark
 * colours whatever Eaon's theme is — it is a picture of Discord.
 */
function DiscordCard({
  status,
  place,
  showStatus,
  showElapsed,
  showButton,
  since
}: {
  status: DiscordStatus
  place: DiscordPlace
  showStatus: boolean
  showElapsed: boolean
  showButton: boolean
  since: number
}): JSX.Element {
  const { details, state } = presenceText({ status, place, showStatus })
  return (
    <div className="dc-card" aria-label="Preview of your Discord profile">
      <div className="dc-card__head">
        <span>Playing</span>
        <MoreHorizontal size={18} strokeWidth={2} aria-hidden="true" />
      </div>
      <div className="dc-card__body">
        <div className="dc-card__art">
          <img className="dc-card__large" src={presenceArt} alt="Animated Eaon logo" draggable={false} />
          {showStatus && (
            // Keyed so a status change replays the pop-in.
            <img
              key={status}
              className="dc-card__small"
              src={BADGES[status]}
              alt={STATUS_LABEL[status]}
              title={STATUS_LABEL[status]}
              draggable={false}
            />
          )}
        </div>
        <div className="dc-card__text">
          <div className="dc-card__title">Eaon Desktop</div>
          {details && (
            <div key={details} className="dc-card__line">
              {details}
            </div>
          )}
          {state && <div className="dc-card__line dc-card__line--dim">{state}</div>}
          {showElapsed && (
            <div className="dc-card__time">
              <Gamepad2 size={16} strokeWidth={2} aria-hidden="true" />
              <Elapsed since={since} />
            </div>
          )}
        </div>
      </div>
      {showButton && (
        <button type="button" className="dc-card__button" onClick={() => void window.api.app.openExternal(DISCORD_DOWNLOAD_URL)}>
          {DISCORD_BUTTON_LABEL}
        </button>
      )}
    </div>
  )
}

export function DiscordPage(): JSX.Element {
  const discord = useApp((s) => s.settings?.discord)
  const patchSettings = useApp((s) => s.patchSettings)
  const setSettingsPage = useApp((s) => s.setSettingsPage)
  const connection = useDiscordConnection()
  const [preview, setPreview] = useState<DiscordStatus>('thinking')
  const [openedAt] = useState(() => Date.now())
  if (!discord) return <></>

  const set = (patch: Partial<typeof discord>): void => void patchSettings({ discord: patch })
  const line = statusLine(connection)
  const since = connection.state === 'connected' ? connection.since : openedAt

  return (
    <>
      <h1 className="settings__h1">Discord</h1>
      <p className="settings__lede">
        Show Eaon Desktop on your Discord profile while you use it, with an animated card and a button your friends can use
        to get it. Eaon never shares what you type or what it replies.
      </p>

      <Section>
        <Card>
          <Row title="Show Eaon on Discord" description="Adds “Playing Eaon Desktop” to your profile while Eaon’s window is open.">
            <Switch label="Show Eaon on Discord" checked={discord.enabled} onChange={(enabled) => set({ enabled })} />
          </Row>
          {discord.enabled && (
            <Row title="Status" description={line.detail}>
              <span className="bx-status" data-state={line.state}>
                <span className="bx-status__dot" aria-hidden="true" />
                {line.label}
              </span>
            </Row>
          )}
        </Card>
      </Section>

      <Section label="Preview">
        <div className="dc-stage" data-off={!discord.enabled || undefined}>
          <DiscordCard
            status={preview}
            place="chat"
            showStatus={discord.showStatus}
            showElapsed={discord.showElapsed}
            showButton={discord.showButton}
            since={since}
          />
          {discord.showStatus && <Segmented value={preview} options={PREVIEW_STATUSES} onChange={setPreview} />}
        </div>
      </Section>

      <Section label="On your profile">
        <Card>
          <Row
            title="Show what Eaon is doing"
            description="Thinking, running tools, ready or away, and which tab you’re in — with an animated badge for each. Never the contents of your chats."
          >
            <Switch label="Show what Eaon is doing" checked={discord.showStatus} onChange={(showStatus) => set({ showStatus })} />
          </Row>
          <Row title="Show time elapsed" description="How long you’ve had Eaon open.">
            <Switch label="Show time elapsed" checked={discord.showElapsed} onChange={(showElapsed) => set({ showElapsed })} />
          </Row>
          <Row title={`Show the “${DISCORD_BUTTON_LABEL}” button`} description="Takes whoever clicks it to eaon.dev to download Eaon Desktop.">
            <Switch
              label={`Show the ${DISCORD_BUTTON_LABEL} button`}
              checked={discord.showButton}
              onChange={(showButton) => set({ showButton })}
            />
          </Row>
        </Card>
      </Section>

      <Section>
        <Card>
          <Row title="Talk to your workers from Discord" description="A Discord bot that answers as one of your workers, for you and the friends you let in, is set up in Chat apps.">
            <button className="btn" onClick={() => setSettingsPage('chat-apps')}>
              Open Chat apps
            </button>
          </Row>
        </Card>
      </Section>
    </>
  )
}
