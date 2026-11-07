import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Automations' webhooks: which automations have one on, and each one's secret.
 * Off by default; turning one on makes a secret, turning it off throws the
 * secret away (a new one is made the next time). The secret is in the secrets
 * vault, like Eaon's other keys; only what the page shows (when it was made,
 * how often it was called) is kept beside it. The route that answers calls is
 * `control/hooks.ts`, on the Local API Server that already runs.
 */

export const HOOK_VAULT_PREFIX = 'automation-hook:'
/** Where a call goes: this, then the automation's secret. */
export const HOOK_PATH = '/hooks/automation/'

export interface HookInfo {
  createdAt: number
  lastCalledAt: number | null
  calls: number
}

export interface HooksDeps {
  load: () => unknown
  save: (hooks: Record<string, HookInfo>) => void
  getSecret: (taskId: string) => string | undefined
  /** Null forgets it. May throw: the vault refuses writes while the keychain is locked. */
  setSecret: (taskId: string, secret: string | null) => void
  newSecret?: () => string
  now?: () => number
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Long enough to never be guessed: 192 random bits. */
export const newHookSecret = (): string => `eaonh_${randomBytes(24).toString('base64url')}`

/** Constant time, whatever the lengths: both sides are hashed first. */
function sameSecret(sent: string, expected: string | undefined): boolean {
  if (!sent || !expected) return false
  const digest = (text: string): Buffer => createHash('sha256').update(text).digest()
  return timingSafeEqual(digest(sent), digest(expected))
}

export class AutomationHooks {
  private info: Record<string, HookInfo> = {}
  private readonly now: () => number
  private readonly make: () => string

  constructor(private readonly deps: HooksDeps) {
    this.now = deps.now ?? Date.now
    this.make = deps.newSecret ?? newHookSecret
  }

  load(): void {
    const raw = this.deps.load()
    this.info = {}
    if (!isRecord(raw)) return
    for (const [taskId, entry] of Object.entries(raw)) {
      if (!isRecord(entry)) continue
      this.info[taskId] = {
        createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
        lastCalledAt: typeof entry.lastCalledAt === 'number' ? entry.lastCalledAt : null,
        calls: typeof entry.calls === 'number' && entry.calls >= 0 ? Math.floor(entry.calls) : 0
      }
    }
  }

  /** On means there is a record and the vault still has its secret. */
  isOn(taskId: string): boolean {
    return taskId in this.info && Boolean(this.deps.getSecret(taskId))
  }

  /** The secret of an automation whose webhook is on, for building its URL. Null when off. */
  secretOf(taskId: string): string | null {
    return this.isOn(taskId) ? (this.deps.getSecret(taskId) ?? null) : null
  }

  stats(taskId: string): HookInfo | null {
    return this.info[taskId] ?? null
  }

  /** Turns it on (a no-op if it already is) and returns the secret. Throws a sentence when the secret can't be kept. */
  enable(taskId: string): string {
    const kept = this.secretOf(taskId)
    if (kept) return kept
    return this.replace(taskId)
  }

  /** A new secret: the old URL stops working at once. */
  rotate(taskId: string): string {
    if (!this.isOn(taskId)) throw new Error('Turn the webhook on first.')
    return this.replace(taskId)
  }

  private replace(taskId: string): string {
    const secret = this.make()
    try {
      this.deps.setSecret(taskId, secret)
    } catch (error) {
      throw new Error(`Eaon couldn’t save the webhook’s secret: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.info[taskId] = { createdAt: this.now(), lastCalledAt: null, calls: 0 }
    this.persist()
    return secret
  }

  /** Turns it off and throws the secret away. */
  disable(taskId: string): void {
    if (!(taskId in this.info) && !this.deps.getSecret(taskId)) return
    try {
      this.deps.setSecret(taskId, null)
    } catch (error) {
      // Better to stay on and say so than to look off while the secret still works.
      throw new Error(`Eaon couldn’t remove the webhook’s secret: ${error instanceof Error ? error.message : String(error)}`)
    }
    delete this.info[taskId]
    this.persist()
  }

  /** The automation a secret belongs to, or null. Every webhook is compared, so what's wrong takes as long as what's right. */
  find(secret: string): string | null {
    let found: string | null = null
    for (const taskId of Object.keys(this.info)) {
      if (sameSecret(secret, this.deps.getSecret(taskId))) found = taskId
    }
    return found
  }

  /** A call that started a run. */
  record(taskId: string): void {
    const info = this.info[taskId]
    if (!info) return
    info.calls += 1
    info.lastCalledAt = this.now()
    this.persist()
  }

  /** Drops the webhooks of automations that are gone. */
  prune(existing: Set<string>): void {
    let changed = false
    for (const taskId of Object.keys(this.info)) {
      if (existing.has(taskId)) continue
      try {
        this.deps.setSecret(taskId, null)
      } catch {
        /* a locked keychain: it is dropped from the list anyway, and can't be found without a record */
      }
      delete this.info[taskId]
      changed = true
    }
    if (changed) this.persist()
  }

  private persist(): void {
    this.deps.save(structuredClone(this.info))
  }
}
