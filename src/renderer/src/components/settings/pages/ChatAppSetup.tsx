import { useState, type JSX, type ReactNode } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { CHANNEL_LABEL, COMMAND_PREFIX, slackManifest, type ChannelKind, type ChannelLink } from '@shared/channels'
import { CLIPBOARD_FAILED, copyText } from '../../../lib/clipboard'
import { notify } from '../../Notice'

/**
 * Setting up a chat app that runs as a bot (every one but WhatsApp): how to
 * make the bot in that app, and the fields Eaon needs from it. Apps that need
 * more than one value send them to main as JSON in place of a token.
 */

type BotKind = Exclude<ChannelKind, 'whatsapp'>

interface Field {
  key: string
  label: string
  placeholder: string
  secret?: boolean
}

interface Setup {
  /** Shown above the steps. */
  title: string
  steps: (ctx: { workerName: string }) => ReactNode[]
  fields: Field[]
  /** What goes to main: the token itself, or the fields as JSON. */
  build: (values: Record<string, string>) => string
  note: string
}

const open = (url: string): void => void window.api.app.openExternal(url)

function LinkButton({ url, children }: { url: string; children: ReactNode }): JSX.Element {
  return (
    <button className="btn btn--sm" onClick={() => open(url)}>
      <ExternalLink size={13} strokeWidth={1.9} />
      {children}
    </button>
  )
}

/** Copies the Slack app manifest, with the bot named after the worker. */
function CopyManifest({ workerName }: { workerName: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="btn btn--sm"
      onClick={() =>
        void copyText(slackManifest(workerName)).then((ok) => {
          if (!ok) return notify(CLIPBOARD_FAILED, 'error')
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        })
      }
    >
      {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.9} />}
      {copied ? 'Copied' : 'Copy manifest'}
    </button>
  )
}

/** Where what was entered is kept: `thing` is "The token", "The tokens"… */
const kept = (thing: string, app: string, plural = false): string =>
  `${thing} ${plural ? 'are' : 'is'} stored in your system keychain and never ${plural ? 'leave' : 'leaves'} this computer except to talk to ${app}.`

export const SETUP: Record<BotKind, Setup> = {
  discord: {
    title: 'Make a bot',
    steps: () => [
      <>
        <span>Open the Discord Developer Portal and create a New Application — its name is the bot’s name.</span>
        <LinkButton url="https://discord.com/developers/applications">Developer Portal</LinkButton>
      </>,
      <span key="token">
        On the <strong>Bot</strong> page, click <strong>Reset Token</strong> and copy it. To have it read every message in a channel, not just mentions,
        also turn on <strong>Message Content Intent</strong> there.
      </span>,
      <span key="paste">Paste the token here.</span>
    ],
    fields: [{ key: 'token', label: 'Bot token', placeholder: 'Bot token', secret: true }],
    build: (v) => v.token,
    note: kept('The token', 'Discord')
  },
  telegram: {
    title: 'Make a bot',
    steps: () => [
      <>
        <span>
          In Telegram, open <strong>@BotFather</strong> and send <code>/newbot</code>.
        </span>
        <LinkButton url="https://t.me/BotFather">Open BotFather</LinkButton>
      </>,
      <span key="name">Pick a name and a username ending in “bot”.</span>,
      <span key="paste">Paste the token BotFather sends you here.</span>
    ],
    fields: [{ key: 'token', label: 'Bot token', placeholder: '123456789:ABC…', secret: true }],
    build: (v) => v.token,
    note: kept('The token', 'Telegram')
  },
  slack: {
    title: 'Make a Slack app',
    steps: ({ workerName }) => [
      <>
        <span>
          Copy the app manifest, then on Slack’s apps page choose <strong>Create New App → From a manifest</strong>, pick your workspace and paste it.
        </span>
        <CopyManifest workerName={workerName} />
        <LinkButton url="https://api.slack.com/apps?new_app=1">Slack apps</LinkButton>
      </>,
      <span key="install">
        Click <strong>Install to Workspace</strong>, then copy the <strong>Bot User OAuth Token</strong> (<code>xoxb-…</code>) from{' '}
        <strong>OAuth &amp; Permissions</strong>.
      </span>,
      <span key="app">
        On <strong>Basic Information</strong>, under App-Level Tokens, generate one with the <code>connections:write</code> scope (<code>xapp-…</code>).
      </span>
    ],
    fields: [
      { key: 'bot', label: 'Bot token', placeholder: 'xoxb-…', secret: true },
      { key: 'app', label: 'App-level token', placeholder: 'xapp-…', secret: true }
    ],
    build: (v) => JSON.stringify({ bot: v.bot.trim(), app: v.app.trim() }),
    note: `${kept('The tokens', 'Slack', true)} Slack shows bots no typing indicator, so replies just arrive.`
  },
  matrix: {
    title: 'Give it a Matrix account',
    steps: () => [
      <>
        <span>Make an account for the worker on any Matrix server, such as matrix.org or your own — for example in Element.</span>
        <LinkButton url="https://app.element.io/#/register">Element</LinkButton>
      </>,
      <span key="sign-in">Enter its server, user name and password. Eaon signs in once and keeps only the session it gets back, never the password.</span>,
      <span key="rooms">
        Invite it to rooms, or start a direct chat with it. Turn <strong>encryption off</strong> for those rooms: Eaon can’t read end-to-end encrypted
        ones yet.
      </span>
    ],
    fields: [
      { key: 'server', label: 'Server', placeholder: 'matrix.org' },
      { key: 'user', label: 'User name', placeholder: '@nova:matrix.org' },
      { key: 'password', label: 'Password', placeholder: 'Password', secret: true }
    ],
    build: (v) => JSON.stringify({ server: v.server.trim(), user: v.user.trim(), password: v.password }),
    note: kept('The session', 'its Matrix server')
  },
  mattermost: {
    title: 'Make a bot account',
    steps: () => [
      <span key="make">
        In Mattermost, open <strong>Integrations → Bot Accounts → Add Bot Account</strong>. (If it isn’t there, an admin turns bot accounts on in System
        Console → Integrations → Bot Accounts.)
      </span>,
      <span key="token">Copy the access token it shows — it’s shown once.</span>,
      <span key="add">Add the bot to the teams and channels it should be in.</span>
    ],
    fields: [
      { key: 'server', label: 'Server', placeholder: 'chat.example.com' },
      { key: 'token', label: 'Access token', placeholder: 'Access token', secret: true }
    ],
    build: (v) => JSON.stringify({ server: v.server.trim(), token: v.token.trim() }),
    note: kept('The token', 'your Mattermost server')
  },
  zulip: {
    title: 'Make a bot',
    steps: () => [
      <span key="make">
        In Zulip, open <strong>Personal settings → Bots → Add a new bot</strong> and make a <strong>Generic bot</strong>.
      </span>,
      <span key="key">Copy its email and API key (they’re in the zuliprc it offers to download).</span>,
      <span key="subscribe">Subscribe the bot to the channels it should answer in.</span>
    ],
    fields: [
      { key: 'server', label: 'Server', placeholder: 'yourteam.zulipchat.com' },
      { key: 'email', label: 'Bot email', placeholder: 'nova-bot@yourteam.zulipchat.com' },
      { key: 'key', label: 'API key', placeholder: 'API key', secret: true }
    ],
    build: (v) => JSON.stringify({ server: v.server.trim(), email: v.email.trim(), key: v.key.trim() }),
    note: kept('The key', 'your Zulip server')
  }
}

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** The steps to make the bot, and the fields to connect it. */
export function TokenSetup({
  link,
  workerName,
  autoFocus,
  onDone
}: {
  link: ChannelLink
  workerName: string
  autoFocus: boolean
  onDone: (link: ChannelLink) => void
}): JSX.Element {
  const setup = SETUP[link.kind as BotKind]
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const complete = setup.fields.every((f) => (values[f.key] ?? '').trim())

  const submit = async (): Promise<void> => {
    if (!complete || busy) return
    setBusy(true)
    setError(null)
    try {
      onDone(await window.api.channels.setToken(link.id, setup.build(values)))
      setValues({})
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="row row--stack">
      <div className="row__body">
        <div className="row__title">{setup.title}</div>
        <div className="row__desc">Eaon runs the bot from this computer. It only works while Eaon is open.</div>
      </div>
      <ol className="bx-steps">
        {setup.steps({ workerName }).map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      <form
        className={setup.fields.length > 1 ? 'ch-token ch-token--fields' : 'ch-token'}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {setup.fields.map((field, i) => (
          <input
            key={field.key}
            className="input"
            type={field.secret ? 'password' : 'text'}
            autoFocus={autoFocus && i === 0}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            placeholder={field.placeholder}
            aria-label={`${CHANNEL_LABEL[link.kind]} ${field.label.toLowerCase()}`}
            value={values[field.key] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
          />
        ))}
        <button className="btn btn--primary" type="submit" disabled={!complete || busy}>
          {busy ? 'Checking…' : 'Connect'}
        </button>
      </form>
      {error && <p className="ch-error">{error}</p>}
      <p className="ch-note">{setup.note}</p>
    </div>
  )
}

/** How the user claims the bot as theirs, in each app. */
export function pairingHint(link: ChannelLink): string {
  const send = `send it ${COMMAND_PREFIX[link.kind]}pair and the code`
  switch (link.kind) {
    case 'telegram':
      return 'Open the bot in Telegram and tap Start, or send it the code. That makes you its owner.'
    case 'discord':
      return 'Invite the bot to a server you’re in, then send it a direct message with the code. That makes you its owner.'
    case 'slack':
      return `In Slack, open the app (under Apps in the sidebar) and ${send} as a direct message. That makes you its owner.`
    case 'matrix':
      return `Start a direct chat with ${link.account ?? 'its account'}, without encryption, and ${send}. That makes you its owner.`
    case 'mattermost':
    case 'zulip':
      return `Send ${link.account ?? 'the bot'} a direct message: ${COMMAND_PREFIX[link.kind]}pair and the code. That makes you its owner.`
    default:
      return 'Send the bot the code. That makes you its owner.'
  }
}
