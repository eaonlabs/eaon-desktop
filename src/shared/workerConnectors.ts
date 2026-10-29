/**
 * Connections that give workers' apps a real door instead of (or as well as)
 * their website: a service's own API, set up once in Eaon and shared by every
 * worker with that app linked. Each is something one person can set up for
 * themselves, with a key or a token they make on the service's site:
 *
 * - Home Assistant: the hub for devices with no API of their own — Roborock,
 *   Ring, locks, thermostats, and Tesla or Hue too if it has them.
 * - Tessie: Tesla's controls (Tesla's own Fleet API needs a registered app).
 * - SimpleFIN Bridge: read-only balances and transactions from most banks.
 * - Instacart Developer Platform: a shopping-list page, filled from a list,
 *   for the user to check out.
 * - Google Maps Routes API: drive times in live traffic.
 * - Philips Hue's bridge pairs with its button (hue.ts), not a form here.
 *
 * Values go into Eaon's secrets, never to the model or the renderer.
 */

export type ConnectorId = 'home-assistant' | 'tessie' | 'simplefin' | 'instacart' | 'google-routes'

export interface ConnectorField {
  key: string
  label: string
  placeholder: string
  /** Shown as dots; a secret the user pastes. */
  secret?: boolean
}

export interface ConnectorSpec {
  id: ConnectorId
  name: string
  /** What connecting it makes possible, one line. */
  unlocks: string
  /** Where the key or token is made, and how, in one line. */
  how: string
  helpUrl: string
  /** Setting it up, step by step, as the Plugins page shows it. */
  steps: string[]
  /** Where the user goes to make the key ("Open Tessie"). */
  site: { label: string; url: string }
  /** Which of the workers' apps it powers, by app id (shared/workerApps.ts). */
  apps: string[]
  /** Its logo, a file in renderer/src/assets/app-logos (see WorkerApp.logo). */
  logo?: string
  fields: ConnectorField[]
  /** It costs the user something (a subscription, metered API). */
  cost?: string
}

export const CONNECTORS: ConnectorSpec[] = [
  {
    id: 'home-assistant',
    logo: 'homeassistant.png',
    name: 'Home Assistant',
    unlocks: 'Robot vacuums, the Ring doorbell and its snapshots, locks, thermostats, garage doors — anything your Home Assistant controls.',
    how: 'In Home Assistant: your profile → Security → Long-lived access tokens → Create token.',
    helpUrl: 'https://www.home-assistant.io/docs/authentication/#your-account-profile',
    steps: [
      'Open Home Assistant in your browser (usually http://homeassistant.local:8123).',
      'Add the devices you want workers to use, if they aren’t there yet: Settings → Devices & services → Add integration → Roborock, Ring, Tesla Fleet, Philips Hue…',
      'Click your name at the bottom left → Security tab → Long-lived access tokens → Create token. Name it “Eaon” and copy it (it’s shown once).',
      'Paste Home Assistant’s address and the token below.'
    ],
    site: { label: 'Home Assistant docs', url: 'https://www.home-assistant.io/docs/authentication/#your-account-profile' },
    apps: ['home-assistant', 'roborock', 'ring', 'tesla', 'hue'],
    fields: [
      { key: 'url', label: 'Address', placeholder: 'http://homeassistant.local:8123' },
      { key: 'token', label: 'Long-lived access token', placeholder: 'eyJ0eXAiOiJKV1Qi…', secret: true }
    ]
  },
  {
    id: 'tessie',
    logo: 'tessie.png',
    name: 'Tessie (Tesla)',
    unlocks: 'Your Tesla: charge and range, climate, lock and unlock, trunks, charge limit.',
    how: 'At my.tessie.com → Settings → API Access → Generate access token.',
    helpUrl: 'https://developer.tessie.com/reference/authentication',
    steps: ['Sign up at tessie.com and add your Tesla (Tessie asks you to sign in to your Tesla account).', 'At my.tessie.com open Settings → API Access → Generate access token, and copy it.', 'Paste the token below.'],
    site: { label: 'Open Tessie', url: 'https://my.tessie.com/' },
    apps: ['tesla'],
    fields: [{ key: 'token', label: 'Access token', placeholder: 'Tessie API token', secret: true }],
    cost: 'Tessie is a paid subscription.'
  },
  {
    id: 'simplefin',
    logo: 'simplefin.png',
    name: 'SimpleFIN Bridge (banks)',
    unlocks: 'Read-only balances and recent transactions from your bank and card accounts. It can never move money.',
    how: 'At bridge.simplefin.org connect your banks, then create a setup token for an app and paste it here.',
    helpUrl: 'https://bridge.simplefin.org/',
    steps: [
      'Sign up at bridge.simplefin.org and connect your bank and card accounts there.',
      'Under Apps, choose New app connection and copy the setup token it gives you.',
      'Paste it below. A setup token works once: Eaon turns it into its own read-only access, so make a new token if you connect again.'
    ],
    site: { label: 'Open SimpleFIN Bridge', url: 'https://bridge.simplefin.org/' },
    apps: ['bank'],
    fields: [{ key: 'setupToken', label: 'Setup token', placeholder: 'aHR0cHM6Ly9icmlkZ2Uuc2ltcGxlZmlu…', secret: true }],
    cost: 'SimpleFIN Bridge is a small yearly subscription.'
  },
  {
    id: 'instacart',
    logo: 'instacart.png',
    name: 'Instacart Developer Platform',
    unlocks: 'Turns a grocery list into an Instacart shopping-list page you check out yourself.',
    how: 'At dashboard.instacart.com → API Keys → Create New API Key (Production).',
    helpUrl: 'https://docs.instacart.com/developer_platform_api/get_started/api-keys',
    steps: [
      'Sign in to the Instacart Developer Dashboard at dashboard.instacart.com.',
      'Open API Keys → Create New API Key, name it “Eaon”, choose Production, and Generate Key.',
      'Paste the key below.'
    ],
    site: { label: 'Open Instacart dashboard', url: 'https://dashboard.instacart.com/' },
    apps: ['instacart'],
    fields: [{ key: 'key', label: 'API key', placeholder: 'Instacart API key', secret: true }]
  },
  {
    id: 'google-routes',
    logo: 'googlemaps.png',
    name: 'Google Maps (live traffic)',
    unlocks: 'Drive, transit, walk and bike times with live traffic, for leave-by times and route cards.',
    how: 'In Google Cloud console: enable the Routes API, then Credentials → Create API key.',
    helpUrl: 'https://developers.google.com/maps/documentation/routes/get-api-key',
    steps: [
      'In the Google Cloud console, create a project (or pick one) and turn on billing — Google gives a monthly free allowance.',
      'APIs & Services → Library → search “Routes API” → Enable.',
      'APIs & Services → Credentials → Create credentials → API key. Restrict it to the Routes API.',
      'Paste the key below.'
    ],
    site: { label: 'Open Google Cloud console', url: 'https://console.cloud.google.com/apis/library/routes.googleapis.com' },
    apps: ['google-maps', 'waze', 'uber', 'lyft'],
    fields: [{ key: 'key', label: 'API key', placeholder: 'AIza…', secret: true }],
    cost: 'Metered by Google, with a monthly free allowance.'
  }
]

export function connectorSpec(id: string): ConnectorSpec | undefined {
  return CONNECTORS.find((c) => c.id === id)
}

/** What the renderer is told about a connection: whether it works, and a line saying where. Never a key. */
export interface ConnectorStatus {
  connected: boolean
  /** "homeassistant.local · 38 devices", "2 accounts at Chase", "Model Y". */
  detail: string | null
}

export type ConnectorStatuses = Record<ConnectorId, ConnectorStatus>
