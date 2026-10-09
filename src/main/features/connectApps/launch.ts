import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../eaonCode/locate'
import { cmdKeepOpenArgs, launchDetached, openLinuxTerminal, shellQuote } from '../eaonCode/terminal'

/**
 * Opening an app in the user's terminal with Eaon's settings in its
 * environment, for apps that only read environment variables (Copilot CLI,
 * Poolside) and as a shortcut for the rest.
 *
 * The variables go in a small script in Eaon's data folder, which the
 * terminal runs, rather than on the command line Terminal types: that keeps
 * the key out of the shell's history and out of AppleScript quoting.
 */

export interface LaunchSpec {
  env: Record<string, string>
  /** The program to run, as typed in a shell; null opens a shell with the variables set. */
  command: string | null
}

/** The script's text: POSIX `sh` everywhere but Windows, a batch file there. */
export function launchScript(spec: LaunchSpec, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    const lines = ['@echo off', ...Object.entries(spec.env).map(([key, value]) => `set "${key}=${value.replace(/"/g, '')}"`)]
    if (spec.command) lines.push(spec.command)
    return `${lines.join('\r\n')}\r\n`
  }
  const lines = [
    '#!/bin/sh',
    '# Written by Eaon (Settings → Connect apps) each time it opens an app here.',
    ...Object.entries(spec.env).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    // A shell with the variables set, when there is no app to run, or once the app exits.
    spec.command ? `${spec.command}\nexec "\${SHELL:-/bin/sh}" -i` : 'exec "${SHELL:-/bin/sh}" -i'
  ]
  return `${lines.join('\n')}\n`
}

/** Writes the script for `name` into `dir` (readable by the user only) and returns its path. */
export function writeLaunchScript(dir: string, name: string, spec: LaunchSpec, platform: NodeJS.Platform): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, platform === 'win32' ? `${name}.cmd` : `${name}.sh`)
  writeFileSync(path, launchScript(spec, platform), { encoding: 'utf8', mode: 0o700 })
  if (platform !== 'win32') chmodSync(path, 0o700)
  return path
}

/** Escape for an AppleScript string literal. */
const appleString = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** Opens a new terminal window running the script. */
export async function openTerminal(script: string, title: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (process.platform === 'darwin') {
    const result = await run('/usr/bin/osascript', [
      '-e',
      `tell application "Terminal" to do script ${appleString(`clear; sh ${shellQuote(script)}`)}`,
      '-e',
      'tell application "Terminal" to activate'
    ])
    return result.ok ? { ok: true } : { ok: false, error: result.stderr.trim() || result.error || 'Terminal did not open.' }
  }

  if (process.platform === 'win32') {
    // A user folder with a space or a bracket in its name needs the script quoted past cmd /k.
    const error = await launchDetached('cmd.exe', cmdKeepOpenArgs(title, [script]), { windowsVerbatimArguments: true })
    return error ? { ok: false, error: `The terminal did not open: ${error}` } : { ok: true }
  }

  return openLinuxTerminal(['sh', script])
}
