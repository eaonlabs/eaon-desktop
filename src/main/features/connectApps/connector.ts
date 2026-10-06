import { existsSync } from 'node:fs'
import type { ConnectAppId, ConnectChoice, ConnectKind, ConnectWritten } from '@shared/connectApps'
import type { GatewayInfo } from '@shared/gateway'
import { deletePath, getPath, readJson, setPath, writeJson, writeJsonBack, type Json } from './files'
import { sameValue, type AppRecord, type KeyRecord } from './state'

/** Everything a connector needs, so tests can point it at a temporary home folder. */
export interface ConnectContext {
  home: string
  info: GatewayInfo
  platform: NodeJS.Platform
  /** `which`, over the login shell's PATH. */
  which: (bin: string) => string | null
  /** Runs a program and returns its stdout; rejects with its stderr. */
  run?: (command: string, args: string[], input?: string) => Promise<string>
}

/** The gateway model's display label, for apps that show a name next to the id. */
export function modelLabel(info: GatewayInfo, id: string): string {
  return info.models.find((m) => m.id === id)?.label ?? id
}

/** The models an app should list: the default first, then the others picked, each once. */
export function listed(choice: ConnectChoice): string[] {
  return [...new Set([choice.model, ...(choice.models ?? [])])]
}

export interface ConnectOutcome {
  record: AppRecord
  written: ConnectWritten[]
}

export interface Connector {
  id: ConnectAppId
  name: string
  kind: ConnectKind
  blurb: string
  hasSmallModel: boolean
  /** The app keeps a list of models (a picker, a /models menu), so any number can be connected. */
  multiModel?: boolean
  /** A Mac desktop app, by its name in /Applications, that Eaon can quit and reopen to load the change. */
  desktopApp?: string
  installHint?: string
  /** Shown after connecting. */
  note?: string
  /** Files it writes (absolute). */
  files: (ctx: ConnectContext) => string[]
  /** Those of `files` that are Eaon's own, rewritten whole, so never refused for what's in them. */
  owned?: (ctx: ConnectContext) => string[]
  installed: (ctx: ConnectContext) => boolean
  /** Whether Eaon's settings are in the app's config, and whether they match the gateway now. */
  inspect?: (
    ctx: ConnectContext,
    record: AppRecord | null
  ) => { connected: boolean; stale: boolean; model?: string | null; models?: string[] }
  connect?: (ctx: ConnectContext, choice: ConnectChoice, previous: AppRecord | null) => Promise<ConnectOutcome> | ConnectOutcome
  disconnect?: (ctx: ConnectContext, record: AppRecord) => Promise<void> | void
  /** The program and environment to open in a terminal (launch apps, and config apps that start from one). */
  launch?: (ctx: ConnectContext, choice: ConnectChoice) => { env: Record<string, string>; command: string | null }
  /** What to paste or set by hand. */
  manual: (ctx: ConnectContext, choice: ConnectChoice) => string
}

export const exists = (path: string): boolean => existsSync(path)

/**
 * Writes `values` (key path → value) into a JSON file, recording for each key
 * what was there before. A key already recorded keeps its original "before":
 * connecting twice must not make Eaon's own first value the thing restored.
 */
export function ownJsonKeys(
  ctx: ConnectContext,
  file: string,
  values: [string[], unknown][],
  previous: KeyRecord[] | undefined
): { records: KeyRecord[]; written: ConnectWritten } {
  const data = readJson(file, ctx.home)
  const records: KeyRecord[] = []
  for (const [path, value] of values) {
    const old = previous?.find((r) => sameValue(r.path, path))
    const current = getPath(data, path)
    records.push(
      old
        ? { ...old, wrote: value }
        : current === undefined
          ? { path, had: false, wrote: value }
          : { path, had: true, before: current, wrote: value }
    )
    setPath(data, path, value)
  }
  // Keys Eaon owned last time but doesn't write now go back as well.
  for (const old of previous ?? []) {
    if (!records.some((r) => sameValue(r.path, old.path))) restoreKey(data, old)
  }
  writeJson(file, data)
  return { records, written: { path: file, keys: values.map(([path]) => path.join('.')) } }
}

function restoreKey(data: Json, record: KeyRecord): void {
  // Changed by the user since: theirs now.
  if (!sameValue(getPath(data, record.path), record.wrote)) return
  if (record.had) setPath(data, record.path, record.before)
  else deletePath(data, record.path)
}

/** Puts back every key Eaon owned in a JSON file, unless the user has changed it since. */
export function releaseJsonKeys(ctx: ConnectContext, file: string, records: KeyRecord[] | undefined): void {
  if (!records?.length || !existsSync(file)) return
  const data = readJson(file, ctx.home)
  for (const record of records) restoreKey(data, record)
  writeJsonBack(file, data)
}

/** Every `[path, value]` pair still matches the file: connected, and connected to this gateway. */
export function jsonMatches(ctx: ConnectContext, file: string, values: [string[], unknown][]): boolean {
  try {
    const data = readJson(file, ctx.home)
    return values.every(([path, value]) => sameValue(getPath(data, path), value))
  } catch {
    return false
  }
}

/** Shell `export` lines for the copy-paste fallback. */
export function exportLines(env: Record<string, string>, platform: NodeJS.Platform): string {
  return Object.entries(env)
    .map(([key, value]) => (platform === 'win32' ? `set ${key}=${value}` : `export ${key}=${JSON.stringify(value)}`))
    .join('\n')
}
