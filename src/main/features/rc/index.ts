import { hostname } from 'node:os'
import path from 'node:path'
import { app, dialog, shell } from 'electron'
import type { Feature } from '../types'
import { store } from '../../store'
import { secrets } from '../../secrets'
import { computerNames, remoteApiDeps } from '../../remote'
import { workersService } from '../workers'
import { terminalsFeature } from '../terminals'
import { adeForRemote } from '../ade'
import { RC_DEFAULT_SERVER, type GuestTerminalSnapshot, type GuestTerminalView, type LockedSupport, type LockedTerminal, type LockedTerminalDraft, type RcConnection, type RcInfo, type RcShare } from '@shared/rc'
import { onPath } from '../../shellEnv'
import { createGuestTerminals, type GuestTerminals } from './guestTerminals'
import { RelayClient } from './client'
import { createRcHandler, type RcBrowsers } from './handler'
import { agentBrowsersOpen, browserStatus, browserSteps, onBrowserStep, watchBrowserFrames } from '../agentBrowser'

/**
 * Eaon Remote: this computer, linked to a GitHub account at rc.eaon.dev, so its
 * ADE sessions, live terminals and Workers can be used from a browser
 * anywhere. Off until the user links it in Settings → Remote devices.
 *
 * Linking is the TV way: Eaon asks the server for a code, opens
 * rc.eaon.dev/link?code=…, and the user signs in with GitHub there and
 * approves; Eaon, polling with a secret only it holds, then collects its
 * device token. The token lives in the secrets vault (encrypted with the
 * system keychain), never in settings. Unlinking here or on the website
 * revokes it.
 *
 * EAON_RC_URL points it at another server (`wrangler dev` for testing).
 */

const VAULT_KEY = 'eaon-rc-device'

/** The agents' browsers, for the web's live view of them. */
function remoteBrowsers(): RcBrowsers {
  return {
    list: agentBrowsersOpen,
    status: browserStatus,
    steps: browserSteps,
    watch: watchBrowserFrames,
    onStep: onBrowserStep,
    label: (target) => {
      const worker = /^worker:(.+)$/.exec(target)
      if (!worker) return 'Eaon’s browser'
      const name = workersService()?.engine.list().find((w) => w.id === worker[1])?.name
      return name ? `${name}’s browser` : 'A Worker’s browser'
    }
  }
}
const server = (): string => (process.env.EAON_RC_URL || RC_DEFAULT_SERVER).replace(/\/$/, '')

let client: RelayClient | null = null
let handler: ReturnType<typeof createRcHandler> | null = null
let guestTerminals: GuestTerminals | null = null
let untapGuestExits: (() => void) | null = null
let sweepTimer: NodeJS.Timeout | null = null
let connection: RcConnection = 'off'
let problem: string | null = null
let linking: { code: string; url: string; expiresAt: number; poll: string } | null = null
let pollTimer: NodeJS.Timeout | null = null
let computerName = hostname().replace(/\.local\.?$/i, '')

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${server()}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(body.error || `Eaon Remote answered ${res.status}.`)
  return body
}

export const rcFeature: Feature = {
  id: 'rc',
  register: (ctx) => {
    void computerNames().then((n) => (computerName = n.computerName), () => undefined)
    const userData = app.getPath('userData')
    const guestsOf = (): GuestTerminals =>
      (guestTerminals ??= createGuestTerminals({
        terminals: terminalsFeature.control,
        store,
        homesDir: path.join(userData, 'guest-homes'),
        userData,
        findBin: onPath,
        onChange: () => ctx.send('rc:guest-terminals', guestTerminals?.watching() ?? [])
      }))
    // A friend's terminal ending (they quit its CLI) changes what you watch too.
    untapGuestExits = terminalsFeature.control.tap((channel, payload) => {
      const paneId = (payload as { paneId?: unknown } | null)?.paneId
      if (channel === 'terminal:exit' && typeof paneId === 'string' && guestTerminals?.watchable(paneId)) ctx.send('rc:guest-terminals', guestTerminals.watching())
    })
    // Expired locked terminals stop on time, not the next time someone looks.
    sweepTimer = setInterval(() => {
      const gone = guestTerminals?.prune(null) ?? []
      const token = secrets.get(VAULT_KEY)
      if (token) for (const id of gone) void api(`/api/device/shares/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined)
    }, 60_000)

    const settings = (): ReturnType<typeof store.getSettings>['rc'] => store.getSettings().rc
    const patch = (change: Partial<ReturnType<typeof store.getSettings>['rc']>): void => {
      store.patchSettings({ rc: { ...settings(), ...change } })
    }

    const info = (): RcInfo => {
      const s = settings()
      return {
        server: server(),
        linked: Boolean(s.deviceId && secrets.has(VAULT_KEY)),
        enabled: s.enabled,
        login: s.login,
        avatar: s.avatar,
        connection,
        problem,
        linking: linking ? { code: linking.code, url: linking.url, expiresAt: linking.expiresAt } : null
      }
    }
    const changed = (): void => ctx.send('rc:status', info())

    const disconnect = (): void => {
      client?.stop()
      client = null
      handler?.dispose()
      handler = null
      connection = 'off'
      problem = null
    }

    const forget = (): void => {
      disconnect()
      secrets.clear(VAULT_KEY)
      patch({ enabled: false, deviceId: null, login: null, avatar: null })
    }

    const connect = (): void => {
      disconnect()
      const token = secrets.get(VAULT_KEY)
      if (!token || !settings().enabled) return changed()
      const workers = workersService()
      handler = createRcHandler({
        terminals: terminalsFeature.control,
        ade: adeForRemote,
        workers: workers ? remoteApiDeps(workers.engine, workers.remove, () => computerName) : null,
        browsers: remoteBrowsers(),
        guests: guestsOf(),
        send: (message) => client?.send(message)
      })
      client = new RelayClient({
        server: server(),
        token,
        name: computerName,
        onMessage: (m) => void handler?.handle(m),
        onStatus: (status, why) => {
          connection = status
          problem = why
          changed()
        },
        onUnlinked: () => {
          forget()
          problem = 'This computer was unlinked from Eaon Remote. Link it again to use it from the web.'
          changed()
        }
      })
      client.start()
    }

    const stopLinking = (): void => {
      if (pollTimer) clearTimeout(pollTimer)
      pollTimer = null
      linking = null
    }

    const poll = async (): Promise<void> => {
      if (!linking) return
      if (Date.now() > linking.expiresAt) {
        stopLinking()
        problem = 'The code expired before it was approved. Link again to get a new one.'
        return changed()
      }
      try {
        const res = await api<{ status: string; token?: string; deviceId?: string; user?: { login: string; avatar: string } }>('/api/link/poll', {
          method: 'POST',
          body: JSON.stringify({ poll: linking.poll })
        })
        if (res.status === 'approved' && res.token && res.deviceId) {
          stopLinking()
          secrets.set(VAULT_KEY, res.token)
          patch({ enabled: true, deviceId: res.deviceId, login: res.user?.login ?? null, avatar: res.user?.avatar ?? null })
          problem = null
          connect()
          return changed()
        }
        if (res.status === 'denied' || res.status === 'expired') {
          stopLinking()
          problem = res.status === 'denied' ? 'Linking was turned down on the website.' : 'The code expired before it was approved. Link again to get a new one.'
          return changed()
        }
      } catch {
        /* the network blinked: keep polling until the code expires */
      }
      pollTimer = setTimeout(() => void poll(), 2000)
    }

    const { ipcMain } = ctx
    ipcMain.handle('rc:info', () => info())

    ipcMain.handle('rc:link', async () => {
      stopLinking()
      problem = null
      const started = await api<{ code: string; poll: string; url: string; expiresIn: number }>('/api/link/start', {
        method: 'POST',
        body: JSON.stringify({ name: computerName, platform: process.platform })
      })
      linking = { code: started.code, url: started.url, poll: started.poll, expiresAt: Date.now() + started.expiresIn * 1000 }
      // EAON_RC_NO_BROWSER: the end-to-end test approves the code itself.
      if (!process.env.EAON_RC_NO_BROWSER) void shell.openExternal(started.url)
      pollTimer = setTimeout(() => void poll(), 2000)
      changed()
      return info()
    })

    ipcMain.handle('rc:cancel-link', () => {
      stopLinking()
      changed()
      return info()
    })

    ipcMain.handle('rc:set-enabled', (_e, enabled: unknown) => {
      patch({ enabled: enabled === true })
      if (enabled === true) connect()
      else disconnect()
      changed()
      return info()
    })

    // Who this computer is shared with (shared on the website), and taking it back from here.
    ipcMain.handle('rc:shares', async (): Promise<RcShare[]> => {
      const token = secrets.get(VAULT_KEY)
      if (!token) return []
      const { shares } = await api<{ shares: Omit<RcShare, 'online'>[] }>('/api/device/shares', { headers: { Authorization: `Bearer ${token}` } })
      // A friend nothing is shared with any more: their home here goes, with what they signed in to.
      guestsOf().prune(new Set(shares.map((s) => s.id)), new Set(shares.map((s) => s.login)))
      const online = new Set(handler?.guestsOnline() ?? [])
      return shares.map((s) => ({
        id: s.id,
        login: s.login,
        pane: s.pane,
        paneLabel: s.paneLabel,
        access: s.access,
        pending: s.pending,
        expired: s.expired,
        createdAt: s.createdAt,
        online: !s.pending && online.has(s.login.toLowerCase())
      }))
    })
    ipcMain.handle('rc:revoke-share', async (_e, id: unknown) => {
      const token = secrets.get(VAULT_KEY)
      if (!token || typeof id !== 'string' || !/^[\w-]{1,40}$/.test(id)) throw new Error('That share isn’t there any more.')
      await api(`/api/device/shares/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      // A locked terminal behind it ends with it.
      const locked = guestsOf().list().find((l) => l.shareId === id)
      if (locked) guestsOf().remove(locked.id)
      return true
    })

    // Watching friends' terminals beside your own work (GuestWatch.tsx): what
    // they show, never a way in. Their output reaches the window as every
    // terminal's does (terminal:data); this is what was there before it opened.
    ipcMain.handle('rc:guest-terminals', (): GuestTerminalView[] => guestsOf().watching())
    ipcMain.handle('rc:guest-snapshot', (_e, paneId: unknown): GuestTerminalSnapshot | null => {
      if (typeof paneId !== 'string' || !guestsOf().watchable(paneId)) return null
      const snap = terminalsFeature.control.snapshot(paneId)
      return { data: snap.data.slice(-768 * 1024), cols: snap.cols, rows: snap.rows, running: snap.running }
    })
    ipcMain.handle('rc:guest-stop', (_e, paneId: unknown) => {
      if (typeof paneId === 'string' && guestsOf().watchable(paneId)) guestsOf().stop(paneId)
      return true
    })

    // Locked terminals: a terminal for a friend, sandboxed to one folder (guestTerminals.ts).
    ipcMain.handle('rc:locked-support', (): LockedSupport => guestsOf().support())
    ipcMain.handle('rc:locked-pick-folder', async (): Promise<string | null> => {
      const picked = await dialog.showOpenDialog({ title: 'Share a folder', buttonLabel: 'Share this folder', properties: ['openDirectory', 'createDirectory'] })
      return picked.canceled ? null : (picked.filePaths[0] ?? null)
    })
    ipcMain.handle('rc:locked-list', async (): Promise<LockedTerminal[]> => {
      const token = secrets.get(VAULT_KEY)
      let remote: { id: string; login: string; pending: boolean }[] | null = null
      if (token) {
        try {
          remote = (await api<{ shares: { id: string; login: string; pending: boolean }[] }>('/api/device/shares', { headers: { Authorization: `Bearer ${token}` } })).shares
        } catch {
          remote = null
        }
      }
      // Revoked on the website (or unlinked): the locked terminal goes too, and
      // the home of a friend nothing is shared with any more.
      guestsOf().prune(remote ? new Set(remote.map((r) => r.id)) : null, remote ? new Set(remote.map((r) => String(r.login ?? ''))) : undefined)
      const online = new Set(handler?.guestsOnline() ?? [])
      return guestsOf()
        .list()
        .map((l) => ({ ...l, pending: remote?.find((r) => r.id === l.shareId)?.pending ?? false, online: online.has(l.login.toLowerCase()) }))
    })
    ipcMain.handle('rc:locked-create', async (_e, draft: LockedTerminalDraft): Promise<{ terminal: LockedTerminal; url: string }> => {
      const token = secrets.get(VAULT_KEY)
      if (!token || !settings().enabled) throw new Error('Link this computer to Eaon Remote first.')
      const guests = guestsOf()
      const { saved, paneId } = await guests.prepare(draft)
      const made = await api<{ share: { id: string }; url: string }>('/api/device/shares', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ pane: paneId, paneLabel: saved.label, login: saved.login })
      })
      return { terminal: guests.commit(saved, made.share.id), url: made.url }
    })
    ipcMain.handle('rc:locked-revoke', async (_e, id: unknown) => {
      if (typeof id !== 'string' || !/^[\w-]{1,40}$/.test(id)) throw new Error('That terminal isn’t shared any more.')
      const shareId = guestsOf().remove(id)
      const token = secrets.get(VAULT_KEY)
      if (token && shareId) await api(`/api/device/shares/${shareId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined)
      return true
    })

    ipcMain.handle('rc:unlink', async () => {
      const token = secrets.get(VAULT_KEY)
      // Revoked on the server too, so the token is dead even if a copy exists somewhere.
      if (token) await api('/api/device/unlink', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined)
      forget()
      changed()
      return info()
    })

    // At launch: reconnect a linked computer that was left on.
    if (settings().enabled && secrets.has(VAULT_KEY)) connect()
  },
  dispose: () => {
    untapGuestExits?.()
    if (pollTimer) clearTimeout(pollTimer)
    if (sweepTimer) clearInterval(sweepTimer)
    guestTerminals?.dispose()
    client?.stop()
    handler?.dispose()
  }
}
