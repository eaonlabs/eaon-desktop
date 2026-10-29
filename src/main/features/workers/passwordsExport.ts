import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Bringing in what Apple's Passwords app holds, as nearly by itself as macOS
 * allows. Passwords has no way for another app to read it, and its passkeys
 * never leave it for anything but another password manager. What it can do is
 * export every login and 2FA code to a file. So Eaon opens Passwords, the user
 * picks File → Export All Passwords to File… and saves it anywhere usual, and
 * Eaon notices the file, imports it and moves it to the Trash (it isn't
 * encrypted).
 */

/** The first line of a Passwords export (Safari's from before Passwords was an app too). */
const APPLE_EXPORT = /^﻿?"?Title"?,"?URL"?,"?Username"?,"?Password"?/i
/** Where the export's save panel puts it unless told otherwise. */
export const EXPORT_FOLDERS = (): string[] => ['Downloads', 'Desktop', 'Documents'].map((dir) => join(homedir(), dir))
const LOOK_EVERY_MS = 1000
const WAIT_MS = 10 * 60_000

/** Passwords (macOS 15+), else the Passwords pane of System Settings (macOS 14). */
export function openPasswords(): Promise<void> {
  return new Promise((resolve) => {
    execFile('open', ['-b', 'com.apple.Passwords'], (error) => {
      if (!error) return resolve()
      execFile('open', ['x-apple.systempreferences:com.apple.Passwords-Settings.extension'], () => resolve())
    })
  })
}

/** A Passwords export saved in `folders` since `since` (ms), and its text; null when there's none yet. */
export async function findPasswordsExport(folders: string[], since: number): Promise<{ file: string; text: string } | null> {
  for (const folder of folders) {
    let names: string[]
    try {
      names = await readdir(folder)
    } catch {
      continue
    }
    for (const name of names) {
      if (!/\.csv$/i.test(name)) continue
      const file = join(folder, name)
      try {
        const info = await stat(file)
        // Still being written: the next look gets it whole.
        if (!info.isFile() || info.mtimeMs < since || Date.now() - info.mtimeMs < 500) continue
        const text = await readFile(file, 'utf8')
        if (APPLE_EXPORT.test(text)) return { file, text }
      } catch {
        /* gone, or not readable: not it */
      }
    }
  }
  return null
}

/**
 * Waits for the export (WAIT_MS at most) and hands it to `found` once. One
 * wait at a time: starting again replaces the last.
 */
export function waitForPasswordsExport(found: (file: string, text: string) => void, options: { folders?: string[]; since?: number } = {}): { stop: () => void } {
  const folders = options.folders ?? EXPORT_FOLDERS()
  const since = options.since ?? Date.now() - 1000
  const started = Date.now()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const look = async (): Promise<void> => {
    if (stopped) return
    const hit = await findPasswordsExport(folders, since).catch(() => null)
    if (stopped) return
    if (hit) {
      stopped = true
      found(hit.file, hit.text)
      return
    }
    if (Date.now() - started > WAIT_MS) {
      stopped = true
      return
    }
    timer = setTimeout(() => void look(), LOOK_EVERY_MS)
  }
  void look()
  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }
}
