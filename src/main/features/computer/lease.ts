import type { ComputerLeaseOwner, ComputerLeaseState } from '@shared/computerUse'

/**
 * Who may use the computer's one pointer and keyboard.
 *
 * Every chat, worker and scheduled task can be offered the `computer` tool,
 * and several can run at once. `exclusive` in tool.ts only stops two actions
 * from overlapping; between them, two runs would take turns clicking on a
 * screen the other just changed. So a run must hold this lease to send input:
 * the first to act gets it, and keeps it for the rest of its run, so a
 * sequence of steps isn't interleaved with someone else's.
 *
 * Another run either waits (bounded, cancellable, and listed in `waiting` so
 * the app can say "Waiting for the computer — Nova is using it") or, when it
 * asked not to wait, is refused with a reason the model understands.
 *
 * The lease ends when its run ends (checked with `isRunning`, which catches
 * every way a run stops, crashes included), when the run is stopped (its
 * signal), after `idleMs` without an action, or when the user takes back
 * control — which also refuses that run, and everyone waiting, for the rest
 * of their runs: the user wants the computer, not the next agent in line.
 *
 * Looking (screenshots, the cursor position) needs no lease: seeing the
 * screen is not permission to control it, and a screenshot changes nothing.
 * Pure bookkeeping with an injected clock, so it is unit tested directly.
 */

export type LeaseResult =
  | { ok: true; waited: boolean }
  | { ok: false; reason: 'busy' | 'timeout' | 'revoked' | 'aborted'; holder: ComputerLeaseOwner | null; text: string }

export interface LeaseOptions {
  now?: () => number
  /** Whether a run is still going; a lease held by a run that ended is free. */
  isRunning?: (runId: string) => boolean
  /** A holder this long without an action lets go. */
  idleMs?: number
  /** How long a run waits for the computer before it is told to do something else. */
  waitMs?: number
  /** How often to check for ended runs and idle holders while anyone holds or waits. */
  sweepMs?: number
}

interface Waiter {
  owner: ComputerLeaseOwner
  since: number
  done: (result: LeaseResult) => void
  timer: ReturnType<typeof setTimeout> | null
  cleanup: () => void
}

/** "Nova (a worker)", "the chat “Trip planning”", "the scheduled task “Daily report”". */
export function ownerLabel(owner: Pick<ComputerLeaseOwner, 'kind' | 'name'>): string {
  const name = owner.name.trim()
  if (owner.kind === 'worker') return name ? `${name} (a worker)` : 'a worker'
  if (owner.kind === 'scheduled') return name ? `the scheduled task “${name}”` : 'a scheduled task'
  return name ? `the chat “${name}”` : 'another chat'
}

export const REVOKED_TEXT =
  "The user took back control of the computer, so this was not done. Don't use the computer again in this run unless the user asks you to: carry on without it, or tell them what you still need done on screen."

export class ComputerLease {
  private holder: (ComputerLeaseOwner & { since: number; lastActive: number }) | null = null
  private waiters: Waiter[] = []
  /** Runs the user took control back from; refused until they end. */
  private revoked = new Set<string>()
  /** Runs whose stop already releases the lease. */
  private watched = new Set<string>()
  /** The last time each run acted, and who it was: for "someone else used the screen since your screenshot". */
  private acted = new Map<string, { at: number; owner: ComputerLeaseOwner }>()
  private listeners = new Set<(state: ComputerLeaseState) => void>()
  private sweeper: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number
  private readonly isRunning: (runId: string) => boolean
  readonly idleMs: number
  readonly waitMs: number
  private readonly sweepMs: number

  constructor(options: LeaseOptions = {}) {
    this.now = options.now ?? Date.now
    this.isRunning = options.isRunning ?? (() => true)
    this.idleMs = options.idleMs ?? 90_000
    this.waitMs = options.waitMs ?? 120_000
    this.sweepMs = options.sweepMs ?? 1000
  }

  state(): ComputerLeaseState {
    return {
      holder: this.holder ? { ...this.holder } : null,
      waiting: this.waiters.map((w) => ({ ...w.owner, since: w.since }))
    }
  }

  onChange(listener: (state: ComputerLeaseState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** True when this run may not use the computer again: the user took it back. */
  isRevoked(runId: string): boolean {
    return this.revoked.has(runId)
  }

  holds(runId: string): boolean {
    return this.holder?.runId === runId
  }

  /**
   * The computer for `owner`'s run: at once if free (or already its), else
   * after the holder lets go — unless `wait` is false, `waitMs` passes, the
   * signal aborts, or the user takes control back meanwhile.
   */
  acquire(owner: ComputerLeaseOwner, options: { signal?: AbortSignal; wait?: boolean; onWait?: (holder: ComputerLeaseOwner) => void } = {}): Promise<LeaseResult> {
    this.sweep()
    if (this.revoked.has(owner.runId)) return Promise.resolve(this.refusal('revoked', null))
    if (options.signal?.aborted) return Promise.resolve(this.refusal('aborted', this.holder))
    this.watch(owner.runId, options.signal)
    if (!this.holder || this.holder.runId === owner.runId) {
      this.grant(owner)
      return Promise.resolve({ ok: true, waited: false })
    }
    const holder: ComputerLeaseOwner = { kind: this.holder.kind, id: this.holder.id, name: this.holder.name, runId: this.holder.runId }
    if (options.wait === false) return Promise.resolve(this.refusal('busy', holder))
    options.onWait?.(holder)
    return new Promise<LeaseResult>((resolve) => {
      const waiter: Waiter = {
        owner,
        since: this.now(),
        timer: null,
        cleanup: () => undefined,
        done: (result) => {
          if (waiter.timer) clearTimeout(waiter.timer)
          waiter.cleanup()
          resolve(result)
        }
      }
      waiter.timer = setTimeout(() => {
        this.dropWaiter(waiter)
        waiter.done(this.refusal('timeout', this.holderOwner()))
        this.changed()
      }, this.waitMs)
      const onAbort = (): void => {
        this.dropWaiter(waiter)
        waiter.done(this.refusal('aborted', this.holderOwner()))
        this.changed()
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      waiter.cleanup = () => options.signal?.removeEventListener('abort', onAbort)
      this.waiters.push(waiter)
      this.startSweeping()
      this.changed()
    })
  }

  /** The holder did something: it isn't idle, and other runs' screenshots before now are out of date. */
  touch(owner: ComputerLeaseOwner): void {
    const at = this.now()
    if (this.holder?.runId === owner.runId) this.holder.lastActive = at
    this.acted.set(owner.runId, { at, owner })
  }

  /**
   * Who else, if anyone, acted on the screen after `since` (a screenshot's
   * time) — so `self` looks again first. "Else" means another agent: the same
   * chat or worker's earlier turn is not news to its own next turn.
   */
  actedSince(since: number, self: Pick<ComputerLeaseOwner, 'kind' | 'id'>): ComputerLeaseOwner | null {
    let latest: { at: number; owner: ComputerLeaseOwner } | null = null
    for (const entry of this.acted.values()) {
      if (entry.owner.kind === self.kind && entry.owner.id === self.id) continue
      if (entry.at > since && (!latest || entry.at > latest.at)) latest = entry
    }
    return latest?.owner ?? null
  }

  /** The run let go (its turn ended, it was stopped, it went idle); the next one waiting gets the computer. */
  release(runId: string): void {
    this.watched.delete(runId)
    const waiting = this.waiters.find((w) => w.owner.runId === runId)
    if (waiting) {
      this.dropWaiter(waiting)
      waiting.done(this.refusal('aborted', this.holderOwner()))
    }
    if (this.holder?.runId !== runId) {
      if (waiting) this.changed()
      return
    }
    this.holder = null
    this.next()
    this.changed()
  }

  /**
   * The user takes back control: the holder loses the computer for the rest
   * of its run, and so does everyone waiting. Returns who was refused, the
   * holder first.
   */
  revoke(): ComputerLeaseOwner[] {
    const refused: ComputerLeaseOwner[] = []
    const holder = this.holderOwner()
    if (holder) {
      this.revoked.add(holder.runId)
      refused.push(holder)
    }
    this.holder = null
    for (const waiter of this.waiters.splice(0)) {
      this.revoked.add(waiter.owner.runId)
      refused.push(waiter.owner)
      waiter.done(this.refusal('revoked', null))
    }
    this.changed()
    return refused
  }

  /** Lets go of runs that ended or went idle; forgets refusals and activity of runs that ended. */
  sweep(): void {
    let changed = false
    for (const runId of [...this.revoked]) if (!this.isRunning(runId)) this.revoked.delete(runId)
    for (const [runId, entry] of this.acted) if (!this.isRunning(runId) && this.now() - entry.at > 10 * 60_000) this.acted.delete(runId)
    for (const waiter of [...this.waiters]) {
      if (this.isRunning(waiter.owner.runId)) continue
      this.dropWaiter(waiter)
      waiter.done(this.refusal('aborted', this.holderOwner()))
      changed = true
    }
    if (this.holder && (!this.isRunning(this.holder.runId) || this.now() - this.holder.lastActive >= this.idleMs)) {
      this.holder = null
      this.next()
      changed = true
    }
    if (changed) this.changed()
    if (!this.holder && this.waiters.length === 0) this.stopSweeping()
  }

  dispose(): void {
    this.stopSweeping()
    for (const waiter of this.waiters.splice(0)) waiter.done(this.refusal('aborted', null))
    this.holder = null
  }

  private holderOwner(): ComputerLeaseOwner | null {
    return this.holder ? { kind: this.holder.kind, id: this.holder.id, name: this.holder.name, runId: this.holder.runId } : null
  }

  private grant(owner: ComputerLeaseOwner): void {
    const at = this.now()
    const fresh = this.holder?.runId !== owner.runId
    this.holder = fresh ? { ...owner, since: at, lastActive: at } : { ...this.holder!, lastActive: at }
    this.startSweeping()
    if (fresh) this.changed()
  }

  /** The longest-waiting run that is still going gets the computer. */
  private next(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      if (!this.isRunning(waiter.owner.runId)) {
        waiter.done(this.refusal('aborted', null))
        continue
      }
      const at = this.now()
      this.holder = { ...waiter.owner, since: at, lastActive: at }
      waiter.done({ ok: true, waited: true })
      return
    }
  }

  private dropWaiter(waiter: Waiter): void {
    const at = this.waiters.indexOf(waiter)
    if (at >= 0) this.waiters.splice(at, 1)
  }

  /** A run that is stopped lets go at once, rather than at the next sweep. */
  private watch(runId: string, signal?: AbortSignal): void {
    if (!signal || this.watched.has(runId)) return
    this.watched.add(runId)
    signal.addEventListener('abort', () => this.release(runId), { once: true })
  }

  private refusal(reason: 'busy' | 'timeout' | 'revoked' | 'aborted', holder: ComputerLeaseOwner | null): LeaseResult {
    const who = holder ? ownerLabel(holder) : 'another agent'
    const text =
      reason === 'revoked'
        ? REVOKED_TEXT
        : reason === 'aborted'
          ? 'Stopped by the user.'
          : `${reason === 'timeout' ? `Waited ${Math.round(this.waitMs / 1000)} s for the computer, but ${who} is still using it` : `${who[0].toUpperCase()}${who.slice(1)} is using the computer right now`}. There is one mouse and keyboard, so only one agent can use them at a time. Do what doesn't need the screen meanwhile (web pages can go through your own browser, web_browser), then try again; if you can't go on without it, say so.`
    return { ok: false, reason, holder, text }
  }

  private changed(): void {
    const state = this.state()
    for (const listener of this.listeners) {
      try {
        listener(state)
      } catch {
        /* a listener's failure is its own */
      }
    }
  }

  private startSweeping(): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => this.sweep(), this.sweepMs)
    this.sweeper.unref?.()
  }

  private stopSweeping(): void {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
  }
}
