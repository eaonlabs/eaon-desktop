import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { MAIN_THREAD } from '@shared/workers'
import { CARD_KINDS, normalizeCard } from '@shared/workerCards'
import { normalizeUi, uiSummary, UI_BLOCK_TYPES } from '@shared/workerUi'
import { findWorkerApp, needsSignIn, signInTarget, workerApp, workerAppsEnabled, type WorkerApp, type WorkerAppLink } from '@shared/workerApps'
import type { AgentTool, ToolContext, ToolSource } from '../../agent/tools'
import type { WorkersEngine } from './engine'
import type { WorkerBrowsers } from './browser'
import type { Hue } from './hue'
import { listText, type Lists } from './lists'
import type { Household } from './household'
import { connectedLines, connectorTools, type Connectors } from './connectors'
import type { Vault } from './vault'
import { VaultLocked } from './vaultSeal'
import { hostMatches } from '@shared/workerVault'

/**
 * A worker's everyday apps (shared/workerApps.ts) and the cards it shows in
 * its thread (shared/workerCards.ts), as tools:
 *
 * - show_card, for every worker: a ride, an order, a route, a device…
 * - open_app / request_sign_in / app_signed_in, for its browser apps: the
 *   worker opens the app's site in its own browser and works it with
 *   web_browser; when it isn't signed in it asks the user, whose sign-in
 *   sheet fills the page without the model ever seeing the password.
 * - hue, lists and household, for the apps with a door of their own.
 *
 * Each is offered only to a worker that has the app linked, so a worker's
 * tool list (and the prompt cache with it) only grows with what it uses.
 */

export interface AppsDeps {
  engine: WorkersEngine
  browsers: WorkerBrowsers
  hue: Hue
  lists: Lists
  household: Household
  /** Connected services (connectors.ts); without them only websites, Hue, lists and the Mac apps work. */
  connectors?: Connectors
  /** The password vault (vault.ts); without it workers have no saved logins or passkeys. */
  vault?: Vault
  platform?: NodeJS.Platform
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((v) => str(v)).filter(Boolean) : typeof value === 'string' && value.trim() ? value.split(/\n|,(?![^(]*\))/).map((v) => v.trim()).filter(Boolean) : []

function self(ctx: ToolContext): string {
  const id = ctx.request.workerId
  if (!id) throw new Error('Only a worker can use this tool.')
  return id
}

/** The worker's links, or none when it is gone (a tool listing must not throw). */
function linksOf(engine: WorkersEngine, workerId: string | undefined): WorkerAppLink[] {
  if (!workerId) return []
  try {
    return engine.appsOf(workerId)
  } catch {
    return []
  }
}

/** The linked app a call names, or a refusal that says which apps it has. */
function linked(engine: WorkersEngine, workerId: string, name: unknown): { app: WorkerApp; link: WorkerAppLink } {
  const app = findWorkerApp(str(name))
  const links = engine.appsOf(workerId)
  const link = app ? links.find((l) => l.id === app.id) : undefined
  if (!app || !link) {
    const have = links.map((l) => workerApp(l.id)?.name).filter(Boolean)
    throw new Error(
      `${app ? `${app.name} isn’t linked to you` : `There is no app called "${str(name)}"`}. ${have.length ? `Your apps: ${have.join(', ')}.` : 'You have no apps linked.'} The user links apps from your page (Apps).`
    )
  }
  return { app, link }
}

/** A path a card names, inside the worker's folder unless absolute. */
function cardImage(folder: string, path: string): string | null {
  const full = isAbsolute(path) ? path : resolve(folder, path)
  return existsSync(full) ? full : null
}

export function cardTool(engine: WorkersEngine, browsers: WorkerBrowsers): AgentTool {
  return {
    name: 'show_card',
    description: `Put a card in your thread for the user: richer than text for things with a state. kind is one of ${CARD_KINDS.join(', ')}.
- status {title, body, badge:{label, tone: done|action|working|failed|info|submitted}, screenshot?, actions}
- checklist {title?, items:[{label, detail, state: done|skipped|failed|pending}]} — the steps of a job, ticked off
- order {app, store, items:[{name, qty, price}], total, eta, stage: cart|placed|preparing|ready|on-the-way|delivered|picked-up|cancelled, actions}
- ride {app, from, to, eta, price, driver, car, plate, stage: quote|requesting|matched|arriving|on-trip|dropped-off|cancelled}
- route {from, to, duration, distance, traffic: light|moderate|heavy, via, leave_by, mode: drive|walk|transit|bike} — opens in Google Maps / Waze
- payment {app, direction: send|request, to, amount, note, state: draft|needs-approval|sent|failed}
- device {app, name, device: light|vacuum|car|lock|thermostat|camera|plug|speaker|other, state, on, level 0-100, stats:[{label, value}], actions${workerAppsEnabled() ? ", entity (a Home Assistant light/switch/fan's entity_id) or light (a Hue light or room's name): its switch then flips it at once" : ''}}
- camera {app, title, at, caption, screenshot: true (your browser's page now) or image (a file path)}
- list {title, list_id (a shared list: the card stays live), items:[{text, done}]}
- events {title, events:[{title, when, where}]}
- options {title, options:[{title, detail, price, reply}]} — the user taps one and you get its reply
- stats {title, stats:[{label, value, trend: up|down}]}
actions: up to 4 buttons [{label, reply (sent to you as the user's answer) | url | browser: true${workerAppsEnabled() ? ' | sign_in: app' : ''}}].`,
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: CARD_KINDS },
        title: { type: 'string' },
        body: { type: 'string' },
        screenshot: { type: 'boolean', description: 'Attach a screenshot of your browser as it is now' },
        image: { type: 'string', description: 'A picture file to show (a path in your folder)' }
      },
      required: ['kind'],
      additionalProperties: true
    },
    mutating: false,
    describe: (input) => `${str(input.kind) || 'card'}${str(input.title) ? `: ${str(input.title)}` : ''}`,
    run: async (input, ctx) => {
      const workerId = self(ctx)
      const raw = input.card && typeof input.card === 'object' ? (input.card as Record<string, unknown>) : input
      const result = normalizeCard(raw)
      if ('error' in result) return { text: result.error, isError: true }
      const worker = engine.list().find((w) => w.id === workerId)
      const folder = worker?.folder ?? ctx.cwd
      let image: string | null = null
      if (raw.screenshot === true) {
        if (!browsers.has(workerId)) return { text: 'Your browser has no page open, so there is nothing to screenshot. Open the page first.', isError: true }
        image = join(folder, 'cards', `card-${Date.now()}.png`)
        await browsers.saveScreenshot(workerId, image, false)
      } else if (str(raw.image)) {
        image = cardImage(folder, str(raw.image))
        if (!image) return { text: `No picture at ${str(raw.image)}.`, isError: true }
      }
      return `Shown to the user as a ${result.card.kind} card.${image ? ` [image: ${image}]` : ''}`
    }
  }
}

/**
 * show_ui: a card the worker lays out itself from blocks (shared/workerUi.ts)
 * when no ready-made card fits — a stock's live chart and figures, a
 * comparison, a plan with tabs. Drawn by Eaon; nothing the worker writes runs.
 */
export const uiTool: AgentTool = {
  name: 'show_ui',
  description: `Put a card you design in your thread, for answers that read better as a small app than as text: how a stock is doing, comparing options, a budget, a plan, results. Build it from blocks (each {type, …}):
- heading {text, detail} · text {text} (short; **bold** works) · divider
- stats {items:[{label, value, change: "+2.4%", tone: up|down|neutral|good|warn|bad}]} — 2 to 4 figures side by side
- chart {style: line|area|bar, unit, series:[{name, points:[{x, y}]}]} or views:[{label: "1W", series}] for tabs over the same chart; the user can read any point
- stock {symbol: "NVDA", range: 1d|5d|1mo|6mo|1y, news: true} — LIVE: Eaon draws the current price, today's move and a chart the user can switch between ranges (and headlines with news). Prefer it to typing prices yourself.
- table {columns, rows:[[...]]} — the user can sort it · list {items:[{title, detail, value, tone}]}
- progress {label, value, max} · badges {items:[{label, tone}]}
- tabs {tabs:[{label, blocks}]} — two or more, one level deep
- buttons {actions:[{label, reply (sent to you as the user's answer) | url}]}
Keep it to what answers the question; say the one-line takeaway in your reply too. For a stock, use trading_quote/trading_history or the web for facts, then a stock block plus a few stats and a line of why.`,
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      subtitle: { type: 'string' },
      blocks: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: UI_BLOCK_TYPES } }, required: ['type'], additionalProperties: true } }
    },
    required: ['blocks']
  },
  mutating: false,
  describe: (input) => str(input.title) || 'A card',
  run: async (input) => {
    const result = normalizeUi(input)
    if ('error' in result) return { text: result.error, isError: true }
    const skipped = result.skipped.length ? ` Left out, fix and show it again if they matter: ${result.skipped.join('; ')}.` : ''
    return `Shown to the user: ${uiSummary(result.ui)}, ${result.ui.blocks.length} block${result.ui.blocks.length === 1 ? '' : 's'}.${skipped}`
  }
}

export function appsToolSource(deps: AppsDeps): ToolSource {
  const { engine, browsers, hue, lists, household } = deps
  const platform = deps.platform ?? process.platform
  const show = cardTool(engine, browsers)

  const openApp: AgentTool = {
    name: 'open_app',
    description:
      'Open one of your linked apps’ website in your own browser (signed in as the user, once they have signed you in). Then work it with web_browser. page: orders (order history and tracking) or reorder (buy again), where the app has them; path: any page on that site ("/account").',
    inputSchema: {
      type: 'object',
      properties: { app: { type: 'string' }, page: { type: 'string', enum: ['orders', 'reorder', 'account'] }, path: { type: 'string' } },
      required: ['app']
    },
    mutating: false,
    describe: (input) => `Open ${str(input.app)}`,
    run: async (input, ctx) => {
      const workerId = self(ctx)
      const { app, link } = linked(engine, workerId, input.app)
      if (app.via !== 'browser') return { text: `${app.name} isn’t a website you drive: ${app.note ?? ''}`.trim(), isError: true }
      const start = app.id === 'bank' ? (link.url ?? '') : app.url
      if (!start) return { text: `${app.name} has no address yet. Ask the user for its sign-in page (ask_user); they set it when linking.`, isError: true }
      const path = str(input.path)
      const page = app.pages?.[str(input.page) as 'orders']
      const url = page ?? (path.startsWith('/') ? new URL(path, start).toString() : start)
      const outcome = await browsers.open(workerId, url, ctx.signal)
      engine.updateApp(workerId, app.id, { usedAt: Date.now() })
      const signIn = needsSignIn(app) && link.signedIn !== 'yes' ? ` You aren’t signed in to ${app.name} yet: if the page asks, call request_sign_in rather than typing anything.` : ''
      return `${outcome === 'timeout' ? 'Still loading' : 'Opened'} ${app.name} at ${browsers.url(workerId) || url}. Take a web_browser snapshot to work on it.${signIn}`
    }
  }

  const requestSignIn: AgentTool = {
    name: 'request_sign_in',
    description:
      'Ask the user to sign you in to one of your linked apps. A card appears in your thread; they type their login into Eaon (it goes straight into your browser, never to you) or sign in themselves in your browser. You get word when they have. Never type a password yourself or ask for one in chat. End your turn or do other work meanwhile.',
    inputSchema: { type: 'object', properties: { app: { type: 'string' }, reason: { type: 'string', description: 'Why, in one short line the user sees' } }, required: ['app'] },
    mutating: false,
    describe: (input) => `Sign in to ${str(input.app)}`,
    run: async (input, ctx) => {
      const workerId = self(ctx)
      const { app, link } = linked(engine, workerId, input.app)
      if (!needsSignIn(app)) return `${app.name} has nothing to sign in to.`
      const target = signInTarget(app, link)
      if (!target) return { text: `${app.name} has no sign-in page yet; ask the user for it (ask_user).`, isError: true }
      const saved = deps.vault?.loginsFor(workerId).find((l) => l.domains.some((d) => target.domains.some((t) => hostMatches(d, [t]) || hostMatches(t, [d]))))
      if (saved) return `You have a saved login for ${app.name} (${saved.username || 'no username'}). Open its sign-in page (open_app) and call sign_in_saved instead of asking the user.`
      engine.updateApp(workerId, app.id, { signedIn: 'no' })
      return `Asked the user to sign you in to ${app.name}. You’ll get a message when they have; until then, do something else or end your turn.`
    }
  }

  const appSignedIn: AgentTool = {
    name: 'app_signed_in',
    description: 'Record whether you are signed in to one of your linked apps, after checking in your browser (an account page loads, or a sign-in page appears).',
    inputSchema: {
      type: 'object',
      properties: { app: { type: 'string' }, signed_in: { type: 'boolean' }, account: { type: 'string', description: 'The account name or email it shows, if any' } },
      required: ['app', 'signed_in']
    },
    mutating: false,
    run: async (input, ctx) => {
      const workerId = self(ctx)
      const { app } = linked(engine, workerId, input.app)
      const link = engine.updateApp(workerId, app.id, { signedIn: input.signed_in === true ? 'yes' : 'no', ...(str(input.account) ? { account: str(input.account) } : {}) })
      return `${app.name}: ${link.signedIn === 'yes' ? `signed in${link.account ? ` as ${link.account}` : ''}` : 'not signed in'}.`
    }
  }

  const hueTool: AgentTool = {
    name: 'hue',
    description:
      'Philips Hue lights, through the bridge at home. lights: every light, its room, on/off and brightness. set {target: a light, a room, or "all", on, brightness 0-100, color (name or #rrggbb), temperature: warm|neutral|cool}.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['lights', 'set'] },
        target: { type: 'string' },
        on: { type: 'boolean' },
        brightness: { type: 'number' },
        color: { type: 'string' },
        temperature: { type: 'string', enum: ['warm', 'neutral', 'cool'] }
      },
      required: ['action']
    },
    mutating: (input) => input.action === 'set',
    describe: (input) => (input.action === 'set' ? `Lights: ${str(input.target) || 'all'}` : 'List lights'),
    run: async (input, ctx) => {
      self(ctx)
      if (!hue.paired()) return { text: 'The Hue bridge isn’t paired yet. Ask the user to pair it from your page (Apps → Philips Hue → Pair), pressing the bridge’s button.', isError: true }
      if (input.action === 'set') {
        return await hue.set(str(input.target), {
          ...(typeof input.on === 'boolean' ? { on: input.on } : {}),
          ...(typeof input.brightness === 'number' ? { brightness: input.brightness } : {}),
          ...(str(input.color) ? { color: str(input.color) } : {}),
          ...(input.temperature === 'warm' || input.temperature === 'neutral' || input.temperature === 'cool' ? { temperature: input.temperature } : {})
        })
      }
      const all = await hue.lights()
      if (all.length === 0) return 'The bridge has no lights.'
      return all.map((l) => `- ${l.name}${l.room ? ` (${l.room})` : ''}: ${l.reachable ? (l.on ? `on, ${l.brightness}%` : 'off') : 'unreachable'}`).join('\n')
    }
  }

  const listsTool: AgentTool = {
    name: 'lists',
    description:
      'Shared household lists (groceries, supplies, chores) the user and your colleagues see too. all: every list. show {list}. create {list}. add / remove / check / uncheck {list, items: [...]}. clear_done {list}. Show one to the user with show_card kind list and its list_id.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['all', 'show', 'create', 'add', 'remove', 'check', 'uncheck', 'clear_done'] },
        list: { type: 'string', description: 'The list’s name or id' },
        items: { type: 'array', items: { type: 'string' } }
      },
      required: ['action']
    },
    mutating: (input) => input.action !== 'all' && input.action !== 'show',
    describe: (input) => `${str(input.action)} ${str(input.list)}`.trim(),
    run: async (input, ctx) => {
      const workerId = self(ctx)
      const name = engine.list().find((w) => w.id === workerId)?.name ?? 'A worker'
      const action = str(input.action)
      if (action === 'all') {
        const all = lists.all()
        return all.length ? all.map((l) => `- ${l.name} (list_id ${l.id}): ${l.items.filter((i) => !i.done).length} to get, ${l.items.filter((i) => i.done).length} ticked`).join('\n') : 'No lists yet. create one.'
      }
      const list = str(input.list)
      if (!list) return { text: 'Say which list.', isError: true }
      if (action === 'create') return listText(lists.ensure(list))
      if (action === 'show') {
        const found = lists.get(list)
        return found ? listText(found) : { text: `No list called "${list}". create it first.`, isError: true }
      }
      if (action === 'clear_done') return lists.edit(list, { action: 'clear_done' }, name).changed
      if (action === 'add' || action === 'remove' || action === 'check' || action === 'uncheck') {
        const items = strings(input.items)
        if (items.length === 0) return { text: 'Give the items.', isError: true }
        // Adding to a list that isn't there yet makes it: "add milk to Groceries".
        if (action === 'add') lists.ensure(list)
        const { list: after, changed } = lists.edit(list, { action, items }, name)
        return `${changed}.\n${listText(after)}`
      }
      return { text: `Unknown action "${action}".`, isError: true }
    }
  }

  const householdTool: AgentTool = {
    name: 'household',
    description:
      'Calendar and Reminders on this Mac. events {days: 1-31, from?: ISO date} lists events. add_event {title, start, end (ISO date-times), location?, calendar?}. reminders {list?} lists what is due. add_reminder {title, due?: ISO, list?, notes?}. complete_reminder {title}.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['events', 'add_event', 'reminders', 'add_reminder', 'complete_reminder'] },
        days: { type: 'number' },
        from: { type: 'string' },
        title: { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
        due: { type: 'string' },
        location: { type: 'string' },
        calendar: { type: 'string' },
        list: { type: 'string' },
        notes: { type: 'string' }
      },
      required: ['action']
    },
    mutating: (input) => input.action === 'add_event' || input.action === 'add_reminder' || input.action === 'complete_reminder',
    describe: (input) => `${str(input.action)}${str(input.title) ? `: ${str(input.title)}` : ''}`,
    run: async (input, ctx) => {
      const workerId = self(ctx)
      const has = (id: string): boolean => linksOf(engine, workerId).some((l) => l.id === id)
      const date = (value: unknown, what: string): Date => {
        const d = new Date(str(value))
        if (Number.isNaN(d.getTime())) throw new Error(`${what} must be a date-time, like 2026-10-24T18:30.`)
        return d
      }
      switch (input.action) {
        case 'events': {
          if (!has('calendar')) return { text: 'Calendar isn’t linked to you.', isError: true }
          const from = str(input.from) ? date(input.from, 'from') : new Date()
          const events = await household.events(from, typeof input.days === 'number' ? input.days : 1)
          if (events.length === 0) return 'Nothing on the calendar then.'
          return events
            .map((e) => `- ${e.allDay ? 'All day' : new Date(e.start).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}: ${e.title}${e.location ? ` @ ${e.location}` : ''} (${e.calendar})`)
            .join('\n')
        }
        case 'add_event': {
          if (!has('calendar')) return { text: 'Calendar isn’t linked to you.', isError: true }
          const start = date(input.start, 'start')
          const end = str(input.end) ? date(input.end, 'end') : new Date(start.getTime() + 60 * 60_000)
          return household.addEvent({ title: str(input.title), start, end, location: str(input.location), calendar: str(input.calendar) })
        }
        case 'reminders': {
          if (!has('reminders')) return { text: 'Reminders isn’t linked to you.', isError: true }
          const items = await household.reminders(str(input.list) || undefined)
          if (items.length === 0) return 'No reminders due.'
          return items.map((r) => `- ${r.name}${r.due ? ` (due ${new Date(r.due).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })})` : ''} — ${r.list}`).join('\n')
        }
        case 'add_reminder': {
          if (!has('reminders')) return { text: 'Reminders isn’t linked to you.', isError: true }
          return household.addReminder({ name: str(input.title), due: str(input.due) ? date(input.due, 'due') : null, list: str(input.list), notes: str(input.notes) })
        }
        case 'complete_reminder': {
          if (!has('reminders')) return { text: 'Reminders isn’t linked to you.', isError: true }
          const n = await household.completeReminder(str(input.title))
          return n > 0 ? `Ticked off ${n} reminder${n === 1 ? '' : 's'}.` : `No open reminder called "${str(input.title)}".`
        }
        default:
          return { text: `Unknown action "${String(input.action)}".`, isError: true }
      }
    }
  }

  const vault = deps.vault
  const savedLogins: AgentTool = {
    name: 'saved_logins',
    description: 'The logins the user saved for you in the vault (website and username — never the password) and the passkeys your browser holds.',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    run: async (_input, ctx) => {
      const workerId = self(ctx)
      const logins = vault!.loginsFor(workerId)
      const passkeys = vault!.passkeysFor(workerId)
      const lines = [
        ...logins.map((l) => `- ${l.site} (${l.domains.join(', ')}): ${l.username || 'no username'}${l.hasCode ? ' · 2FA codes' : ''}${l.ask ? ' · asks the user before each use' : ''}`),
        ...passkeys.map((p) => `- Passkey for ${p.rpId}${p.userName ? ` (${p.userName})` : ''}`)
      ]
      return lines.length ? lines.join('\n') : 'Nothing saved for you yet. When a site needs a login, request_sign_in.'
    }
  }
  const signInSaved: AgentTool = {
    name: 'sign_in_saved',
    description:
      'Sign in with a login saved in the vault, on the sign-in page open in your browser: Eaon types the username and password itself (only if the page is on that login’s own website) and, if the site then asks for a 2FA code and one is saved, the code too. You never see the password. site: which login, if you have several for one website.',
    inputSchema: { type: 'object', properties: { site: { type: 'string' } } },
    mutating: true,
    catastrophic: (input, ctx) => {
      const workerId = ctx.request.workerId
      return Boolean(workerId && vault!.match(workerId, browsers.url(workerId), str(input.site))?.ask)
    },
    describe: (input) => `Sign in${str(input.site) ? ` to ${str(input.site)}` : ''} with a saved login`,
    run: async (input, ctx) => {
      const workerId = self(ctx)
      const url = browsers.url(workerId)
      if (!url || !browsers.has(workerId)) return { text: 'Open the site’s sign-in page in your browser first.', isError: true }
      const login = vault!.match(workerId, url, str(input.site))
      if (!login) {
        const host = (() => {
          try {
            return new URL(url).hostname
          } catch {
            return url
          }
        })()
        return { text: `You have no saved login for ${host}${url.startsWith('https:') ? '' : ' (and it isn’t a secure https page)'}. Call request_sign_in, or ask the user to save one.`, isError: true }
      }
      const result = await browsers.fillLogin(workerId, { username: login.username, password: login.password, domains: login.domains })
      if ('refused' in result) return { text: `The page moved to ${result.refused}, which isn’t ${login.site}; nothing was typed.`, isError: true }
      if (result.filled.length === 0) return { text: `Couldn’t find where to type on this page. Snapshot it: you may need to click “Sign in” first.`, isError: true }
      vault!.used(login.id)
      let codeNote = ''
      if (result.stillOnSignIn) {
        const code = login.code()
        if (code) {
          const typed = await browsers.fillCode(workerId, code, login.domains)
          codeNote = 'filled' in typed && typed.filled ? ' The site asked for a 2FA code; Eaon typed the saved one.' : ''
        }
      }
      return `Typed your saved ${login.site} login (${result.filled.join(' and ')}).${codeNote}${result.stillOnSignIn && !codeNote ? ' The page still shows a sign-in form: snapshot it — it may want a code sent to the user (ask them), or the login may be wrong.' : ' Snapshot the page to check you are in.'}`
    }
  }
  const fillSavedCode: AgentTool = {
    name: 'fill_2fa_code',
    description: 'Type the current 2FA code for the open page’s saved login into the page’s code field (the user saved its authenticator secret). You never see the code.',
    inputSchema: { type: 'object', properties: { site: { type: 'string' } } },
    mutating: true,
    // A login the user asked to be asked about each time is asked about for its code too, as sign_in_saved is.
    catastrophic: (input, ctx) => {
      const workerId = ctx.request.workerId
      return Boolean(workerId && vault!.match(workerId, browsers.url(workerId), str(input.site))?.ask)
    },
    describe: (input) => `Type the 2FA code${str(input.site) ? ` for ${str(input.site)}` : ''} from a saved login`,
    run: async (input, ctx) => {
      const workerId = self(ctx)
      const login = vault!.match(workerId, browsers.url(workerId), str(input.site))
      if (!login) return { text: 'No saved login for this page.', isError: true }
      const code = login.code()
      if (!code) return { text: `The ${login.site} login has no 2FA secret saved. Ask the user for the code (ask_user).`, isError: true }
      const typed = await browsers.fillCode(workerId, code, login.domains)
      if ('refused' in typed) return { text: 'This page isn’t on that login’s website; nothing was typed.', isError: true }
      return typed.filled ? 'Typed the code. Snapshot the page to check.' : { text: 'Couldn’t find a code field on this page.', isError: true }
    }
  }

  return {
    id: 'worker-apps',
    tools: (query) => {
      const workerId = query.request.workerId
      if (query.mode !== 'work' || query.depth !== 0 || !workerId) return []
      const tools: AgentTool[] = [show, uiTool]
      if (!workerAppsEnabled()) return tools
      const links = linksOf(engine, workerId)
      const apps = links.map((l) => workerApp(l.id)).filter((a): a is WorkerApp => Boolean(a))
      if (apps.some((a) => a.via === 'browser')) tools.push(openApp, requestSignIn, appSignedIn)
      if (apps.some((a) => a.via === 'hue')) tools.push(hueTool)
      if (apps.some((a) => a.via === 'lists')) tools.push(listsTool)
      if (platform === 'darwin' && apps.some((a) => a.via === 'mac-calendar' || a.via === 'mac-reminders')) tools.push(householdTool)
      if (deps.connectors) tools.push(...connectorTools(engine, deps.connectors, links))
      if (vault) {
        try {
          const logins = vault.loginsFor(workerId)
          if (logins.length > 0 || vault.passkeysFor(workerId).length > 0) tools.push(savedLogins)
          if (logins.length > 0) tools.push(signInSaved)
          if (logins.some((l) => l.hasCode)) tools.push(fillSavedCode)
        } catch (error) {
          // Locked until the desktop connects (vaultSeal.ts): no vault tools for this turn, and the brief says why.
          if (!(error instanceof VaultLocked)) throw error
        }
      }
      return tools
    },
    guidance: (query) => {
      if (!query.request.workerId) return null
      const card =
        'show_card shows the user something with a state — an order, a ride, a route, a payment, a device, a camera snapshot, a list, the day’s events, options to pick from, or the steps of a job ticked off — instead of describing it in text. Keep the text around a card short.'
      const lines = workerAppsEnabled() && deps.connectors ? connectedLines(deps.connectors, linksOf(engine, query.request.workerId)) : []
      if (workerAppsEnabled() && vault) {
        try {
          const logins = vault.loginsFor(query.request.workerId)
          const passkeys = vault.passkeysFor(query.request.workerId)
          if (logins.length) lines.push(`- Saved logins (vault): ${logins.map((l) => l.site).join(', ')}. On their sign-in page call sign_in_saved rather than request_sign_in; you never see these passwords.`)
          if (passkeys.length) lines.push(`- Your passkeys: ${[...new Set(passkeys.map((p) => p.rpId))].join(', ')}. On those sites choose “Sign in with a passkey”: your browser answers it.`)
          lines.push('- If the user asks you to set up a passkey for yourself on a site, sign in, open its security settings and add a passkey: your browser makes it and Eaon keeps it.')
        } catch (error) {
          // Locked on a worker computer until the desktop connects (vaultSeal.ts): the turn goes on without it.
          if (!(error instanceof VaultLocked)) throw error
          lines.push('- Your password vault is locked until Eaon on the user’s desktop connects to this computer. Until then, sign-ins go through request_sign_in.')
        }
      }
      return lines.length ? `${card}\nConnected services:\n${lines.join('\n')}` : card
    }
  }
}

/** Everything the sign-in sheet does, for the IPC handler and tests. */
export async function signInApp(
  deps: Pick<AppsDeps, 'engine' | 'browsers'>,
  workerId: string,
  appId: string,
  login: { username: string; password: string; remember?: boolean },
  threadId: string = MAIN_THREAD,
  vault?: Vault
): Promise<{ ok: boolean; message: string }> {
  const { engine, browsers } = deps
  const app = workerApp(appId)
  const link = engine.appsOf(workerId).find((l) => l.id === appId)
  if (!app || !link) throw new Error('That app isn’t linked to this worker any more.')
  const target = signInTarget(app, link)
  if (!target) throw new Error(`${app.name} has no sign-in page to fill.`)
  if (!login.username.trim() && !login.password) throw new Error('Type your username and password.')
  const opened = await browsers.open(workerId, target.url)
  if (opened === 'timeout') return { ok: false, message: `${app.name}’s sign-in page didn’t load. Try again, or use the browser instead.` }
  const result = await browsers.fillLogin(workerId, { username: login.username.trim(), password: login.password, domains: target.domains })
  if ('refused' in result) {
    return { ok: false, message: `The browser ended up on ${hostOf(result.refused)}, not ${app.name}, so nothing was typed. Use the browser instead.` }
  }
  if (result.filled.length === 0) return { ok: false, message: `Couldn’t find where to type on ${app.name}’s page. Use the browser instead.` }
  const account = login.username.includes('@') ? login.username.trim() : undefined
  engine.updateApp(workerId, appId, { signedIn: result.stillOnSignIn ? 'no' : 'yes', ...(account ? { account } : {}) })
  const name = engine.list().find((w) => w.id === workerId)?.name ?? 'The worker'
  if (result.stillOnSignIn) {
    engine.appEvent(
      workerId,
      `${app.name} sign-in needs another step`,
      `The user typed their ${app.name} login into your browser, but the page still shows a sign-in form (a code, a captcha, or a wrong password). Take a snapshot to see; if it needs a code, ask the user for it, and if it needs them, ask them to sign in in your browser themselves.`,
      threadId
    )
    return { ok: false, message: `${app.name} wants another step (a code, or a check that you’re human). ${name} will look, or use the browser to finish it yourself.` }
  }
  // Remembered, so next time the worker signs itself in (sign_in_saved) instead of asking.
  let remembered = false
  if (login.remember && vault) {
    try {
      vault.saveLogin({ site: app.name, domains: target.domains, username: login.username.trim(), password: login.password, workers: [workerId], source: 'sign-in' })
      remembered = true
    } catch {
      /* the sign-in itself went through */
    }
  }
  engine.appEvent(
    workerId,
    `Signed in to ${app.name}`,
    `The user signed you in to ${app.name}${account ? ` as ${account}` : ''} in your browser.${remembered ? ' The login is saved in the vault: next time, use sign_in_saved on its sign-in page.' : ''} Check the page, then carry on with what you needed it for.`,
    threadId
  )
  return { ok: true, message: remembered ? `Signed in, and saved to the vault for ${name}.` : `Login saved in ${name}’s browser.` }
}

/** The user finished signing in themselves, in the worker's browser. */
export function signedInByHand(engine: WorkersEngine, workerId: string, appId: string, threadId: string = MAIN_THREAD): void {
  const app = workerApp(appId)
  if (!app) throw new Error('There is no such app.')
  engine.updateApp(workerId, appId, { signedIn: 'yes' })
  engine.appEvent(workerId, `Signed in to ${app.name}`, `The user signed you in to ${app.name} themselves, in your browser. Check the page, then carry on.`, threadId)
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return 'another page'
  }
}
