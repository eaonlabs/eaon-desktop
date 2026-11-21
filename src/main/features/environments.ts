import { basename } from 'node:path'
import { isRemote, remoteCwd, remoteLocation, type SshHost } from '@shared/adeRemote'
import {
  environmentsOf,
  exeHost,
  exeHostId,
  shortId,
  vmNameFor,
  type BringBackResult,
  type CloudEnvironment,
  type ExeAccount,
  type PrepareRequest,
  type PrepareResult,
  type SessionPlace
} from '@shared/environments'
import { store } from '../store'
import { sshRun } from '../remoteWork'
import { sshHosts } from './ade'
import { bringBack, bringBackBranch } from './environments/bringBack'
import { CopyError, copyProject, ensureRemoteFolder } from './environments/copy'
import { ExeClient } from './environments/exe'
import { allowFolders } from './workspaceFiles'
import type { Feature } from './types'

/**
 * Cloud environments (shared/environments.ts): making the place a session
 * runs in — an exe.dev VM made for it, or a folder on one of the user's
 * machines — with a copy of the project, and bringing what was done there
 * back. The renderer keeps each session's place on the session; main keeps
 * nothing but the work in flight.
 */

const exe = new ExeClient()

/**
 * The copies sessions work on, which the dock, the diff and the terminal may
 * look inside as they do a project's folder: each made here, and those chats
 * already had when Eaon started (read once).
 */
const copies = new Set<string>()
let copiesRead = false
function placeFolders(): string[] {
  if (!copiesRead) {
    copiesRead = true
    for (const chat of store.getChats()) if (chat.place?.folder) copies.add(chat.place.folder)
  }
  return [...copies]
}
/** Preparations in flight, by the key the renderer gave, so one can be stopped. */
const preparing = new Map<string, AbortController>()

const clean = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function environment(id: string): CloudEnvironment | null {
  return environmentsOf(store.getSettings().environments).find((env) => env.id === id) ?? null
}

/** A folder name for a project's copy: its own name, as a folder name anywhere can be. */
export function copyName(project: string): string {
  return (
    basename(project)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+/, '')
      .slice(0, 60) || 'project'
  )
}

/** Waits until the machine answers over SSH: a new VM takes a moment to let anyone in. */
async function reachable(host: SshHost, signal: AbortSignal, tries = 24): Promise<void> {
  let last = ''
  for (let i = 0; i < tries; i++) {
    if (signal.aborted) throw new CopyError('Stopped.')
    const result = await sshRun(host, 'true', { timeoutMs: 25_000, signal })
    if (result.code === 0) return
    last = result.stderr.trim().split('\n').pop() ?? ''
    // A key problem won't fix itself by waiting.
    if (/permission denied|publickey|host key verification/i.test(last)) break
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  throw new CopyError(`${host.label} didn’t let Eaon in${last ? `: ${last}` : '.'}`)
}

export async function prepare(req: PrepareRequest, onStep: (step: string) => void): Promise<PrepareResult> {
  const env = environment(req.envId)
  if (!env) return { ok: false, error: 'That environment isn’t in Settings → Environments any more. Pick another one.' }
  if (typeof req.project !== 'string' || !req.project || isRemote(req.project)) return { ok: false, error: 'This project is already on another machine, so it runs there.' }
  const at = Date.now()
  const place: SessionPlace = { envId: env.id, name: env.name, kind: env.kind, state: 'preparing', source: req.project, at }
  const controller = new AbortController()
  preparing.get(req.key)?.abort()
  preparing.set(req.key, controller)
  const { signal } = controller
  let made: string | null = null
  try {
    let host: SshHost
    let parent: string
    let name = copyName(req.project)
    if (env.kind === 'exe') {
      const options = env.exe ?? { vm: null }
      if (options.vm) {
        onStep(`Starting ${options.vm} on exe.dev`)
        const vm = await exe.find(options.vm)
        if (!vm) return { ok: false, error: `${options.vm} isn’t one of your exe.dev VMs any more. Pick another in Settings → Environments.` }
        await exe.wake(vm)
        place.vm = vm.name
        parent = '~/eaon'
        name = `${name}-${shortId()}`
      } else {
        const vmName = vmNameFor(req.title || basename(req.project))
        onStep(`Making the VM ${vmName} on exe.dev`)
        await exe.create({ name: vmName, cpu: options.cpu, memory: options.memory, disk: options.disk, image: options.image, setup: options.setup })
        made = vmName
        place.vm = vmName
        place.madeVm = true
        parent = '~'
      }
      if (signal.aborted) throw new CopyError('Stopped.')
      host = exeHost(exeHostId(place.vm!))!
      onStep(`Waiting for ${place.vm} to let Eaon in`)
      await reachable(host, signal)
    } else {
      const found = env.ssh ? await sshHosts.find(env.ssh.hostId) : null
      if (!found) return { ok: false, error: `${env.name}’s SSH host isn’t in ~/.ssh/config or Eaon’s hosts any more. Edit it in Settings → Environments.` }
      host = found
      parent = env.ssh?.folder?.trim() || '~/eaon'
      name = `${name}-${shortId()}`
    }

    const copy = await copyProject({ host, project: req.project, parent, name, branch: req.branch, onStep, signal })
    copies.add(remoteCwd(host.id, copy.path))
    const ready: SessionPlace = {
      ...place,
      state: 'ready',
      folder: remoteCwd(host.id, copy.path),
      host: host.label,
      ...(copy.base ? { base: copy.base } : {}),
      ...(copy.branch ? { branch: copy.branch } : {})
    }
    return { ok: true, place: ready }
  } catch (error) {
    // A VM made for a session that couldn't be set up would only cost money: it goes.
    if (made) await exe.remove(made).catch(() => undefined)
    const stopped = signal.aborted
    return { ok: false, error: stopped ? 'Stopped before the environment was ready.' : clean(error), place: { ...place, state: 'failed', madeVm: false, error: stopped ? 'Stopped' : clean(error) } }
  } finally {
    if (preparing.get(req.key) === controller) preparing.delete(req.key)
  }
}

/** Whether an environment can be reached, for Settings' Check button. */
export async function check(env: CloudEnvironment): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  if (env.kind === 'exe') {
    const account = await exe.account()
    if (!account.ok) return { ok: false, message: account.message }
    if (env.exe?.vm) {
      const vm = account.vms.find((v) => v.name === env.exe!.vm)
      if (!vm) return { ok: false, message: `${env.exe.vm} isn’t one of your exe.dev VMs.` }
      return { ok: true, message: `${vm.name} is ${vm.status}. Sessions go in ~/eaon on it.` }
    }
    return { ok: true, message: `Signed in to exe.dev${account.email ? ` as ${account.email}` : ''}. Each session gets a VM of its own.` }
  }
  const host = env.ssh ? await sshHosts.find(env.ssh.hostId) : null
  if (!host) return { ok: false, message: 'Pick an SSH host.' }
  try {
    const folder = await ensureRemoteFolder(host, env.ssh?.folder || '~/eaon')
    const tools = await sshRun(host, 'for t in git claude codex; do command -v "$t" >/dev/null 2>&1 && printf "%s " "$t"; done; echo', { timeoutMs: 20_000 })
    const has = tools.stdout.toString('utf8').trim().split(/\s+/).filter(Boolean)
    const missing = ['git'].filter((t) => !has.includes(t))
    if (missing.length) return { ok: false, message: `Connected, but git isn’t installed on ${host.label}. Sessions copy projects over with it.` }
    const agents = has.filter((t) => t !== 'git')
    return { ok: true, message: `Connected. Sessions go in ${folder}${agents.length ? `; ${agents.map((a) => (a === 'claude' ? 'Claude Code' : 'Codex')).join(' and ')} installed` : ''}.` }
  } catch (error) {
    return { ok: false, message: clean(error) }
  }
}

/** What a session did on its machine, as a branch in the project here. */
export async function bringBackPlace(place: SessionPlace, name: string): Promise<BringBackResult> {
  const at = place.folder ? remoteLocation(place.folder) : null
  if (!at || !place.source) return { ok: false, error: 'This session has no copy to bring back.' }
  if (isRemote(place.source)) return { ok: false, error: 'This session’s project is on another machine already.' }
  const host = await sshHosts.find(at.hostId)
  if (!host) return { ok: false, error: 'The session’s machine isn’t known any more.' }
  return bringBack({ host, remote: at.path, project: place.source, base: place.base ?? null, branch: bringBackBranch(name), where: place.vm ?? host.label })
}

export const environmentsFeature: Feature = {
  id: 'environments',
  register({ ipcMain }) {
    allowFolders(placeFolders)
    ipcMain.handle('environments:exe-account', (): Promise<ExeAccount> => exe.account())
    ipcMain.handle('environments:check', (_e, env: CloudEnvironment) => check(env))
    ipcMain.handle('environments:prepare', (event, req: PrepareRequest) =>
      prepare(req, (step) => {
        if (!event.sender.isDestroyed()) event.sender.send('environments:progress', { key: req.key, step })
      })
    )
    ipcMain.handle('environments:cancel', (_e, key: unknown) => {
      if (typeof key === 'string') preparing.get(key)?.abort()
    })
    ipcMain.handle('environments:bring-back', (_e, place: SessionPlace, name: unknown) => bringBackPlace(place, typeof name === 'string' ? name : 'cloud'))
    ipcMain.handle('environments:remove-vm', async (_e, name: unknown): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (typeof name !== 'string') return { ok: false, error: 'No VM named.' }
      try {
        await exe.remove(name)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: clean(error) }
      }
    })
  },
  dispose() {
    for (const controller of preparing.values()) controller.abort()
  }
}
