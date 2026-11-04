import type { AppInfo } from '@shared/appControl'
import { failure } from './protocol'

/**
 * Refs: `@<snapshot>:e<n>`, element n of one read of an app's interface. The
 * snapshot id is part of every ref, so an action always names the read it was
 * decided on, and a ref from a read that has been dropped fails as stale
 * rather than landing on whatever now sits in that slot.
 *
 * The engine holds the elements themselves; this keeps what Eaon needs to
 * know about each without asking it again — which app it belongs to (for the
 * protected-app check), what to call it in an approval or the activity list,
 * and whether it's a password field.
 */

export interface RefSummary {
  role: string
  name?: string
  secure?: boolean
  bounds?: [number, number, number, number]
}

interface SnapshotEntry {
  app: AppInfo
  epoch: number
  nodes: Map<number, RefSummary>
}

export interface ParsedRef {
  sid: string
  n: number
}

const REF = /^@?(s[a-z0-9]{3,16}):e([1-9]\d{0,6})$/

export function formatRef(sid: string, n: number): string {
  return `@${sid}:e${n}`
}

/** Parses `@s1abc:e12` (the @ may be left off). Throws BAD_REF otherwise. */
export function parseRef(value: unknown): ParsedRef {
  const text = typeof value === 'string' ? value.trim() : ''
  const match = REF.exec(text)
  if (!match) {
    throw failure('BAD_REF', text ? `"${text}" isn't a ref. Refs look like @s4k2p9xq:e12 and come from snapshot, find or list-windows.` : 'A ref is required.')
  }
  return { sid: match[1], n: Number(match[2]) }
}

export function looksLikeRef(value: unknown): boolean {
  return typeof value === 'string' && REF.test(value.trim())
}

/** As many as the engines keep; older refs are stale on both sides. */
const KEPT = 48

export class RefStore {
  private readonly snapshots = new Map<string, SnapshotEntry>()

  add(sid: string, app: AppInfo, epoch: number): Map<number, RefSummary> {
    const nodes = new Map<number, RefSummary>()
    this.snapshots.delete(sid)
    this.snapshots.set(sid, { app, epoch, nodes })
    while (this.snapshots.size > KEPT) this.snapshots.delete(this.snapshots.keys().next().value as string)
    return nodes
  }

  /** The snapshot a ref belongs to; STALE_REF when it's unknown or from before the engine restarted. */
  entry(ref: ParsedRef, epoch: number): SnapshotEntry {
    const entry = this.snapshots.get(ref.sid)
    if (!entry || entry.epoch !== epoch) {
      throw failure('STALE_REF', `${formatRef(ref.sid, ref.n)} is from a snapshot that's gone.`, 'Take a new snapshot and use its refs.')
    }
    return entry
  }

  summary(ref: ParsedRef): RefSummary | undefined {
    return this.snapshots.get(ref.sid)?.nodes.get(ref.n)
  }

  appOf(ref: ParsedRef): AppInfo | undefined {
    return this.snapshots.get(ref.sid)?.app
  }

  clear(): void {
    this.snapshots.clear()
  }
}

/** How an element is named in an approval or the activity list: `button "Save" in TextEdit`. */
export function labelOf(summary: RefSummary | undefined, app: AppInfo | undefined): string {
  const what = summary ? `${summary.role}${summary.name ? ` “${clip(summary.name, 40)}”` : ''}` : 'an element'
  return app ? `${what} in ${app.name}` : what
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
