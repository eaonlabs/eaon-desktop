import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CONNECTORS, connectorSpec, type ConnectorId, type ConnectorStatus, type ConnectorStatuses } from '@shared/workerConnectors'
import { cashAppLink, googleMapsLink, lyftLink, uberLink, venmoLink, wazeLink, type LatLng } from '@shared/workerLinks'
import { findWorkerApp, workerApp, workerAppsEnabled, type WorkerAppLink } from '@shared/workerApps'
import type { AgentTool, ToolContext } from '../../agent/tools'
import type { WorkersEngine } from './engine'

/**
 * The connections behind workers' apps (shared/workerConnectors.ts): the
 * clients for each service's API, where their keys are kept, and the tools
 * a worker gets once one is connected and it has an app that uses it.
 *
 * Keys live in the secrets vault under `worker-apps:conn:<id>` and never
 * leave the main process. `fetch` and the vault are injected, so tests run
 * against fakes.
 */

export interface ConnectorDeps {
  fetch?: typeof fetch
  /** The saved JSON for a connection, or undefined. */
  load: (id: ConnectorId) => string | undefined
  save: (id: ConnectorId, value: string | null) => void
  onChange?: (statuses: ConnectorStatuses) => void
}

const TIMEOUT_MS = 15_000
/**
 * A Tesla command or wake: Tessie wakes a sleeping car first and waits for the
 * command to finish, which takes up to 90 seconds (its /wake gives up then).
 */
const TESLA_TIMEOUT_MS = 120_000
/**
 * SimpleFIN asks apps for 24 requests a day at most and disables the access
 * token past that, so one reply (90 days of transactions, every balance) is
 * kept this long and every question in that time is answered from it.
 */
const SIMPLEFIN_FRESH_MS = 60 * 60_000
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const num = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.replace(/[$,]/g, '')) : NaN
  return Number.isFinite(n) ? n : undefined
}

/** A connection's saved values: the fields the user gave, plus what the client keeps (a claimed SimpleFIN address). */
type Saved = Record<string, string> & { detail?: string }

export class ConnectorError extends Error {}

export function createConnectors(deps: ConnectorDeps) {
  const http = deps.fetch ?? fetch
  const details = new Map<ConnectorId, string | null>()

  const saved = (id: ConnectorId): Saved | null => {
    try {
      const raw = deps.load(id)
      const value = raw ? (JSON.parse(raw) as Saved) : null
      return value && typeof value === 'object' ? value : null
    } catch {
      return null
    }
  }
  const need = (id: ConnectorId): Saved => {
    const value = saved(id)
    if (!value) throw new ConnectorError(`${connectorSpec(id)?.name ?? id} isn’t connected. Ask the user to connect it (your page → Apps → Connections).`)
    return value
  }

  /** One JSON request, with a timeout and an error that says which service and what it said. */
  const request = async (service: string, url: string, init: RequestInit = {}, raw = false, timeout: { ms: number; late?: string } = { ms: TIMEOUT_MS }): Promise<unknown> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout.ms)
    let response: Response
    try {
      response = await http(url, { ...init, signal: controller.signal })
    } catch (error) {
      throw new ConnectorError((error as Error)?.name === 'AbortError' ? (timeout.late ?? `${service} didn’t answer in time.`) : `Couldn’t reach ${service}: ${(error as Error)?.message ?? error}`)
    } finally {
      clearTimeout(timer)
    }
    if (response.status === 401 || response.status === 403) throw new ConnectorError(`${service} refused the key or token (${response.status}). It may have expired; connect it again.`)
    if (response.status === 402) throw new ConnectorError(`${service} says the subscription needs paying (402).`)
    if (!response.ok) {
      let text = ''
      try {
        text = (await response.text()).slice(0, 300)
      } catch {
        /* no body */
      }
      throw new ConnectorError(`${service} answered ${response.status}${text ? `: ${text}` : ''}`)
    }
    if (raw) return response
    const text = await response.text()
    try {
      return text ? JSON.parse(text) : null
    } catch {
      return text
    }
  }

  /* ------------------------------------------------------------ Home Assistant */

  const ha = {
    base(): { url: string; headers: Record<string, string> } {
      const { url, token } = need('home-assistant')
      return { url: url.replace(/\/+$/, ''), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    },
    async states(): Promise<HaState[]> {
      const { url, headers } = ha.base()
      const list = await request('Home Assistant', `${url}/api/states`, { headers })
      return Array.isArray(list) ? (list as HaState[]) : []
    },
    async state(entity: string): Promise<HaState> {
      const { url, headers } = ha.base()
      return (await request('Home Assistant', `${url}/api/states/${encodeURIComponent(entity)}`, { headers })) as HaState
    },
    /**
     * Calls a service: the states it changed, and what it answered for one
     * that returns data (todo.get_items, calendar.get_events,
     * weather.get_forecasts). Home Assistant refuses those with a 400 unless
     * the call asks for the answer (?return_response), and refuses that
     * question from a service that has none, both before anything runs; so
     * the call is made plainly, and again asking, only when it says to.
     */
    async call(domain: string, service: string, data: Record<string, unknown>): Promise<{ changed: HaState[]; response?: unknown }> {
      if (!/^[a-z0-9_]+$/.test(domain) || !/^[a-z0-9_]+$/.test(service)) throw new ConnectorError('domain and service are lower-case words, like light and turn_on.')
      const { url, headers } = ha.base()
      const at = `${url}/api/services/${domain}/${service}`
      const init = { method: 'POST', headers, body: JSON.stringify(data) }
      try {
        const changed = await request('Home Assistant', at, init)
        return { changed: Array.isArray(changed) ? (changed as HaState[]) : [] }
      } catch (error) {
        if (!(error instanceof ConnectorError) || !/answered 400\b[\s\S]*(requires responses|return_response)/.test(error.message)) throw error
        const reply = (await request('Home Assistant', `${at}?return_response`, init)) as { changed_states?: HaState[]; service_response?: unknown } | null
        return { changed: Array.isArray(reply?.changed_states) ? reply.changed_states : [], response: reply?.service_response ?? null }
      }
    },
    async snapshot(entity: string): Promise<{ bytes: Buffer; type: string }> {
      if (!/^camera\.[a-z0-9_]+$/.test(entity)) throw new ConnectorError('A snapshot needs a camera entity, like camera.front_door.')
      const { url, headers } = ha.base()
      const response = (await request('Home Assistant', `${url}/api/camera_proxy/${entity}`, { headers }, true)) as Response
      return { bytes: Buffer.from(await response.arrayBuffer()), type: response.headers.get('content-type') ?? 'image/jpeg' }
    }
  }

  /* ------------------------------------------------------------ Tessie */

  const TESSIE = 'https://api.tessie.com'
  const tessie = {
    headers: (): Record<string, string> => ({ Authorization: `Bearer ${need('tessie').token}` }),
    async vehicles(): Promise<TessieVehicle[]> {
      const reply = (await request('Tessie', `${TESSIE}/vehicles?only_active=true`, { headers: tessie.headers() })) as { results?: TessieVehicle[] }
      return Array.isArray(reply?.results) ? reply.results : []
    },
    async command(vin: string, command: TeslaCommand, percent?: number): Promise<boolean> {
      if (!/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) throw new ConnectorError('That isn’t a VIN.')
      const path = command === 'wake' ? `/${vin}/wake` : `/${vin}/command/${command}`
      const query = command === 'set_charge_limit' ? `?percent=${Math.max(50, Math.min(100, Math.round(percent ?? 80)))}` : ''
      // Not known to have failed: the car may have done it as the wait ran out, and trying again could
      // honk or unlock twice. The worker is told to look before it tries again.
      const late = 'Tessie didn’t say in time whether the car did it (a sleeping car can take a minute and a half to wake). Check its status with tesla status before trying again.'
      const reply = (await request('Tessie', `${TESSIE}${path}${query}`, { method: 'POST', headers: tessie.headers() }, false, { ms: TESLA_TIMEOUT_MS, late })) as { result?: boolean }
      return reply?.result !== false
    }
  }

  /* ------------------------------------------------------------ SimpleFIN */

  /** A claimed access URL as a request: its credentials go in a header (fetch refuses them in the URL). */
  const sfin = (accessUrl: string, path: string): { url: string; headers: Record<string, string> } => {
    const parsed = new URL(accessUrl)
    const auth = Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString('base64')
    parsed.username = ''
    parsed.password = ''
    return { url: `${parsed.toString().replace(/\/+$/, '')}${path}`, headers: { Authorization: `Basic ${auth}` } }
  }
  let sfinCache: { accessUrl: string; at: number; accounts: SimplefinAccount[]; problems: string[] } | null = null
  const simplefin = {
    async claim(setupToken: string): Promise<string> {
      let claimUrl: string
      try {
        claimUrl = Buffer.from(setupToken.trim(), 'base64').toString('utf8').trim()
        if (new URL(claimUrl).protocol !== 'https:') throw new Error()
      } catch {
        throw new ConnectorError('That isn’t a SimpleFIN setup token. Copy the whole token from bridge.simplefin.org.')
      }
      const access = await request('SimpleFIN', claimUrl, { method: 'POST', headers: { 'Content-Length': '0' } })
      const url = typeof access === 'string' ? access.trim() : ''
      if (!/^https:\/\/[^/\s]+:[^/\s]+@/.test(url)) throw new ConnectorError('SimpleFIN didn’t return an access address. The token may have been used already — make a new one.')
      return url
    },
    /**
     * The accounts, with their transactions from the last `days` (balances
     * only, when `balancesOnly`), and what SimpleFIN said it couldn't get
     * (a bank that needs signing in again). One request an hour at most:
     * SIMPLEFIN_FRESH_MS.
     */
    async accounts(options: { days?: number; balancesOnly?: boolean } = {}): Promise<{ accounts: SimplefinAccount[]; problems: string[] }> {
      const { accessUrl } = need('simplefin')
      const now = Date.now()
      if (!sfinCache || sfinCache.accessUrl !== accessUrl || now - sfinCache.at > SIMPLEFIN_FRESH_MS) {
        const params = new URLSearchParams({ version: '2', pending: '1', 'start-date': String(Math.floor(now / 1000) - 90 * 86400) })
        const { url, headers } = sfin(accessUrl, `/accounts?${params.toString()}`)
        const reply = (await request('SimpleFIN', url, { headers })) as SimplefinReply
        const banks = new Map((reply?.connections ?? []).map((c) => [c.conn_id, c.name]))
        sfinCache = {
          accessUrl,
          at: now,
          accounts: (reply?.accounts ?? []).map((a) => ({ ...a, bank: a.org?.name ?? (a.conn_id ? banks.get(a.conn_id) : undefined) ?? '' })),
          problems: [...(reply?.errlist ?? []).map((e) => e.msg).filter(Boolean), ...(reply?.errors ?? [])]
        }
      }
      const since = Math.floor(now / 1000) - Math.max(1, Math.min(90, options.days ?? 14)) * 86400
      const accounts = sfinCache.accounts.map((a) =>
        options.balancesOnly ? { ...a, transactions: undefined } : { ...a, transactions: (a.transactions ?? []).filter((t) => (t.transacted_at ?? t.posted) >= since) }
      )
      return { accounts, problems: sfinCache.problems }
    }
  }

  /* ------------------------------------------------------------ Instacart */

  /**
   * Instacart's two hosts: a Production key works on the first only once
   * Instacart has approved the app using it (weeks); a Development key works
   * at once, on the second, and makes test pages. Which one a key answers on
   * is found when it's connected and kept with it (`host`).
   */
  const INSTACART_HOSTS = { production: 'https://connect.instacart.com', development: 'https://connect.dev.instacart.tools' }
  const instacart = {
    async list(title: string, items: string[]): Promise<string> {
      const { key, host } = need('instacart')
      const reply = (await request('Instacart', `${host === 'development' ? INSTACART_HOSTS.development : INSTACART_HOSTS.production}/idp/v1/products/products_link`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.slice(0, 120) || 'Shopping list', link_type: 'shopping_list', line_items: items.slice(0, 100).map((name) => ({ name: name.slice(0, 120), display_text: name.slice(0, 120) })) })
      })) as { products_link_url?: string }
      const link = reply?.products_link_url
      if (!link || !/^https?:\/\//.test(link)) throw new ConnectorError('Instacart didn’t return a link.')
      return link.replace(/^http:/, 'https:')
    }
  }

  /* ------------------------------------------------------------ Google Routes */

  const routes = {
    async compute(input: { from: string; to: string; mode: RouteMode; departAt?: Date }): Promise<RouteResult> {
      const { key } = need('google-routes')
      const travelMode = { drive: 'DRIVE', walk: 'WALK', transit: 'TRANSIT', bike: 'BICYCLE' }[input.mode]
      const body: Record<string, unknown> = { origin: { address: input.from }, destination: { address: input.to }, travelMode }
      if (input.mode === 'drive') body.routingPreference = 'TRAFFIC_AWARE'
      if (input.departAt && input.departAt.getTime() > Date.now()) body.departureTime = input.departAt.toISOString()
      const reply = (await request('Google Maps', 'https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'routes.duration,routes.staticDuration,routes.distanceMeters,routes.description,routes.legs.startLocation,routes.legs.endLocation'
        },
        body: JSON.stringify(body)
      })) as { routes?: GoogleRoute[] }
      const route = reply?.routes?.[0]
      if (!route) throw new ConnectorError(`Google Maps found no ${input.mode} route from ${input.from} to ${input.to}.`)
      const seconds = parseSeconds(route.duration)
      const usual = parseSeconds(route.staticDuration)
      const ratio = seconds && usual ? seconds / usual : 1
      const leg = route.legs?.[0]
      return {
        minutes: Math.round(seconds / 60),
        usualMinutes: usual ? Math.round(usual / 60) : null,
        miles: route.distanceMeters ? Math.round((route.distanceMeters / 1609.34) * 10) / 10 : null,
        via: route.description ?? null,
        traffic: input.mode !== 'drive' ? null : ratio < 1.15 ? 'light' : ratio < 1.5 ? 'moderate' : 'heavy',
        fromAt: latLng(leg?.startLocation),
        toAt: latLng(leg?.endLocation)
      }
    }
  }

  /* ------------------------------------------------------------ connecting */

  const status = (id: ConnectorId): ConnectorStatus => {
    const value = saved(id)
    return { connected: Boolean(value), detail: value ? (details.get(id) ?? value.detail ?? null) : null }
  }
  const statuses = (): ConnectorStatuses => Object.fromEntries(CONNECTORS.map((c) => [c.id, status(c.id)])) as ConnectorStatuses
  const changed = (): void => deps.onChange?.(statuses())

  /**
   * Connects a service from what the user typed: checks it really works (a
   * request with the key) before saving anything, and says what it found.
   */
  async function connect(id: ConnectorId, fields: Record<string, string>): Promise<ConnectorStatus> {
    const spec = connectorSpec(id)
    if (!spec) throw new ConnectorError('There is no such connection.')
    const value: Saved = {}
    for (const field of spec.fields) {
      const v = str(fields[field.key])
      if (!v) throw new ConnectorError(`Fill in ${field.label}.`)
      value[field.key] = v
    }
    let detail: string
    const previous = deps.load(id)
    // Saved first so the clients can read it, and put back if the check fails.
    const tryWith = async <T>(stored: Saved, check: () => Promise<T>): Promise<T> => {
      deps.save(id, JSON.stringify(stored))
      try {
        return await check()
      } catch (error) {
        deps.save(id, previous ?? null)
        throw error
      }
    }
    switch (id) {
      case 'home-assistant': {
        let url: URL
        try {
          url = new URL(value.url)
          if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error()
        } catch {
          throw new ConnectorError('Give Home Assistant’s address, like http://homeassistant.local:8123.')
        }
        value.url = url.origin
        const states = await tryWith(value, () => ha.states())
        detail = `${url.host} · ${states.length} entities`
        break
      }
      case 'tessie': {
        const cars = await tryWith(value, () => tessie.vehicles())
        detail = cars.length ? cars.map((c) => c.last_state?.display_name || c.vin).join(', ') : 'No active cars on this account'
        break
      }
      case 'simplefin': {
        // The setup token works once; what is kept is the access address it turns into.
        const accessUrl = await simplefin.claim(value.setupToken)
        const stored: Saved = { accessUrl }
        const { accounts } = await tryWith(stored, () => simplefin.accounts({ balancesOnly: true }))
        const banks = [...new Set(accounts.map((a) => a.bank).filter(Boolean))]
        detail = `${accounts.length} account${accounts.length === 1 ? '' : 's'}${banks.length ? ` at ${banks.join(', ')}` : ''}`
        details.set(id, detail)
        deps.save(id, JSON.stringify({ ...stored, detail }))
        changed()
        return status(id)
      }
      case 'instacart': {
        try {
          await tryWith({ ...value, host: 'production' }, () => instacart.list('Eaon connection check', ['bananas']))
          value.host = 'production'
          detail = 'Shopping-list pages'
        } catch (error) {
          // Refused there: a Development key, or a Production one Instacart hasn't approved yet.
          if (!(error instanceof ConnectorError) || !/refused the key/.test(error.message)) throw error
          try {
            await tryWith({ ...value, host: 'development' }, () => instacart.list('Eaon connection check', ['bananas']))
          } catch {
            throw new ConnectorError('Instacart refused the key. A Production key only works once Instacart has approved your app; a Development key works straight away.')
          }
          value.host = 'development'
          detail = 'Development key: test pages until a Production key is approved'
        }
        break
      }
      case 'google-routes': {
        await tryWith(value, () => routes.compute({ from: 'Union Square, San Francisco', to: 'Ferry Building, San Francisco', mode: 'walk' }))
        detail = 'Live traffic on'
        break
      }
    }
    details.set(id, detail)
    deps.save(id, JSON.stringify({ ...value, detail }))
    changed()
    return status(id)
  }

  function disconnect(id: ConnectorId): void {
    deps.save(id, null)
    details.delete(id)
    changed()
  }

  return { ha, tessie, simplefin, instacart, routes, connect, disconnect, status, statuses, connected: (id: ConnectorId) => Boolean(saved(id)) }
}

export type Connectors = ReturnType<typeof createConnectors>

/* -------------------------------------------------------------------- types */

export interface HaState {
  entity_id: string
  state: string
  attributes: Record<string, unknown>
  last_changed?: string
}

interface TessieVehicle {
  vin: string
  is_active?: boolean
  last_state?: {
    display_name?: string
    charge_state?: { battery_level?: number; battery_range?: number; charging_state?: string; charge_limit_soc?: number; minutes_to_full_charge?: number }
    climate_state?: { inside_temp?: number; outside_temp?: number; is_climate_on?: boolean }
    vehicle_state?: { locked?: boolean; sentry_mode?: boolean; odometer?: number }
    drive_state?: { shift_state?: string | null }
  }
}

interface SimplefinAccount {
  id: string
  name: string
  currency: string
  balance: string
  'available-balance'?: string
  'balance-date': number
  conn_id?: string
  org?: { name?: string }
  transactions?: { id: string; posted: number; amount: string; description: string; pending?: boolean; transacted_at?: number }[]
  bank?: string
}
interface SimplefinReply {
  accounts?: SimplefinAccount[]
  connections?: { conn_id: string; name: string }[]
  errlist?: { code: string; msg: string }[]
  errors?: string[]
}

interface GoogleRoute {
  duration?: string
  staticDuration?: string
  distanceMeters?: number
  description?: string
  legs?: { startLocation?: { latLng?: LatLng }; endLocation?: { latLng?: LatLng } }[]
}

export type RouteMode = 'drive' | 'walk' | 'transit' | 'bike'
export interface RouteResult {
  minutes: number
  usualMinutes: number | null
  miles: number | null
  via: string | null
  traffic: 'light' | 'moderate' | 'heavy' | null
  fromAt: LatLng | null
  toAt: LatLng | null
}

const parseSeconds = (value: string | undefined): number => (value ? Number(value.replace(/s$/, '')) || 0 : 0)
const latLng = (location: { latLng?: LatLng } | undefined): LatLng | null =>
  location?.latLng && Number.isFinite(location.latLng.latitude) && Number.isFinite(location.latLng.longitude) ? location.latLng : null

/* -------------------------------------------------------------------- tools */

export const TESLA_COMMANDS = [
  'lock',
  'unlock',
  'start_climate',
  'stop_climate',
  'start_charging',
  'stop_charging',
  'set_charge_limit',
  'flash',
  'honk',
  'activate_front_trunk',
  'activate_rear_trunk',
  'wake'
] as const
export type TeslaCommand = (typeof TESLA_COMMANDS)[number]
/** Commands that open the car to anyone standing next to it: always the user's call. */
const TESLA_OPENS = new Set<string>(['unlock', 'activate_front_trunk', 'activate_rear_trunk'])

/**
 * A Home Assistant service call that lets someone in or switches protection
 * off — a lock opened, a garage or gate opened, an alarm disarmed: always
 * the user's call, however free the worker is otherwise.
 */
export function opensTheHouse(domain: string, service: string, entity: string, data: Record<string, unknown> = {}): boolean {
  if (domain === 'lock' && (service === 'unlock' || service === 'open')) return true
  if (domain === 'alarm_control_panel' && service.startsWith('alarm_disarm')) return true
  // Who the call is for: `entity`, and the entity_id the data names too (one, a list, or "all"),
  // since that's what Home Assistant acts on. A call aimed by area, device or label can't be told.
  const named = [entity, ...[data.entity_id].flat().flatMap((e) => (typeof e === 'string' ? e.split(',') : []))].map((e) => e.trim().toLowerCase()).filter(Boolean)
  const unseen = named.length === 0 || named.includes('all') || ['area_id', 'device_id', 'floor_id', 'label_id'].some((k) => data[k] !== undefined)
  const doorway = (e: string): boolean => /garage|gate|door/.test(e)
  const opens =
    service === 'open_cover' ||
    service === 'toggle' ||
    (service === 'set_cover_position' && !(Number(data.position) <= 0))
  if (domain === 'cover' && opens) return unseen || named.some(doorway)
  // homeassistant.turn_on and toggle open a cover as cover.open_cover would; a lock or an alarm named through it is asked about too.
  if (domain === 'homeassistant' && (service === 'turn_on' || service === 'toggle' || service === 'turn_off')) {
    return named.some((e) => /^(lock|alarm_control_panel)\./.test(e) || (e.startsWith('cover.') && service !== 'turn_off' && doorway(e)))
  }
  return false
}

/** A Home Assistant entity in one line for the model. */
export function entityLine(s: HaState): string {
  const a = s.attributes ?? {}
  const name = typeof a.friendly_name === 'string' ? a.friendly_name : s.entity_id
  const extra = [
    typeof a.brightness === 'number' ? `${Math.round((a.brightness / 255) * 100)}%` : null,
    typeof a.battery_level === 'number' ? `battery ${a.battery_level}%` : null,
    typeof a.current_temperature === 'number' ? `now ${a.current_temperature}°` : null,
    typeof a.temperature === 'number' && s.entity_id.startsWith('climate.') ? `set ${a.temperature}°` : null,
    typeof a.unit_of_measurement === 'string' ? a.unit_of_measurement : null
  ].filter(Boolean)
  return `- ${s.entity_id} (${name}): ${s.state}${extra.length ? ` · ${extra.join(' · ')}` : ''}`
}

const DEVICE_DOMAINS = ['light', 'switch', 'lock', 'climate', 'cover', 'vacuum', 'camera', 'media_player', 'fan', 'alarm_control_panel', 'event', 'binary_sensor', 'sensor', 'button', 'scene', 'device_tracker']

function self(ctx: ToolContext): string {
  const id = ctx.request.workerId
  if (!id) throw new Error('Only a worker can use this tool.')
  return id
}

const has = (links: WorkerAppLink[], ...ids: string[]): boolean => links.some((l) => ids.includes(l.id))

/**
 * The tools a worker gets from its apps' connections: only those whose
 * connection is made and for which it has an app linked. `route` and
 * `app_link` need no connection at all.
 */
export function connectorTools(engine: WorkersEngine, connectors: Connectors, links: WorkerAppLink[]): AgentTool[] {
  if (!workerAppsEnabled()) return []
  const tools: AgentTool[] = []
  const folderOf = (ctx: ToolContext): string => engine.list().find((w) => w.id === self(ctx))?.folder ?? ctx.cwd

  if (connectors.connected('home-assistant') && has(links, 'home-assistant', 'roborock', 'ring', 'tesla', 'hue')) {
    tools.push({
      name: 'home',
      description:
        'Home Assistant: the devices at home. devices {search?, domain?} lists them (vacuum, lock, climate, camera, light, cover, event…) with their state. state {entity}. do {domain, service, entity, data?} calls a service — vacuum.start / return_to_base, lock.lock, climate.set_temperature {temperature}, light.turn_on {brightness_pct}, cover.close_cover; services that answer with data (todo.get_items, calendar.get_events {duration: {hours}}, weather.get_forecasts {type: daily}) return it. snapshot {entity: camera.x} saves a picture to your folder; to show a camera, show_card {kind: camera, entity: camera.x} draws its picture now and a live view the user can watch. Opening locks, garages or gates and disarming alarms wait for the user.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['devices', 'state', 'do', 'snapshot'] },
          search: { type: 'string' },
          domain: { type: 'string' },
          service: { type: 'string' },
          entity: { type: 'string' },
          data: { type: 'object' }
        },
        required: ['action']
      },
      mutating: (input) => input.action === 'do',
      risky: (input) => input.action === 'do',
      catastrophic: (input) =>
        input.action === 'do' && opensTheHouse(str(input.domain), str(input.service), str(input.entity), input.data && typeof input.data === 'object' && !Array.isArray(input.data) ? (input.data as Record<string, unknown>) : {}),
      describe: (input) => (input.action === 'do' ? `${str(input.domain)}.${str(input.service)} ${str(input.entity)}` : `${str(input.action)} ${str(input.search ?? input.entity)}`.trim()),
      run: async (input, ctx) => {
        self(ctx)
        switch (input.action) {
          case 'devices': {
            const search = str(input.search).toLowerCase()
            const domain = str(input.domain)
            const all = (await connectors.ha.states()).filter((s) => {
              const d = s.entity_id.split('.')[0]
              if (domain ? d !== domain : !DEVICE_DOMAINS.includes(d)) return false
              const name = String(s.attributes?.friendly_name ?? '').toLowerCase()
              return !search || s.entity_id.includes(search) || name.includes(search)
            })
            if (all.length === 0) return 'No matching devices.'
            const shown = all.slice(0, 80)
            return `${shown.map(entityLine).join('\n')}${all.length > shown.length ? `\n…and ${all.length - shown.length} more; narrow with search or domain.` : ''}`
          }
          case 'state':
            return entityLine(await connectors.ha.state(str(input.entity)))
          case 'do': {
            const entity = str(input.entity)
            const data = input.data && typeof input.data === 'object' && !Array.isArray(input.data) ? (input.data as Record<string, unknown>) : {}
            const { changed, response } = await connectors.ha.call(str(input.domain), str(input.service), entity ? { entity_id: entity, ...data } : data)
            const answer = response === undefined ? '' : `\nIt answered:\n${JSON.stringify(response, null, 1).slice(0, 6000)}`
            return changed.length ? `Done. Now:\n${changed.slice(0, 10).map(entityLine).join('\n')}${answer}` : `Called ${str(input.domain)}.${str(input.service)}.${answer}`
          }
          case 'snapshot': {
            const entity = str(input.entity)
            const shot = await connectors.ha.snapshot(entity)
            const dir = join(folderOf(ctx), 'cards')
            await mkdir(dir, { recursive: true })
            const file = join(dir, `${entity.replace(/\W/g, '-')}-${Date.now()}.${shot.type.includes('png') ? 'png' : 'jpg'}`)
            await writeFile(file, shot.bytes)
            return `Saved the snapshot to ${file}. Show it with show_card {kind: camera, image: "${file}"}.`
          }
          default:
            return { text: `Unknown action "${String(input.action)}".`, isError: true }
        }
      }
    })
  }

  if (connectors.connected('tessie') && has(links, 'tesla')) {
    tools.push({
      name: 'tesla',
      description: `The user's Tesla, through Tessie. status: every car's charge, range, climate, lock and whether it's charging. command {command, vin?, percent?}: ${TESLA_COMMANDS.join(', ')} (percent for set_charge_limit, 50–100). Unlocking and opening a trunk wait for the user.`,
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['status', 'command'] }, command: { type: 'string', enum: [...TESLA_COMMANDS] }, vin: { type: 'string' }, percent: { type: 'number' } },
        required: ['action']
      },
      mutating: (input) => input.action === 'command',
      risky: (input) => input.action === 'command',
      catastrophic: (input) => input.action === 'command' && TESLA_OPENS.has(str(input.command)),
      describe: (input) => (input.action === 'command' ? `Tesla: ${str(input.command)}` : 'Tesla status'),
      run: async (input, ctx) => {
        self(ctx)
        const cars = await connectors.tessie.vehicles()
        if (cars.length === 0) return 'There are no active cars on the Tessie account.'
        if (input.action === 'status') {
          return cars
            .map((car) => {
              const s = car.last_state ?? {}
              const charge = s.charge_state ?? {}
              return [
                `- ${s.display_name || 'Tesla'} (VIN ${car.vin}):`,
                `battery ${charge.battery_level ?? '?'}%, ${Math.round(charge.battery_range ?? 0)} mi range`,
                charge.charging_state ? `charging: ${charge.charging_state}${charge.minutes_to_full_charge ? `, full in ${charge.minutes_to_full_charge} min` : ''}` : null,
                charge.charge_limit_soc ? `limit ${charge.charge_limit_soc}%` : null,
                s.climate_state?.inside_temp !== undefined ? `inside ${s.climate_state.inside_temp}°C${s.climate_state.is_climate_on ? ', climate on' : ''}` : null,
                s.vehicle_state?.locked === undefined ? null : s.vehicle_state.locked ? 'locked' : 'UNLOCKED'
              ]
                .filter(Boolean)
                .join(' · ')
            })
            .join('\n')
        }
        const command = str(input.command) as TeslaCommand
        if (!TESLA_COMMANDS.includes(command)) return { text: `Unknown command. Use one of ${TESLA_COMMANDS.join(', ')}.`, isError: true }
        const vin = str(input.vin) || (cars.length === 1 ? cars[0].vin : '')
        if (!vin) return { text: `Say which car (vin): ${cars.map((c) => `${c.last_state?.display_name ?? 'Tesla'} ${c.vin}`).join(', ')}.`, isError: true }
        const ok = await connectors.tessie.command(vin, command, num(input.percent))
        return ok ? `Done: ${command.replace(/_/g, ' ')}.` : { text: `The car didn’t do it (${command}). It may be asleep or out of signal; try wake first.`, isError: true }
      }
    })
  }

  if (connectors.connected('simplefin') && has(links, 'bank')) {
    tools.push({
      name: 'bank',
      description: 'The user’s bank and card accounts, read-only through SimpleFIN. balances: every account’s balance. transactions {days: 1-90, account?}: recent transactions, newest first. It can never move money.',
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['balances', 'transactions'] }, days: { type: 'number' }, account: { type: 'string' } }, required: ['action'] },
      mutating: false,
      describe: (input) => `Bank ${str(input.action)}`,
      run: async (input, ctx) => {
        self(ctx)
        const { accounts, problems } = await connectors.simplefin.accounts(input.action === 'balances' ? { balancesOnly: true } : { days: num(input.days) ?? 14 })
        // A bank SimpleFIN couldn't reach (it wants signing in again on bridge.simplefin.org): said, not left out quietly.
        const warning = problems.length ? `\n\nSimpleFIN couldn’t get everything: ${problems.join('; ')}. Tell the user; fixing it is on bridge.simplefin.org.` : ''
        if (accounts.length === 0) return `No accounts are shared through SimpleFIN.${warning}`
        if (input.action === 'balances') {
          return (
            accounts
              .map((a) => `- ${a.bank ? `${a.bank} · ` : ''}${a.name}: ${money(a.balance, a.currency)}${a['available-balance'] ? ` (available ${money(a['available-balance'], a.currency)})` : ''}, as of ${new Date(a['balance-date'] * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`)
              .join('\n') + warning
          )
        }
        const wanted = str(input.account).toLowerCase()
        const rows = accounts
          .filter((a) => !wanted || a.name.toLowerCase().includes(wanted) || a.id === wanted)
          .flatMap((a) => (a.transactions ?? []).map((t) => ({ ...t, account: a.name, currency: a.currency })))
          .sort((x, y) => (y.transacted_at ?? y.posted) - (x.transacted_at ?? x.posted))
          .slice(0, 120)
        if (rows.length === 0) return `No transactions in that time.${warning}`
        return (
          rows
            .map((t) => `- ${new Date((t.transacted_at ?? t.posted) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${money(t.amount, t.currency)} ${t.description}${t.pending ? ' (pending)' : ''} — ${t.account}`)
            .join('\n') + warning
        )
      }
    })
  }

  if (connectors.connected('instacart') && has(links, 'instacart')) {
    tools.push({
      name: 'instacart',
      description: 'Make an Instacart shopping-list page from items (or from a shared list’s open items, with list) that the user opens, picks a store and checks out themselves. Returns its link; show it with show_card and a url button.',
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, items: { type: 'array', items: { type: 'string' } } }, required: ['items'] },
      mutating: true,
      describe: (input) => `Instacart list: ${str(input.title) || 'Shopping list'}`,
      run: async (input, ctx) => {
        self(ctx)
        const items = Array.isArray(input.items) ? input.items.map(str).filter(Boolean) : []
        if (items.length === 0) return { text: 'Give the items.', isError: true }
        const link = await connectors.instacart.list(str(input.title) || 'Shopping list', items)
        return `Instacart list ready (${items.length} item${items.length === 1 ? '' : 's'}): ${link}\nNothing is ordered until the user checks out there.`
      }
    })
  }

  if (has(links, 'google-maps', 'waze', 'uber', 'lyft')) {
    tools.push({
      name: 'route',
      description: `How long a trip takes${connectors.connected('google-routes') ? ' in live traffic (Google Maps)' : ''}, with links to start it in Google Maps, Waze${has(links, 'uber') ? ', Uber' : ''}${has(links, 'lyft') ? ', Lyft' : ''}. {to, from? (default: the user's location), mode: drive|walk|transit|bike, depart_at?: ISO time}. Show it with show_card kind route.`,
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string' }, from: { type: 'string' }, mode: { type: 'string', enum: ['drive', 'walk', 'transit', 'bike'] }, depart_at: { type: 'string' } },
        required: ['to']
      },
      mutating: false,
      describe: (input) => `Route to ${str(input.to)}`,
      run: async (input, ctx) => {
        self(ctx)
        const to = str(input.to)
        const from = str(input.from)
        const mode = (['drive', 'walk', 'transit', 'bike'].includes(str(input.mode)) ? str(input.mode) : 'drive') as RouteMode
        let live: RouteResult | null = null
        let note = ''
        if (connectors.connected('google-routes') && from) {
          const departAt = str(input.depart_at) ? new Date(str(input.depart_at)) : undefined
          live = await connectors.routes.compute({ from, to, mode, ...(departAt && !Number.isNaN(departAt.getTime()) ? { departAt } : {}) })
        } else if (connectors.connected('google-routes')) note = 'Give from (an address) for a live drive time.'
        else note = 'No live traffic without Google Maps connected: open the Google Maps link in your browser (web_browser) to read the time, or ask the user to connect it.'
        const urls = [
          `Google Maps: ${googleMapsLink({ to, from, mode })}`,
          `Waze: ${wazeLink({ to, toAt: live?.toAt })}`,
          ...(has(links_(engine, ctx), 'uber') ? [`Uber: ${uberLink({ to, toAt: live?.toAt, from, fromAt: live?.fromAt })}`] : []),
          ...(has(links_(engine, ctx), 'lyft') ? [`Lyft: ${lyftLink({ toAt: live?.toAt })}`] : [])
        ]
        const head = live
          ? `${live.minutes} min${live.usualMinutes && live.usualMinutes !== live.minutes ? ` (usually ${live.usualMinutes})` : ''}${live.miles ? ` · ${live.miles} mi` : ''}${live.via ? ` · via ${live.via}` : ''}${live.traffic ? ` · ${live.traffic} traffic` : ''}`
          : `Route to ${to}`
        return [head, note, ...urls].filter(Boolean).join('\n')
      }
    })
  }

  if (has(links, 'venmo', 'cashapp', 'uber')) {
    tools.push({
      name: 'app_link',
      description:
        'A link that opens an app with a payment or ride filled in, for the user to confirm with a tap — the way to set up money or a car without doing it yourself. venmo {to: @username, amount, note, request?}. cashapp {to: $cashtag, amount}. uber {to: address}. Show it with show_card (kind payment or ride) and a url button labelled with what it does.',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', enum: ['venmo', 'cashapp', 'uber'] },
          to: { type: 'string' },
          amount: { type: 'number' },
          note: { type: 'string' },
          request: { type: 'boolean', description: 'venmo: request money instead of paying' }
        },
        required: ['app', 'to']
      },
      mutating: false,
      describe: (input) => `${str(input.app)} link`,
      run: async (input, ctx) => {
        self(ctx)
        const app = findWorkerApp(str(input.app))
        if (!app || !has(links_(engine, ctx), app.id)) return { text: `${app?.name ?? str(input.app)} isn’t linked to you.`, isError: true }
        const amount = num(input.amount)
        let link: string
        if (app.id === 'venmo') {
          if (amount === undefined) return { text: 'Give the amount.', isError: true }
          link = venmoLink({ to: str(input.to), amount, note: str(input.note), request: input.request === true })
        } else if (app.id === 'cashapp') link = cashAppLink({ to: str(input.to), ...(amount !== undefined ? { amount } : {}) })
        else {
          let toAt: LatLng | null = null
          if (connectors.connected('google-routes')) {
            toAt = await connectors.routes
              .compute({ from: str(input.to), to: str(input.to), mode: 'walk' })
              .then((r) => r.toAt)
              .catch(() => null)
          }
          link = uberLink({ to: str(input.to), toAt })
        }
        return `${link}\nNothing happens until the user opens it and confirms in ${app.name}.`
      }
    })
  }

  return tools
}

/** The calling worker's links, read when a tool runs (they may have changed since the listing). */
function links_(engine: WorkersEngine, ctx: ToolContext): WorkerAppLink[] {
  try {
    return engine.appsOf(self(ctx))
  } catch {
    return []
  }
}

function money(amount: string, currency: string): string {
  const n = Number(amount)
  if (!Number.isFinite(n)) return `${amount} ${currency}`
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: /^[A-Z]{3}$/.test(currency) ? currency : 'USD' }).format(n)
  } catch {
    return `${n.toFixed(2)} ${currency}`
  }
}

/** What each connected service lets this worker do, for its persona. */
export function connectedLines(connectors: Connectors, links: WorkerAppLink[]): string[] {
  const lines: string[] = []
  if (connectors.connected('home-assistant') && has(links, 'home-assistant', 'roborock', 'ring', 'tesla', 'hue')) lines.push('- Home Assistant is connected: use the home tool for devices (vacuum, doorbell events and camera snapshots, locks, climate).')
  else if (has(links, 'roborock')) lines.push('- Roborock needs Home Assistant, which isn’t connected: tell the user how (your page → Apps → Connections) when they ask for the vacuum.')
  if (has(links, 'tesla')) {
    lines.push(
      connectors.connected('tessie')
        ? '- Tesla is connected through Tessie: the tesla tool.'
        : connectors.connected('home-assistant')
          ? '- Tesla: through Home Assistant, if it has the Tesla integration (home devices search "tesla").'
          : '- Tesla isn’t connected (Tessie or Home Assistant): tell the user how when they ask for the car.'
    )
  }
  if (has(links, 'bank')) lines.push(connectors.connected('simplefin') ? '- Your bank: read-only through SimpleFIN, the bank tool. Prefer it to the bank’s website.' : '- Your bank: no SimpleFIN connection, so through its website in your browser.')
  if (has(links, 'instacart')) lines.push(connectors.connected('instacart') ? '- Instacart: the instacart tool makes a shopping-list page for the user to check out; prefer it to filling a cart in the browser.' : '- Instacart: through its website.')
  if (has(links, 'google-maps', 'waze')) lines.push(connectors.connected('google-routes') ? '- Live traffic is on: route gives real drive times.' : '- route gives links but no live times (Google Maps isn’t connected); read times from the Google Maps page in your browser if you need them.')
  if (has(links, 'venmo', 'cashapp', 'uber')) lines.push('- To pay someone or get the user a ride, prefer app_link: a link they confirm with one tap, shown in a card. Only use the website for what a link can’t do.')
  return lines
}
