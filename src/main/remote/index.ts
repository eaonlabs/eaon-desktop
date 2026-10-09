import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { hostname, networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { app } from 'electron'
import { REMOTE_TOKEN_PREFIX, remotePairingLink, type RemoteInfo, type RemoteModelEntry, type RemoteModelRef, type RemoteStatus } from '@shared/remote'
import type { WorkersHub } from '../features/workers/hub'
import { gatewayModels } from '../gateway/models'
import { getProvider } from '../providers'
import { store } from '../store'
import type { RemoteEngine } from './api'
import { Bonjour } from './bonjour'
import { RemoteServer, type RemoteServerOptions } from './server'

/**
 * Remote devices, wired to the app: when the server runs, with which key, and
 * what Settings shows. The server itself (`server.ts`) knows nothing of
 * settings, so tests drive it directly; this is the part that reads them.
 */

export const newRemoteToken = (): string => `${REMOTE_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`

/** The key, made the first time anything asks for it. */
export function remoteToken(): string {
  const saved = store.getSettings().remote.token
  if (saved) return saved
  const token = newRemoteToken()
  store.patchSettings({ remote: { ...store.getSettings().remote, token } })
  return token
}

/**
 * Addresses a phone could reach this computer on: non-internal IPv4, with the
 * ordinary home and office ranges first, then the rest (Tailscale's 100.x, a
 * VPN's). Link-local 169.254.x is left out: it is what an interface with no
 * network gives itself.
 */
export function lanAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  const found: string[] = []
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if ((info.family === 'IPv4' || (info.family as unknown) === 4) && !info.internal && !info.address.startsWith('169.254.')) found.push(info.address)
    }
  }
  const private_ = (address: string): boolean => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)
  return [...new Set(found)].sort((a, b) => Number(private_(b)) - Number(private_(a)))
}

function scutil(key: string): Promise<string | null> {
  return new Promise((resolve) => execFile('scutil', ['--get', key], { timeout: 2000 }, (error, stdout) => resolve(error ? null : stdout.trim() || null)))
}

/**
 * The name the phone lists ("Alex's MacBook Pro") and the name the Mac
 * answers to on the network ("Alexs-MacBook-Pro", which with ".local" is
 * what Bonjour resolves). macOS keeps both apart from the hostname.
 */
export async function computerNames(): Promise<{ computerName: string; hostName: string }> {
  const fallback = hostname().replace(/\.local\.?$/i, '')
  if (process.platform !== 'darwin') return { computerName: fallback, hostName: fallback }
  const [computerName, hostName] = await Promise.all([scutil('ComputerName'), scutil('LocalHostName')])
  return { computerName: computerName ?? fallback, hostName: hostName ?? fallback }
}

/** The name the model picker shows for a model a worker is pinned to. */
function modelLabel(model: RemoteModelRef): string | undefined {
  try {
    return getProvider(model.providerId)?.models.find((m) => m.id === model.modelId)?.label || undefined
  } catch {
    return undefined
  }
}

/** What a worker can be pinned to, as the phone lists it. */
export const remoteModels = (): RemoteModelEntry[] => gatewayModels().map((m) => ({ id: m.id, name: m.label, provider: m.providerName }))

/** The app's selected model as `provider/model`, if the gateway can serve it. */
export function defaultModelId(): string | null {
  const { selectedModelId, selectedProviderId } = store.getSettings()
  if (!selectedModelId) return null
  const models = gatewayModels()
  const hit =
    (selectedProviderId ? models.find((m) => m.id === `${selectedProviderId}/${selectedModelId}`) : undefined) ?? models.find((m) => m.id.endsWith(`/${selectedModelId}`))
  return hit?.id ?? null
}

export interface RemoteDeps {
  hub: WorkersHub
  engine: RemoteEngine
  remove: (id: string) => Promise<void>
  onStatus?: (status: RemoteStatus) => void
  /** For tests. */
  server?: Partial<RemoteServerOptions>
  bonjour?: Bonjour
}

export interface RemoteController {
  info(): Promise<RemoteInfo>
  /** Starts the server if settings say it is on. Call once, at launch. */
  launch(): Promise<void>
  setEnabled(enabled: boolean): Promise<RemoteInfo>
  setPort(port: number): Promise<RemoteInfo>
  /** A new key; every connected phone is dropped and has to pair again. */
  resetToken(): Promise<RemoteInfo>
  /** Stops the server and the Bonjour announcement. */
  stop(): Promise<void>
  /** The synchronous part of stop(), for before-quit. */
  dispose(): void
  readonly server: RemoteServer
}

export function createRemote(deps: RemoteDeps): RemoteController {
  let names = { computerName: hostname().replace(/\.local\.?$/i, ''), hostName: hostname().replace(/\.local\.?$/i, '') }
  const namesReady = computerNames().then(
    (found) => {
      names = found
    },
    () => undefined
  )
  // Read once and kept: a request must not cost a settings-file read.
  let token = store.getSettings().remote.token ?? ''
  const bonjour = deps.bonjour ?? new Bonjour()

  const server = new RemoteServer({
    token: () => token,
    api: {
      engine: deps.engine,
      remove: deps.remove,
      info: () => ({ name: names.computerName, appVersion: app.getVersion() }),
      models: remoteModels,
      defaultModel: defaultModelId,
      modelLabel
    },
    hub: deps.hub,
    onStatus: deps.onStatus,
    ...deps.server
  })

  // Starting, stopping and moving the server touch the same socket; one at a time.
  let chain: Promise<unknown> = Promise.resolve()
  const queued = <T>(job: () => Promise<T>): Promise<T> => {
    const run = chain.then(job, job)
    chain = run.catch(() => undefined)
    return run
  }

  const begin = async (): Promise<void> => {
    await namesReady
    token = remoteToken()
    const status = await server.start(store.getSettings().remote.port)
    if (status.running) bonjour.start({ computerName: names.computerName, hostName: names.hostName, port: status.port })
  }
  const end = async (): Promise<void> => {
    bonjour.stop()
    await server.stop()
  }

  const info = async (): Promise<RemoteInfo> => {
    await namesReady
    const settings = store.getSettings().remote
    const status = server.status()
    const port = status.running ? status.port : settings.port
    const addresses = lanAddresses()
    const hostName = `${names.hostName}.local`
    return {
      enabled: settings.enabled,
      status: { ...status, port },
      addresses,
      hostName,
      computerName: names.computerName,
      token: settings.token,
      link: settings.token ? remotePairingLink({ host: addresses[0] ?? hostName, port, key: settings.token, name: names.computerName }) : null
    }
  }

  const patch = (change: Partial<{ enabled: boolean; port: number; token: string | null }>): void => {
    store.patchSettings({ remote: { ...store.getSettings().remote, ...change } })
  }

  return {
    server,
    info,
    launch: () => queued(async () => (store.getSettings().remote.enabled ? begin() : undefined)),
    async setEnabled(enabled) {
      await queued(async () => {
        patch({ enabled })
        await (enabled ? begin() : end())
      })
      return info()
    },
    async setPort(port) {
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Pick a port between 1024 and 65535.')
      await queued(async () => {
        patch({ port })
        // The announcement and the pairing link carry the port: move both.
        if (server.status().running) {
          await end()
          await begin()
        }
      })
      return info()
    },
    async resetToken() {
      await queued(async () => {
        token = newRemoteToken()
        patch({ token })
        // The streams were opened with the old key; closing them is how a phone finds out.
        server.disconnect()
      })
      return info()
    },
    stop: () => queued(end),
    dispose() {
      bonjour.stop()
      void server.stop()
    }
  }
}
