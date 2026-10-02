import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import QRCode from 'qrcode'
import { Check, Copy, ExternalLink, Plus, Trash2, TriangleAlert, UserRound, UsersRound, X } from 'lucide-react'
import {
  CHANNEL_LABEL,
  GUEST_ACCESS,
  discordInviteUrl,
  type ChannelKind,
  type ChannelLink,
  type ChannelStatus,
  type GuestAccess,
  type WhatsAppGroup
} from '@shared/channels'
import { Card, Modal, Popover, MenuItem, Row, Section, Segmented, Select, Switch } from '../../ui'
import { ChannelLogo } from '../../channels/ChannelLogo'
import { useChannels } from '../../channels/channelsStore'
import { useWorkers } from '../../workers/workersStore'
import { WorkerFace } from '../../workers/WorkerFace'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../../../state/store'

/**
 * Settings → Chat apps: connect a worker to a Discord bot, a Telegram bot or
 * a WhatsApp account, pair your own account with it, and decide who else may
 * talk to it and how much they may make it do. Main owns the connections
 * (features/channels); this page shows them and sends commands.
 */

const APPS: { kind: ChannelKind; blurb: string }[] = [
  { kind: 'discord', blurb: 'A bot in your servers and DMs' },
  { kind: 'telegram', blurb: 'A bot to message, alone or in groups' },
  { kind: 'whatsapp', blurb: 'Your number, linked like WhatsApp Web' }
]

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function ChatAppsPage(): JSX.Element {
  const { links, statuses, ready, focusWorkerId, init, put, focusWorker } = useChannels()
  const workers = useWorkers((s) => s.workers)
  const { setView, setWorkspace, workspaces } = useApp(useShallow((s) => ({ setView: s.setView, setWorkspace: s.setWorkspace, workspaces: s.workspaces })))
  const [creating, setCreating] = useState<ChannelKind | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fresh, setFresh] = useState<string | null>(null)

  useEffect(() => {
    void init()
  }, [init])

  const create = async (kind: ChannelKind): Promise<void> => {
    setCreating(kind)
    setError(null)
    try {
      const workerId = focusWorkerId && workers.some((w) => w.id === focusWorkerId) ? focusWorkerId : (workers[0]?.id ?? null)
      const link = await window.api.channels.create(kind, workerId)
      put(link)
      setFresh(link.id)
      focusWorker(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setCreating(null)
    }
  }

  return (
    <>
      <h1 className="settings__h1">Chat apps</h1>
      <p className="settings__lede">
        Talk to your workers from Discord, Telegram and WhatsApp, and let friends and groups talk to them too. Each connection
        speaks for one worker, and you decide how much anyone else can make it do.
      </p>

      <Section label="Connect an app">
        {workers.length === 0 ? (
          <Card>
            <Row title="Create a worker first" description="A chat app connects to one of your workers, so it has someone to answer as.">
              <button
                className="btn"
                onClick={() => {
                  const tab = workspaces.find((w) => w.kind === 'workers')
                  if (tab) setWorkspace(tab.id)
                  setView('chat')
                }}
              >
                Open Workers
              </button>
            </Row>
          </Card>
        ) : (
          <div className="ch-apps">
            {APPS.map((app) => (
              <button key={app.kind} className="ch-app" onClick={() => void create(app.kind)} disabled={creating !== null}>
                <ChannelLogo kind={app.kind} size={34} />
                <span className="ch-app__text">
                  <span className="ch-app__name">{CHANNEL_LABEL[app.kind]}</span>
                  <span className="ch-app__blurb">{app.blurb}</span>
                </span>
                <Plus className="ch-app__plus" size={16} strokeWidth={2} aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
        {error && <p className="ch-error">{error}</p>}
      </Section>

      {ready &&
        [...links]
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((link) => (
            <LinkSection key={link.id} link={link} status={statuses[link.id]} autoFocus={link.id === fresh} />
          ))}
    </>
  )
}

/* ---------------------------------------------------------------- one link */

/** "You, 3 people and 1 group" — who can talk to the worker through this link. */
function audience(link: ChannelLink): string {
  if (!link.owner) return link.kind === 'whatsapp' ? 'Not linked yet' : link.account ? 'Waiting for you to pair your account' : 'Not set up yet'
  const people = link.people.length
  const chats = link.chats.length
  const groupWord = link.kind === 'discord' ? 'channel' : 'group'
  const parts = [
    people ? `${people} ${people === 1 ? 'person' : 'people'}` : '',
    chats ? `${chats} ${groupWord}${chats === 1 ? '' : 's'}` : ''
  ].filter(Boolean)
  return parts.length ? `You, ${parts.join(' and ')}` : 'Only you so far'
}

function statusLine(link: ChannelLink, status: ChannelStatus | undefined): { state: string; label: string; detail?: string } {
  if (!link.enabled) {
    return link.kind !== 'whatsapp' && !link.account ? { state: 'waiting', label: 'Needs a token' } : { state: 'off', label: 'Off' }
  }
  switch (status?.state) {
    case 'connected':
      return { state: 'on', label: 'Connected' }
    case 'scan':
      return { state: 'waiting', label: 'Scan to link' }
    case 'error':
      return { state: 'error', label: 'Not connected', detail: status.message }
    case 'connecting':
      return { state: 'waiting', label: 'Connecting…', detail: status.message }
    default:
      return { state: 'waiting', label: 'Starting…' }
  }
}

function LinkSection({ link, status, autoFocus }: { link: ChannelLink; status: ChannelStatus | undefined; autoFocus: boolean }): JSX.Element {
  const put = useChannels((s) => s.put)
  const workers = useWorkers((s) => s.workers)
  const worker = workers.find((w) => w.id === link.workerId) ?? null
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const line = statusLine(link, status)
  // A bot is set up once its token checked out; WhatsApp once a phone linked it. Only then do people and options mean anything.
  const setUp = Boolean(link.account)
  const app = CHANNEL_LABEL[link.kind]

  const run = async (work: () => Promise<ChannelLink | void>): Promise<void> => {
    setError(null)
    try {
      const next = await work()
      if (next) put(next)
    } catch (e) {
      setError(errorText(e))
    }
  }
  const update = (patch: Parameters<typeof window.api.channels.update>[1]): Promise<void> => run(() => window.api.channels.update(link.id, patch))

  const workerOptions = [
    ...workers.map((w) => ({ value: w.id, label: w.name, icon: <WorkerFace color={w.color} size={16} /> })),
    ...(worker ? [] : [{ value: '', label: 'Choose a worker' }])
  ]

  return (
    <Section>
      <Card className="ch-card">
        <div className="row ch-card__head">
          <ChannelLogo kind={link.kind} size={36} />
          <div className="row__body">
            <div className="row__title">
              {app}
              {link.account && <span className="ch-card__account"> · {link.account}</span>}
            </div>
            <div className="row__desc">{line.detail ?? audience(link)}</div>
          </div>
          <div className="row__trail">
            <span className="bx-status" data-state={line.state}>
              <span className="bx-status__dot" aria-hidden="true" />
              {line.label}
            </span>
            {(setUp || link.kind === 'whatsapp') && <Switch label={`${app} on`} checked={link.enabled} onChange={(enabled) => void update({ enabled })} />}
            <button className="icon-btn" aria-label={`Remove this ${app} connection`} title="Remove" onClick={() => setConfirm(true)}>
              <Trash2 size={15} strokeWidth={1.9} />
            </button>
          </div>
        </div>

        <Row title="Speaks for" description="The worker that answers here. Messages from you arrive as your own; from anyone else, as a guest’s.">
          <Select
            value={link.workerId ?? ''}
            options={workerOptions}
            onChange={(workerId) => workerId && void update({ workerId })}
            width={180}
          />
        </Row>

        {link.kind !== 'whatsapp' && (!link.account || status?.needsToken) && <TokenSetup link={link} autoFocus={autoFocus} onDone={put} />}
        {link.kind === 'whatsapp' && <WhatsAppSetup link={link} status={status} onChange={update} />}
        {link.kind !== 'whatsapp' && link.account && <Pairing link={link} run={run} />}
        {link.kind === 'discord' && link.appId && (
          <Row title="Invite to a server" description="Add the bot to a Discord server you manage. It answers there when mentioned.">
            <button className="btn" onClick={() => void window.api.app.openExternal(discordInviteUrl(link.appId!))}>
              <ExternalLink size={14} strokeWidth={1.9} />
              Invite
            </button>
          </Row>
        )}
        {error && (
          <div className="row">
            <p className="ch-error">{error}</p>
          </div>
        )}
      </Card>

      {setUp && <Access link={link} status={status} run={run} update={update} />}

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Remove this ${app} connection?`}
        actions={
          <>
            <button className="btn btn--ghost" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button
              className="btn btn--danger"
              autoFocus
              onClick={() => {
                setConfirm(false)
                void run(() => window.api.channels.remove(link.id))
              }}
            >
              Remove
            </button>
          </>
        }
      >
        {link.kind === 'whatsapp'
          ? 'Eaon unlinks itself from your WhatsApp and forgets the session. Your chats stay as they are.'
          : `Eaon disconnects the bot and forgets its token and the people you let in. The bot itself stays in ${app}.`}
      </Modal>
    </Section>
  )
}

/* ------------------------------------------------------------ bot tokens */

function TokenSetup({ link, autoFocus, onDone }: { link: ChannelLink; autoFocus: boolean; onDone: (link: ChannelLink) => void }): JSX.Element {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const discord = link.kind === 'discord'

  const submit = async (): Promise<void> => {
    if (!token.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      onDone(await window.api.channels.setToken(link.id, token))
      setToken('')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="row row--stack">
      <div className="row__body">
        <div className="row__title">Make a bot</div>
        <div className="row__desc">Eaon runs the bot from this computer. It only works while Eaon is open.</div>
      </div>
      <ol className="bx-steps">
        {discord ? (
          <>
            <li>
              <span>Open the Discord Developer Portal and create a New Application — its name is the bot’s name.</span>
              <button className="btn btn--sm" onClick={() => void window.api.app.openExternal('https://discord.com/developers/applications')}>
                <ExternalLink size={13} strokeWidth={1.9} />
                Developer Portal
              </button>
            </li>
            <li>
              <span>
                On the <strong>Bot</strong> page, click <strong>Reset Token</strong> and copy it. To have it read every message in a channel,
                not just mentions, also turn on <strong>Message Content Intent</strong> there.
              </span>
            </li>
            <li>
              <span>Paste the token here.</span>
            </li>
          </>
        ) : (
          <>
            <li>
              <span>
                In Telegram, open <strong>@BotFather</strong> and send <code>/newbot</code>.
              </span>
              <button className="btn btn--sm" onClick={() => void window.api.app.openExternal('https://t.me/BotFather')}>
                <ExternalLink size={13} strokeWidth={1.9} />
                Open BotFather
              </button>
            </li>
            <li>
              <span>Pick a name and a username ending in “bot”.</span>
            </li>
            <li>
              <span>Paste the token BotFather sends you here.</span>
            </li>
          </>
        )}
      </ol>
      <form
        className="ch-token"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <input
          className="input"
          type="password"
          autoFocus={autoFocus}
          spellCheck={false}
          autoComplete="off"
          placeholder={discord ? 'Bot token' : '123456789:ABC…'}
          aria-label={`${CHANNEL_LABEL[link.kind]} bot token`}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <button className="btn btn--primary" type="submit" disabled={!token.trim() || busy}>
          {busy ? 'Checking…' : 'Connect'}
        </button>
      </form>
      {error && <p className="ch-error">{error}</p>}
      <p className="ch-note">The token is stored in your system keychain and never leaves this computer except to talk to {CHANNEL_LABEL[link.kind]}.</p>
    </div>
  )
}

/* --------------------------------------------------------------- pairing */

function Pairing({ link, run }: { link: ChannelLink; run: (work: () => Promise<ChannelLink | void>) => Promise<void> }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  if (link.owner) {
    return (
      <Row title="You" description={`${link.owner.name}. Messages from this account are yours, with every command.`}>
        <button className="btn" onClick={() => void run(() => window.api.channels.resetOwner(link.id))}>
          Change
        </button>
      </Row>
    )
  }
  const username = link.kind === 'telegram' && link.account?.startsWith('@') ? link.account.slice(1) : null
  const copy = (): void => {
    void navigator.clipboard.writeText(`/pair ${link.pairCode}`)
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1600)
  }
  return (
    <div className="row bx-pair">
      <div className="row__body">
        <div className="row__title">Pair your account</div>
        <div className="row__desc">
          {link.kind === 'telegram'
            ? 'Open the bot in Telegram and tap Start, or send it the code. That makes you its owner.'
            : 'Invite the bot to a server you’re in, then send it a direct message with the code. That makes you its owner.'}
        </div>
      </div>
      <div className="row__trail">
        <span className="bx-code" aria-label="Pairing code">
          {link.pairCode}
        </span>
        <button className="icon-btn" aria-label="Copy the pairing message" title="Copy “/pair code”" onClick={copy}>
          {copied ? <Check size={15} strokeWidth={2} /> : <Copy size={15} strokeWidth={1.9} />}
        </button>
        {username && (
          <button className="btn" onClick={() => void window.api.app.openExternal(`https://t.me/${username}?start=${link.pairCode}`)}>
            <ExternalLink size={14} strokeWidth={1.9} />
            Open in Telegram
          </button>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- WhatsApp */

function QrCode({ text, size = 196 }: { text: string; size?: number }): JSX.Element {
  const path = useMemo(() => {
    const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' })
    let d = ''
    for (let y = 0; y < modules.size; y++) {
      for (let x = 0; x < modules.size; x++) if (modules.get(y, x)) d += `M${x} ${y}h1v1h-1z`
    }
    return { d, size: modules.size }
  }, [text])
  // A quiet zone of 3 modules on every side, as scanners expect.
  const box = path.size + 6
  return (
    <svg className="ch-qr" width={size} height={size} viewBox={`-3 -3 ${box} ${box}`} shapeRendering="crispEdges" role="img" aria-label="WhatsApp linking code">
      <rect x={-3} y={-3} width={box} height={box} fill="#fff" />
      <path d={path.d} fill="#111" />
    </svg>
  )
}

function WhatsAppSetup({
  link,
  status,
  onChange
}: {
  link: ChannelLink
  status: ChannelStatus | undefined
  onChange: (patch: { whatsappMode: ChannelLink['whatsappMode'] }) => Promise<void>
}): JSX.Element {
  const linked = status?.state === 'connected'
  return (
    <>
      {!linked && link.enabled && (
        <div className="row row--stack">
          <div className="ch-warn" role="note">
            <TriangleAlert size={15} strokeWidth={2} aria-hidden="true" />
            <span>
              WhatsApp has no bot API for personal accounts or groups, so Eaon links as a device, like WhatsApp Web, through an
              unofficial client. WhatsApp can change things without notice or restrict numbers it thinks are automated. A spare
              number is the safest choice.
            </span>
          </div>
          <div className="ch-link">
            {status?.state === 'scan' && status.qr ? <QrCode text={status.qr} /> : <div className="ch-qr ch-qr--wait">Getting a code…</div>}
            <ol className="bx-steps">
              <li>
                <span>On your phone, open WhatsApp.</span>
              </li>
              <li>
                <span>
                  Go to <strong>Settings → Linked devices</strong> (on Android, the ⋮ menu) and tap <strong>Link a device</strong>.
                </span>
              </li>
              <li>
                <span>Point the camera at this code. It refreshes every so often; scan the one showing.</span>
              </li>
            </ol>
          </div>
        </div>
      )}
      {(linked || link.account) && (
        <Row
          title="Whose number"
          description={
            link.whatsappMode === 'personal'
              ? 'Your own: it answers only when someone starts a message with its name, or in your “Message yourself” chat. Its replies go out from your number, signed with its name.'
              : 'A number just for this worker: it answers every direct message from people you let in, like a bot.'
          }
        >
          <Segmented
            value={link.whatsappMode}
            options={[
              { value: 'personal', label: 'Mine' },
              { value: 'dedicated', label: 'Just for it' }
            ]}
            onChange={(whatsappMode) => void onChange({ whatsappMode })}
          />
        </Row>
      )}
    </>
  )
}

function AddWhatsAppGroup({ link, onAdded }: { link: ChannelLink; onAdded: (link: ChannelLink) => void }): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [groups, setGroups] = useState<WhatsAppGroup[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next) {
      setGroups(null)
      setError(null)
      window.api.channels.whatsappGroups(link.id).then(setGroups, (e) => setError(errorText(e)))
    }
  }
  const available = (groups ?? []).filter((g) => !link.chats.some((c) => c.id === g.id))
  return (
    <>
      <button ref={anchor} className="btn btn--sm" onClick={toggle}>
        <Plus size={13} strokeWidth={2} />
        Add a group
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-end" width={260}>
        {error ? (
          <div className="ch-popover-note">{error}</div>
        ) : !groups ? (
          <div className="ch-popover-note">Loading your groups…</div>
        ) : available.length === 0 ? (
          <div className="ch-popover-note">{groups.length ? 'Every group is added already.' : 'This account isn’t in any groups.'}</div>
        ) : (
          <div className="ch-group-list">
            {available.map((group) => (
              <MenuItem
                key={group.id}
                icon={<UsersRound size={15} strokeWidth={1.9} />}
                title={group.name}
                onClick={() => {
                  setOpen(false)
                  void window.api.channels.addChat(link.id, group.id, group.name).then(onAdded)
                }}
              />
            ))}
          </div>
        )}
      </Popover>
    </>
  )
}

/* ------------------------------------------------------ who may talk to it */

function Access({
  link,
  status,
  run,
  update
}: {
  link: ChannelLink
  status: ChannelStatus | undefined
  run: (work: () => Promise<ChannelLink | void>) => Promise<void>
  update: (patch: Parameters<typeof window.api.channels.update>[1]) => Promise<void>
}): JSX.Element {
  const put = useChannels((s) => s.put)
  const guest = GUEST_ACCESS.find((g) => g.id === link.guestAccess) ?? GUEST_ACCESS[0]
  const groupWord = link.kind === 'discord' ? 'channels' : 'groups'
  const personalWhatsApp = link.kind === 'whatsapp' && link.whatsappMode === 'personal'

  return (
    <>
      {link.requests.length > 0 && (
        <div className="settings__section ch-subsection">
          <div className="settings__section-label">Asking to talk to it</div>
          <Card>
            {link.requests.map((request) => (
              <Row
                key={request.code}
                title={
                  <span className="ch-who">
                    {request.kind === 'person' ? <UserRound size={14} strokeWidth={1.9} /> : <UsersRound size={14} strokeWidth={1.9} />}
                    {request.name}
                  </span>
                }
                description={`“${request.preview}”${request.kind === 'chat' ? ` — lets everyone in this ${link.kind === 'discord' ? 'channel' : 'group'} talk to it` : ''}`}
              >
                <button className="btn btn--sm btn--ghost" onClick={() => void run(() => window.api.channels.dismiss(link.id, request.code))}>
                  Ignore
                </button>
                <button className="btn btn--sm" onClick={() => void run(() => window.api.channels.allow(link.id, request.code))}>
                  Allow
                </button>
              </Row>
            ))}
          </Card>
        </div>
      )}

      <div className="settings__section ch-subsection">
        <div className="settings__section-label">Who can talk to it</div>
        <Card>
          <div className="row row--stack ch-explain">
            <div className="row__desc">
              {personalWhatsApp
                ? 'People who start a message with the worker’s name show up above for you to allow. Everyone you let in talks to the same worker you do, and it remembers your conversations, so give a group its own worker if that matters.'
                : `People who message the bot, and ${groupWord} where someone mentions it, show up above for you to allow — or send /allow and their code from your own account. Everyone you let in talks to the same worker you do, and it remembers your conversations, so give a group its own worker if that matters.`}
            </div>
          </div>
          {link.people.map((person) => (
            <Row
              key={person.id}
              title={
                <span className="ch-who">
                  <UserRound size={14} strokeWidth={1.9} />
                  {person.name}
                </span>
              }
              description={person.level === 'control' ? 'Can also stop, pause, resume and wake it.' : 'Can talk to it.'}
            >
              <Segmented
                value={person.level}
                options={[
                  { value: 'chat', label: 'Talk' },
                  { value: 'control', label: 'Control' }
                ]}
                onChange={(level) => void run(() => window.api.channels.setPersonLevel(link.id, person.id, level))}
              />
              <button className="icon-btn" aria-label={`Remove ${person.name}`} onClick={() => void run(() => window.api.channels.removePerson(link.id, person.id))}>
                <X size={15} strokeWidth={2} />
              </button>
            </Row>
          ))}
          {link.chats.map((chat) => (
            <Row
              key={chat.id}
              title={
                <span className="ch-who">
                  <UsersRound size={14} strokeWidth={1.9} />
                  {chat.name}
                </span>
              }
              description={`Everyone here can talk to it${link.groupReplies === 'all' ? '' : ' when they mention it or start with its name'}.`}
            >
              <button className="icon-btn" aria-label={`Remove ${chat.name}`} onClick={() => void run(() => window.api.channels.removeChat(link.id, chat.id))}>
                <X size={15} strokeWidth={2} />
              </button>
            </Row>
          ))}
          {link.kind === 'whatsapp' && status?.state === 'connected' && (
            <Row title="WhatsApp groups" description="Let the worker answer in a group you’re in.">
              <AddWhatsAppGroup link={link} onAdded={put} />
            </Row>
          )}
        </Card>
      </div>

      <div className="settings__section ch-subsection">
        <div className="settings__section-label">How it behaves</div>
        <Card>
          <Row title="What others can make it do" description={guest.description}>
            <Select<GuestAccess>
              value={link.guestAccess}
              options={GUEST_ACCESS.map((g) => ({ value: g.id, label: g.label }))}
              onChange={(guestAccess) => void update({ guestAccess })}
              width={150}
            />
          </Row>
          <Row
            title={`In ${groupWord}, answer`}
            description={
              link.groupReplies === 'all'
                ? `Every message in the ${groupWord} you allowed.`
                : 'Only when someone mentions it, replies to it, or starts with its name.'
            }
          >
            <Segmented
              value={link.groupReplies}
              options={[
                { value: 'mention', label: 'When called' },
                { value: 'all', label: 'Everything' }
              ]}
              onChange={(groupReplies) => void update({ groupReplies })}
            />
          </Row>
          {link.kind === 'discord' && link.groupReplies === 'all' && status?.readsAllMessages === false && (
            <DiscordContentHint />
          )}
          {link.kind === 'telegram' && link.groupReplies === 'all' && (
            <Row
              title="Turn off privacy mode"
              description="Telegram bots only see group messages meant for them. In @BotFather, send /setprivacy, pick this bot, choose Disable, then remove the bot from the group and add it again."
            />
          )}
          <Row title="Send you its questions and alerts" description={`When it asks you something or has news, it tells you here too — reply with /answer, /approve or /decline.`}>
            <Switch label="Send you its questions and alerts" checked={link.forwardAlerts} onChange={(forwardAlerts) => void update({ forwardAlerts })} />
          </Row>
        </Card>
      </div>
    </>
  )
}

function DiscordContentHint(): JSX.Element {
  return (
    <Row
      title={<Hint>Discord only shows this bot messages that mention it</Hint>}
      description="To answer every message, turn on Message Content Intent on the Bot page of the Developer Portal, then switch this connection off and on."
    >
      <button className="btn btn--sm" onClick={() => void window.api.app.openExternal('https://discord.com/developers/applications')}>
        <ExternalLink size={13} strokeWidth={1.9} />
        Developer Portal
      </button>
    </Row>
  )
}

function Hint({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="ch-who ch-who--warn">
      <TriangleAlert size={14} strokeWidth={2} />
      {children}
    </span>
  )
}
