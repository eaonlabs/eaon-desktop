import { unreachable } from './connectors'

/**
 * Philips Hue, through the bridge's own local API (v1, on the home network):
 * find the bridge, pair with it by pressing its button, then list and set
 * lights and rooms. Nothing goes through Philips' cloud.
 *
 * The bridge's app key ("username") is a credential, so it lives with the
 * other secrets; the service passes `load`/`save` for it. `fetch` is
 * injectable so tests run against a fake bridge.
 */

export interface HueBridge {
  ip: string
  id: string
  /** The app key the bridge issued when its button was pressed. */
  username: string
}

export interface HueLight {
  id: string
  name: string
  on: boolean
  /** 0–100. */
  brightness: number
  reachable: boolean
  room: string | null
}

export interface HueDeps {
  fetch?: typeof fetch
  load: () => HueBridge | null
  save: (bridge: HueBridge | null) => void
}

export interface HueTarget {
  on?: boolean
  /** 0–100. */
  brightness?: number
  /** A colour name or #rrggbb. */
  color?: string
  temperature?: 'warm' | 'neutral' | 'cool'
}

const TIMEOUT_MS = 8000

/** The bridge (or Philips' bridge finder) never answered: not on, not on this network, or moved to another address. */
class Unreachable extends Error {}

/** Colour names a model is likely to say, as sRGB. */
const NAMED: Record<string, [number, number, number]> = {
  red: [255, 0, 0],
  orange: [255, 120, 0],
  amber: [255, 170, 40],
  yellow: [255, 230, 0],
  green: [0, 200, 70],
  teal: [0, 180, 170],
  cyan: [0, 220, 255],
  blue: [0, 80, 255],
  purple: [140, 60, 255],
  violet: [150, 80, 255],
  pink: [255, 80, 170],
  magenta: [255, 0, 200],
  white: [255, 244, 229]
}

/** sRGB to the CIE xy a Hue light takes (gamma-expanded, wide-gamut D65 matrix). */
export function toXy(color: string): [number, number] | null {
  const key = color.trim().toLowerCase()
  let rgb = NAMED[key]
  const hex = /^#?([0-9a-f]{6})$/i.exec(key)
  if (!rgb && hex) {
    const n = parseInt(hex[1], 16)
    rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  if (!rgb) return null
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255
    return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92
  })
  const X = r * 0.664511 + g * 0.154324 + b * 0.162028
  const Y = r * 0.283881 + g * 0.668433 + b * 0.047685
  const Z = r * 0.000088 + g * 0.07231 + b * 0.986039
  const sum = X + Y + Z
  if (sum === 0) return [0.3227, 0.329]
  return [Math.round((X / sum) * 10000) / 10000, Math.round((Y / sum) * 10000) / 10000]
}

/** Mireds for a white: warm 2700 K, neutral 4000 K, cool 6500 K. */
const MIREDS = { warm: 370, neutral: 250, cool: 153 } as const

/** The state body a light (or a room's action) is sent. */
export function stateBody(target: HueTarget): Record<string, unknown> {
  // "warm white" and the like are whites: colour temperatures, not colours.
  const white = target.color ? /^(warm|soft|neutral|cool|cold|daylight)(\s+white)?$/i.exec(target.color.trim()) : null
  if (white) {
    const word = white[1].toLowerCase()
    target = { ...target, color: undefined, temperature: word === 'warm' || word === 'soft' ? 'warm' : word === 'neutral' ? 'neutral' : 'cool' }
  }
  const body: Record<string, unknown> = {}
  if (typeof target.on === 'boolean') body.on = target.on
  if (typeof target.brightness === 'number' && Number.isFinite(target.brightness)) {
    const pct = Math.max(0, Math.min(100, target.brightness))
    if (pct === 0) body.on = false
    else {
      body.bri = Math.max(1, Math.round((pct / 100) * 254))
      if (body.on === undefined) body.on = true
    }
  }
  // Off is off: a colour or a white sent with it is refused by the bridge (error 201) though the light did go off.
  if (body.on === false) return body
  if (target.color) {
    const xy = toXy(target.color)
    if (!xy) throw new Error(`"${target.color}" isn't a colour the lights know. Use a name (red, warm white…) or #rrggbb.`)
    body.xy = xy
    if (body.on === undefined) body.on = true
  } else if (target.temperature) {
    body.ct = MIREDS[target.temperature]
    if (body.on === undefined) body.on = true
  }
  return body
}

type Json = Record<string, unknown>

/** A bridge's address in a URL: an IPv6 one in brackets (fe80::1 → [fe80::1]), anything else as it is. */
export const hostOf = (ip: string): string => ((ip.match(/:/g) ?? []).length > 1 && !ip.startsWith('[') ? `[${ip}]` : ip)

export function createHue(deps: HueDeps) {
  const http = deps.fetch ?? fetch

  const call = async (url: string, init: RequestInit = {}, who = 'The Hue bridge'): Promise<unknown> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    let response: Response
    try {
      response = await http(url, { ...init, signal: controller.signal, headers: { 'content-type': 'application/json' } })
    } catch (error) {
      const at = (() => {
        try {
          return new URL(url).host
        } catch {
          return url
        }
      })()
      if ((error as Error)?.name === 'AbortError') throw new Unreachable(`${who} at ${at} didn’t answer. Is it on, and on the same network as this computer?`)
      throw new Unreachable(`Couldn’t reach ${who.replace(/^The /, 'the ')} at ${at}: ${unreachable(error)}. Is it on, and on the same network as this computer?`)
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) throw new Error(`${who} answered ${response.status}.`)
    try {
      return await response.json()
    } catch {
      throw new Error(`${who} answered with something that isn’t the Hue API. Is that the bridge’s address?`)
    }
  }

  /** The first error in a bridge reply, as a sentence. */
  const bridgeError = (reply: unknown): string | null => {
    const items = Array.isArray(reply) ? reply : [reply]
    for (const item of items) {
      const error = (item as { error?: { type?: number; description?: string } })?.error
      if (error) return error.type === 1 ? 'The bridge no longer knows Eaon. Pair it again.' : (error.description ?? 'The bridge refused that.')
    }
    return null
  }

  const bridge = (): HueBridge => {
    const saved = deps.load()
    if (!saved) throw new Error('No Hue bridge is paired yet. Pair one first: press the button on the bridge, then pair.')
    return saved
  }

  const base = (b: HueBridge): string => `http://${hostOf(b.ip)}/api/${encodeURIComponent(b.username)}`

  /** Bridges on this network, from Philips' discovery service. */
  const discover = async (): Promise<{ id: string; ip: string }[]> => {
    let reply: unknown
    try {
      reply = await call('https://discovery.meethue.com/', {}, 'Philips’ bridge finder')
    } catch (error) {
      // It allows few requests from one address (429), and needs the internet: the address typed in works without it.
      throw new Error(`${(error as Error).message} Type the bridge’s IP address instead (in the Hue app: Settings → My Hue System → your bridge).`)
    }
    return (Array.isArray(reply) ? reply : [])
      .map((b: Json) => ({ id: String(b.id ?? ''), ip: String(b.internalipaddress ?? '') }))
      .filter((b) => /^[0-9.]+$/.test(b.ip) || /^[0-9a-f:]+$/i.test(b.ip))
  }

  /**
   * `work` with the paired bridge. A home network hands addresses out again,
   * so a bridge that doesn't answer where it was is looked for by its id and,
   * found somewhere new, kept there and asked again — as Philips' own apps do.
   */
  const withBridge = async <T>(work: (b: HueBridge) => Promise<T>): Promise<T> => {
    const b = bridge()
    try {
      return await work(b)
    } catch (error) {
      if (!(error instanceof Unreachable) || !b.id) throw error
      const moved = await discover().then(
        (found) => found.find((f) => f.id.toLowerCase() === b.id.toLowerCase() && f.ip !== b.ip),
        () => undefined
      )
      if (!moved) throw error
      const next = { ...b, ip: moved.ip }
      deps.save(next)
      return await work(next)
    }
  }

  return {
    paired(): HueBridge | null {
      return deps.load()
    },

    discover,

    /**
     * Pairs with a bridge (the first one found, unless `ip` names one). The
     * bridge only agrees in the 30 seconds after its button is pressed;
     * before that it says so, which is passed on.
     */
    async pair(ip?: string): Promise<HueBridge> {
      let target = ip?.trim()
      let id = ''
      if (!target) {
        const found = await this.discover()
        if (found.length === 0) throw new Error('No Hue bridge was found on this network. Type its IP address (in the Hue app: Settings → My Hue System → your bridge) and pair again.')
        target = found[0].ip
        id = found[0].id
      }
      target = target.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
      if (!/^[0-9a-z.:\[\]-]+$/i.test(target)) throw new Error('That isn’t an IP address.')
      target = target.replace(/^\[(.*)\]$/, '$1')
      const reply = await call(`http://${hostOf(target)}/api`, { method: 'POST', body: JSON.stringify({ devicetype: 'eaon#workers' }) })
      const first = Array.isArray(reply) ? (reply[0] as { success?: { username?: string }; error?: { type?: number } }) : null
      if (first?.error?.type === 101) throw new Error('Press the round button on top of the Hue bridge, then pair again within 30 seconds.')
      const username = first?.success?.username
      if (!username) throw new Error(bridgeError(reply) ?? 'The bridge didn’t give Eaon a key.')
      // Its id, so it can be found again if its address changes (the config answers without a key).
      if (!id) {
        const config = (await call(`http://${hostOf(target)}/api/config`).catch(() => null)) as { bridgeid?: unknown } | null
        id = typeof config?.bridgeid === 'string' ? config.bridgeid.toLowerCase() : ''
      }
      const paired = { ip: target, id, username }
      deps.save(paired)
      return paired
    },

    forget(): void {
      deps.save(null)
    },

    async lights(): Promise<HueLight[]> {
      const [lights, groups] = (await withBridge((b) => Promise.all([call(`${base(b)}/lights`), call(`${base(b)}/groups`)]))) as [Json, Json]
      const failed = bridgeError(lights)
      if (failed) throw new Error(failed)
      const roomOf = new Map<string, string>()
      for (const group of Object.values(groups ?? {}) as Json[]) {
        if (group?.type !== 'Room' && group?.type !== 'Zone') continue
        for (const lightId of (group.lights as string[]) ?? []) if (!roomOf.has(lightId)) roomOf.set(lightId, String(group.name))
      }
      return Object.entries(lights ?? {}).map(([id, raw]) => {
        const light = raw as { name?: string; state?: { on?: boolean; bri?: number; reachable?: boolean } }
        return {
          id,
          name: light.name ?? `Light ${id}`,
          on: light.state?.on === true,
          brightness: Math.round(((light.state?.bri ?? 0) / 254) * 100),
          reachable: light.state?.reachable !== false,
          room: roomOf.get(id) ?? null
        }
      })
    },

    /**
     * Sets a light, a room (or zone) by name, or `all`. Names match ignoring
     * case; a room wins over a light of the same name. Says what changed.
     */
    async set(target: string, state: HueTarget): Promise<string> {
      bridge()
      const body = stateBody(state)
      if (Object.keys(body).length === 0) throw new Error('Say what to change: on, brightness, color or temperature.')
      const wanted = target.trim().toLowerCase()
      let path: string
      let label: string
      if (!wanted || wanted === 'all' || wanted === 'everything') {
        path = '/groups/0/action'
        label = 'every light'
      } else {
        const groups = (await withBridge((b) => call(`${base(b)}/groups`))) as Json
        const group = Object.entries(groups ?? {}).find(([, g]) => String((g as Json)?.name ?? '').toLowerCase() === wanted)
        if (group) {
          path = `/groups/${group[0]}/action`
          label = String((group[1] as Json).name)
        } else {
          const lights = await this.lights()
          const light = lights.find((l) => l.name.toLowerCase() === wanted) ?? lights.find((l) => l.name.toLowerCase().includes(wanted))
          if (!light) throw new Error(`No light or room called "${target}". Lights: ${lights.map((l) => l.name).join(', ') || 'none'}.`)
          path = `/lights/${light.id}/state`
          label = light.name
        }
      }
      const reply = await withBridge((b) => call(`${base(b)}${path}`, { method: 'PUT', body: JSON.stringify(body) }))
      const failed = bridgeError(reply)
      if (failed) throw new Error(failed)
      const parts = [
        body.on === false ? 'off' : body.on === true ? 'on' : null,
        typeof body.bri === 'number' ? `${Math.round((body.bri / 254) * 100)}%` : null,
        body.xy && state.color ? state.color : body.ct ? `${Object.entries(MIREDS).find(([, m]) => m === body.ct)?.[0] ?? 'white'} white` : null
      ].filter(Boolean)
      return `${label}: ${parts.join(', ')}`
    }
  }
}

export type Hue = ReturnType<typeof createHue>
