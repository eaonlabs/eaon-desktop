import { randomUUID } from 'node:crypto'
import { parseSavedPrompts, removePrompt, savePrompt, type PromptChange, type SavedPrompt } from '@shared/savedPrompts'
import { store } from '../store'
import type { Feature } from './types'

/**
 * The prompt library (shared/savedPrompts.ts) in `saved-prompts.json`.
 *
 * Channels (all `prompts:`): `list`, `save`, `delete`, and the `changed`
 * event, which carries the whole list so every window shows the same one.
 */

const FILE = 'saved-prompts.json'

let cached: SavedPrompt[] | null = null
let announce: (channel: string, ...args: unknown[]) => void = () => undefined

export function listSavedPrompts(): SavedPrompt[] {
  cached ??= parseSavedPrompts(store.getJson<unknown>(FILE, null))
  return cached
}

/** Tests: forget the copy in memory so the next read comes from the file. */
export function resetSavedPromptsForTests(): void {
  cached = null
}

function keep(list: SavedPrompt[]): SavedPrompt[] {
  cached = list
  store.setJson(FILE, list)
  announce('prompts:changed', list)
  return list
}

export function saveSavedPrompt(input: unknown): PromptChange {
  const value = (input && typeof input === 'object' ? input : {}) as { id?: unknown; name?: unknown; text?: unknown }
  const result = savePrompt(listSavedPrompts(), { id: typeof value.id === 'string' ? value.id : undefined, name: value.name, text: value.text }, randomUUID, Date.now())
  if (result.ok) keep(result.list)
  return result
}

export const deleteSavedPrompt = (id: unknown): SavedPrompt[] => keep(removePrompt(listSavedPrompts(), typeof id === 'string' ? id : ''))

export const savedPromptsFeature: Feature = {
  id: 'saved-prompts',
  register: ({ ipcMain, send }) => {
    announce = send
    ipcMain.handle('prompts:list', (): SavedPrompt[] => listSavedPrompts())
    ipcMain.handle('prompts:save', (_e, input: unknown): PromptChange => saveSavedPrompt(input))
    ipcMain.handle('prompts:delete', (_e, id: unknown): SavedPrompt[] => deleteSavedPrompt(id))
  },
  dispose: () => {
    announce = () => undefined
  }
}
