import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import type { Feature, FeatureContext } from '@main/features/types'
import { store } from '@main/store'
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
import { listen } from '@main/workerHost/channel'
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

  // A worker's news goes to the desktop, which shows it as its own notification.
  const service: WorkersService = createWorkersService(context, {
    notifier: {
      notify: (worker, outcome) => broadcast('host:notify', { workerId: worker.id, title: outcome.ok ? worker.name : `${worker.name} hit a problem`, body: outcome.text, reachOut: false }),
      reachOut: (worker, message) => broadcast('host:notify', { workerId: worker.id, title: message.title, body: message.body, reachOut: true })
    }
  })
  service.start()
  service.registerIpc()
  if (options.runtime === 'electron') {
    // The live view and take-over of each worker's browser, served to the desktop.
    agentBrowserFeature.register(context)
    features.push(agentBrowserFeature)
  } else {
    // No Electron, no browser: the tool is withdrawn rather than offered and failing.
    registerToolSource({ id: 'worker-browser', tools: () => [] })
  }

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
    uninstall: async () => {
      const child = spawn('sh', [join(appDir, 'install.sh'), '--uninstall'], { detached: true, stdio: 'ignore', env: { ...process.env, EAON_HOST_HOME: home } })
      child.unref()
    }
  })

  const server = await listen({ port: config.port, secret: () => config.secret, onPeer: (peer) => host.attach(peer) })
  console.log(`[host] Eaon worker host ${options.build} (${options.runtime}) listening on port ${server.port} (pid ${process.pid})`)
  // install.sh waits for this line.
  console.log(`EAON_HOST_READY ${server.port}`)

  let stopping: Promise<void> | null = null
  const stop = (): Promise<void> => {
    if (stopping) return stopping
    stopping = (async () => {
      await server.close().catch(() => undefined)
      killBackgroundProcesses()
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
