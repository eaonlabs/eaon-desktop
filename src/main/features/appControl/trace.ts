import type { AppControlTraceEntry } from '@shared/appControl'

/**
 * What app control did lately, for Settings → App control and the `trace`
 * command: who ran which command on what, and how it went. In memory only,
 * and never what was typed: an entry says "type into textfield “To” in
 * Mail", not the words.
 */

const KEPT = 300

export class AppControlTrace {
  private entries: AppControlTraceEntry[] = []
  private nextId = 1
  private readonly listeners = new Set<(entry: AppControlTraceEntry) => void>()

  add(entry: Omit<AppControlTraceEntry, 'id'>): AppControlTraceEntry {
    const full = { ...entry, id: this.nextId++ }
    this.entries.push(full)
    if (this.entries.length > KEPT) this.entries = this.entries.slice(-KEPT)
    for (const listener of this.listeners) listener(full)
    return full
  }

  /** Newest first. */
  recent(limit = 50): AppControlTraceEntry[] {
    return this.entries.slice(-limit).reverse()
  }

  clear(): void {
    this.entries = []
  }

  onEntry(listener: (entry: AppControlTraceEntry) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
