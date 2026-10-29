/**
 * Cards a worker can put in its thread (show_card): a ride on its way, an
 * order being made, a route with traffic, a payment waiting for approval,
 * the lights in the living room, a doorbell snapshot, a grocery list, the
 * day's events, a few options to pick from, the steps of a job ticked off.
 *
 * The card is the call's input, kept in the transcript like any tool call,
 * so nothing new is stored and an old thread still shows its cards. Both the
 * tool (to refuse a malformed card with a useful error) and the renderer (to
 * draw it) read it through `normalizeCard`, which drops what it doesn't
 * understand rather than failing.
 *
 * A button on a card either replies for the user (`reply`: the text is sent
 * to the worker as if the user wrote it), opens the worker's browser, opens a
 * link, or starts signing the worker in to one of its apps.
 */

import { workerAppsEnabled } from './workerApps'

export type CardTone = 'done' | 'action' | 'working' | 'failed' | 'info' | 'submitted'

export interface CardAction {
  label: string
  /** Sent to the worker as the user's message. */
  reply?: string
  /** Opens a web address in the user's browser. */
  url?: string
  /** Shows the worker's own browser. */
  browser?: boolean
  /** Starts the sign-in sheet for this linked app. */
  signIn?: string
  primary?: boolean
}

export type OrderStage = 'cart' | 'placed' | 'preparing' | 'ready' | 'on-the-way' | 'delivered' | 'picked-up' | 'cancelled'
export type RideStage = 'quote' | 'requesting' | 'matched' | 'arriving' | 'on-trip' | 'dropped-off' | 'cancelled'
export type DeviceKind = 'light' | 'vacuum' | 'car' | 'lock' | 'thermostat' | 'camera' | 'plug' | 'speaker' | 'other'

export type WorkerCard =
  | { kind: 'status'; title: string; body?: string; badge?: { label: string; tone: CardTone }; image?: string; actions?: CardAction[] }
  | { kind: 'checklist'; title?: string; items: { label: string; detail?: string; state: 'done' | 'skipped' | 'failed' | 'pending' }[] }
  | {
      kind: 'order'
      app?: string
      store: string
      items: { name: string; qty?: number; price?: string }[]
      total?: string
      eta?: string
      stage: OrderStage
      actions?: CardAction[]
    }
  | {
      kind: 'ride'
      app?: string
      from: string
      to: string
      eta?: string
      price?: string
      driver?: string
      car?: string
      plate?: string
      stage: RideStage
      actions?: CardAction[]
    }
  | {
      kind: 'route'
      from: string
      to: string
      duration?: string
      distance?: string
      traffic?: 'light' | 'moderate' | 'heavy'
      via?: string
      mode: 'drive' | 'walk' | 'transit' | 'bike'
      leaveBy?: string
    }
  | {
      kind: 'payment'
      app?: string
      direction: 'send' | 'request'
      to: string
      amount: string
      note?: string
      state: 'draft' | 'needs-approval' | 'sent' | 'failed'
      actions?: CardAction[]
    }
  | {
      kind: 'device'
      app?: string
      name: string
      device: DeviceKind
      state: string
      on?: boolean
      /** 0–100: brightness, battery, charge. */
      level?: number
      stats?: { label: string; value: string }[]
      actions?: CardAction[]
      /**
       * What its switch flips by itself, without asking the worker: a Hue
       * light or room by name, or a Home Assistant entity (light, switch,
       * fan, plug). Anything else, a lock or a garage, goes through the worker.
       */
      control?: { hue: string } | { entity: string }
    }
  | {
      kind: 'camera'
      app?: string
      title: string
      image?: string
      at?: string
      caption?: string
      actions?: CardAction[]
      /** A Home Assistant camera (labs): the card shows its picture now and can play its live view. */
      entity?: string
    }
  | { kind: 'list'; title: string; listId?: string; items: { text: string; done?: boolean }[] }
  | { kind: 'events'; title?: string; events: { title: string; when: string; where?: string }[] }
  | { kind: 'options'; title: string; options: { title: string; detail?: string; price?: string; reply: string }[] }
  | { kind: 'stats'; title?: string; stats: { label: string; value: string; trend?: 'up' | 'down' }[] }

export type CardKind = WorkerCard['kind']

export const CARD_KINDS: CardKind[] = ['status', 'checklist', 'order', 'ride', 'route', 'payment', 'device', 'camera', 'list', 'events', 'options', 'stats']

const ORDER_STAGES: OrderStage[] = ['cart', 'placed', 'preparing', 'ready', 'on-the-way', 'delivered', 'picked-up', 'cancelled']
const RIDE_STAGES: RideStage[] = ['quote', 'requesting', 'matched', 'arriving', 'on-trip', 'dropped-off', 'cancelled']
const DEVICES: DeviceKind[] = ['light', 'vacuum', 'car', 'lock', 'thermostat', 'camera', 'plug', 'speaker', 'other']
const TONES: CardTone[] = ['done', 'action', 'working', 'failed', 'info', 'submitted']

const MAX_TEXT = 600
const MAX_ROWS = 24

type Raw = Record<string, unknown>
const obj = (value: unknown): Raw | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : null)
/** Text, trimmed and capped; numbers are written out (a price sent as 12.5). */
const text = (value: unknown, max = MAX_TEXT): string => {
  const s = typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
  const trimmed = s.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}
const optional = (value: unknown, max = MAX_TEXT): string | undefined => text(value, max) || undefined
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback)
const rows = <T>(value: unknown, map: (row: Raw) => T | null): T[] =>
  (Array.isArray(value) ? value : [])
    .map((row) => {
      // A bare string is a row with just its label.
      const o = typeof row === 'string' ? { label: row, text: row, name: row, title: row } : obj(row)
      return o ? map(o) : null
    })
    .filter((row): row is T => row !== null)
    .slice(0, MAX_ROWS)

export function cardActions(value: unknown): CardAction[] | undefined {
  const list = rows(value, (a): CardAction | null => {
    const label = text(a.label, 40)
    if (!label) return null
    const action: CardAction = { label }
    const reply = optional(a.reply, 1000)
    const url = optional(a.url, 2000)
    const signIn = optional(a.sign_in ?? a.signIn, 60)
    if (reply) action.reply = reply
    else if (url && /^https:\/\//i.test(url)) action.url = url
    else if (a.browser === true) action.browser = true
    // Signing in to a linked app is labs only (workerApps.ts): without it, nothing would answer the button.
    else if (signIn && workerAppsEnabled()) action.signIn = signIn
    else return null
    if (a.primary === true) action.primary = true
    return action
  }).slice(0, 4)
  return list.length > 0 ? list : undefined
}

/**
 * The card a show_card call describes, or why it can't be shown. Field names
 * follow the tool's schema (snake_case from the model; camelCase accepted).
 */
/** Home Assistant entities a card's switch may flip on its own: on and off is all they do. */
export const SWITCHABLE_DOMAINS = ['light', 'switch', 'fan', 'input_boolean', 'media_player']

/** A device card's direct control (labs: Hue and Home Assistant are linked apps), from what the worker gave. */
function deviceControl(raw: Raw, name: string): { hue: string } | { entity: string } | undefined {
  if (!workerAppsEnabled() || typeof raw.on !== 'boolean') return undefined
  const entity = text(raw.entity ?? raw.entity_id, 120)
  if (entity && SWITCHABLE_DOMAINS.includes(entity.split('.')[0])) return { entity }
  if (entity) return undefined
  if (raw.app === 'hue') return { hue: text(raw.light ?? raw.target, 80) || name }
  return undefined
}

export function normalizeCard(input: unknown): { card: WorkerCard } | { error: string } {
  const raw = obj(input)
  if (!raw) return { error: 'card must be an object with a kind.' }
  const kind = raw.kind
  switch (kind) {
    case 'status': {
      const title = text(raw.title, 120)
      if (!title) return { error: 'A status card needs a title.' }
      const badge = obj(raw.badge)
      const badgeLabel = text(badge?.label ?? raw.badge, 30)
      return {
        card: {
          kind,
          title,
          ...(optional(raw.body) ? { body: optional(raw.body) } : {}),
          ...(badgeLabel ? { badge: { label: badgeLabel, tone: oneOf(badge?.tone ?? raw.tone, TONES, 'info') } } : {}),
          ...(optional(raw.image, 2000) ? { image: optional(raw.image, 2000) } : {}),
          ...(cardActions(raw.actions) ? { actions: cardActions(raw.actions) } : {})
        }
      }
    }
    case 'checklist': {
      const items = rows(raw.items, (r) => {
        const label = text(r.label ?? r.text, 120)
        return label ? { label, ...(optional(r.detail, 200) ? { detail: optional(r.detail, 200) } : {}), state: oneOf(r.state, ['done', 'skipped', 'failed', 'pending'] as const, 'done') } : null
      })
      if (items.length === 0) return { error: 'A checklist card needs items.' }
      return { card: { kind, ...(optional(raw.title, 120) ? { title: optional(raw.title, 120) } : {}), items } }
    }
    case 'order': {
      const store = text(raw.store ?? raw.restaurant ?? raw.merchant, 80)
      if (!store) return { error: 'An order card needs the store.' }
      const items = rows(raw.items, (r) => {
        const name = text(r.name ?? r.label, 80)
        if (!name) return null
        const qty = typeof r.qty === 'number' && r.qty > 0 ? Math.round(r.qty) : undefined
        return { name, ...(qty ? { qty } : {}), ...(optional(r.price, 20) ? { price: optional(r.price, 20) } : {}) }
      })
      return {
        card: {
          kind,
          ...(optional(raw.app, 40) ? { app: optional(raw.app, 40) } : {}),
          store,
          items,
          ...(optional(raw.total, 20) ? { total: optional(raw.total, 20) } : {}),
          ...(optional(raw.eta, 40) ? { eta: optional(raw.eta, 40) } : {}),
          stage: oneOf(raw.stage, ORDER_STAGES, 'placed'),
          ...(cardActions(raw.actions) ? { actions: cardActions(raw.actions) } : {})
        }
      }
    }
    case 'ride': {
      const from = text(raw.from ?? raw.pickup, 120)
      const to = text(raw.to ?? raw.dropoff, 120)
      if (!from || !to) return { error: 'A ride card needs from and to.' }
      const extra = (['eta', 'price', 'driver', 'car', 'plate'] as const).reduce<Record<string, string>>((out, key) => {
        const value = optional(raw[key], 60)
        if (value) out[key] = value
        return out
      }, {})
      return {
        card: {
          kind,
          ...(optional(raw.app, 40) ? { app: optional(raw.app, 40) } : {}),
          from,
          to,
          ...extra,
          stage: oneOf(raw.stage, RIDE_STAGES, 'quote'),
          ...(cardActions(raw.actions) ? { actions: cardActions(raw.actions) } : {})
        }
      }
    }
    case 'route': {
      const from = text(raw.from ?? raw.origin, 120)
      const to = text(raw.to ?? raw.destination, 120)
      if (!to) return { error: 'A route card needs where to (to).' }
      const traffic = raw.traffic === 'light' || raw.traffic === 'moderate' || raw.traffic === 'heavy' ? raw.traffic : undefined
      return {
        card: {
          kind,
          from: from || 'Current location',
          to,
          ...(optional(raw.duration, 40) ? { duration: optional(raw.duration, 40) } : {}),
          ...(optional(raw.distance, 40) ? { distance: optional(raw.distance, 40) } : {}),
          ...(traffic ? { traffic } : {}),
          ...(optional(raw.via, 80) ? { via: optional(raw.via, 80) } : {}),
          ...(optional(raw.leave_by ?? raw.leaveBy, 40) ? { leaveBy: optional(raw.leave_by ?? raw.leaveBy, 40) } : {}),
          mode: oneOf(raw.mode, ['drive', 'walk', 'transit', 'bike'] as const, 'drive')
        }
      }
    }
    case 'payment': {
      const to = text(raw.to ?? raw.person, 80)
      const amount = text(raw.amount, 30)
      if (!to || !amount) return { error: 'A payment card needs to and amount.' }
      return {
        card: {
          kind,
          ...(optional(raw.app, 40) ? { app: optional(raw.app, 40) } : {}),
          direction: raw.direction === 'request' ? 'request' : 'send',
          to,
          amount,
          ...(optional(raw.note, 200) ? { note: optional(raw.note, 200) } : {}),
          state: oneOf(raw.state, ['draft', 'needs-approval', 'sent', 'failed'] as const, 'draft'),
          ...(cardActions(raw.actions) ? { actions: cardActions(raw.actions) } : {})
        }
      }
    }
    case 'device': {
      const name = text(raw.name, 80)
      if (!name) return { error: 'A device card needs a name.' }
      const level = typeof raw.level === 'number' && Number.isFinite(raw.level) ? Math.max(0, Math.min(100, Math.round(raw.level))) : undefined
      const stats = rows(raw.stats, (r) => (text(r.label, 40) && text(r.value, 40) ? { label: text(r.label, 40), value: text(r.value, 40) } : null)).slice(0, 6)
      return {
        card: {
          kind,
          ...(optional(raw.app, 40) ? { app: optional(raw.app, 40) } : {}),
          name,
          device: oneOf(raw.device, DEVICES, 'other'),
          state: text(raw.state, 80) || (raw.on === true ? 'On' : raw.on === false ? 'Off' : ''),
          ...(typeof raw.on === 'boolean' ? { on: raw.on } : {}),
          ...(level !== undefined ? { level } : {}),
          ...(stats.length > 0 ? { stats } : {}),
          ...(cardActions(raw.actions) ? { actions: cardActions(raw.actions) } : {}),
          ...(deviceControl(raw, name) ? { control: deviceControl(raw, name)! } : {})
        }
      }
    }
    case 'camera': {
      const title = text(raw.title, 120) || 'Camera'
      return {
        card: {
          kind,
          ...(optional(raw.app, 40) ? { app: optional(raw.app, 40) } : {}),
          title,
          ...(optional(raw.image, 2000) ? { image: optional(raw.image, 2000) } : {}),
          ...(optional(raw.at, 40) ? { at: optional(raw.at, 40) } : {}),
          ...(optional(raw.caption, 300) ? { caption: optional(raw.caption, 300) } : {}),
          ...(cardActions(raw.actions) ? { actions: cardActions(raw.actions) } : {}),
          ...(workerAppsEnabled() && /^camera\.[a-z0-9_]+$/.test(text(raw.entity ?? raw.entity_id, 120)) ? { entity: text(raw.entity ?? raw.entity_id, 120) } : {})
        }
      }
    }
    case 'list': {
      const title = text(raw.title, 80)
      const items = rows(raw.items, (r) => {
        const t = text(r.text ?? r.label ?? r.name, 120)
        return t ? { text: t, ...(r.done === true ? { done: true } : {}) } : null
      })
      if (!title && !raw.list_id && !raw.listId) return { error: 'A list card needs a title (or the list_id of a shared list).' }
      return { card: { kind, title: title || 'List', ...(optional(raw.list_id ?? raw.listId, 80) ? { listId: optional(raw.list_id ?? raw.listId, 80) } : {}), items } }
    }
    case 'events': {
      const events = rows(raw.events ?? raw.items, (r) => {
        const title = text(r.title ?? r.label, 120)
        const when = text(r.when ?? r.time, 60)
        return title ? { title, when, ...(optional(r.where, 120) ? { where: optional(r.where, 120) } : {}) } : null
      })
      if (events.length === 0) return { error: 'An events card needs events.' }
      return { card: { kind, ...(optional(raw.title, 80) ? { title: optional(raw.title, 80) } : {}), events } }
    }
    case 'options': {
      const title = text(raw.title, 120)
      const options = rows(raw.options ?? raw.items, (r) => {
        const t = text(r.title ?? r.label, 80)
        if (!t) return null
        return {
          title: t,
          ...(optional(r.detail, 200) ? { detail: optional(r.detail, 200) } : {}),
          ...(optional(r.price, 20) ? { price: optional(r.price, 20) } : {}),
          reply: text(r.reply, 500) || t
        }
      }).slice(0, 6)
      if (!title || options.length === 0) return { error: 'An options card needs a title and options.' }
      return { card: { kind, title, options } }
    }
    case 'stats': {
      const stats = rows(raw.stats ?? raw.items, (r) => {
        const label = text(r.label, 40)
        const value = text(r.value, 40)
        if (!label || !value) return null
        return { label, value, ...(r.trend === 'up' || r.trend === 'down' ? { trend: r.trend as 'up' | 'down' } : {}) }
      }).slice(0, 8)
      if (stats.length === 0) return { error: 'A stats card needs stats.' }
      return { card: { kind, ...(optional(raw.title, 80) ? { title: optional(raw.title, 80) } : {}), stats } }
    }
    default:
      return { error: `Unknown card kind "${String(kind)}". Use one of: ${CARD_KINDS.join(', ')}.` }
  }
}

/** "[image: /path]" — how show_card's result tells the transcript which picture it resolved. */
export const CARD_IMAGE_MARK = /\[image: ([^\]\n]+)\]/

/** Google Maps and Waze links for a route card. */
export function routeLinks(card: Extract<WorkerCard, { kind: 'route' }>): { google: string; waze: string } {
  const travel = { drive: 'driving', walk: 'walking', transit: 'transit', bike: 'bicycling' }[card.mode]
  const origin = card.from && card.from !== 'Current location' ? `&origin=${encodeURIComponent(card.from)}` : ''
  return {
    google: `https://www.google.com/maps/dir/?api=1${origin}&destination=${encodeURIComponent(card.to)}&travelmode=${travel}`,
    waze: `https://waze.com/ul?q=${encodeURIComponent(card.to)}&navigate=yes`
  }
}

export const ORDER_STEPS: OrderStage[] = ['placed', 'preparing', 'on-the-way', 'delivered']
export const PICKUP_STEPS: OrderStage[] = ['placed', 'preparing', 'ready', 'picked-up']
export const RIDE_STEPS: RideStage[] = ['requesting', 'matched', 'arriving', 'on-trip', 'dropped-off']

export const ORDER_LABEL: Record<OrderStage, string> = {
  cart: 'In the cart',
  placed: 'Placed',
  preparing: 'Preparing',
  ready: 'Ready for pickup',
  'on-the-way': 'On the way',
  delivered: 'Delivered',
  'picked-up': 'Picked up',
  cancelled: 'Cancelled'
}

export const RIDE_LABEL: Record<RideStage, string> = {
  quote: 'Price check',
  requesting: 'Finding a driver',
  matched: 'Driver found',
  arriving: 'Arriving',
  'on-trip': 'On the way',
  'dropped-off': 'Arrived',
  cancelled: 'Cancelled'
}
