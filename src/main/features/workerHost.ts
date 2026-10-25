import { app, Notification } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import type { AgentBrowserStatus, BrowserTarget } from '@shared/agentBrowser'
import type { ChannelLink, ChannelStatus } from '@shared/channels'
import type { Worker, WorkerRoom } from '@shared/workers'
import {
  credentialExpiry,
  WORKER_HOST_DEFAULT_PORT,
  WORKER_HOST_PROTOCOL,
  type HostHello,
  type HostInstallProgress,
  type HostPairing,
  type LinkedHost,
  type SshInstallRequest,
  type WorkerHostState
} from '@shared/workerHost'
import { secrets } from '../secrets'
import { store } from '../store'
import { computerNames, lanAddresses } from '../remote'
import { newHostSecret, type Peer } from '../workerHost/channel'
import { HostLink } from '../workerHost/client'
import { installOverSsh, startPairingServer, type PairingServer } from '../workerHost/install'
import { inside, listFolder, readChunks, readSnapshot, relocate, writeChunk, writeSnapshot, type FolderEntry, type WorkersSnapshot } from '../workerHost/move'
import { personalSkillsDir } from './skills'
import { remoteBrowserFrame, setRemoteBrowsers, type RemoteBrowsers } from './agentBrowser'
import { channelsHandle, type ChannelsData, type ChannelsHandle } from './channels'
import { workersService } from './workers'
import type { WorkersService } from './workers/service'
import type { Feature, FeatureContext } from './types'

/**
 * Worker computer: the user's workers run on another machine they leave on
 * (a Raspberry Pi, a spare Mac), so they keep working while this computer
 * sleeps, and this computer still shows them in the Workers tab.
 *
 * Linking installs the host app there (over SSH, or with one command typed
 * on it; `workerHost/install.ts`) with a secret only the two share, and
 * keeps a link to it (`workerHost/client.ts`, encrypted end to end in
 * `workerHost/channel.ts`). Each time the link comes up the desktop brings
 * the host up to date with its own build, then sends it the keys, provider
 * settings, MCP servers and skills the workers need.
 *
 * Turning it on moves the workers: the engine here stops, everything that
 * makes them who they are (and their folders) goes to the host, and the
 * Workers tab's IPC is answered by the host from then on. Their chat apps
 * go with them (the bots, their tokens, a WhatsApp session), so a worker
 * still answers on Telegram while this computer sleeps; Settings → Chat
 * apps is answered by the host too. Live views of
 * their browsers come over the link too. Turning it off brings them back.
 * While it is on and the host can't be reached, the tab shows the workers
 * as last seen, read-only.
 */

const CONFIG_FILE = 'worker-host.json'
const BACKUP_FILE = 'worker-host-backup.json'
const CACHE_FILE = 'worker-host-cache.json'
const SECRET_KEY = 'worker-host:secret'
/** Vault entries the host never gets on a sync: the link's own secret, and chat-app bot tokens (they move with the workers instead). */
const PRIVATE_SECRETS = /^(worker-host:|channel:)/
const RESYNC_MS = 10 * 60_000
const HELLO_MS = 30_000
/** How long a change made while the link is still coming up waits for it. */
const CONNECTING_WAIT_MS = 8000
/** Channels the cache answers while the host is away, without waiting for it. */
const READ_ONLY = new Set([
  'workers:list',
  'workers:rooms',
  'workers:thread',
  'workers:room-posts',
  'workers:executions',
  'workers:delegations',
  'workers:job-log',
  'workers:has-browser',
  'workers:teach-steps',
  'workers:viewing',
  'workers:mark-read',
  'workers:room-read',
  'channels:list'
])

interface Config {
  host: LinkedHost | null
  enabled: boolean
  /** Where each worker's folder was on this computer before it moved, so it comes back to the same place. */
  origins: Record<string, string>
  backupAt: number | null
  /** What the skills folder looked like when last sent, so it is only sent again when it changed. */
  skillsHash: string | null
  /**
   * The workers were restored here from the copy while the host was away:
   * it still runs its own, so the next time it connects it is told to stop.
   */
  releasePending: boolean
  /**
   * The chat apps went with the workers. False with `enabled` for workers
   * moved before chat apps could go too: they follow once the host connects.
   */
  channelsMoved: boolean
}

const emptyConfig = (): Config => ({ host: null, enabled: false, origins: {}, backupAt: null, skillsHash: null, releasePending: false, channelsMoved: false })

interface PackageInfo {
  path: string
  build: string
  sha256: string
  size: number
  electron: string
}

/** The host package this build of Eaon carries (scripts/build-host.mjs). */
function hostPackage(): PackageInfo | null {
  // EAON_HOST_PACKAGE_DIR: a development run from somewhere other than the checkout.
  const dir = (!app.isPackaged && process.env.EAON_HOST_PACKAGE_DIR) || join(app.getAppPath(), 'out', 'host')
  try {
    const info = JSON.parse(readFileSync(join(dir, 'eaon-host.json'), 'utf8')) as Omit<PackageInfo, 'path'>
    const path = join(dir, 'eaon-host.tgz')
    return existsSync(path) ? { ...info, path } : null
  } catch {
    return null
  }
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
/** Hosts are Linux or macOS: their paths always use `/`. */
const hostJoin = (dir: string, rel: string): string => `${dir.replace(/\/+$/, '')}/${rel}`

export interface WorkerHostController {
  state: () => WorkerHostState
  link: HostLink
}

let controller: WorkerHostController | null = null
export const workerHostController = (): WorkerHostController | null => controller

export function createWorkerHost(ctx: FeatureContext, workers: WorkersService, chats: ChannelsHandle | null = null): WorkerHostController & { dispose: () => void } {
  let config: Config = { ...emptyConfig(), ...store.getJson<Partial<Config>>(CONFIG_FILE, {}) }
  const saveConfig = (): void => store.setJson(CONFIG_FILE, config)
  let moving: WorkerHostState['moving'] = null
  let pairing: PairingServer | null = null
  /** The host builds already sent this session, so a host that won't take one isn't sent it forever. */
  const updatesTried = new Set<string>()

  /** The host's workers (and chat apps) as last seen, for while it can't be reached. */
  const cached = store.getJson<{ workers?: Worker[]; rooms?: WorkerRoom[]; links?: ChannelLink[] }>(CACHE_FILE, {})
  const cache: { workers: Worker[]; rooms: WorkerRoom[]; links: ChannelLink[]; threads: Map<string, unknown> } = {
    workers: cached.workers ?? [],
    rooms: cached.rooms ?? [],
    links: cached.links ?? [],
    threads: new Map()
  }
  let cacheTimer: ReturnType<typeof setTimeout> | null = null
  const saveCache = (): void => {
    if (cacheTimer) return
    cacheTimer = setTimeout(() => {
      cacheTimer = null
      store.setJsonAsync(CACHE_FILE, { workers: cache.workers, rooms: cache.rooms, links: cache.links })
    }, 2000)
    cacheTimer.unref?.()
  }

  const state = (): WorkerHostState => ({
    host: config.host,
    enabled: config.enabled,
    connection: config.host ? link.connection : 'offline',
    hello: link.hello,
    error: link.error,
    seenAt: link.seenAt,
    moving,
    backupAt: config.backupAt
  })
  const pushState = (): void => ctx.send('worker-host:state', state())
  const progress = (p: HostInstallProgress): void => ctx.send('worker-host:progress', p)
  const step = (direction: 'to-host' | 'to-here', text: string): void => {
    moving = { direction, step: text }
    pushState()
  }

  /* ------------------------------------------------- the host's browsers */

  const browserStatus = new Map<BrowserTarget, AgentBrowserStatus>()
  /** Live views open here, by browser, so they are asked for again when the link comes back. */
  const watching = new Map<BrowserTarget, number>()
  const closedStatus = (target: BrowserTarget): AgentBrowserStatus => ({ target, open: false, url: '', title: '', controlled: false })
  const hostIpc = <T = unknown>(channel: string, args: unknown[], timeoutMs = 120_000): Promise<T> => link.call<T>('ipc', { channel, args }, timeoutMs)

  const remoteBrowsers: RemoteBrowsers = {
    watch: (target) => {
      watching.set(target, (watching.get(target) ?? 0) + 1)
      void hostIpc<AgentBrowserStatus>('agent-browser:watch', [true, target])
        .then((status) => browserStatus.set(target, status))
        .catch(() => undefined)
      return () => {
        const count = (watching.get(target) ?? 1) - 1
        if (count > 0) watching.set(target, count)
        else watching.delete(target)
        void hostIpc('agent-browser:watch', [false, target]).catch(() => undefined)
      }
    },
    status: (target) => browserStatus.get(target) ?? closedStatus(target),
    fetchStatus: async (target) => {
      if (!link.connected) return browserStatus.get(target) ?? closedStatus(target)
      const status = await hostIpc<AgentBrowserStatus>('agent-browser:status', [target], 15_000).catch(() => browserStatus.get(target) ?? closedStatus(target))
      browserStatus.set(target, status)
      return status
    },
    control: async (target, on) => {
      const status = await hostIpc<AgentBrowserStatus>('agent-browser:control', [on, target])
      browserStatus.set(target, status)
      return status
    },
    input: (target, event) => hostIpc<boolean>('agent-browser:input', [event, target], 15_000).catch(() => false),
    navigate: (target, url) => hostIpc<boolean>('agent-browser:navigate', [url, target]).catch(() => false)
  }

  /* --------------------------------------------- the Workers tab, there */

  let proxied = false
  const uploadFiles = async (files: unknown): Promise<string[]> => {
    if (!Array.isArray(files) || files.length === 0) return []
    const out: string[] = []
    for (const file of files) {
      if (typeof file !== 'string' || !existsSync(file)) continue
      // A worker here is handed a folder's path; one on the host couldn't reach it.
      if (!statSync(file).isFile()) throw new Error(`${basename(file)} is a folder. Workers on ${config.host?.name ?? 'the worker computer'} can be sent files, not folders.`)
      const remote = await link.call<string>('files.upload-path', { name: basename(file) })
      await pushFile(file, remote)
      out.push(remote)
    }
    return out
  }

  const offlineAnswer = (channel: string, args: unknown[]): unknown => {
    switch (channel) {
      case 'workers:list':
        return cache.workers
      case 'workers:rooms':
        return cache.rooms
      case 'workers:thread': {
        const thread = cache.threads.get(threadKey(args))
        if (thread) return thread
        return { workerId: String(args[0]), messages: [], summary: null }
      }
      case 'workers:room-posts':
      case 'workers:executions':
      case 'workers:delegations':
        return []
      case 'workers:job-log':
        return ''
      case 'workers:has-browser':
      case 'workers:show-browser':
        return false
      case 'workers:teach-steps':
        return []
      // Its chat apps as last seen, none of them answering from here.
      case 'channels:list':
        return {
          links: cache.links,
          statuses: cache.links.map((l): ChannelStatus => ({ linkId: l.id, state: 'error', message: `${config.host?.name ?? 'The worker computer'} can’t be reached right now.` }))
        }
      // Nothing to change on the host: what the tab is showing, and what was read.
      case 'workers:viewing':
      case 'workers:mark-read':
      case 'workers:room-read':
        return undefined
      default:
        throw new Error(`${config.host?.name ?? 'The worker computer'} can’t be reached right now, so its workers can’t be changed. ${link.error ?? ''}`.trim())
    }
  }

  /** The cache's key for a thread: the worker, and which of its threads (the main one when none is given). */
  const threadKey = (args: unknown[]): string => `${String(args[0])}#${typeof args[1] === 'string' && args[1] ? args[1] : 'main'}`

  const proxy = async (channel: string, args: unknown[]): Promise<unknown> => {
    // Just opened, or back from sleep: the link is a moment away, so a change waits for it
    // rather than failing; what the tab only reads is shown from the cache meanwhile.
    if (!READ_ONLY.has(channel)) {
      for (const started = Date.now(); !link.connected && link.connection === 'connecting' && Date.now() - started < CONNECTING_WAIT_MS; ) {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    if (!link.connected) return offlineAnswer(channel, args)
    // Its windows are on its own screen; the live view is how to see a worker's browser from here.
    if (channel === 'workers:show-browser') return false
    if (channel === 'workers:send') args = [args[0], args[1], await uploadFiles(args[2]), args[3]]
    if (channel === 'workers:room-post') args = [args[0], args[1], await uploadFiles(args[2])]
    const value = await hostIpc(channel, args)
    if (channel === 'workers:list') {
      cache.workers = value as Worker[]
      saveCache()
    } else if (channel === 'workers:rooms') {
      cache.rooms = value as WorkerRoom[]
      saveCache()
    } else if (channel === 'channels:list') {
      cache.links = (value as { links: ChannelLink[] }).links
      saveCache()
    } else if (channel === 'workers:thread') {
      cache.threads.set(threadKey(args), value)
      // A few recent threads are enough for a short outage.
      if (cache.threads.size > 8) cache.threads.delete(cache.threads.keys().next().value as string)
    }
    return value
  }

  /** The IPC the host answers while the workers live there: the Workers tab's, and Chat apps'. */
  const servedThere = (): string[] => [...workers.channels, ...(chats?.channels ?? [])]

  const takeOver = (): void => {
    if (proxied) return
    proxied = true
    // Their bots answer from the host; here they would fight it for every message.
    void chats?.suspend()
    for (const channel of servedThere()) {
      ctx.ipcMain.removeHandler(channel)
      ctx.ipcMain.handle(channel, (_event, ...args: unknown[]) => proxy(channel, args))
    }
    setRemoteBrowsers(remoteBrowsers)
  }

  const handBack = (): void => {
    if (!proxied) return
    proxied = false
    for (const channel of servedThere()) ctx.ipcMain.removeHandler(channel)
    workers.registerIpc()
    chats?.registerIpc()
    chats?.resume()
    setRemoteBrowsers(null)
  }

  /** The Workers tab (and Chat apps) show what the host has now. */
  const refreshTab = async (): Promise<void> => {
    try {
      const [list, rooms] = await Promise.all([hostIpc<Worker[]>('workers:list', []), hostIpc<WorkerRoom[]>('workers:rooms', [])])
      cache.workers = list
      cache.rooms = rooms
      saveCache()
      ctx.send('workers:changed', list)
      ctx.send('workers:rooms-changed', rooms)
      if (chats) {
        const { links, statuses } = await hostIpc<{ links: ChannelLink[]; statuses: ChannelStatus[] }>('channels:list', [])
        cache.links = links
        saveCache()
        ctx.send('channels:changed', links)
        ctx.send('channels:status', statuses)
      }
    } catch {
      /* the link went again; the next connect refreshes */
    }
  }

  /**
   * Chat apps here → the host, to answer for workers already there: for
   * workers moved before chat apps could go with them. The host keeps them
   * from then on, as if they had moved together.
   */
  const moveChatsAfter = async (): Promise<void> => {
    if (!chats || config.channelsMoved) return
    await chats.suspend()
    const data = await chats.exportData()
    if (data.links.length > 0) await link.call('channels.import', { data }, 120_000)
    config.channelsMoved = true
    saveConfig()
  }

  /* -------------------------------------------------------- notifications */

  const notifications = new Set<Notification>()
  const showNotice = (notice: { workerId: string; title: string; body: string; reachOut: boolean }): void => {
    if (!Notification.isSupported()) return
    if (!notice.reachOut && !store.getSettings().notifications.taskComplete) return
    if (!notice.reachOut && ctx.getWindow()?.isFocused()) return
    const notification = new Notification({ title: notice.title, body: notice.body })
    notifications.add(notification)
    notification.on('click', () => {
      notifications.delete(notification)
      workers.openWorker(notice.workerId)
    })
    notification.on('close', () => notifications.delete(notification))
    notification.show()
  }

  /* ------------------------------------------------------------- files */

  async function pushFile(local: string, remote: string): Promise<void> {
    let offset = 0
    for await (const chunk of readChunks(local)) {
      await link.call('files.put', { path: remote, offset, data: chunk.toString('base64') }, 120_000)
      offset += chunk.length
    }
    if (offset === 0) await link.call('files.put', { path: remote, offset: 0, data: '' })
  }

  async function pullFile(remote: string, local: string): Promise<void> {
    let offset = 0
    for (;;) {
      const { data, size } = await link.call<{ data: string; size: number }>('files.get', { path: remote, offset }, 120_000)
      const bytes = Buffer.from(data, 'base64')
      await writeChunk(local, offset, bytes)
      offset += bytes.length
      if (offset >= size || bytes.length === 0) break
    }
  }

  /* ------------------------------------------------------ keeping it up */

  const syncPayload = (): Record<string, unknown> => ({
    secrets: Object.fromEntries(Object.entries(secrets.entries()).filter(([id]) => !PRIVATE_SECRETS.test(id))),
    providers: store.getProviderConfig(),
    settings: store.getSettings(),
    mcpServers: store.getMcpServers().filter((server) => !server.official)
  })

  const syncSkills = async (): Promise<void> => {
    const dir = personalSkillsDir()
    const { files } = listFolder(dir, 64 * 1024 * 1024)
    const hash = createHash('sha256')
    for (const file of files) hash.update(file.path).update(String(file.size)).update(readFileSync(join(dir, file.path)))
    const digest = hash.digest('hex')
    if (digest === config.skillsHash) return
    const remoteDir = await link.call<string>('skills.dir')
    await link.call('skills.clear')
    for (const file of files) await pushFile(join(dir, file.path), hostJoin(remoteDir, file.path))
    config.skillsHash = digest
    saveConfig()
  }

  /**
   * Sign-ins the host refreshed: its copy is the good one now (the refresh
   * token here was spent there), so this computer takes it. Only for sign-ins
   * this computer still has; one signed out of here stays out.
   */
  let takingSignIns = false
  const takeSignIns = (entries: unknown): void => {
    if (!entries || typeof entries !== 'object') return
    const own = secrets.entries()
    const newer: Record<string, string> = {}
    for (const [id, value] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof value !== 'string' || PRIVATE_SECRETS.test(id) || !own[id]) continue
      const theirs = credentialExpiry(value)
      const mine = credentialExpiry(own[id])
      if (theirs !== null && mine !== null && theirs > mine) newer[id] = value
    }
    if (Object.keys(newer).length === 0) return
    takingSignIns = true
    try {
      secrets.setMany(newer)
    } finally {
      takingSignIns = false
    }
  }

  let syncing: Promise<void> | null = null
  const sync = (): Promise<void> => {
    if (syncing) return syncing
    syncing = (async () => {
      link.hello = await link.call<HostHello>('sync', syncPayload())
      // And back: what it refreshed while this computer was asleep (an older host has no `tokens`).
      takeSignIns(await link.call('tokens', null, 15_000).catch(() => null))
      await syncSkills().catch((error) => console.error('[worker-host] skills didn’t sync:', errorText(error)))
      pushState()
    })().finally(() => {
      syncing = null
    })
    return syncing
  }

  /** Sends the host this desktop's build of the host app; it restarts on it and the link comes back. */
  const pushUpdate = async (pkg: PackageInfo): Promise<void> => {
    updatesTried.add(pkg.build)
    link.setUpdating()
    progress({ line: `Updating the host app on ${config.host?.name ?? 'the worker computer'}` })
    let offset = 0
    for await (const chunk of readChunks(pkg.path)) {
      await link.call('update.put', { offset, data: chunk.toString('base64') }, 120_000)
      offset += chunk.length
    }
    await link.call('update.apply', { sha256: pkg.sha256 }, 60_000)
  }

  const onConnected = async (_peer: Peer, hello: HostHello): Promise<void> => {
    const pkg = hostPackage()
    if (pkg && hello.build !== pkg.build) {
      if (!updatesTried.has(pkg.build)) {
        try {
          await pushUpdate(pkg)
          return
        } catch (error) {
          link.error = `The host app couldn’t be updated: ${errorText(error)}`
        }
      } else if (hello.protocol !== WORKER_HOST_PROTOCOL) {
        link.error = 'The worker computer runs a host app this Eaon can’t use, and updating it didn’t work. Reinstall it from Settings → Workers → Worker computer.'
        pushState()
        return
      }
    }
    if (config.host && hello.name && config.host.name !== hello.name && config.host.via === 'command') {
      config.host = { ...config.host, name: hello.name }
      saveConfig()
    }
    try {
      await sync()
    } catch (error) {
      link.error = `Keys and settings didn’t reach it: ${errorText(error)}`
    }
    if (config.releasePending && !config.enabled) {
      // They run here now, from the copy; two of each must not run.
      await link
        .call('workers.release', null, 60_000)
        .then(() => {
          config.releasePending = false
          saveConfig()
        })
        .catch(() => undefined)
    }
    if (config.enabled && !moving) {
      await moveChatsAfter().catch((error) => console.error('[worker-host] chat apps didn’t move:', errorText(error)))
      // A move cut short leaves the host waiting; it should be running its workers.
      await link.call('workers.resume').catch(() => undefined)
      for (const [target, count] of watching) for (let i = 0; i < count; i++) void hostIpc('agent-browser:watch', [true, target]).catch(() => undefined)
      await refreshTab()
    }
    pushState()
  }

  const onEvent = (name: string, data: unknown): void => {
    if (name === 'hello') return pushState()
    if (name !== 'ipc') return
    const { channel, args } = data as { channel: string; args: unknown[] }
    if (!Array.isArray(args)) return
    if (channel === 'host:notify') return showNotice(args[0] as Parameters<typeof showNotice>[0])
    if (channel === 'host:tokens') return takeSignIns(args[0])
    if (!config.enabled || moving) return
    if (channel === 'agent-browser:frame') return remoteBrowserFrame(args[0] as Parameters<typeof remoteBrowserFrame>[0])
    if (channel === 'agent-browser:status') {
      const status = args[0] as AgentBrowserStatus
      if (status?.target) browserStatus.set(status.target, status)
    }
    if (channel === 'workers:changed') {
      cache.workers = args[0] as Worker[]
      saveCache()
    }
    if (channel === 'workers:rooms-changed') {
      cache.rooms = args[0] as WorkerRoom[]
      saveCache()
    }
    if (channel === 'channels:changed') {
      cache.links = args[0] as ChannelLink[]
      saveCache()
    }
    ctx.send(channel, ...args)
  }

  const link = new HostLink({
    target: () => {
      const secret = secrets.get(SECRET_KEY)
      return config.host && secret ? { address: config.host.address, port: config.host.port, secret } : null
    },
    onState: pushState,
    onConnected,
    onEvent
  })

  // A key added or a setting changed here reaches the host within the next round; this keeps it fresh anyway.
  const resync = setInterval(() => {
    if (link.connected && link.connection === 'connected') void sync().catch(() => undefined)
  }, RESYNC_MS)
  resync.unref?.()
  // A key saved, or a sign-in refreshed, here goes over within seconds: the host's
  // copy of a refreshed sign-in stops working as soon as this one is used.
  let vaultTimer: ReturnType<typeof setTimeout> | null = null
  const offVault = secrets.onChange(() => {
    if (takingSignIns || vaultTimer) return
    vaultTimer = setTimeout(() => {
      vaultTimer = null
      if (link.connected && link.connection === 'connected') void sync().catch(() => undefined)
    }, 3000)
    vaultTimer.unref?.()
  })
  const hellos = setInterval(() => {
    if (!link.connected || link.connection !== 'connected') return
    void link
      .call<HostHello>('hello', null, 10_000)
      .then((hello) => {
        link.hello = hello
        link.seenAt = Date.now()
        pushState()
      })
      .catch(() => undefined)
  }, HELLO_MS)
  hellos.unref?.()

  /* ------------------------------------------------------------- moving */

  let busy: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(job: () => Promise<T>): Promise<T> => {
    const run = busy.then(job, job)
    busy = run.catch(() => undefined)
    return run
  }

  const requireLink = async (): Promise<void> => {
    if (!config.host) throw new Error('Link a worker computer first.')
    link.start()
    if (!(await link.ready(20_000))) throw new Error(`${config.host.name} can’t be reached. ${link.error ?? ''}`.trim())
  }

  /** Workers here → the host. */
  const moveToHost = async (): Promise<void> => {
    await requireLink()
    await sync()
    step('to-host', 'Stopping the workers on this computer')
    workers.suspend()
    await store.flushWrites()
    const snapshot = readSnapshot(store)
    try {
      store.setJson(BACKUP_FILE, { at: Date.now(), snapshot })
      config.backupAt = Date.now()
      step('to-host', `Sending ${snapshot.workers.length} worker${snapshot.workers.length === 1 ? '' : 's'}`)
      const { moves } = await link.call<{ moves: { id: string; from: string; to: string }[] }>('workers.import', { snapshot }, 120_000)
      let skipped = 0
      for (const move of moves) {
        const folder = listFolder(move.from)
        skipped += folder.skipped
        const name = (snapshot.workers.find((w) => (w as { id?: string }).id === move.id) as { name?: string } | undefined)?.name ?? 'a worker'
        if (folder.files.length) step('to-host', `Copying ${name}’s folder (${folder.files.length} file${folder.files.length === 1 ? '' : 's'})`)
        for (const file of folder.files) await pushFile(join(move.from, ...file.path.split('/')), hostJoin(move.to, file.path))
        config.origins[move.id] = move.from
      }
      if (skipped) progress({ line: `${skipped} large or rebuildable item${skipped === 1 ? ' was' : 's were'} left behind (node_modules, .git and the like).` })
      if (chats) {
        // Their bots stop here and answer from there; what's here stays as the copy, like the workers'.
        step('to-host', 'Moving their chat apps')
        await chats.suspend()
        await link.call('channels.import', { data: await chats.exportData() }, 120_000)
      }
      step('to-host', 'Starting them there')
      link.hello = await link.call<HostHello>('workers.resume')
    } catch (error) {
      // Nothing is lost: the host lets go of what it got, and they run here again.
      await link.call('workers.release').catch(() => undefined)
      workers.resume()
      chats?.resume()
      moving = null
      pushState()
      throw error
    }
    // Here they are gone, so nothing else here (a phone, chat apps) acts on a stale copy.
    writeSnapshot(store, { workers: [], threads: {}, rooms: null })
    workers.engine.reload()
    config.enabled = true
    config.channelsMoved = true
    saveConfig()
    takeOver()
    moving = null
    await refreshTab()
    pushState()
  }

  /** Workers on the host → here. With `fromBackup`, the copy taken when they left (for a host that is gone). */
  const moveHere = async (fromBackup: boolean): Promise<void> => {
    let snapshot: WorkersSnapshot
    let folders: { id: string; folder: string; files: FolderEntry[] }[] = []
    /** The chat apps on the host; with the copy, those here are already the ones to run. */
    let chatData: ChannelsData | null = null
    if (fromBackup) {
      const backup = store.getJson<{ snapshot?: WorkersSnapshot } | null>(BACKUP_FILE, null)
      if (!backup?.snapshot) throw new Error('There is no copy of the workers on this computer.')
      snapshot = backup.snapshot
      step('to-here', 'Restoring the copy taken when they moved')
    } else {
      await requireLink()
      step('to-here', `Stopping the workers on ${config.host?.name ?? 'the worker computer'}`)
      const exported = await link.call<{ snapshot: WorkersSnapshot; folders: { id: string; folder: string; files: FolderEntry[] }[] }>('workers.export', null, 120_000)
      snapshot = exported.snapshot
      folders = exported.folders
      if (chats && config.channelsMoved) {
        try {
          chatData = await link.call<ChannelsData>('channels.export', null, 120_000)
        } catch (error) {
          await link.call('workers.resume').catch(() => undefined)
          moving = null
          pushState()
          throw error
        }
      }
    }
    try {
      const root = join(store.getSettings().work.defaultFolder || join(homedir(), 'Eaon'), 'Workers')
      const local = relocate(snapshot, root, config.origins)
      for (const move of local.moves) {
        const folder = folders.find((f) => f.id === move.id)
        if (!folder?.files.length) continue
        const name = (snapshot.workers.find((w) => (w as { id?: string }).id === move.id) as { name?: string } | undefined)?.name ?? 'a worker'
        step('to-here', `Copying ${name}’s folder back (${folder.files.length} file${folder.files.length === 1 ? '' : 's'})`)
        for (const file of folder.files) await pullFile(hostJoin(folder.folder, file.path), inside(move.to, file.path))
      }
      writeSnapshot(store, local.snapshot)
      if (chatData) {
        step('to-here', 'Bringing their chat apps back')
        await chats?.suspend()
        await chats?.importData(chatData)
      }
      if (!fromBackup) link.hello = await link.call<HostHello>('workers.release')
    } catch (error) {
      if (!fromBackup) await link.call('workers.resume').catch(() => undefined)
      moving = null
      pushState()
      throw error
    }
    config.enabled = false
    config.channelsMoved = false
    config.origins = {}
    config.releasePending = fromBackup
    saveConfig()
    handBack()
    browserStatus.clear()
    workers.resume()
    moving = null
    pushState()
  }

  /* ----------------------------------------------------------- linking */

  const linkTo = async (host: LinkedHost, secret: string): Promise<WorkerHostState> => {
    secrets.set(SECRET_KEY, secret)
    config = { ...emptyConfig(), host }
    saveConfig()
    link.reconnect()
    if (await link.ready(30_000)) {
      if (link.hello?.name && host.via === 'command') config.host = { ...host, name: link.hello.name }
      saveConfig()
    }
    pushState()
    return state()
  }

  const installSsh = (request: SshInstallRequest): Promise<WorkerHostState> =>
    exclusive(async () => {
      if (config.enabled) throw new Error('Bring your workers back from the current worker computer first.')
      const pkg = hostPackage()
      if (!pkg) throw new Error('This copy of Eaon doesn’t include the host app (npm run build:host).')
      const secret = newHostSecret()
      const result = await installOverSsh({
        request,
        packagePath: pkg.path,
        secret,
        port: WORKER_HOST_DEFAULT_PORT,
        onProgress: progress,
        knownHostsFile: join(app.getPath('userData'), 'worker-host-known_hosts')
      })
      progress({ line: 'Installed. Connecting to it' })
      const host: LinkedHost = {
        id: randomUUID(),
        name: request.name?.trim() || request.host.replace(/\.local$/i, ''),
        address: request.host.trim(),
        port: result.port,
        platform: result.platform,
        arch: result.arch,
        linkedAt: Date.now(),
        via: 'ssh',
        ssh: { user: request.user.trim(), port: request.port ?? 22, ...(request.keyFile ? { keyFile: request.keyFile } : {}) }
      }
      const linked = await linkTo(host, secret)
      progress({ line: link.connected ? `Linked to ${host.name}` : `Installed, but not connected yet: ${link.error ?? ''}`, done: true })
      return linked
    })

  /** Installs the host app again over SSH, with the same link key: for a host that broke, or to start over. */
  const reinstall = (password?: string): Promise<WorkerHostState> =>
    exclusive(async () => {
      const host = config.host
      const secret = secrets.get(SECRET_KEY)
      if (!host || !secret) throw new Error('No worker computer is linked.')
      if (!host.ssh) throw new Error(`${host.name} was linked with a command. Run a new one from this page on it to reinstall.`)
      const pkg = hostPackage()
      if (!pkg) throw new Error('This copy of Eaon doesn’t include the host app (npm run build:host).')
      updatesTried.clear()
      await installOverSsh({
        request: { host: host.address, user: host.ssh.user, port: host.ssh.port, keyFile: host.ssh.keyFile, password: password || undefined, name: host.name },
        packagePath: pkg.path,
        secret,
        port: host.port,
        onProgress: progress,
        knownHostsFile: join(app.getPath('userData'), 'worker-host-known_hosts')
      })
      progress({ line: 'Reinstalled. Connecting to it' })
      link.reconnect()
      await link.ready(30_000)
      progress({ line: link.connected ? `${host.name} is back` : `Reinstalled, but not connected yet: ${link.error ?? ''}`, done: true })
      return state()
    })

  /**
   * Serves a one-line install. With `reinstall`, for the computer already
   * linked (with a command, so there is no SSH to reinstall over): the same
   * link key and port, and the workers there stay where they are.
   */
  const startPairing = async (options: { reinstall?: boolean } = {}): Promise<HostPairing> => {
    const linked = config.host
    const linkedSecret = secrets.get(SECRET_KEY)
    if (options.reinstall && (!linked || !linkedSecret)) throw new Error('No worker computer is linked.')
    if (!options.reinstall && config.enabled) throw new Error('Bring your workers back from the current worker computer first.')
    const pkg = hostPackage()
    if (!pkg) throw new Error('This copy of Eaon doesn’t include the host app (npm run build:host).')
    await pairing?.close()
    const names = await computerNames()
    const address = lanAddresses()[0] ?? `${names.hostName}.local`
    const secret = options.reinstall ? linkedSecret! : newHostSecret()
    pairing = await startPairingServer({
      packagePath: pkg.path,
      address,
      secret,
      hostPort: options.reinstall ? linked!.port : WORKER_HOST_DEFAULT_PORT,
      computerName: names.computerName,
      onProgress: progress,
      onDone: (done) => {
        void exclusive(async () => {
          const server = pairing
          pairing = null
          void server?.close()
          if (options.reinstall && config.host) {
            // Same computer, same key: only where it is and what it runs can have changed.
            config.host = { ...config.host, address: done.address, port: done.port, platform: done.platform, arch: done.arch }
            saveConfig()
            updatesTried.clear()
            progress({ line: 'Reinstalled. Connecting to it' })
            link.reconnect()
            await link.ready(30_000)
            progress({ line: link.connected ? `${config.host.name} is back` : `Reinstalled, but not connected yet: ${link.error ?? ''}`, done: true })
            return
          }
          const host: LinkedHost = {
            id: randomUUID(),
            name: done.name || done.address,
            address: done.address,
            port: done.port,
            platform: done.platform,
            arch: done.arch,
            linkedAt: Date.now(),
            via: 'command'
          }
          progress({ line: 'Installed. Connecting to it' })
          await linkTo(host, secret)
          progress({ line: link.connected ? `Linked to ${config.host?.name ?? host.name}` : `Installed, but not connected yet: ${link.error ?? ''}`, done: true })
        }).catch((error) => progress({ line: errorText(error), error: errorText(error) }))
      }
    })
    return { code: pairing.code, command: pairing.command, address, expiresAt: pairing.expiresAt }
  }

  const unlink = (options: { removeApp?: boolean; fromBackup?: boolean }): Promise<WorkerHostState> =>
    exclusive(async () => {
      if (config.enabled) await moveHere(options.fromBackup === true)
      if (options.removeApp && link.connected) await link.call('uninstall').catch(() => undefined)
      link.stop()
      secrets.clear(SECRET_KEY)
      config = emptyConfig()
      saveConfig()
      cache.workers = []
      cache.rooms = []
      cache.links = []
      saveCache()
      pushState()
      return state()
    })

  /* --------------------------------------------------------------- IPC */

  const { ipcMain } = ctx
  ipcMain.handle('worker-host:state', () => state())
  ipcMain.handle('worker-host:install-ssh', (_e, request: SshInstallRequest) => installSsh(request))
  ipcMain.handle('worker-host:reinstall', (_e, password?: string) => reinstall(typeof password === 'string' ? password : undefined))
  ipcMain.handle('worker-host:pair-start', (_e, options?: { reinstall?: boolean }) => startPairing({ reinstall: options?.reinstall === true }))
  ipcMain.handle('worker-host:pair-cancel', async () => {
    await pairing?.close()
    pairing = null
  })
  ipcMain.handle('worker-host:set-enabled', (_e, enabled: boolean, options?: { fromBackup?: boolean }) =>
    exclusive(async () => {
      if (enabled === config.enabled) return state()
      if (enabled) await moveToHost()
      else await moveHere(options?.fromBackup === true)
      return state()
    })
  )
  ipcMain.handle('worker-host:reconnect', () => {
    link.reconnect()
    return state()
  })
  ipcMain.handle('worker-host:sync', async () => {
    await requireLink()
    config.skillsHash = null
    await sync()
    return state()
  })
  ipcMain.handle('worker-host:set-address', (_e, address: string, port?: number) => {
    if (!config.host) throw new Error('No worker computer is linked.')
    const clean = String(address ?? '').trim()
    if (!clean || /[\s/]/.test(clean)) throw new Error('Enter an address like 192.168.1.20 or raspberrypi.local.')
    config.host = { ...config.host, address: clean, port: port && Number.isInteger(port) ? port : config.host.port }
    saveConfig()
    link.reconnect()
    return state()
  })
  ipcMain.handle('worker-host:unlink', (_e, options?: { removeApp?: boolean; fromBackup?: boolean }) => unlink(options ?? {}))

  // Workers that live on the host: they don't run here, and the tab asks the host.
  if (config.host) {
    if (config.enabled) {
      workers.suspend()
      takeOver()
    }
    link.start()
  }

  return {
    state,
    link,
    dispose: () => {
      clearInterval(resync)
      clearInterval(hellos)
      offVault()
      if (vaultTimer) clearTimeout(vaultTimer)
      void pairing?.close()
      link.stop()
    }
  }
}

let instance: ReturnType<typeof createWorkerHost> | null = null

export const workerHostFeature: Feature = {
  id: 'worker-host',
  register: (ctx) => {
    // Right after the workers feature and their chat apps, before anything else starts the engine.
    const workers = workersService()
    if (!workers) return
    instance = createWorkerHost(ctx, workers, channelsHandle())
    controller = instance
  },
  dispose: () => instance?.dispose()
}
