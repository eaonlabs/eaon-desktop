import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type JSX, type ReactNode } from 'react'
import {
  ArrowUpRight,
  BookOpen,
  Bot,
  CalendarDays,
  Camera,
  Car,
  Check,
  Circle,
  Flag,
  Landmark,
  Lightbulb,
  ListChecks,
  Lock,
  MapPin,
  Monitor,
  Navigation,
  Plug,
  Repeat,
  Send,
  ShieldCheck,
  Speaker,
  Thermometer,
  TrendingDown,
  TrendingUp,
  X,
  Minus,
  type LucideIcon
} from 'lucide-react'
import type { ChatToolPart } from '@shared/types'
import {
  CAMERA_LIVE_MS,
  CARD_IMAGE_MARK,
  normalizeCard,
  ORDER_LABEL,
  ORDER_STEPS,
  PICKUP_STEPS,
  RIDE_LABEL,
  RIDE_STEPS,
  routeLinks,
  type CardAction,
  type CardTone,
  type DeviceKind,
  type WorkerCard
} from '@shared/workerCards'
import { findWorkerApp, signInTarget, workerApp, workerAppsEnabled, type WorkerApp } from '@shared/workerApps'
import { MAIN_THREAD } from '@shared/workers'
import { fileUrl } from '../../lib/files'
import { Modal } from '../ui'
import { appLogoFor } from '../plugins/PluginLogo'
import { WorkerFace } from './WorkerFace'
import { UiCard } from './WorkerUi'
import { errorText, useWorkers } from './workersStore'

/**
 * What a worker shows in its thread besides text: cards (show_card, and the
 * sign-in card request_sign_in makes) and the one-line events for what it did
 * — "Created routine ⏱ Overnight outbound", "Handed the Acme list to ● Chief".
 *
 * They need to know whose thread they are in (to send a card's reply, open
 * its browser, sign it in), which the worker page provides with
 * WorkerThreadContext; outside one (a chat) they draw but their buttons
 * don't act.
 */

export const WorkerThreadContext = createContext<{ workerId: string; threadId: string } | null>(null)

/** The call a card came from, so what was answered on it is remembered (useCardAnswer). */
export const CardIdContext = createContext<string | null>(null)

/**
 * What was answered on each card — the option picked, the button pressed, the
 * switch flipped — by its call's id and which part of it. A card is drawn
 * afresh each time its thread is opened, and an answer already sent must not
 * be offered again. Kept on this computer, the latest few hundred.
 */
const ANSWERS_KEY = 'eaon.workers.cardAnswers'
const MAX_ANSWERS = 400
const answers: Map<string, string> = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(ANSWERS_KEY) ?? '[]')
    return new Map(Array.isArray(saved) ? saved.filter((e): e is [string, string] => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string') : [])
  } catch {
    return new Map()
  }
})()

function useCardAnswer(part: string): [string | null, (answer: string) => void] {
  const card = useContext(CardIdContext)
  const thread = useContext(WorkerThreadContext)
  const key = card && thread ? `${thread.workerId}:${card}:${part}` : null
  const [answer, setAnswer] = useState<string | null>(() => (key ? (answers.get(key) ?? null) : null))
  const remember = (value: string): void => {
    setAnswer(value)
    if (!key) return
    answers.delete(key)
    answers.set(key, value)
    while (answers.size > MAX_ANSWERS) answers.delete(answers.keys().next().value as string)
    try {
      localStorage.setItem(ANSWERS_KEY, JSON.stringify([...answers]))
    } catch {
      /* storage full or off: remembered until the app closes */
    }
  }
  return [answer, remember]
}

const TONE_LABEL: Record<CardTone, string> = {
  done: 'Done',
  action: 'Action needed',
  working: 'Working',
  failed: 'Failed',
  info: 'Info',
  submitted: 'Submitted'
}

/** A card in the thread, from a show_card or request_sign_in call. */
export function WorkerCardRow({ part }: { part: ChatToolPart }): JSX.Element | null {
  // A sign-in request is a linked app's (labs): a build without them has nothing to sign in with.
  if (part.name === 'request_sign_in') return workerAppsEnabled() ? <SignInCard part={part} /> : null
  if (part.name === 'show_ui')
    return (
      <CardIdContext.Provider value={part.id}>
        <UiCard input={part.input} />
      </CardIdContext.Provider>
    )
  const input = part.input.card && typeof part.input.card === 'object' ? part.input.card : part.input
  const result = normalizeCard(input)
  if ('error' in result) return null
  // The picture the tool resolved (a screenshot it took, a file in the worker's folder).
  const image = (part.output && CARD_IMAGE_MARK.exec(part.output)?.[1]) ?? null
  return (
    <CardIdContext.Provider value={part.id}>
      <CardView card={result.card} image={image} />
    </CardIdContext.Provider>
  )
}

export function CardView({ card, image }: { card: WorkerCard; image: string | null }): JSX.Element {
  const app = 'app' in card && card.app ? findWorkerApp(card.app) : undefined
  return (
    <article className="wcard" data-kind={card.kind}>
      {renderCard(card, image, app)}
    </article>
  )
}

/*
 * Every card follows one rhythm: an eyebrow line (the app's mark and name,
 * a status at the end), one hero line — the number or name that matters —
 * the details beneath it in quieter type, and quiet buttons last. Surfaces
 * are hairline-edged rather than filled, inner radii are concentric with the
 * card's, and colour is spent only on state: a stage reached, a light that
 * is on, traffic that is heavy.
 */

function renderCard(card: WorkerCard, image: string | null, app: WorkerApp | undefined): ReactNode {
  switch (card.kind) {
    case 'status':
      return (
        <>
          {(image ?? card.image) && <Media path={(image ?? card.image)!} />}
          <div className="wcard__head">
            <span className="wcard__title">{card.title}</span>
            {card.badge && <Badge tone={card.badge.tone} label={card.badge.label} />}
          </div>
          {card.body && <p className="wcard__body">{card.body}</p>}
          <Actions actions={card.actions} />
        </>
      )
    case 'checklist':
      return (
        <>
          {card.title && <Eyebrow label={card.title} />}
          <ul className="wsteps">
            {card.items.map((item, i) => (
              <li key={i} data-state={item.state}>
                <span className="wcheck" data-state={item.state} aria-label={item.state}>
                  {item.state === 'done' ? (
                    <Check size={11} strokeWidth={3} />
                  ) : item.state === 'failed' ? (
                    <X size={11} strokeWidth={3} />
                  ) : item.state === 'skipped' ? (
                    <Minus size={11} strokeWidth={3} />
                  ) : null}
                </span>
                <span className="wsteps__text">
                  <span className="wsteps__label">{item.label}</span>
                  {item.detail && <span className="wsteps__detail">{item.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )
    case 'order': {
      const pickup = card.stage === 'ready' || card.stage === 'picked-up' || app?.category === 'pickup'
      const steps = pickup ? PICKUP_STEPS : ORDER_STEPS
      const finished = card.stage === 'delivered' || card.stage === 'picked-up'
      const count = card.items.reduce((n, item) => n + (item.qty ?? 1), 0)
      return (
        <>
          <Eyebrow app={app} label={app ? undefined : 'Order'}>
            <Badge tone={card.stage === 'cancelled' ? 'failed' : finished ? 'done' : card.stage === 'cart' ? 'action' : 'working'} label={ORDER_LABEL[card.stage]} />
          </Eyebrow>
          <div className="whero">
            <span className="whero__value">{card.eta ? (finished ? card.eta : card.eta.replace(/^arrives\s+/i, '')) : ORDER_LABEL[card.stage]}</span>
            <span className="whero__meta">
              {card.eta && !finished ? `${pickup ? 'Ready' : 'Arriving'} · ` : ''}
              {card.store}
              {count > 0 ? ` · ${count} item${count === 1 ? '' : 's'}` : ''}
            </span>
          </div>
          {card.stage !== 'cart' && card.stage !== 'cancelled' && <Stepper steps={steps.map((s) => ORDER_LABEL[s])} at={steps.indexOf(card.stage)} />}
          {card.items.length > 0 && (
            <ul className="wlines">
              {card.items.map((item, i) => (
                <li key={i}>
                  {item.qty && item.qty > 1 ? <span className="wlines__qty">{item.qty}</span> : <span className="wlines__qty">1</span>}
                  <span className="wlines__name">{item.name}</span>
                  {item.price && <span className="wlines__price">{item.price}</span>}
                </li>
              ))}
              {card.total && (
                <li className="wlines__total">
                  <span className="wlines__name">Total</span>
                  <span className="wlines__price">{card.total}</span>
                </li>
              )}
            </ul>
          )}
          <Actions actions={card.actions} />
        </>
      )
    }
    case 'ride':
      return (
        <>
          <Eyebrow app={app} label={app ? undefined : 'Ride'}>
            <Badge tone={card.stage === 'cancelled' ? 'failed' : card.stage === 'dropped-off' ? 'done' : card.stage === 'quote' ? 'info' : 'working'} label={RIDE_LABEL[card.stage]} />
          </Eyebrow>
          <div className="whero whero--split">
            <span>
              <span className="whero__value">{card.eta ?? RIDE_LABEL[card.stage]}</span>
              {card.eta && <span className="whero__meta">{card.stage === 'on-trip' ? 'to drop-off' : card.stage === 'dropped-off' ? 'trip' : card.stage === 'quote' ? 'wait for a pickup' : 'until pickup'}</span>}
            </span>
            {card.price && <span className="whero__aside">{card.price}</span>}
          </div>
          <Trip from={card.from} to={card.to} />
          {card.stage !== 'quote' && card.stage !== 'cancelled' && <Stepper steps={RIDE_STEPS.map((s) => RIDE_STEP_LABEL[s])} at={RIDE_STEPS.indexOf(card.stage)} />}
          {(card.driver || card.car || card.plate) && (
            <div className="wdriver">
              <span className="wavatar">{initials(card.driver ?? 'Driver')}</span>
              <span className="wdriver__text">
                <span className="wcard__title wcard__title--small">{card.driver ?? 'Your driver'}</span>
                {card.car && <span className="whero__meta">{card.car}</span>}
              </span>
              {card.plate && <span className="wplate">{card.plate}</span>}
            </div>
          )}
          <Actions actions={card.actions} />
        </>
      )
    case 'route': {
      const links = routeLinks(card)
      return (
        <>
          <Eyebrow icon={Navigation} label={{ drive: 'Drive', walk: 'Walk', transit: 'Transit', bike: 'Bike' }[card.mode]}>
            {card.traffic && (
              <Badge tone={card.traffic === 'light' ? 'done' : card.traffic === 'moderate' ? 'action' : 'failed'} label={card.traffic === 'light' ? 'Light traffic' : card.traffic === 'moderate' ? 'Some traffic' : 'Heavy traffic'} />
            )}
          </Eyebrow>
          <div className="whero">
            <span className="whero__value">{card.duration ?? 'Route'}</span>
            <span className="whero__meta">{[card.distance, card.via ? `via ${card.via}` : null, card.leaveBy ? `leave by ${card.leaveBy}` : null].filter(Boolean).join(' · ')}</span>
          </div>
          <Trip from={card.from} to={card.to} end="pin" />
          <div className="wcard-actions">
            <LinkButton url={links.google} label="Google Maps" logo="googlemaps.png" />
            <LinkButton url={links.waze} label="Waze" logo="waze.png" />
          </div>
        </>
      )
    }
    case 'payment':
      return (
        <>
          <Eyebrow app={app} label={app ? undefined : 'Payment'}>
            <Badge
              tone={card.state === 'sent' ? 'done' : card.state === 'failed' ? 'failed' : card.state === 'needs-approval' ? 'action' : 'info'}
              label={card.state === 'sent' ? (card.direction === 'request' ? 'Requested' : 'Sent') : card.state === 'needs-approval' ? 'Needs your OK' : card.state === 'failed' ? 'Failed' : 'Draft'}
            />
          </Eyebrow>
          <div className="wpay">
            <span className="wavatar">{initials(card.to)}</span>
            <span className="wpay__who">
              <span className="whero__meta">{card.direction === 'request' ? 'Request from' : 'Pay'}</span>
              <span className="wcard__title">{card.to}</span>
            </span>
            <span className="whero__value">{card.amount}</span>
          </div>
          {card.note && <p className="wnote">{card.note}</p>}
          <Actions actions={card.actions} />
        </>
      )
    case 'device':
      return <DeviceCard card={card} app={app} />
    case 'camera':
      // A Home Assistant camera (labs): what it sees now, and its live view.
      if (card.entity && workerAppsEnabled())
        return (
          <>
            <CameraView entity={card.entity} title={card.title} at={card.at} image={image ?? card.image ?? null} />
            {card.caption && <p className="wcard__body">{card.caption}</p>}
            <Actions actions={card.actions} />
          </>
        )
      return (
        <>
          {(image ?? card.image) ? (
            <Media path={(image ?? card.image)!} label={card.title} at={card.at} />
          ) : (
            <>
              <Eyebrow app={app} label={app ? undefined : 'Camera'}>
                {card.at && <span className="wcard__time">{card.at}</span>}
              </Eyebrow>
              <div className="wdevice">
                <span className="wdevice__icon">
                  <Camera size={19} strokeWidth={1.75} />
                </span>
                <span className="wdevice__text">
                  <span className="wcard__title">{card.title}</span>
                  <span className="whero__meta">No snapshot attached</span>
                </span>
              </div>
            </>
          )}
          {card.caption && <p className="wcard__body">{card.caption}</p>}
          <Actions actions={card.actions} />
        </>
      )
    case 'list':
      return <ListCard card={card} />
    case 'events':
      return (
        <>
          <Eyebrow icon={CalendarDays} label={card.title ?? 'Coming up'} />
          <ol className="wagenda">
            {card.events.map((event, i) => (
              <li key={i}>
                <span className="wagenda__when">{event.when}</span>
                <span className="wagenda__what">
                  <span className="wagenda__title">{event.title}</span>
                  {event.where && <span className="whero__meta">{event.where}</span>}
                </span>
              </li>
            ))}
          </ol>
        </>
      )
    case 'options':
      return <OptionsCard card={card} />
    case 'stats':
      return (
        <>
          {card.title && <Eyebrow label={card.title} />}
          <div className="wstats" style={{ ['--n' as string]: Math.min(card.stats.length, 3) }}>
            {card.stats.map((stat, i) => (
              <div key={i} className="wstat">
                <span className="wstat__label">{stat.label}</span>
                <span className="wstat__value">{stat.value}</span>
                {stat.trend && (
                  <span className="wstat__trend" data-trend={stat.trend}>
                    {stat.trend === 'up' ? <TrendingUp size={12} strokeWidth={2} /> : <TrendingDown size={12} strokeWidth={2} />}
                    {stat.trend === 'up' ? 'Up' : 'Down'}
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )
  }
}

/** A ride's stages, short enough for five to sit side by side. */
const RIDE_STEP_LABEL: Record<string, string> = { requesting: 'Requested', matched: 'Matched', arriving: 'Arriving', 'on-trip': 'On trip', 'dropped-off': 'Arrived' }

const DEVICE_ICON: Record<DeviceKind, LucideIcon> = {
  light: Lightbulb,
  vacuum: Bot,
  car: Car,
  lock: Lock,
  thermostat: Thermometer,
  camera: Camera,
  plug: Plug,
  speaker: Speaker,
  other: Circle
}

const DEVICE_LABEL: Record<DeviceKind, string> = {
  light: 'Light',
  vacuum: 'Vacuum',
  car: 'Car',
  lock: 'Lock',
  thermostat: 'Thermostat',
  camera: 'Camera',
  plug: 'Plug',
  speaker: 'Speaker',
  other: 'Device'
}

/** What a device's level measures. */
const LEVEL_LABEL: Partial<Record<DeviceKind, string>> = { light: 'Brightness', vacuum: 'Battery', car: 'Charge', thermostat: 'Target', speaker: 'Volume' }

/**
 * A device, like a tile in a home app: its icon lit when it's on, its name
 * and state, a switch, a slim meter for its level, its facts in a quiet
 * grid, and any other actions. The switch flips a Hue light or a Home
 * Assistant light, switch or fan itself when the card names one (control);
 * anything else it asks the worker to flip.
 */
function DeviceCard({ card, app }: { card: Extract<WorkerCard, { kind: 'device' }>; app: WorkerApp | undefined }): JSX.Element {
  const act = useCardAction()
  const thread = useContext(WorkerThreadContext)
  const [flipped, setFlipped] = useCardAnswer('switch')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; failed?: boolean } | null>(null)
  const on = flipped === null ? card.on : flipped === 'on'
  const Icon = DEVICE_ICON[card.device]
  const direct = workerAppsEnabled() && card.control ? card.control : null
  const flip = (): void => {
    const next = !on
    if (!direct) {
      setFlipped(next ? 'on' : 'off')
      act({ label: next ? 'Turn on' : 'Turn off', reply: `Turn ${next ? 'on' : 'off'} the ${card.name}` })
      return
    }
    setBusy(true)
    setNote(null)
    window.api.workers
      .deviceSwitch(direct, next)
      .then(() => {
        setFlipped(next ? 'on' : 'off')
        setNote({ text: `Turned ${next ? 'on' : 'off'}.` })
      })
      .catch((error: unknown) => setNote({ text: errorText(error), failed: true }))
      .finally(() => setBusy(false))
  }
  return (
    <>
      <Eyebrow app={app} label={app ? undefined : DEVICE_LABEL[card.device]} />
      <div className="wdevice">
        <span className="wdevice__icon" data-device={card.device} data-on={on === undefined ? undefined : String(on)}>
          <Icon size={19} strokeWidth={1.75} />
        </span>
        <span className="wdevice__text">
          <span className="wcard__title">{card.name}</span>
          {/* Flipped here since the worker drew it: what it is now, not what the worker saw. */}
          {(flipped !== null || card.state) && <span className="whero__meta">{flipped !== null ? (on ? 'On' : 'Off') : card.state}</span>}
        </span>
        {on !== undefined && (
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={`${card.name}: ${on ? 'on' : 'off'}`}
            className="wswitch"
            data-device={card.device}
            disabled={busy || (!thread && !direct)}
            data-busy={busy || undefined}
            onClick={flip}
          >
            <span className="wswitch__knob" />
          </button>
        )}
      </div>
      {note && (
        <span className="wdevice__note" data-failed={note.failed || undefined} role="status">
          {note.text}
          {note.failed && thread && (
            <>
              {' '}
              <button type="button" className="link-btn" onClick={() => act({ label: 'Ask', reply: `Turn ${on ? 'off' : 'on'} the ${card.name}` })}>
                Ask the worker instead
              </button>
            </>
          )}
        </span>
      )}
      {card.level !== undefined && <Meter label={LEVEL_LABEL[card.device] ?? 'Level'} value={card.level} warm={card.device === 'light'} />}
      {card.stats && (
        <dl className="wfacts">
          {card.stats.map((stat, i) => (
            <div key={i}>
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <Actions actions={card.actions} />
    </>
  )
}

/** The top line of a card: the app's mark and name (or an icon and a label), with a status at the end. */
function Eyebrow({ app, label, icon: Icon, children }: { app?: WorkerApp; label?: string; icon?: LucideIcon; children?: ReactNode }): JSX.Element {
  return (
    <div className="wcard-eyebrow">
      {app ? <AppMark app={app} tiny /> : Icon ? <Icon size={14} strokeWidth={1.75} className="wcard-eyebrow__icon" /> : null}
      <span className="wcard-eyebrow__label">{app?.name ?? label}</span>
      {children && <span className="wcard-eyebrow__end">{children}</span>}
    </div>
  )
}

function Badge({ tone, label }: { tone: CardTone; label: string }): JSX.Element {
  return (
    <span className="wbadge" data-tone={tone}>
      <span className="wbadge__dot" />
      {label || TONE_LABEL[tone]}
    </span>
  )
}

/** The stages of an order or a ride as a labelled track: done, now (pulsing), to come. */
function Stepper({ steps, at }: { steps: string[]; at: number }): JSX.Element {
  return (
    <ol className="wstepper" style={{ ['--n' as string]: steps.length }} aria-label={`Step ${at + 1} of ${steps.length}: ${steps[at] ?? ''}`}>
      {steps.map((step, i) => (
        <li key={step} data-state={i < at ? 'past' : i === at ? 'now' : 'next'}>
          <span className="wstepper__dot" />
          <span className="wstepper__label">{step}</span>
        </li>
      ))}
    </ol>
  )
}

/** From → to, joined by a dotted line; the end a square stop or a pin. */
function Trip({ from, to, end = 'stop' }: { from: string; to: string; end?: 'stop' | 'pin' }): JSX.Element {
  return (
    <div className="wtrip">
      <span className="wtrip__row">
        <span className="wtrip__mark wtrip__mark--start" />
        <span className="wtrip__place">{from}</span>
      </span>
      <span className="wtrip__row">
        {end === 'pin' ? <MapPin size={14} strokeWidth={2} className="wtrip__pin" /> : <span className="wtrip__mark wtrip__mark--end" />}
        <span className="wtrip__place">{to}</span>
      </span>
    </div>
  )
}

/** A level as a slim meter with its label and value above it. */
function Meter({ label, value, warm }: { label: string; value: number; warm?: boolean }): JSX.Element {
  return (
    <div className="wmeter" data-warm={warm || undefined}>
      <span className="wmeter__head">
        <span>{label}</span>
        <span className="wmeter__value">{value}%</span>
      </span>
      <span className="wmeter__track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-label={label}>
        <span className="wmeter__fill" style={{ width: `${value}%` }} />
      </span>
    </div>
  )
}

/** A picture across the top of the card, opened full size on click; a camera's name and time over its foot. */
function Media({ path, label, at }: { path: string; label?: string; at?: string }): JSX.Element {
  return (
    <button className="wmedia" onClick={() => void window.api.library.open(path).catch(() => {})} title="Open the picture">
      <img src={fileUrl(path)} alt={label ?? ''} loading="lazy" />
      {label && (
        <span className="wmedia__caption">
          <span className="wmedia__live" />
          <span className="wmedia__label">{label}</span>
          {at && <span className="wmedia__at">{at}</span>}
        </span>
      )}
    </button>
  )
}

/** How often a camera that can't stream is asked for a fresh picture while it's watched. */
const STILL_EVERY_MS = 2000

/**
 * A Home Assistant camera on a card (main/features/workers/cameraView.ts):
 * the picture the worker attached, or what the camera sees now, and "Watch
 * live" for its stream. A camera that can't stream (a Ring doorbell between
 * events, often) is shown as a picture a couple of seconds fresh instead.
 */
function CameraView({ entity, title, at, image }: { entity: string; title: string; at?: string; image: string | null }): JSX.Element {
  const [live, setLive] = useState(false)
  const [stills, setStills] = useState(false)
  const [tick, setTick] = useState(() => Date.now())
  const [problem, setProblem] = useState<string | null>(null)
  const picture = useRef<HTMLImageElement>(null)
  // A live view is one long request: Chromium keeps loading a removed <img>'s, so
  // leaving clears it, and Home Assistant's stream ends with it (cameraView.ts).
  useEffect(() => {
    const node = picture.current
    return () => {
      if (node) node.src = ''
    }
  }, [])
  useEffect(() => {
    if (!live || !stills) return
    const timer = setInterval(() => setTick(Date.now()), STILL_EVERY_MS)
    return () => clearInterval(timer)
  }, [live, stills])
  // Main ends a live view after CAMERA_LIVE_MS, which would leave its last frame up still saying "live":
  // the card goes back to a picture then, and Watch live starts it again.
  useEffect(() => {
    if (!live) return
    const timer = setTimeout(() => {
      setLive(false)
      setTick(Date.now())
    }, CAMERA_LIVE_MS)
    return () => clearTimeout(timer)
  }, [live])
  const src = live
    ? stills
      ? `eaon-camera://still/${entity}?t=${tick}`
      : `eaon-camera://live/${entity}?t=${tick}`
    : image
      ? fileUrl(image)
      : `eaon-camera://still/${entity}?t=${tick}`
  const watch = (): void => {
    setProblem(null)
    setStills(false)
    setTick(Date.now())
    setLive(true)
  }
  return (
    <div className="wmedia wmedia--camera" data-live={live || undefined}>
      <img
        ref={picture}
        src={src}
        alt={title}
        onError={() => {
          if (live && !stills) {
            setStills(true)
            setTick(Date.now())
          } else if (!image) setProblem('The camera isn’t answering. Is Home Assistant reachable?')
        }}
        onLoad={() => setProblem(null)}
      />
      <span className="wmedia__caption">
        {live && <span className="wmedia__live" />}
        <span className="wmedia__label">{live ? `${title} · ${stills ? 'every 2 s' : 'live'}` : title}</span>
        {!live && at && <span className="wmedia__at">{at}</span>}
        <button type="button" className="wmedia__watch" onClick={live ? () => setLive(false) : watch}>
          {live ? 'Stop' : 'Watch live'}
        </button>
      </span>
      {problem && <span className="wmedia__problem">{problem}</span>}
    </div>
  )
}

/** A link out — Google Maps, Waze — with the service's icon. */
function LinkButton({ url, label, logo }: { url: string; label: string; logo?: string }): JSX.Element {
  const art = appLogoFor(logo)
  return (
    <button className="wbtn" onClick={() => void window.api.app.openExternal(url)}>
      {art && <img className="wbtn__art" src={art} alt="" draggable={false} />}
      {label}
      <ArrowUpRight size={13} strokeWidth={2} className="wbtn__out" />
    </button>
  )
}

const initials = (name: string): string => {
  const words = name.replace(/^[@$]/, '').trim().split(/\s+/).filter(Boolean)
  return ((words[0]?.[0] ?? '?') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase()
}

/** Apps with no logo of their own get a plain icon for what they are, not an imitation of a logo. */
const APP_ICON: Partial<Record<string, LucideIcon>> = { bank: Landmark, lists: ListChecks }

/**
 * An app's mark: its own icon, in its real colours; else, on a tile of its
 * colour, an icon for what it is (a bank), else its initials.
 */
export function AppMark({ app, fallback, icon: Icon, small, tiny }: { app: WorkerApp | undefined; fallback?: string; icon?: LucideIcon; small?: boolean; tiny?: boolean }): JSX.Element {
  const art = appLogoFor(app?.logo)
  if (art) {
    return (
      <span className="app-mark app-mark--art" data-small={small || undefined} data-tiny={tiny || undefined} aria-hidden="true">
        <img src={art} alt="" draggable={false} />
      </span>
    )
  }
  const Generic = app ? APP_ICON[app.id] : undefined
  const color = app?.color ?? 'var(--surface-3, #3a3a3c)'
  const ink = app && isLight(app.color) ? '#16181c' : '#ffffff'
  return (
    <span className="app-mark" data-small={small || undefined} data-tiny={tiny || undefined} style={{ background: color, color: ink }} aria-hidden="true">
      {Generic ? (
        <Generic size={tiny ? 11 : small ? 13 : 18} strokeWidth={2.2} />
      ) : app ? (
        app.mark
      ) : Icon ? (
        <Icon size={16} strokeWidth={2} />
      ) : (
        (fallback ?? '?').slice(0, 2)
      )}
    </span>
  )
}

/** A colour light enough that a white mark on it would wash out. */
function isLight(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return false
  const n = parseInt(m[1], 16)
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 186
}

/** What a card's buttons do, in the thread they are in. */
function useCardAction(): (action: CardAction) => void {
  const thread = useContext(WorkerThreadContext)
  const [, setSignIn] = useSignInSheet()
  return (action) => {
    if (action.url) {
      void window.api.app.openExternal(action.url)
      return
    }
    if (!thread) return
    if (action.reply) void useWorkers.getState().send(thread.workerId, action.reply, [], thread.threadId === MAIN_THREAD ? {} : { threadId: thread.threadId })
    else if (action.browser) useWorkers.getState().setBrowser(thread.workerId)
    else if (action.signIn) {
      const app = findWorkerApp(action.signIn)
      if (app) setSignIn({ workerId: thread.workerId, threadId: thread.threadId, appId: app.id })
    }
  }
}

/**
 * A card's buttons, quiet by default: the one marked primary (or the only
 * one) is solid; a reply, once sent, marks the chosen button and settles the
 * rest. Links out carry an arrow.
 */
export function Actions({ actions, slot = 'actions' }: { actions?: CardAction[]; slot?: string }): JSX.Element | null {
  const act = useCardAction()
  const [done, setDone] = useCardAnswer(slot)
  if (!actions || actions.length === 0) return null
  return (
    <div className="wcard-actions">
      {actions.map((action, i) => (
        <button
          key={i}
          className="wbtn"
          data-primary={action.primary || actions.length === 1 || undefined}
          data-picked={done === action.label || undefined}
          disabled={Boolean(done) && Boolean(action.reply)}
          onClick={() => {
            if (action.reply) setDone(action.label)
            act(action)
          }}
        >
          {done === action.label && <Check size={13} strokeWidth={2.4} />}
          {action.label}
          {action.url && <ArrowUpRight size={13} strokeWidth={2} className="wbtn__out" />}
        </button>
      ))}
    </div>
  )
}

function OptionsCard({ card }: { card: Extract<WorkerCard, { kind: 'options' }> }): JSX.Element {
  const act = useCardAction()
  const [answer, setAnswer] = useCardAnswer('options')
  const picked = answer === null ? null : Number(answer)
  return (
    <>
      <div className="wcard__head">
        <span className="wcard__title">{card.title}</span>
      </div>
      <div className="wchoices" role="radiogroup" aria-label={card.title}>
        {card.options.map((option, i) => (
          <button
            key={i}
            role="radio"
            aria-checked={picked === i}
            className="wchoice"
            data-picked={picked === i || undefined}
            disabled={picked !== null && picked !== i}
            onClick={() => {
              if (picked !== null) return
              setAnswer(String(i))
              act({ label: option.title, reply: option.reply })
            }}
          >
            <span className="wchoice__radio" />
            <span className="wchoice__text">
              <span className="wchoice__title">{option.title}</span>
              {option.detail && <span className="whero__meta">{option.detail}</span>}
            </span>
            {option.price && <span className="wchoice__price">{option.price}</span>}
          </button>
        ))}
      </div>
    </>
  )
}

/** A list card: live and tickable when it is one of the shared lists, as it was when shown otherwise. */
function ListCard({ card }: { card: Extract<WorkerCard, { kind: 'list' }> }): JSX.Element {
  const live = useWorkers((s) => (card.listId ? s.lists.find((l) => l.id === card.listId) : undefined))
  useEffect(() => {
    if (card.listId) void useWorkers.getState().loadLists()
  }, [card.listId])
  const items = live ? live.items.map((i) => ({ id: i.id, text: i.text, done: i.done })) : card.items.map((i, n) => ({ id: String(n), text: i.text, done: i.done === true }))
  const left = items.filter((i) => !i.done).length
  return (
    <>
      <Eyebrow icon={ListChecks} label={live?.name ?? card.title}>
        <span className="wcard__time">{left === 0 ? 'All done' : `${left} of ${items.length} left`}</span>
      </Eyebrow>
      <ul className="wlist">
        {items.map((item) => (
          <li key={item.id} data-done={item.done || undefined}>
            <label>
              <input
                type="checkbox"
                checked={item.done}
                disabled={!live}
                onChange={(e) => live && void window.api.workers.listToggle(live.id, item.id, e.target.checked)}
              />
              <span className="wlist__box">
                <Check size={11} strokeWidth={3} />
              </span>
              <span className="wlist__text">{item.text}</span>
            </label>
          </li>
        ))}
      </ul>
    </>
  )
}

/* ---------------------------------------------------------------- Sign-in */

/**
 * The sign-in sheet, open for one app of one worker at a time; shared so a
 * card's Continue and an app chip's Sign in open the same sheet.
 */
type SignInTarget = { workerId: string; threadId: string; appId: string } | null
let signInState: SignInTarget = null
const signInListeners = new Set<(target: SignInTarget) => void>()
function setSignInSheet(target: SignInTarget): void {
  signInState = target
  for (const listener of signInListeners) listener(target)
}
export function useSignInSheet(): [SignInTarget, (target: SignInTarget) => void] {
  const [target, setTarget] = useState(signInState)
  useEffect(() => {
    signInListeners.add(setTarget)
    return () => void signInListeners.delete(setTarget)
  }, [])
  return [target, setSignInSheet]
}

/** "Action needed · Uber sign-in · Continue", and once it is done, "Submitted · Login saved." */
function SignInCard({ part }: { part: ChatToolPart }): JSX.Element | null {
  const thread = useContext(WorkerThreadContext)
  const app = findWorkerApp(String(part.input.app ?? ''))
  const link = useWorkers((s) => (thread && app ? s.workers.find((w) => w.id === thread.workerId)?.apps.find((a) => a.id === app.id) : undefined))
  const [, open] = useSignInSheet()
  if (!app) return null
  const target = signInTarget(app, link ?? null)
  const host = target ? hostName(target.url) : app.name
  const signedIn = link?.signedIn === 'yes'
  const reason = typeof part.input.reason === 'string' && part.input.reason.trim() ? part.input.reason.trim() : `Sign in to ${host}`
  return (
    <article className="wcard wcard--signin" data-kind="signin">
      <Eyebrow app={app}>
        <Badge tone={signedIn ? 'submitted' : 'action'} label={signedIn ? 'Signed in' : 'Action needed'} />
      </Eyebrow>
      <div className="wcard__head">
        <span className="wcard__title wcard__title--large">{signedIn ? `Signed in to ${app.name}` : `Sign in to ${app.name}`}</span>
      </div>
      <p className="wcard__body">{signedIn ? `Login saved${link?.account ? ` for ${link.account}` : ''}. Picking up where it left off.` : reason}</p>
      {!signedIn && (
        <p className="wsecure">
          <ShieldCheck size={13} strokeWidth={1.75} />
          Typed only into {host}. The worker never sees your password.
        </p>
      )}
      {!signedIn && thread && link && (
        <button className="wbtn wbtn--block" data-primary onClick={() => open({ workerId: thread.workerId, threadId: thread.threadId, appId: app.id })}>
          Continue
        </button>
      )}
    </article>
  )
}

const hostName = (url: string): string => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/**
 * Signing a worker in to one of its apps, like a password manager would:
 * the user types their login here and it is typed straight into the app's
 * sign-in page in the worker's browser — only if that page is on the app's
 * own site — and goes no further. Or they open the worker's browser and sign
 * in themselves (the monitor button), then say they're done.
 */
export function SignInSheet(): JSX.Element | null {
  return workerAppsEnabled() ? <AppSignInSheet /> : null
}

function AppSignInSheet(): JSX.Element | null {
  const [target, setTarget] = useSignInSheet()
  const worker = useWorkers((s) => (target ? s.workers.find((w) => w.id === target.workerId) : undefined))
  const app = target ? workerApp(target.appId) : undefined
  const link = worker?.apps.find((a) => a.id === target?.appId)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [byHand, setByHand] = useState(false)
  const [remember, setRemember] = useState(true)
  useEffect(() => {
    setUsername(link?.account ?? '')
    setPassword('')
    setMessage(null)
    setByHand(false)
    setBusy(false)
    // A new target only; the link changing under an open sheet keeps what was typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.workerId, target?.appId])
  if (!target || !worker || !app) return null
  const where = signInTarget(app, link ?? null)
  const host = where ? hostName(where.url) : app.name
  const close = (): void => setTarget(null)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy || !password) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await window.api.workers.appSignIn(worker.id, app.id, { username, password, remember: remember && workerAppsEnabled() }, target.threadId)
      setPassword('')
      setMessage({ ok: result.ok, text: result.message })
      if (result.ok) setTimeout(close, 1200)
    } catch (error) {
      setMessage({ ok: false, text: errorText(error) })
    } finally {
      setBusy(false)
    }
  }

  const openBrowser = async (): Promise<void> => {
    setByHand(true)
    setMessage(null)
    try {
      await window.api.workers.appBrowser(worker.id, app.id)
      useWorkers.getState().setBrowser(worker.id)
    } catch (error) {
      setMessage({ ok: false, text: errorText(error) })
    }
  }

  return (
    <Modal open onClose={close} title={`${app.name} sign-in`} width={460}>
      <div className="signin-sheet">
        {byHand ? (
          <div className="signin-sheet__hand">
            <p>
              {worker.name}’s browser is open on {host}. Sign in there, then come back and tell {worker.name} you’re done.
            </p>
            <button
              className="wcard-continue"
              onClick={() => {
                void window.api.workers.appSignedIn(worker.id, app.id, target.threadId)
                close()
              }}
            >
              I’ve signed in
            </button>
            <button className="btn btn--ghost" onClick={() => setByHand(false)}>
              Type it here instead
            </button>
          </div>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <p className="signin-sheet__lead">Sign in to {host}</p>
            <label className="signin-sheet__field">
              <span>Username</span>
              <input className="signin-sheet__input" autoFocus autoComplete="username" placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label className="signin-sheet__field">
              <span>Password *</span>
              <input className="signin-sheet__input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="signin-sheet__remember">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Save to the vault, so {worker.name} signs itself in next time
            </label>
            <p className="signin-sheet__note">
              <ShieldCheck size={16} strokeWidth={1.9} />
              Fills only the page open in the browser at {host}. {worker.name} never sees your password.
            </p>
            {message && (
              <p className="signin-sheet__message" data-ok={message.ok || undefined} role="status">
                {message.text}
              </p>
            )}
            <button className="wcard-continue" type="submit" disabled={busy || !password}>
              {busy ? 'Signing in…' : 'Continue'}
            </button>
            <button type="button" className="signin-sheet__browser" onClick={() => void openBrowser()}>
              <Monitor size={16} strokeWidth={1.9} />
              Sign in yourself in {worker.name}’s browser
            </button>
          </form>
        )}
      </div>
    </Modal>
  )
}

/* ---------------------------------------------------------------- Events */

/** One centred line for something a worker did: a routine created, a job handed over, a colleague messaged. */
export function WorkerEventLine({ part }: { part: ChatToolPart }): JSX.Element | null {
  const input = part.input
  const s = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string).trim() : '')
  const colleague = useWorkers((st) => {
    const name = s('to').toLowerCase()
    return name ? st.workers.find((w) => w.name.toLowerCase() === name) : undefined
  })
  const who = (name: string): JSX.Element => (
    <span className="wevent__who" style={colleague ? { ['--who' as string]: colleague.color } : undefined}>
      {colleague && <WorkerFace color={colleague.color} shape={colleague.shape} size={18} />}
      {colleague?.name ?? name}
    </span>
  )
  let content: ReactNode
  switch (part.name) {
    case 'add_routine':
      content = (
        <>
          Created routine <Repeat size={15} strokeWidth={2} /> <strong>{s('name')}</strong>
        </>
      )
      break
    case 'remove_routine':
      content = (
        <>
          Stopped routine <strong>{s('name')}</strong>
        </>
      )
      break
    case 'create_worker':
      content = (
        <>
          Created{' '}
          <span className="wevent__who" style={s('color') ? { ['--who' as string]: s('color') } : undefined}>
            <WorkerFace color={s('color') || '#6B7280'} size={18} mood="happy" />
            {s('name')}
          </span>
        </>
      )
      break
    case 'hand_off':
      content = (
        <>
          Handed <Send size={14} strokeWidth={2} /> “{clip(s('task'), 60)}” to {who(s('to'))}
        </>
      )
      break
    case 'message_worker':
      content = <>Messaged {who(s('to'))}</>
      break
    case 'post_to_room':
      content = (
        <>
          Posted in <strong>{s('room')}</strong>
        </>
      )
      break
    case 'save_playbook':
      content = (
        <>
          {input.remove === true ? 'Removed playbook' : 'Saved playbook'} <BookOpen size={14} strokeWidth={2} /> <strong>{s('name')}</strong>
        </>
      )
      break
    case 'set_goal':
      if (!s('goal')) return null
      content = (
        <>
          <Flag size={14} strokeWidth={2} /> Goal: <strong>{clip(s('goal'), 80)}</strong>
        </>
      )
      break
    default:
      return null
  }
  return (
    <div className="wevent" data-running={part.status === 'running' || undefined}>
      {content}
    </div>
  )
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
