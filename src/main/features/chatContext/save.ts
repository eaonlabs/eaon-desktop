import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { mentionFileName } from '@shared/chatContext'

/** Where text mentions are kept: beside pasted text, under the app's data rather than a temp folder. */
const mentionsFolder = (): string => join(app.getPath('userData'), 'Pasted')

/** The most a saved mention may hold (the diff's own cap, a little over). */
const SAVE_MAX = 600_000

/** Saves `text` as a file the message attaches, named so the chip says what it is. */
export async function saveMention(label: string, ext: string, text: string): Promise<string> {
  if (!text.trim()) throw new Error('There was nothing to attach.')
  if (text.length > SAVE_MAX) throw new Error('That is too large to attach.')
  const folder = mentionsFolder()
  await mkdir(folder, { recursive: true })
  const path = join(folder, mentionFileName(label, ext))
  await writeFile(path, text, 'utf8')
  return path
}
