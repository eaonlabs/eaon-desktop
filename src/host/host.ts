import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { freemem, loadavg, totalmem } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { hostForwardsEvent, hostServesChannel, WORKER_HOST_PROTOCOL, type HostHello } from '@shared/workerHost'
import type { Worker } from '@shared/workers'
import type { WorkersService } from '@main/features/workers/service'
import type { Peer } from '@main/workerHost/channel'
import { CHUNK, inside, listFolder, readSnapshot, relocate, safeName, writeChunk, writeSnapshot, type WorkersSnapshot } from '@main/workerHost/move'
import { invoke, onBroadcast, senderFor } from './ipc'

/**
 * What a worker computer does for the desktops linked to it: runs the
 * workers (the same service the desktop runs), answers the Workers tab's IPC
 * over the link and sends it everything the workers say, takes the keys and
 * settings the workers need, takes workers in and gives them back, and
 * replaces itself with the build the desktop sends.
 */

export interface SyncPayload {
  /** The desktop's key vault: API keys and sign-ins. */
  secrets: Record<string, string>
  providers: Record<string, unknown>
  settings: Record<string, unknown>
  mcpServers: unknown[]
}

interface StoreLike {
  getJson<T>(name: string, fallback: T): T
  setJson(name: string, value: unknown): void
  flushWrites(): Promise<unknown>
}

export interface HostDeps {
  /** ~/.eaon-host */
  home: string
  /** Where workers' folders live on this computer. */
  workRoot: () => string
  /** Personal skills, kept in step with the desktop's. */
  skillsDir: string
  runtime: 'electron' | 'node'
  browserNote: string | null
  build: string
  appVersion: string
  name: () => string
  store: StoreLike
  service: () => WorkersService
  applySync: (payload: SyncPayload) => Promise<void>
  /** Replaces the host app with the package in `file` and restarts; resolves once the swap has been handed off. */
  applyUpdate: (file: string) => Promise<void>
  /** Removes the host app from this computer. */
  uninstall: () => Promise<void>
  now?: () => number
}

const SYNC_MARK = 'host-synced.json'

export interface Host {
  attach: (peer: Peer) => void
  hello: () => HostHello
}

export function createHost(deps: HostDeps): Host {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const uploads = join(deps.home, 'uploads')
  const incoming = join(deps.home, 'incoming.tgz')
  let nextSender = 1

  const roots = (): string[] => [deps.workRoot(), uploads, deps.skillsDir].map((r) => resolve(r))
  /** File calls only ever reach the workers' folders, uploads and skills. */
  const allowed = (path: string): string => {
    const full = resolve(String(path ?? ''))
    if (!roots().some((root) => full === root || full.startsWith(root + sep))) throw new Error('That path isn’t one the worker computer shares.')
    return full
  }

  const hello = (): HostHello => {
    const workers = deps.service().engine.list()
    return {
      protocol: WORKER_HOST_PROTOCOL,
      build: deps.build,
      appVersion: deps.appVersion,
      name: deps.name(),
      platform: process.platform,
      arch: process.arch,
      runtime: deps.runtime,
      browserNote: deps.browserNote,
      startedAt,
      workers: workers.length,
      running: workers.filter((w: Worker) => w.status === 'working').length,
      synced: deps.store.getJson<{ at?: number } | null>(SYNC_MARK, null) !== null,
      memory: { free: freemem(), total: totalmem() },
      load: loadavg()[0]
    }
  }

  const attach = (peer: Peer): void => {
    const id = nextSender++
    const event = senderFor(id, (channel, args) => peer.emit('ipc', { channel, args }))
    // Everything features send goes to this desktop too; a frame only to the one watching.
    const off = onBroadcast((channel, args) => {
      if (hostForwardsEvent(channel)) peer.emit('ipc', { channel, args })
    })
    /** Live views this desktop opened, so they close with it. */
    const watching = new Map<string, number>()

    peer.onClose(() => {
      off()
      for (const [target, count] of watching) {
        for (let i = 0; i < count; i++) void invoke(event, 'agent-browser:watch', [false, target]).catch(() => undefined)
      }
      watching.clear()
    })

    peer.handle(async (method, params) => {
      const p = (params ?? {}) as Record<string, unknown>
      switch (method) {
        case 'hello':
          return hello()

        case 'sync': {
          await deps.applySync(p as unknown as SyncPayload)
          deps.store.setJson(SYNC_MARK, { at: now() })
          return hello()
        }

        case 'ipc': {
          const channel = String(p.channel ?? '')
          const args = Array.isArray(p.args) ? p.args : []
          if (!hostServesChannel(channel, args)) throw new Error(`${channel} isn’t served by the worker computer.`)
          if (channel === 'agent-browser:watch') {
            const target = String(args[1])
            const count = (watching.get(target) ?? 0) + (args[0] ? 1 : -1)
            if (count > 0) watching.set(target, count)
            else watching.delete(target)
          }
          return invoke(event, channel, args)
        }

        /* Workers moving in: suspend, write, take the folders, then resume. */
        case 'workers.import': {
          const service = deps.service()
          service.suspend()
          await deps.store.flushWrites()
          const current = readSnapshot(deps.store)
          if (current.workers.length > 0) {
            // Whatever was here is kept, not lost, should the move be a mistake.
            deps.store.setJson(`workers-before-import-${now()}.json`, current)
          }
          const { snapshot, moves } = relocate(p.snapshot as WorkersSnapshot, deps.workRoot())
          for (const move of moves) mkdirSync(move.to, { recursive: true })
          writeSnapshot(deps.store, snapshot)
          return { moves }
        }
        case 'workers.export': {
          const service = deps.service()
          service.suspend()
          await deps.store.flushWrites()
          const snapshot = readSnapshot(deps.store)
          const folders = snapshot.workers.map((w) => {
            const folder = String((w as { folder?: unknown }).folder ?? '')
            return { id: String((w as { id: string }).id), folder, ...listFolder(folder) }
          })
          return { snapshot, folders }
        }
        case 'workers.release': {
          // The workers went back to the desktop: keep a copy, then run none.
          const service = deps.service()
          service.suspend()
          await deps.store.flushWrites()
          const snapshot = readSnapshot(deps.store)
          if (snapshot.workers.length > 0) deps.store.setJson(`workers-released-${now()}.json`, snapshot)
          writeSnapshot(deps.store, { workers: [], threads: {}, rooms: null })
          service.resume()
          return hello()
        }
        case 'workers.resume': {
          const service = deps.service()
          if (service.suspended) service.resume()
          return hello()
        }

        /* Files: uploads for mail, workers' folders, skills. */
        case 'files.upload-path': {
          const dir = join(uploads, randomBytes(6).toString('hex'))
          mkdirSync(dir, { recursive: true })
          return join(dir, safeName(String(p.name ?? 'file')))
        }
        case 'files.put': {
          const path = allowed(String(p.path))
          await writeChunk(path, Number(p.offset ?? 0), Buffer.from(String(p.data ?? ''), 'base64'))
          return true
        }
        case 'files.list': {
          const folder = allowed(String(p.folder))
          return listFolder(folder)
        }
        case 'files.get': {
          const path = allowed(String(p.path))
          const offset = Number(p.offset ?? 0)
          const size = statSync(path).size
          const handle = await open(path, 'r')
          try {
            const buffer = Buffer.alloc(Math.max(0, Math.min(CHUNK, size - offset)))
            await handle.read(buffer, 0, buffer.length, offset)
            return { data: buffer.toString('base64'), size }
          } finally {
            await handle.close()
          }
        }
        case 'skills.dir':
          return deps.skillsDir
        case 'skills.clear': {
          await rm(deps.skillsDir, { recursive: true, force: true })
          mkdirSync(deps.skillsDir, { recursive: true })
          return true
        }

        /* Keeping the host app in step with the desktop. */
        case 'update.put': {
          await writeChunk(incoming, Number(p.offset ?? 0), Buffer.from(String(p.data ?? ''), 'base64'))
          return true
        }
        case 'update.apply': {
          if (!existsSync(incoming)) throw new Error('The update didn’t arrive.')
          const { createHash } = await import('node:crypto')
          const hash = createHash('sha256').update(readFileSync(incoming)).digest('hex')
          if (hash !== p.sha256) throw new Error('The update arrived damaged; it will be sent again.')
          // Answer first: the swap ends this process.
          setTimeout(() => void deps.applyUpdate(incoming), 200)
          return true
        }
        case 'uninstall': {
          setTimeout(() => void deps.uninstall(), 200)
          return true
        }
        default:
          throw new Error(`${method} isn’t something the worker computer does.`)
      }
    })

    // The desktop learns at once what it is talking to.
    peer.emit('hello', hello())
  }

  return { attach, hello }
}
