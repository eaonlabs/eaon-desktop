/**
 * Everyday apps a worker can be linked to: food delivery, rides, maps,
 * payments, shopping, ordering ahead, the doorbell camera, connected devices
 * and the household's calendar and lists.
 *
 * None of these services offers a public API an assistant can use on the
 * user's behalf, so most are worked the way a person would: the worker signs
 * in once on the service's website in its own browser (a profile of its own,
 * kept between runs) and drives the site from there. The user signs it in,
 * never the model: the sign-in sheet fills the page directly and the
 * password never reaches the model. A few have a better door:
 *
 * - `hue`: the Philips Hue bridge's own local API, paired with its button.
 * - `mac-calendar` / `mac-reminders`: Calendar and Reminders on this Mac.
 * - `mac-shortcuts`: the user's Shortcuts on this Mac, which reach the apps on the device.
 * - `lists`: shared lists Eaon keeps itself, which every worker and the user
 *   can read and tick off.
 * - `plugin`: no website can drive it (a car, a robot vacuum): the worker
 *   uses a connected plugin such as Home Assistant's, if there is one.
 *
 * Anything that spends money (an order, a ride, a payment) still stops for
 * the user's approval, as every purchase a worker makes does.
 *
 * Labs: off in release builds (see `workerAppsEnabled`), so it doesn't ship
 * in 2026.7.0.
 */

import { baseDomain } from './siteDomain'
import type { ConnectorId } from './workerConnectors'

declare const __EAON_LABS__: boolean | undefined

/** Whether an app works on a computer: Calendar and Reminders only on a Mac. */
export function availableOn(app: WorkerApp, platform: string): boolean {
  return !app.platforms || app.platforms.includes(platform as 'darwin')
}

/** Whether linked apps are offered in this build: dev builds, and builds made with EAON_LABS=1. */
export function workerAppsEnabled(): boolean {
  try {
    return typeof __EAON_LABS__ !== 'undefined' && __EAON_LABS__ === true
  } catch {
    return false
  }
}

export type WorkerAppCategory = 'food' | 'rides' | 'navigation' | 'payments' | 'shopping' | 'pickup' | 'security' | 'devices' | 'household'

export type WorkerAppVia = 'browser' | 'hue' | 'mac-calendar' | 'mac-reminders' | 'mac-shortcuts' | 'lists' | 'hub'

export interface WorkerApp {
  id: string
  name: string
  category: WorkerAppCategory
  /** Brand-ish tile colour for its mark; the mark itself is the name's first letters. */
  color: string
  mark: string
  /**
   * Its logo: the app's own icon, as on the App Store, a 128px file in
   * renderer/src/assets/app-logos. Without one (your bank, shared lists, which
   * aren't any one brand) it gets an icon for what it is.
   */
  logo?: string
  via: WorkerAppVia
  /** Where the worker starts (browser apps), or the service's site. */
  url: string
  /** The sign-in page; null when there is nothing to sign in to. */
  signIn: string | null
  /** Sites the sign-in sheet may fill. A page anywhere else is refused. */
  domains: string[]
  /** What a worker can do with it, in a few words each. */
  can: string[]
  /** Orders, rides or payments: real money, so each one waits for the user. */
  spends?: boolean
  /** One line the worker and the user should know. */
  note?: string
  /** Platforms it works on; all when absent. */
  platforms?: ('darwin' | 'win32' | 'linux')[]
  /**
   * Connections (shared/workerConnectors.ts) that give it a real API, best
   * first. Optional for a website app (it works without), required for a
   * `hub` app (nothing works without one of them).
   */
  connectors?: ConnectorId[]
  /** It has a prefilled link the user confirms with a tap (shared/workerLinks.ts, app_link). */
  links?: boolean
  /** Pages a worker goes straight to (open_app page), so it doesn't click its way there. */
  pages?: Partial<Record<'orders' | 'reorder' | 'account', string>>
}

export const APP_CATEGORIES: { id: WorkerAppCategory; label: string; blurb: string }[] = [
  { id: 'food', label: 'Food delivery', blurb: 'Ordering dinner and tracking it' },
  { id: 'rides', label: 'Rides', blurb: 'Getting a car and following it' },
  { id: 'navigation', label: 'Navigation', blurb: 'Getting somewhere and checking traffic' },
  { id: 'payments', label: 'Payments', blurb: 'Sending money or checking spending' },
  { id: 'shopping', label: 'Shopping', blurb: 'Buying essentials and tracking orders' },
  { id: 'pickup', label: 'Food pickup', blurb: 'Ordering ahead' },
  { id: 'security', label: 'Home security', blurb: 'Checking the doorbell or camera' },
  { id: 'devices', label: 'Connected devices', blurb: 'Controlling a car, vacuum, or lights' },
  { id: 'household', label: 'Household', blurb: 'Chores, plans, and supplies' }
]

export const WORKER_APPS: WorkerApp[] = [
  // Food delivery
  {
    id: 'doordash',
    name: 'DoorDash',
    category: 'food',
    color: '#EB1700',
    mark: 'DD',
    logo: 'doordash.png',
    via: 'browser',
    url: 'https://www.doordash.com/',
    signIn: 'https://identity.doordash.com/auth',
    domains: ['doordash.com'],
    can: ['reorder a favourite', 'find a restaurant', 'track a delivery'],
    spends: true,
    pages: { orders: 'https://www.doordash.com/orders/' }
  },
  {
    id: 'ubereats',
    name: 'Uber Eats',
    category: 'food',
    color: '#06C167',
    mark: 'UE',
    logo: 'ubereats.png',
    via: 'browser',
    url: 'https://www.ubereats.com/',
    signIn: 'https://auth.uber.com/v2/',
    domains: ['ubereats.com', 'uber.com'],
    can: ['reorder a favourite', 'find a restaurant', 'track a delivery'],
    spends: true,
    pages: { orders: 'https://www.ubereats.com/orders' }
  },
  {
    id: 'instacart',
    name: 'Instacart',
    category: 'food',
    color: '#43B02A',
    mark: 'IC',
    logo: 'instacart.png',
    via: 'browser',
    url: 'https://www.instacart.com/',
    signIn: 'https://www.instacart.com/login',
    domains: ['instacart.com'],
    can: ['fill a cart from your grocery list', 'schedule a delivery'],
    spends: true,
    connectors: ['instacart']
  },
  // Rides
  {
    id: 'uber',
    name: 'Uber',
    category: 'rides',
    color: '#000000',
    mark: 'U',
    logo: 'uber.png',
    via: 'browser',
    url: 'https://m.uber.com/',
    signIn: 'https://auth.uber.com/v2/',
    domains: ['uber.com'],
    can: ['price a ride', 'book a ride', 'follow the driver', 'a ride link you confirm'],
    spends: true,
    links: true
  },
  {
    id: 'lyft',
    name: 'Lyft',
    category: 'rides',
    color: '#FF00BF',
    mark: 'L',
    logo: 'lyft.png',
    via: 'browser',
    url: 'https://ride.lyft.com/',
    signIn: 'https://ride.lyft.com/login',
    domains: ['lyft.com'],
    can: ['price a ride', 'book a ride'],
    spends: true,
    links: true
  },
  // Navigation
  {
    id: 'google-maps',
    name: 'Google Maps',
    category: 'navigation',
    color: '#34A853',
    mark: 'GM',
    logo: 'googlemaps.png',
    via: 'browser',
    url: 'https://www.google.com/maps',
    signIn: null,
    domains: ['google.com'],
    can: ['directions', 'live traffic', 'find places nearby'],
    connectors: ['google-routes'],
    links: true
  },
  {
    id: 'waze',
    name: 'Waze',
    category: 'navigation',
    color: '#33CCFF',
    mark: 'W',
    logo: 'waze.png',
    via: 'browser',
    url: 'https://www.waze.com/live-map/',
    signIn: null,
    domains: ['waze.com'],
    can: ['drive times', 'traffic and hazards', 'a link that opens Waze on your phone'],
    connectors: ['google-routes'],
    links: true
  },
  // Payments
  {
    id: 'venmo',
    name: 'Venmo',
    category: 'payments',
    color: '#008CFF',
    mark: 'V',
    logo: 'venmo.png',
    via: 'browser',
    url: 'https://account.venmo.com/',
    signIn: 'https://id.venmo.com/signin',
    domains: ['venmo.com'],
    can: ['check your balance', 'see who paid you', 'a payment or request you confirm'],
    spends: true,
    links: true
  },
  {
    id: 'cashapp',
    name: 'Cash App',
    category: 'payments',
    color: '#00D632',
    mark: '$',
    logo: 'cashapp.png',
    via: 'browser',
    url: 'https://cash.app/account/activity',
    signIn: 'https://cash.app/login',
    domains: ['cash.app'],
    can: ['check your balance', 'see recent activity', 'a payment you confirm'],
    spends: true,
    links: true,
    note: 'Cash App signs in with a code sent to your phone or email, so it asks you for it.'
  },
  {
    id: 'bank',
    name: 'Your bank',
    category: 'payments',
    color: '#1F3A5F',
    mark: 'B',
    via: 'browser',
    url: '',
    signIn: null,
    domains: [],
    can: ['check balances', 'look over spending', 'spot unusual charges'],
    connectors: ['simplefin'],
    note: 'Best through SimpleFIN Bridge (read-only, most US banks). Without it, give your bank’s sign-in page and it looks in its browser. It never moves money.'
  },
  // Shopping
  {
    id: 'amazon',
    name: 'Amazon',
    category: 'shopping',
    color: '#FF9900',
    mark: 'a',
    logo: 'amazon.png',
    via: 'browser',
    url: 'https://www.amazon.com/',
    signIn: 'https://www.amazon.com/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.com%2F&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=usflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0',
    domains: ['amazon.com'],
    can: ['reorder essentials', 'track packages', 'compare prices'],
    spends: true,
    pages: { orders: 'https://www.amazon.com/gp/css/order-history', reorder: 'https://www.amazon.com/gp/buyagain' }
  },
  {
    id: 'walmart',
    name: 'Walmart',
    category: 'shopping',
    color: '#0071DC',
    mark: 'W',
    logo: 'walmart.png',
    via: 'browser',
    url: 'https://www.walmart.com/',
    signIn: 'https://www.walmart.com/account/login',
    domains: ['walmart.com'],
    can: ['fill a cart', 'pickup or delivery', 'track orders'],
    spends: true,
    pages: { orders: 'https://www.walmart.com/orders' }
  },
  {
    id: 'target',
    name: 'Target',
    category: 'shopping',
    color: '#CC0000',
    mark: 'T',
    logo: 'target.png',
    via: 'browser',
    url: 'https://www.target.com/',
    signIn: 'https://www.target.com/login',
    domains: ['target.com'],
    can: ['Drive Up and pickup orders', 'track orders', 'Circle deals'],
    spends: true,
    pages: { orders: 'https://www.target.com/orders' }
  },
  // Food pickup
  {
    id: 'starbucks',
    name: 'Starbucks',
    category: 'pickup',
    color: '#00704A',
    mark: 'S',
    logo: 'starbucks.png',
    via: 'browser',
    url: 'https://app.starbucks.com/menu',
    signIn: 'https://app.starbucks.com/account/signin',
    domains: ['starbucks.com'],
    can: ['order your usual ahead', 'pick a store', 'check Stars'],
    spends: true
  },
  {
    id: 'mcdonalds',
    name: 'McDonald’s',
    category: 'pickup',
    color: '#FFC72C',
    mark: 'M',
    logo: 'mcdonalds.png',
    via: 'browser',
    url: 'https://www.mcdonalds.com/us/en-us/mcdelivery.html',
    signIn: null,
    domains: ['mcdonalds.com'],
    can: ['find a restaurant and hours', 'order McDelivery through DoorDash or Uber Eats'],
    spends: true,
    note: 'Mobile Order & Pay is only in the McDonald’s phone app; on the web a worker orders through DoorDash or Uber Eats, so link one of those too.'
  },
  {
    id: 'chipotle',
    name: 'Chipotle',
    category: 'pickup',
    color: '#A81612',
    mark: 'C',
    logo: 'chipotle.png',
    via: 'browser',
    url: 'https://www.chipotle.com/order',
    signIn: 'https://www.chipotle.com/account/sign-in',
    domains: ['chipotle.com'],
    can: ['reorder your bowl', 'pick a pickup time'],
    spends: true
  },
  // Home security
  {
    id: 'ring',
    name: 'Ring',
    category: 'security',
    color: '#1C9AD6',
    mark: 'R',
    logo: 'ring.png',
    via: 'browser',
    url: 'https://account.ring.com/account/dashboard',
    signIn: 'https://ring.com/users/sign_in',
    domains: ['ring.com'],
    can: ['check who rang', 'look at the latest events', 'take a snapshot of live view'],
    connectors: ['home-assistant'],
    note: 'With Home Assistant’s Ring integration it sees rings and motion and grabs camera snapshots directly; otherwise it uses ring.com (Ring asks for a code from your phone the first time).'
  },
  // Connected devices
  {
    id: 'hue',
    name: 'Philips Hue',
    category: 'devices',
    color: '#6B4BFF',
    mark: 'H',
    logo: 'philipshue.png',
    via: 'hue',
    url: 'https://www.philips-hue.com/',
    signIn: null,
    domains: [],
    can: ['turn lights on and off', 'dim and colour them', 'see which are on'],
    connectors: ['home-assistant'],
    note: 'Pairs with the Hue bridge on your home network: press its button when asked.'
  },
  {
    id: 'roborock',
    name: 'Roborock',
    category: 'devices',
    color: '#E5322D',
    mark: 'RR',
    logo: 'roborock.png',
    via: 'hub',
    url: 'https://www.home-assistant.io/integrations/roborock/',
    signIn: null,
    domains: [],
    can: ['start or stop cleaning', 'send it to the dock', 'clean one room'],
    connectors: ['home-assistant'],
    note: 'Roborock has no public API or website. It works through Home Assistant with its Roborock integration added.'
  },
  {
    id: 'tesla',
    name: 'Tesla',
    category: 'devices',
    color: '#171A20',
    mark: 'T',
    logo: 'tesla.png',
    via: 'hub',
    url: 'https://www.tessie.com/',
    signIn: null,
    domains: [],
    can: ['check charge and range', 'precondition the cabin', 'lock or unlock', 'set the charge limit'],
    connectors: ['tessie', 'home-assistant'],
    note: 'Tesla’s own API needs a registered developer app, so it goes through Tessie (a token from my.tessie.com) or Home Assistant’s Tesla integration.'
  },
  {
    id: 'home-assistant',
    name: 'Home Assistant',
    category: 'devices',
    color: '#18BCF2',
    mark: 'HA',
    logo: 'homeassistant.png',
    via: 'hub',
    url: 'https://www.home-assistant.io/',
    signIn: null,
    domains: [],
    can: ['any device it controls', 'locks, thermostats, garage, sensors', 'camera snapshots'],
    connectors: ['home-assistant'],
    note: 'Opening a lock, the garage or disarming an alarm always waits for your OK.'
  },
  // Household
  {
    id: 'calendar',
    name: 'Calendar',
    category: 'household',
    color: '#FF3B30',
    mark: '31',
    logo: 'applecalendar.png',
    via: 'mac-calendar',
    url: '',
    signIn: null,
    domains: [],
    can: ['what’s on today', 'add an event'],
    platforms: ['darwin'],
    note: 'Uses Calendar on this Mac; macOS asks you once to allow it.'
  },
  {
    id: 'reminders',
    name: 'Reminders',
    category: 'household',
    color: '#FF9500',
    mark: '✓',
    logo: 'applereminders.png',
    via: 'mac-reminders',
    url: '',
    signIn: null,
    domains: [],
    can: ['add a reminder', 'tick one off', 'what’s due'],
    platforms: ['darwin'],
    note: 'Uses Reminders on this Mac; macOS asks you once to allow it.'
  },
  {
    id: 'shortcuts',
    name: 'Shortcuts',
    category: 'household',
    color: '#3B5BDB',
    mark: '⌘',
    logo: 'shortcuts.png',
    via: 'mac-shortcuts',
    url: '',
    signIn: null,
    domains: [],
    can: ['run your shortcuts', 'use the apps on this Mac that add actions to Shortcuts'],
    platforms: ['darwin'],
    note: 'Runs the shortcuts you make in the Shortcuts app: a Home scene, a Message, Music, a Focus, or any app’s own actions.'
  },
  {
    id: 'lists',
    name: 'Shared lists',
    category: 'household',
    color: '#22A7A0',
    mark: '≡',
    via: 'lists',
    url: '',
    signIn: null,
    domains: [],
    can: ['grocery and supply lists', 'chores', 'shared with every worker and you']
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    category: 'household',
    color: '#4285F4',
    mark: 'G',
    logo: 'googlecalendar.png',
    via: 'browser',
    url: 'https://calendar.google.com/',
    signIn: 'https://accounts.google.com/',
    domains: ['google.com'],
    can: ['what’s on today', 'add an event', 'find a free slot'],
    note: 'Google often refuses automated sign-ins; if it does, sign in yourself in the worker’s browser.'
  }
]

const BY_ID = new Map(WORKER_APPS.map((app) => [app.id, app]))

export function workerApp(id: string): WorkerApp | undefined {
  return BY_ID.get(id)
}

/** An app by id or by name, as a model writes it ("Uber Eats", "ubereats", "uber-eats"). */
export function findWorkerApp(text: string): WorkerApp | undefined {
  const key = text.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!key) return undefined
  return WORKER_APPS.find((app) => app.id.replace(/[^a-z0-9]/g, '') === key || app.name.toLowerCase().replace(/[^a-z0-9]/g, '') === key)
}

/**
 * An app linked to one worker. `signedIn` is what is known about its session:
 * `yes` once the user signed it in (or the worker confirmed it is), `no`
 * before that or after the site signed it out, `n/a` for apps with nothing
 * to sign in to.
 */
export interface WorkerAppLink {
  id: string
  linkedAt: number
  signedIn: 'yes' | 'no' | 'n/a'
  /** The account it is signed in as, if the user said ("sam@…"). Never a password. */
  account?: string
  /** Your bank: the sign-in page the user gave. */
  url?: string
  /** When it last used the app. */
  usedAt?: number
}

export function needsSignIn(app: WorkerApp): boolean {
  return app.via === 'browser' && (app.signIn !== null || app.id === 'bank')
}

/** Where the sign-in sheet sends the worker's browser, and the sites it may fill there. */
export function signInTarget(app: WorkerApp, link: Pick<WorkerAppLink, 'url'> | null): { url: string; domains: string[] } | null {
  if (app.id === 'bank') {
    const url = link?.url ?? ''
    try {
      const host = new URL(url).hostname.replace(/^www\./, '')
      // The bank's own name, never its country's suffix ("co.uk") or a shared host's.
      return { url, domains: [baseDomain(host)] }
    } catch {
      return null
    }
  }
  if (!app.signIn) return null
  return { url: app.signIn, domains: app.domains }
}

/** Whether `url` is on one of `domains` (subdomains included). */
export function onDomain(url: string, domains: string[]): boolean {
  let host: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    host = parsed.hostname.toLowerCase()
  } catch {
    return false
  }
  return domains.some((d) => host === d || host.endsWith(`.${d}`))
}

/** What the worker is told about an app it has, one line. */
export function appLine(app: WorkerApp, link: WorkerAppLink, platform: string): string {
  // Linked on a Mac, then moved with its worker to a worker computer that isn't one.
  if (!availableOn(app, platform)) {
    return `- ${app.name}: not reachable from the computer you run on now (it needs a Mac). If the user asks for it, say so: bringing you back to their Mac (Settings → Worker computer) makes it work again.`
  }
  const state =
    app.via === 'browser'
      ? link.signedIn === 'yes'
        ? `signed in${link.account ? ` as ${link.account}` : ''} in your browser`
        : needsSignIn(app)
          ? 'not signed in yet — request_sign_in before using it'
          : 'no account needed'
      : app.via === 'hue'
        ? 'through the Hue bridge (hue tool)'
        : app.via === 'lists'
          ? 'shared lists (lists tool)'
          : app.via === 'mac-shortcuts'
            ? 'the user’s shortcuts on this Mac (shortcuts tool)'
          : app.via === 'hub'
            ? 'through its connection (see Connected services)'
            : 'on this Mac (household tool)'
  return `- ${app.name}: ${app.can.join(', ')} — ${state}${app.spends ? '; anything that spends money waits for the user’s approval' : ''}.`
}
