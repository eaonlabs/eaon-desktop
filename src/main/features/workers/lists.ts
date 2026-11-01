import { randomUUID } from 'node:crypto'
import type { HouseholdList, HouseholdListItem } from '@shared/workerLists'
import { MAX_LISTS, MAX_LIST_ITEMS } from '@shared/workerLists'

/**
 * Shared lists — groceries, supplies, chores — that Eaon keeps itself, so
 * every worker linked to them and the user see the same list: one worker
 * adds milk, another fills a cart from it, the user ticks things off on the
 * card in a thread. Kept in one file; `onChange` tells the windows.
 */

export interface ListsDeps {
  load: () => unknown
  save: (lists: HouseholdList[]) => void
  onChange?: (lists: HouseholdList[]) => void
  now?: () => number
}

export type ListEdit =
  | { action: 'add'; items: string[] }
  | { action: 'remove'; items: string[] }
  | { action: 'check'; items: string[] }
  | { action: 'uncheck'; items: string[] }
  | { action: 'clear_done' }

const clean = (text: unknown, max = 120): string => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, max) : '')

function normalize(raw: unknown): HouseholdList[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((l): l is HouseholdList => !!l && typeof l.id === 'string' && typeof l.name === 'string')
    .map((l) => ({
      id: l.id,
      name: clean(l.name, 60) || 'List',
      updatedAt: typeof l.updatedAt === 'number' ? l.updatedAt : 0,
      items: (Array.isArray(l.items) ? l.items : [])
        .filter((i): i is HouseholdListItem => !!i && typeof i.id === 'string' && typeof i.text === 'string')
        .map((i) => ({ id: i.id, text: clean(i.text), done: i.done === true, by: clean(i.by, 60) || 'You', at: typeof i.at === 'number' ? i.at : 0 }))
        .slice(0, MAX_LIST_ITEMS)
    }))
    .slice(0, MAX_LISTS)
}

export function createLists(deps: ListsDeps) {
  const now = deps.now ?? Date.now
  let lists = normalize(deps.load())
  const commit = (): void => {
    deps.save(lists)
    deps.onChange?.(structuredClone(lists))
  }
  const find = (nameOrId: string): HouseholdList | undefined => {
    const key = nameOrId.trim().toLowerCase()
    return lists.find((l) => l.id === nameOrId) ?? lists.find((l) => l.name.toLowerCase() === key)
  }
  /** Items matching `text`: the same words, ignoring case, else ones that contain them. */
  const matching = (list: HouseholdList, text: string): HouseholdListItem[] => {
    const key = text.trim().toLowerCase()
    const exact = list.items.filter((i) => i.text.toLowerCase() === key || i.id === text)
    return exact.length > 0 ? exact : list.items.filter((i) => i.text.toLowerCase().includes(key))
  }

  return {
    all(): HouseholdList[] {
      return structuredClone(lists)
    },
    /** Every list at once, as they came back with the workers from a worker computer (or went there). */
    replace(raw: unknown): void {
      lists = normalize(raw)
      commit()
    },
    get(nameOrId: string): HouseholdList | null {
      const list = find(nameOrId)
      return list ? structuredClone(list) : null
    },
    /** A list by name, made when there isn't one yet ("Groceries"). */
    ensure(name: string): HouseholdList {
      const title = clean(name, 60)
      if (!title) throw new Error('Give the list a name.')
      const existing = find(title)
      if (existing) return structuredClone(existing)
      if (lists.length >= MAX_LISTS) throw new Error(`There can be up to ${MAX_LISTS} lists. Remove one first.`)
      const list: HouseholdList = { id: randomUUID(), name: title, items: [], updatedAt: now() }
      lists.push(list)
      commit()
      return structuredClone(list)
    },
    remove(nameOrId: string): void {
      const list = find(nameOrId)
      if (!list) return
      lists = lists.filter((l) => l !== list)
      commit()
    },
    /** Applies one edit; `by` is who made it ("You", a worker's name). Says what changed. */
    edit(nameOrId: string, edit: ListEdit, by: string): { list: HouseholdList; changed: string } {
      const list = find(nameOrId)
      if (!list) throw new Error(`There is no list called "${nameOrId}". Lists: ${lists.map((l) => l.name).join(', ') || 'none yet'}.`)
      const at = now()
      const done: string[] = []
      if (edit.action === 'clear_done') {
        const before = list.items.length
        list.items = list.items.filter((i) => !i.done)
        done.push(`cleared ${before - list.items.length} ticked item${before - list.items.length === 1 ? '' : 's'}`)
      } else {
        for (const raw of edit.items) {
          const text = clean(raw)
          if (!text) continue
          if (edit.action === 'add') {
            const already = list.items.find((i) => i.text.toLowerCase() === text.toLowerCase())
            if (already) {
              if (already.done) {
                already.done = false
                done.push(`put ${already.text} back`)
              }
              continue
            }
            if (list.items.length >= MAX_LIST_ITEMS) throw new Error(`${list.name} is full (${MAX_LIST_ITEMS} items). Clear what's done first.`)
            list.items.push({ id: randomUUID(), text, done: false, by, at })
            done.push(`added ${text}`)
            continue
          }
          const hits = matching(list, text)
          if (hits.length === 0) {
            done.push(`no "${text}" on it`)
            continue
          }
          for (const item of hits) {
            if (edit.action === 'remove') list.items = list.items.filter((i) => i !== item)
            else item.done = edit.action === 'check'
          }
          done.push(`${edit.action === 'remove' ? 'removed' : edit.action === 'check' ? 'ticked' : 'unticked'} ${hits.map((h) => h.text).join(', ')}`)
        }
      }
      list.updatedAt = at
      commit()
      return { list: structuredClone(list), changed: done.join('; ') || 'nothing changed' }
    },
    /** The user ticking an item on a card, by id. */
    toggle(listId: string, itemId: string, doneNow: boolean): void {
      const list = find(listId)
      const item = list?.items.find((i) => i.id === itemId)
      if (!list || !item) return
      item.done = doneNow
      list.updatedAt = now()
      commit()
    }
  }
}

export type Lists = ReturnType<typeof createLists>

/** A list as the model reads it. */
export function listText(list: HouseholdList): string {
  if (list.items.length === 0) return `${list.name} (list_id ${list.id}): empty.`
  const open = list.items.filter((i) => !i.done)
  const ticked = list.items.filter((i) => i.done)
  return [
    `${list.name} (list_id ${list.id}):`,
    ...open.map((i) => `- [ ] ${i.text}`),
    ...ticked.map((i) => `- [x] ${i.text}`)
  ].join('\n')
}
