import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import type { Feature, FeatureContext } from '@main/features/types'
import { store } from '@main/store'
import { secrets } from '@main/secrets'
import { signInEntries } from '@shared/workerHost'
import '@main/agent/sources'
import { killBackgroundProcesses } from '@main/localTools'
import { shutdownMcp, syncMcpServers } from '@main/mcp'
import { refreshLocalProviders } from '@main/providers/localDiscovery'
import { refreshCatalogInBackground } from '@main/providers/modelCatalog'
import { registerToolSource } from '@main/agent/tools'
import { providerAuthFeature } from '@main/features/providerAuth'
import { pluginsFeature } from '@main/features/plugins'
import { personalSkillsDir, skillsFeature } from '@main/features/skills'
import { agentBrowserFeature } from '@main/features/agentBrowser'
import { createWorkersService, type WorkersService } from '@main/features/workers/service'
import { sealVaultAtRest } from '@main/features/workers/vaultSeal'
import { createChannels } from '@main/features/channels'
import { listen } from '@main/workerHost/channel'
import { createVmManager, defaultSocketDir } from '@main/vms/service'
import { registerVmIpc } from '@main/vms/ipc'
import { vmToolSource } from '@main/vms/tool'
import { broadcast, ipc } from './ipc'
import { createHost, type SyncPayload } from './host'
import { applySync } from './sync'

/**
 * Starts the desktop app's main process with no window, as a worker
 * computer: the store, providers, plugins, skills and MCP servers, the
 * workers service, and (under Electron) every worker's own browser. Then
 * listens for the desktop.
 */

export interface HostConfig {
  port: number
  secret: string
  name?: string
}

export interface BootOptions {
  home: string
  config: HostConfig
  runtime: 'electron' | 'node'
  browserNote: string | null
  build: string
  appVersion: string
}

export async function bootHost(options: BootOptions): Promise<{ stop: () => Promise<void> }> {
  const { home, config } = options
  mkdirSync(join(home, 'uploads'), { recursive: true })
  store.migrateWorkspaces()

  const context: FeatureContext = {
    ipcMain: ipc as unknown as FeatureContext['ipcMain'],
    getWindow: () => null,
    getWindows: () => [],
    send: (channel, ...args) => broadcast(channel, ...args),
    emitStream: () => {}
  }
  const features: Feature[] = []
  for (const feature of [providerAuthFeature, pluginsFeature, skillsFeature]) {
    try {
      await feature.register(context)
      features.push(feature)
    } catch (error) {
      console.error(`[host] ${feature.id} failed to start:`, error)
    }
  }

  // No keychain here: the workers' password vault is kept sealed with the desktop's key, which only ever sits in memory.
  sealVaultAtRest(true)
  // A worker's news goes to the desktop, which shows it as its own notification.
  const service: WorkersService = createWorkersService(context, {
    notifier: {
      notify: (worker, outcome) => broadcast('host:notify', { workerId: worker.id, title: outcome.ok ? worker.name : `${worker.name} hit a problem`, body: outcome.text, reachOut: false }),
      reachOut: (worker, message) => broadcast('host:notify', { workerId: worker.id, title: message.title, body: message.body, reachOut: true })
    }
  })
  service.start()
  service.registerIpc()
  // The workers' chat apps: their bots answer from here, so they keep answering while the desktop sleeps.
  const channels = createChannels(context, service)
  channels.registerIpc()
  channels.start()
  if (options.runtime === 'electron') {
    // The live view and take-over of each worker's browser, served to the desktop.
    agentBrowserFeature.register(context)
    features.push(agentBrowserFeature)
  } else {
    // No Electron, no browser: the tool is withdrawn rather than offered and failing.
    registerToolSource({ id: 'worker-browser', tools: () => [] })
  }

  // VMs on this computer, for the desktop's Computers page and for agents (workers here among them).
  const vms = createVmManager({
    root: join(home, 'vms'),
    socketDir: defaultSocketDir(),
    helper: process.platform === 'darwin' ? join(home, 'app', 'vm', 'eaon-vm') : null,
    device: 'host',
    name: () => config.name || hostname().replace(/\.local\.?$/i, ''),
    onChange: (list) => broadcast('vms:changed', list),
    autostart: true
  })
  const offVmIpc = registerVmIpc(ipc as unknown as Parameters<typeof registerVmIpc>[0], vms)
  registerToolSource(
    vmToolSource({
      cached: () => vms.list(),
      start: (_device, id) => vms.start(id),
      stop: (_device, id) => vms.stop(id),
      exec: (_device, id, command, timeoutMs) => vms.exec(id, command, timeoutMs),
      screenshot: (_device, id) => vms.screenshot(id),
      input: (_device, id, actions) => vms.input(id, actions),
      setActive: (_device, id, active) => vms.setAgentActive(id, active)
    })
  )

  void syncMcpServers()
  void refreshLocalProviders(true).catch(() => undefined)
  void refreshCatalogInBackground().catch(() => undefined)

  const workRoot = (): string => join(store.getSettings().work.defaultFolder || join(homedir(), 'Eaon'), 'Workers')
  const appDir = join(home, 'app')
  const host = createHost({
    home,
    workRoot,
    skillsDir: personalSkillsDir(),
    runtime: options.runtime,
    browserNote: options.browserNote,
    build: options.build,
    appVersion: options.appVersion,
    name: () => config.name || hostname().replace(/\.local\.?$/i, ''),
    store,
    service: () => service,
    channels,
    applySync: async (payload: SyncPayload) => {
      applySync(payload)
      void syncMcpServers()
      void refreshLocalProviders(true).catch(() => undefined)
    },
    applyUpdate: async (file) => {
      // install.sh in the new package swaps the app in and restarts this service.
      const script = `set -e; D=$(mktemp -d); tar -xzf "$1" -C "$D"; EAON_HOST_HOME="$2" sh "$D/eaon-host/install.sh" --update`
      const child = spawn('sh', ['-c', script, 'sh', file, home], { detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env } })
      child.unref()
    },
    signIns: () => signInEntries(secrets.entries()),
    uninstall: async () => {
      const child = spawn('sh', [join(appDir, 'install.sh'), '--uninstall'], { detached: true, stdio: 'ignore', env: { ...process.env, EAON_HOST_HOME: home } })
      child.unref()
    }
  })

  // A sign-in refreshed here (a worker thinking with it) goes to the desktop at once:
  // its copy's refresh token stopped working the moment this one was used.
  let lastSignIns = JSON.stringify(signInEntries(secrets.entries()))
  let signInTimer: ReturnType<typeof setTimeout> | null = null
  const offSecrets = secrets.onChange(() => {
    if (signInTimer) return
    signInTimer = setTimeout(() => {
      signInTimer = null
      const now = signInEntries(secrets.entries())
      const json = JSON.stringify(now)
      if (json === lastSignIns) return
      lastSignIns = json
      broadcast('host:tokens', now)
    }, 500)
  })

  const server = await listen({ port: config.port, secret: () => config.secret, onPeer: (peer) => host.attach(peer) })
  console.log(`[host] Eaon worker host ${options.build} (${options.runtime}) listening on port ${server.port} (pid ${process.pid})`)
  // install.sh waits for this line.
  console.log(`EAON_HOST_READY ${server.port}`)

  let stopping: Promise<void> | null = null
  const stop = (): Promise<void> => {
    if (stopping) return stopping
    stopping = (async () => {
      offSecrets()
      if (signInTimer) clearTimeout(signInTimer)
      offVmIpc()
      // On Linux the service manager ends QEMU with this app, so VMs are shut down properly and come back when it starts again.
      // A Mac's helpers run on their own and keep their VMs going.
      await vms.shutdown({ stopVms: process.platform === 'linux', resumeLater: true, graceMs: 25_000 }).catch(() => undefined)
      await server.close().catch(() => undefined)
      killBackgroundProcesses()
      await channels.stop().catch(() => undefined)
      service.stop()
      for (const feature of features) {
        try {
          feature.dispose?.()
        } catch {
          /* stopping regardless */
        }
      }
      await Promise.race([shutdownMcp(), new Promise((r) => setTimeout(r, 4000))]).catch(() => undefined)
      await Promise.race([store.flushWrites(), new Promise((r) => setTimeout(r, 3000))])
    })()
    return stopping
  }
  return { stop }
}
