import type { AppControlCommandGroup, AppControlCommandInfo, AppInfo, UiNode } from '@shared/appControl'
import { parseCombo } from '../computer/keys'
import { failure, AppControlFailure, type AppControlEngine, type RawActResult, type RawApp, type RawNode, type RawSnapshot, type RawStatus } from './protocol'
import { clip, formatRef, labelOf, looksLikeRef, parseRef, type ParsedRef, type RefStore, type RefSummary } from './refs'
import { assertAllowed, assertNotSecret, protectedEntry } from './safety'
import { capNodes, convertOne, convertTree, flatten, interactiveOnly, nodeMatches, summaryOf, treeHasText, treeText, type FindQuery } from './tree'

/**
 * The commands, one table for every way in: Eaon's own agents (tool.ts),
 * coding agents in the ADE (`eaon-apps`, and Eaon's MCP server for Claude
 * Code), and the Settings page's try-it panel. Each reads its arguments,
 * talks to the engine and returns plain data; service.ts wraps that in the
 * envelope, checks the switches and records the activity.
 *
 * The loop an agent runs: observe (snapshot, find), act on a ref (click,
 * type, select…), verify (each action returns the element as it is now;
 * wait checks for what should follow). A successful action is not proof the
 * interface changed.
 */

export interface DisplayInfo {
  id: number
  primary: boolean
  bounds: [number, number, number, number]
  workArea: [number, number, number, number]
  scale: number
}

export interface CommandContext {
  engine: AppControlEngine
  refs: RefStore
  /** Eaon's own processes, which are never read or acted on. */
  ownPids: ReadonlySet<number>
  platform: NodeJS.Platform
  clipboard: { readText: () => string; writeText: (text: string) => void; clear: () => void; hasImage: () => boolean }
  displays: () => DisplayInfo[]
  sleep: (ms: number) => Promise<void>
  signal?: AbortSignal
  /** Runs one command of a batch through the service (switches, activity). */
  runStep: (command: string, args: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: unknown }>
  status: () => Promise<unknown>
  guide: () => string
  trace: (limit: number) => unknown
  version: () => Promise<unknown>
  /** Filled in by the command: what it acted on, for the activity list and the outline. */
  target: { label: string | null; bounds?: [number, number, number, number] }
}

type Args = Record<string, unknown>

export interface CommandDef extends AppControlCommandInfo {
  /** `eaon-apps` positional arguments, in order; the last takes what's left. */
  positional?: string[]
  /** CLI flags that take no value. */
  flags?: string[]
  run: (args: Args, ctx: CommandContext) => Promise<unknown>
}

/* -------------------------------------------------------------- arguments */

function str(args: Args, key: string, required: true): string
function str(args: Args, key: string, required?: false): string | undefined
function str(args: Args, key: string, required = false): string | undefined {
  const value = args[key]
  if (typeof value === 'string' && value.trim() !== '') return value
  if (typeof value === 'number') return String(value)
  if (required) throw failure('INVALID_ARGS', `\`${key}\` is required.`)
  return undefined
}

function num(args: Args, key: string, fallback: number, min: number, max: number): number {
  const raw = args[key]
  if (raw === undefined || raw === null || raw === '') return fallback
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) throw failure('INVALID_ARGS', `\`${key}\` must be a number.`)
  return Math.min(max, Math.max(min, value))
}

function optNum(args: Args, key: string): number | undefined {
  const raw = args[key]
  if (raw === undefined || raw === null || raw === '') return undefined
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) throw failure('INVALID_ARGS', `\`${key}\` must be a number.`)
  return value
}

const bool = (args: Args, key: string): boolean => args[key] === true || args[key] === 'true' || args[key] === 1

function list(args: Args, key: string): string[] | undefined {
  const value = args[key]
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean)
  if (typeof value === 'string' && value.trim()) return value.split(',').map((s) => s.trim()).filter(Boolean)
  return undefined
}

/* ------------------------------------------------------------------- apps */

const appOf = (raw: RawApp): AppInfo => ({ pid: raw.pid, name: raw.name, bundleId: raw.bundleId, path: raw.path, active: raw.active, hidden: raw.hidden })

async function runningApps(ctx: CommandContext, all = false): Promise<AppInfo[]> {
  return (await ctx.engine.call<RawApp[]>('apps', { all })).map(appOf)
}

const fold = (text: string): string => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()

/** An app by pid, bundle id or name (exact, then the start of a name, then anywhere in it). */
export function pickApp(apps: AppInfo[], wanted: string): AppInfo {
  const text = wanted.trim()
  if (/^\d+$/.test(text)) {
    const byPid = apps.find((app) => app.pid === Number(text))
    if (byPid) return byPid
    throw failure('APP_NOT_FOUND', `No app with pid ${text} is running.`)
  }
  const want = fold(text.replace(/\.app$/i, ''))
  const tiers = [
    apps.filter((app) => app.bundleId && fold(app.bundleId) === want),
    apps.filter((app) => fold(app.name) === want),
    apps.filter((app) => fold(app.name).startsWith(want)),
    apps.filter((app) => fold(app.name).includes(want))
  ]
  for (const tier of tiers) {
    const unique = [...new Map(tier.map((app) => [app.pid, app])).values()]
    if (unique.length === 1) return unique[0]
    if (unique.length > 1) {
      throw failure('APP_NOT_FOUND', `"${text}" matches more than one app: ${unique.slice(0, 8).map((app) => `${app.name} (pid ${app.pid})`).join(', ')}.`, 'Name it exactly, or pass its pid.')
    }
  }
  const names = apps.map((app) => app.name).slice(0, 25).join(', ')
  throw failure('APP_NOT_FOUND', `No running app called "${text}".`, `Running: ${names}. Start one with launch.`)
}

async function resolveApp(ctx: CommandContext, args: Args, key = 'app'): Promise<AppInfo> {
  const wanted = str(args, key)
  if (!wanted) throw failure('INVALID_ARGS', `\`${key}\` is required: an app's name, bundle id or pid.`)
  const app = pickApp(await runningApps(ctx, true), wanted)
  assertAllowed(app, ctx.ownPids)
  return app
}

interface Resolved {
  ref: ParsedRef
  app: AppInfo
  summary: RefSummary | undefined
}

function resolveRef(ctx: CommandContext, args: Args, key = 'ref'): Resolved {
  const ref = parseRef(args[key])
  const entry = ctx.refs.entry(ref, ctx.engine.epoch)
  assertAllowed(entry.app, ctx.ownPids)
  const summary = ctx.refs.summary(ref)
  ctx.target = { label: labelOf(summary, entry.app), bounds: summary?.bounds }
  return { ref, app: entry.app, summary }
}

/** Remembers elements an engine returned outside a snapshot (windows, surfaces, focus). */
function registerNodes(ctx: CommandContext, app: AppInfo, sid: string, raws: RawNode[]): UiNode[] {
  const store = ctx.refs.add(sid, app, ctx.engine.epoch)
  return raws.map((raw) => {
    const node = convertOne(raw, sid, ctx.platform)
    store.set(raw.n, summaryOf(node, raw))
    return node
  })
}

/* -------------------------------------------------------------- snapshots */

interface SnapshotRequest {
  app?: AppInfo
  root?: ParsedRef
  scope?: 'window' | 'app' | 'menubar'
  depth?: number
  maxNodes?: number
  skipMenuBar?: boolean
  ephemeral?: boolean
}

interface Taken {
  sid: string
  app: AppInfo
  tree: UiNode
  count: number
  truncated: boolean
}

async function snapshot(ctx: CommandContext, req: SnapshotRequest): Promise<Taken> {
  const params: Args = { depth: req.depth ?? 30, maxNodes: req.maxNodes ?? 4000 }
  let app = req.app
  if (req.root) {
    const entry = ctx.refs.entry(req.root, ctx.engine.epoch)
    app = entry.app
    params.sid = req.root.sid
    params.n = req.root.n
  } else {
    if (!app) throw failure('INVALID_ARGS', '`app` is required.')
    params.pid = app.pid
    params.scope = req.scope ?? 'window'
    if (req.skipMenuBar) params.skipMenuBar = true
  }
  if (req.ephemeral) params.ephemeral = true
  assertAllowed(app!, ctx.ownPids)
  const raw = await ctx.engine.call<RawSnapshot>('snapshot', params, 30_000)
  const { node, summaries } = convertTree(raw.tree, raw.sid, ctx.platform)
  if (!req.ephemeral) {
    const store = ctx.refs.add(raw.sid, app!, ctx.engine.epoch)
    for (const [n, summary] of summaries) store.set(n, summary)
  }
  return { sid: raw.sid, app: app!, tree: node, count: raw.count, truncated: raw.truncated }
}

/** A window of an app by ref, by title, or the app's focused one. */
async function resolveWindow(ctx: CommandContext, args: Args): Promise<Resolved> {
  if (args.ref !== undefined || looksLikeRef(args.window)) return resolveRef(ctx, args, args.ref !== undefined ? 'ref' : 'window')
  const app = await resolveApp(ctx, args)
  const raws = await ctx.engine.call<RawNode[]>('windows', { pid: app.pid })
  if (raws.length === 0) throw failure('WINDOW_NOT_FOUND', `${app.name} has no windows open.`)
  const nodes = registerNodes(ctx, app, raws[0].sid!, raws)
  const title = str(args, 'window')
  let index = 0
  if (title) {
    index = nodes.findIndex((node) => fold(node.name ?? '').includes(fold(title)))
    if (index === -1) throw failure('WINDOW_NOT_FOUND', `${app.name} has no window titled "${title}".`, `Its windows: ${nodes.map((n) => `“${n.name ?? ''}”`).join(', ')}.`)
  } else {
    const focused = raws.findIndex((raw) => raw.focused || raw.main)
    index = focused === -1 ? 0 : focused
  }
  const ref = parseRef(nodes[index].ref)
  const summary = ctx.refs.summary(ref)
  ctx.target = { label: labelOf(summary, app), bounds: summary?.bounds }
  return { ref, app, summary }
}

function shape(tree: UiNode, args: Args, defaultLimit: number): { tree?: UiNode; text?: string; shown: number; cut: number } {
  let root: UiNode | null = tree
  if (bool(args, 'interactive')) root = interactiveOnly(tree) ?? { ...tree, children: [] }
  const limit = num(args, 'limit', defaultLimit, 20, 5000)
  const { node, cut } = capNodes(root, limit)
  const shown = flatten(node).length
  if (bool(args, 'compact')) return { text: treeText(node), shown, cut }
  return { tree: node, shown, cut }
}

/* --------------------------------------------------------------- actions */

async function act(ctx: CommandContext, resolved: Resolved, action: string, extra: Args = {}): Promise<{ ref: string; note?: string; after: UiNode | null; gone: boolean }> {
  const { ref, summary } = resolved
  const result = await ctx.engine.call<RawActResult>('act', { sid: ref.sid, n: ref.n, action, ...extra }, 20_000)
  const after = result.after ? convertOne({ ...result.after, n: ref.n }, ref.sid, ctx.platform) : null
  if (after) {
    if (after.bounds) ctx.target.bounds = after.bounds
    // The name may have changed (a button that now says "Stop").
    if (summary) Object.assign(summary, summaryOf(after))
  }
  return { ref: formatRef(ref.sid, ref.n), ...(result.note ? { note: result.note } : {}), after, gone: Boolean(result.gone) }
}

async function read(ctx: CommandContext, resolved: Resolved): Promise<UiNode> {
  const raw = await ctx.engine.call<RawNode>('read', { sid: resolved.ref.sid, n: resolved.ref.n })
  return convertOne({ ...raw, n: resolved.ref.n }, resolved.ref.sid, ctx.platform)
}

/** An action's optional follow-up check (`wait_text`, `wait_window`, `wait_gone`). */
async function followUp(ctx: CommandContext, args: Args, app: AppInfo): Promise<{ waited?: unknown }> {
  const text = str(args, 'wait_text')
  const windowTitle = str(args, 'wait_window')
  if (!text && !windowTitle) return {}
  const timeout = num(args, 'wait_timeout', 8000, 100, 60_000)
  const waited = text
    ? await waitUntil(ctx, timeout, async () => treeHasText((await snapshot(ctx, { app, scope: 'app', skipMenuBar: true, ephemeral: true, maxNodes: 3000 })).tree, text) !== bool(args, 'wait_gone'), `text “${text}”${bool(args, 'wait_gone') ? ' to go' : ''}`)
    : await waitUntil(ctx, timeout, async () => (await windowTitles(ctx, app)).some((t) => fold(t).includes(fold(windowTitle!))) !== bool(args, 'wait_gone'), `window “${windowTitle}”`)
  return { waited }
}

async function windowTitles(ctx: CommandContext, app: AppInfo): Promise<string[]> {
  const raws = await ctx.engine.call<RawNode[]>('windows', { pid: app.pid })
  return raws.map((raw) => raw.title ?? '')
}

async function waitUntil(ctx: CommandContext, timeout: number, check: () => Promise<boolean>, what: string): Promise<{ met: true; ms: number }> {
  const started = Date.now()
  for (;;) {
    if (ctx.signal?.aborted) throw failure('ACTION_FAILED', 'Stopped.')
    let ok = false
    try {
      ok = await check()
    } catch (error) {
      // An element going away mid-wait is an answer, not a failure, for checks that look for it.
      if (!(error instanceof AppControlFailure) || (error.code !== 'STALE_REF' && error.code !== 'ELEMENT_NOT_FOUND' && error.code !== 'WINDOW_NOT_FOUND')) throw error
    }
    if (ok) return { met: true, ms: Date.now() - started }
    if (Date.now() - started >= timeout) throw failure('TIMEOUT', `Waited ${Math.round(timeout / 100) / 10}s for ${what}; it didn't happen.`, 'Take a snapshot to see where things are.')
    await ctx.sleep(Math.min(300, Math.max(50, timeout - (Date.now() - started))))
  }
}

const ELEMENT_STATES = new Set(['exists', 'gone', 'enabled', 'disabled', 'focused', 'checked', 'unchecked', 'mixed', 'selected', 'expanded', 'collapsed', 'visible', 'hidden', 'editable', 'value', 'value-contains', 'name'])

function elementState(node: UiNode | null, predicate: string, value: string | undefined, displays: DisplayInfo[]): boolean {
  if (predicate === 'gone') return node === null
  if (!node) return false
  const has = (state: string): boolean => node.states?.includes(state) ?? false
  switch (predicate) {
    case 'exists':
      return true
    case 'enabled':
      return !has('disabled')
    case 'value':
      return (node.value ?? '') === (value ?? '')
    case 'value-contains':
      return fold(node.value ?? '').includes(fold(value ?? ''))
    case 'name':
      return fold(node.name ?? '').includes(fold(value ?? ''))
    case 'visible':
      return visible(node, displays)
    case 'hidden':
      return !visible(node, displays)
    default:
      return has(predicate)
  }
}

function visible(node: UiNode, displays: DisplayInfo[]): boolean {
  if (!node.bounds || node.states?.includes('minimized')) return false
  const [x, y, w, h] = node.bounds
  if (w <= 0 || h <= 0) return false
  return displays.some(({ bounds: [dx, dy, dw, dh] }) => x < dx + dw && x + w > dx && y < dy + dh && y + h > dy)
}

async function readOrGone(ctx: CommandContext, resolved: Resolved): Promise<UiNode | null> {
  try {
    return await read(ctx, resolved)
  } catch (error) {
    if (error instanceof AppControlFailure && error.code === 'STALE_REF') return null
    throw error
  }
}

/* ----------------------------------------------------------------- menus */

const menuName = (text: string): string => fold(text).replace(/(\.\.\.|…)$/, '').trim()

function findMenuPath(tree: UiNode, path: string[]): { node: UiNode | null; level: number; seen: string[] } {
  let scope: UiNode[] = tree.children ?? []
  let found: UiNode | null = null
  for (let level = 0; level < path.length; level++) {
    const want = menuName(path[level])
    // Items sit inside an unnamed menu container under each title; look through
    // those. A named menu is itself an item with a submenu (GTK's titles are).
    const candidates = scope
      .flatMap((node) => (node.role === 'menu' && !node.name ? node.children ?? [] : [node]))
      .filter((node) => node.role === 'menuitem' || node.role === 'menubaritem' || (node.role === 'menu' && Boolean(node.name)))
    const exact = candidates.find((node) => menuName(node.name ?? '') === want)
    const loose = exact ?? candidates.find((node) => menuName(node.name ?? '').startsWith(want))
    if (!loose) return { node: null, level, seen: candidates.map((node) => node.name ?? '').filter(Boolean) }
    found = loose
    scope = loose.children ?? []
  }
  return { node: found, level: path.length, seen: [] }
}

/* -------------------------------------------------------------- the table */

const def = (group: AppControlCommandGroup, name: string, acts: boolean, usage: string, summary: string, run: CommandDef['run'], extra: Partial<CommandDef> = {}): CommandDef => ({ group, name, acts, usage, summary, run, ...extra })

const refused = (code: 'RESERVED' | 'NEEDS_POINTER', name: string): CommandDef['run'] => async () => {
  if (code === 'RESERVED') throw failure('RESERVED', `${name} is reserved and always refuses: a held key or button could be left stuck down.`, 'Use press for key combos and click for buttons.')
  throw failure('NEEDS_POINTER', `${name} moves the real pointer, which app control never does.`, 'Act on the element by its ref (click, scroll, select), or use computer use for pointer gestures.')
}

export const COMMANDS: CommandDef[] = [
  /* apps and windows */
  def('apps', 'list-apps', false, 'list-apps [--all]', 'Running apps with their pids and bundle ids. --all includes background agents.', async (args, ctx) => {
    const apps = await runningApps(ctx, bool(args, 'all'))
    return { apps: apps.map((app) => ({ ...app, ...(protectedEntry(app, ctx.ownPids) ? { protected: true } : {}) })) }
  }, { flags: ['all'] }),

  def('apps', 'launch', true, 'launch <app> [--activate]', 'Start an app (or find it already running) and wait for its first window. Leaves the app you are using in front unless --activate.', async (args, ctx) => {
    const name = str(args, 'app', true)
    assertAllowed({ pid: -1, name, bundleId: name }, ctx.ownPids)
    const params: Args = { activate: bool(args, 'activate') }
    if (name.includes('/') || name.includes('\\')) params.path = name
    else params.name = name
    const raw = await ctx.engine.call<RawApp>('launch', params, 30_000)
    const app = appOf(raw)
    assertAllowed(app, ctx.ownPids)
    ctx.target = { label: app.name }
    let windows = 0
    if (!bool(args, 'no_wait')) {
      try {
        await waitUntil(ctx, num(args, 'timeout', 8000, 0, 60_000), async () => (windows = (await windowTitles(ctx, app)).length) > 0, `${app.name}'s first window`)
      } catch (error) {
        if (!(error instanceof AppControlFailure) || error.code !== 'TIMEOUT') throw error
      }
    }
    return { app, alreadyRunning: Boolean(raw.alreadyRunning), windows }
  }, { positional: ['app'], flags: ['activate', 'no-wait'] }),

  def('apps', 'quit-app', true, 'quit-app <app> [--force]', 'Quit an app the way its Quit menu would (it may ask to save). --force ends it at once and loses unsaved work.', async (args, ctx) => {
    const app = await resolveApp(ctx, args)
    ctx.target = { label: app.name }
    const result = await ctx.engine.call<{ requested: boolean }>('quit', { pid: app.pid, force: bool(args, 'force') })
    return { app, requested: result.requested }
  }, { positional: ['app'], flags: ['force'] }),

  def('apps', 'list-windows', false, 'list-windows [--app <app>]', 'Windows with refs, titles, bounds and focus. Without --app, every app’s.', async (args, ctx) => {
    if (str(args, 'app')) {
      const app = await resolveApp(ctx, args)
      const raws = await ctx.engine.call<RawNode[]>('windows', { pid: app.pid })
      return { windows: raws.length ? registerNodes(ctx, app, raws[0].sid!, raws).map((node) => ({ ...node, app: app.name })) : [] }
    }
    const apps = new Map((await runningApps(ctx, true)).map((app) => [app.pid, app]))
    const raws = await ctx.engine.call<RawNode[]>('windows', {})
    const bySid = new Map<string, RawNode[]>()
    for (const raw of raws) bySid.set(raw.sid!, [...(bySid.get(raw.sid!) ?? []), raw])
    const windows: unknown[] = []
    for (const [sid, group] of bySid) {
      const app = apps.get(group[0].pid ?? -1)
      if (!app || protectedEntry(app, ctx.ownPids)) continue
      windows.push(...registerNodes(ctx, app, sid, group).map((node) => ({ ...node, app: app.name })))
    }
    return { windows }
  }, { positional: ['app'] }),

  def('apps', 'focus-window', true, 'focus-window <ref> | --app <app> [--window <title>]', 'Bring a window (and its app) to the front, then check the OS says it is.', async (args, ctx) => {
    const resolved = await resolveWindow(ctx, args)
    const result = await act(ctx, resolved, 'focus')
    await ctx.sleep(150)
    const front = await ctx.engine.call<RawApp>('frontmost').catch(() => null)
    return { ...result, focused: front?.pid === resolved.app.pid }
  }, { positional: ['ref'] }),

  def('apps', 'move-window', true, 'move-window <ref> --x <x> --y <y>', 'Move a window to screen coordinates (points, top-left origin).', async (args, ctx) => {
    const resolved = await resolveWindow(ctx, args)
    return act(ctx, resolved, 'setframe', { x: num(args, 'x', 0, -100_000, 100_000), y: num(args, 'y', 0, -100_000, 100_000) })
  }, { positional: ['ref'] }),

  def('apps', 'resize-window', true, 'resize-window <ref> --w <width> --h <height>', 'Set a window’s width and height.', async (args, ctx) => {
    const resolved = await resolveWindow(ctx, args)
    return act(ctx, resolved, 'setframe', { w: num(args, 'w', 800, 50, 100_000), h: num(args, 'h', 600, 50, 100_000) })
  }, { positional: ['ref'] }),

  def('apps', 'minimize', true, 'minimize <ref>', 'Minimize a window.', async (args, ctx) => act(ctx, await resolveWindow(ctx, args), 'minimize'), { positional: ['ref'] }),
  def('apps', 'maximize', true, 'maximize <ref>', 'Maximize (zoom) a window.', async (args, ctx) => act(ctx, await resolveWindow(ctx, args), 'zoom'), { positional: ['ref'] }),
  def('apps', 'restore', true, 'restore <ref>', 'Bring back a minimized or full-screen window.', async (args, ctx) => {
    const resolved = await resolveWindow(ctx, args)
    const node = await read(ctx, resolved)
    return act(ctx, resolved, node.states?.includes('fullscreen') ? 'unfullscreen' : 'unminimize')
  }, { positional: ['ref'] }),
  def('apps', 'close-window', true, 'close-window <ref>', 'Close a window with its close button (the app may ask to save).', async (args, ctx) => act(ctx, await resolveWindow(ctx, args), 'close'), { positional: ['ref'] }),

  /* observing */
  def('observe', 'snapshot', false, 'snapshot --app <app> [-i] [--skeleton] [--root <ref>] [--scope window|app|menubar] [--compact]', 'The accessibility tree as elements with refs. -i keeps what can be operated; --skeleton is a shallow map to drill into with --root.', async (args, ctx) => {
    const root = args.root !== undefined ? parseRef(args.root) : undefined
    const scope = (str(args, 'scope') as SnapshotRequest['scope']) ?? 'window'
    if (!['window', 'app', 'menubar'].includes(scope)) throw failure('INVALID_ARGS', '`scope` is window, app or menubar.')
    let app: AppInfo | undefined
    let windowRoot: ParsedRef | undefined
    if (!root) {
      if (str(args, 'window')) windowRoot = (await resolveWindow(ctx, args)).ref
      else app = await resolveApp(ctx, args)
    }
    const depth = num(args, 'depth', bool(args, 'skeleton') ? 3 : 30, 1, 60)
    const taken = await snapshot(ctx, { app, root: root ?? windowRoot, scope, depth, maxNodes: num(args, 'max_nodes', 4000, 50, 20_000) })
    const shaped = shape(taken.tree, args, bool(args, 'compact') ? 400 : 1500)
    return {
      app: { name: taken.app.name, pid: taken.app.pid },
      snapshot: taken.sid,
      ...(shaped.text !== undefined ? { text: shaped.text } : { tree: shaped.tree }),
      nodes: shaped.shown,
      ...(taken.truncated || shaped.cut > 0 ? { truncated: true, hint: 'Some elements were left out. Snapshot a branch with --root <ref>, or use find.' } : {})
    }
  }, { positional: ['app'], flags: ['interactive', 'skeleton', 'compact'] }),

  def('observe', 'find', false, 'find --app <app> [--role <roles>] [--name <text>] [--text <text>] [--value <text>] [--id <id>] [--state <states>] [--root <ref>]', 'Search an app’s windows for elements by role, name, value, text, id or state. Returns refs.', async (args, ctx) => {
    const query: FindQuery = {
      role: list(args, 'role'),
      name: str(args, 'name'),
      value: str(args, 'value'),
      text: str(args, 'text'),
      id: str(args, 'id'),
      state: list(args, 'state'),
      interactive: bool(args, 'interactive'),
      exact: bool(args, 'exact')
    }
    if (!query.role && query.name === undefined && query.value === undefined && query.text === undefined && query.id === undefined && !query.state) {
      throw failure('INVALID_ARGS', 'Say what to look for: role, name, text, value, id or state.')
    }
    const root = args.root !== undefined ? parseRef(args.root) : undefined
    const taken = root
      ? await snapshot(ctx, { root, depth: 40, maxNodes: 8000 })
      : await snapshot(ctx, { app: await resolveApp(ctx, args), scope: 'app', skipMenuBar: !bool(args, 'menubar'), depth: 40, maxNodes: 8000 })
    const limit = num(args, 'limit', 25, 1, 200)
    const hits = flatten(taken.tree).filter(({ node }) => nodeMatches(node, query))
    return {
      app: { name: taken.app.name, pid: taken.app.pid },
      snapshot: taken.sid,
      total: hits.length,
      matches: hits.slice(0, limit).map(({ node, path }) => {
        const { children: _children, more: _more, ...flat } = node
        return { ...flat, ...(path.length ? { in: path.slice(-3).join(' › ') } : {}) }
      }),
      ...(taken.truncated ? { hint: 'The app is large and the search stopped early; narrow it with --root.' } : {})
    }
  }, { positional: ['app'], flags: ['interactive', 'exact', 'menubar'] }),

  def('observe', 'get', false, 'get <ref> [--property text|value|name|description|bounds|role|states|actions|all]', 'Read one property of an element as it is now.', async (args, ctx) => {
    const resolved = resolveRef(ctx, args)
    const node = await read(ctx, resolved)
    const property = str(args, 'property') ?? 'all'
    switch (property) {
      case 'all':
        return node
      case 'text':
        return { ref: node.ref, text: node.value ?? node.name ?? '' }
      case 'title':
        return { ref: node.ref, name: node.name ?? null }
      case 'states':
        return { ref: node.ref, states: node.states ?? [] }
      case 'value':
      case 'name':
      case 'description':
      case 'bounds':
      case 'role':
      case 'actions':
      case 'placeholder':
      case 'id':
        return { ref: node.ref, [property]: node[property as keyof UiNode] ?? null }
      default:
        throw failure('INVALID_ARGS', '`property` is text, value, name, description, bounds, role, states, actions, placeholder, id or all.')
    }
  }, { positional: ['ref', 'property'] }),

  def('observe', 'is', false, 'is <ref> <visible|enabled|checked|focused|expanded|selected|editable>', 'Check one state of an element: true or false.', async (args, ctx) => {
    const resolved = resolveRef(ctx, args)
    const state = str(args, 'state', true)
    if (!ELEMENT_STATES.has(state)) throw failure('INVALID_ARGS', `\`state\` is one of ${[...ELEMENT_STATES].join(', ')}.`)
    const node = await readOrGone(ctx, resolved)
    return { ref: formatRef(resolved.ref.sid, resolved.ref.n), state, result: elementState(node, state, str(args, 'value'), ctx.displays()) }
  }, { positional: ['ref', 'state'] }),

  def('observe', 'list-surfaces', false, 'list-surfaces --app <app>', 'Sheets, dialogs, menus and popovers the app is showing now.', async (args, ctx) => {
    const app = await resolveApp(ctx, args)
    const raws = await ctx.engine.call<RawNode[]>('surfaces', { pid: app.pid })
    return { surfaces: raws.length ? registerNodes(ctx, app, raws[0].sid!, raws) : [] }
  }, { positional: ['app'] }),

  def('observe', 'focused', false, 'focused [--app <app>]', 'The element with keyboard focus, in one app or wherever it is.', async (args, ctx) => {
    const app = str(args, 'app') ? await resolveApp(ctx, args) : undefined
    const result = await ctx.engine.call<{ sid: string; pid: number; node: RawNode }>('focused', app ? { pid: app.pid } : {})
    const owner = app ?? (await runningApps(ctx, true)).find((candidate) => candidate.pid === result.pid) ?? { pid: result.pid, name: `pid ${result.pid}` }
    assertAllowed(owner, ctx.ownPids)
    const [node] = registerNodes(ctx, owner, result.sid, [result.node])
    return { app: { name: owner.name, pid: owner.pid }, element: node }
  }, { positional: ['app'] }),

  def('observe', 'list-displays', false, 'list-displays', 'Displays with bounds, work area, scale factor and which is primary.', async (_args, ctx) => ({ displays: ctx.displays() })),

  /* interacting */
  def('interact', 'click', true, 'click <ref> [--wait-text <text>]', 'Activate an element with its primary action (press a button, open a menu item, follow a link). Doesn’t move the pointer.', async (args, ctx) => {
    const resolved = resolveRef(ctx, args)
    const result = await act(ctx, resolved, 'press')
    return { ...result, ...(await followUp(ctx, args, resolved.app)) }
  }, { positional: ['ref'] }),

  def('interact', 'double-click', true, 'double-click <ref>', 'Open an element (a file in a list, say) through its open action. Elements without one need computer use.', async (args, ctx) => {
    const resolved = resolveRef(ctx, args)
    return act(ctx, resolved, 'open')
  }, { positional: ['ref'] }),

  def('interact', 'right-click', true, 'right-click <ref>', 'Open an element’s context menu and return the menu’s items as refs.', async (args, ctx) => {
    const resolved = resolveRef(ctx, args)
    const result = await act(ctx, resolved, 'showmenu')
    await ctx.sleep(250)
    const surfaces = await ctx.engine.call<RawNode[]>('surfaces', { pid: resolved.app.pid })
    const menu = surfaces.find((raw) => raw.role === 'AXMenu' || raw.role === 'menu' || raw.role === 'popup menu' || raw.role === 'Menu')
    if (!menu) return { ...result, menu: null, hint: 'No menu showed up. Take a snapshot with --scope app to look for it.' }
    const [node] = registerNodes(ctx, resolved.app, menu.sid!, [menu])
    const taken = await snapshot(ctx, { root: parseRef(node.ref), depth: 4, maxNodes: 400 })
    return { ...result, menu: treeText(taken.tree) }
  }, { positional: ['ref'] }),

  def('interact', 'type', true, 'type <ref> <text> | type --app <app> <text>', 'Insert text into a field (at its cursor), or type it into an app’s focused field. Never into password fields.', async (args, ctx) => {
    const text = typeof args.text === 'string' ? args.text : undefined
    if (text === undefined || text === '') throw failure('INVALID_ARGS', '`text` is required.')
    if (args.ref !== undefined) {
      const resolved = resolveRef(ctx, args)
      assertNotSecret(resolved.summary)
      const result = await act(ctx, resolved, 'inserttext', { text })
      return { ...result, typed: text.length, ...(await followUp(ctx, args, resolved.app)) }
    }
    const app = await resolveApp(ctx, args)
    ctx.target = { label: `the focused field in ${app.name}` }
    const focus = await ctx.engine.call<{ sid: string; pid: number; node: RawNode }>('focused', { pid: app.pid }).catch(() => null)
    if (focus?.node.secure || focus?.node.subrole === 'AXSecureTextField') assertNotSecret({ role: 'password', secure: true })
    await ctx.engine.call('text', { pid: app.pid, text })
    return { app: app.name, typed: text.length, ...(await followUp(ctx, args, app)) }
  }, { positional: ['ref', 'text'] }),

  def('interact', 'set-value', true, 'set-value <ref> <value>', 'Write a value straight into an element (a field, slider or stepper), replacing what is there.', async (args, ctx) => {
    const resolved = resolveRef(ctx, args)
    assertNotSecret(resolved.summary)
    if (args.value === undefined) throw failure('INVALID_ARGS', '`value` is required.')
    const value = typeof args.value === 'number' || typeof args.value === 'boolean' ? args.value : String(args.value)
    return act(ctx, resolved, 'setvalue', { value: typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) && ['slider', 'stepper', 'meter'].includes(resolved.summary?.role ?? '') ? Number(value) : value })
  }, { positional: ['ref', 'value'] }),

  def('interact', 'clear', true, 'clear <ref>', 'Empty a text field.', async (args, ctx) => {
    const resolved = resolveRef(ctx, args)
    assertNotSecret(resolved.summary)
    return act(ctx, resolved, 'setvalue', { value: '' })
  }, { positional: ['ref'] }),

  def('interact', 'focus', true, 'focus <ref>', 'Move keyboard focus to an element without clicking it.', async (args, ctx) => act(ctx, resolveRef(ctx, args), 'focus'), { positional: ['ref'] }),

  def('interact', 'select', true, 'select <ref> [<option>]', 'Pick an option in a pop-up, combo box, list or tab group; without an option, select the element itself (a row, a tab).', async (args, ctx) => {
    const resolved = resolveRef(ctx, args)
    const option = str(args, 'option')
    if (!option) return act(ctx, resolved, 'select')
    const role = resolved.summary?.role ?? ''
    const pickFrom = async (tree: UiNode): Promise<UiNode | null> => {
      const items = flatten(tree).map(({ node }) => node).filter((node) => node !== tree && ['menuitem', 'listitem', 'row', 'cell', 'radio', 'tab', 'option', 'treeitem', 'text'].includes(node.role))
      return items.find((node) => fold(node.name ?? node.value ?? '') === fold(option)) ?? items.find((node) => fold(node.name ?? node.value ?? '').includes(fold(option))) ?? null
    }
    if (['popup', 'combobox', 'menubutton'].includes(role)) {
      await act(ctx, resolved, 'press')
      await ctx.sleep(250)
      let item = await pickFrom((await snapshot(ctx, { root: resolved.ref, depth: 6, maxNodes: 800 })).tree)
      if (!item) {
        for (const surface of await ctx.engine.call<RawNode[]>('surfaces', { pid: resolved.app.pid })) {
          const [node] = registerNodes(ctx, resolved.app, surface.sid!, [surface])
          item = await pickFrom((await snapshot(ctx, { root: parseRef(node.ref), depth: 5, maxNodes: 800 })).tree)
          if (item) break
        }
      }
      if (item) {
        const picked = resolveRef(ctx, { ref: item.ref })
        await act(ctx, picked, item.role === 'menuitem' ? 'press' : 'select')
        ctx.target = { label: `${labelOf(resolved.summary, resolved.app)} → “${clip(option, 30)}”`, bounds: resolved.summary?.bounds }
        await ctx.sleep(150)
        return { ref: formatRef(resolved.ref.sid, resolved.ref.n), picked: item.name ?? option, after: await readOrGone(ctx, resolved) }
      }
      // Close the menu that was opened for nothing.
      await ctx.engine.call('keys', { pid: resolved.app.pid, key: 'escape', modifiers: [] }).catch(() => undefined)
      if (role === 'combobox') return act(ctx, resolved, 'setvalue', { value: option })
      throw failure('ELEMENT_NOT_FOUND', `No option “${option}” in ${labelOf(resolved.summary, resolved.app)}.`)
    }
    const item = await pickFrom((await snapshot(ctx, { root: resolved.ref, depth: 8, maxNodes: 2000 })).tree)
    if (!item) throw failure('ELEMENT_NOT_FOUND', `No option “${option}” in ${labelOf(resolved.summary, resolved.app)}.`)
    return act(ctx, resolveRef(ctx, { ref: item.ref }), 'select')
  }, { positional: ['ref', 'option'] }),

  def('interact', 'toggle', true, 'toggle <ref>', 'Flip a checkbox or switch.', async (args, ctx) => act(ctx, resolveRef(ctx, args), 'press'), { positional: ['ref'] }),

  ...(['check', 'uncheck'] as const).map((name) =>
    def('interact', name, true, `${name} <ref>`, `Set a checkbox or switch to ${name}ed; does nothing if it already is.`, async (args, ctx) => {
      const resolved = resolveRef(ctx, args)
      const want = name === 'check' ? 'checked' : 'unchecked'
      const before = await read(ctx, resolved)
      if (before.states?.includes(want)) return { ref: before.ref, changed: false, after: before }
      const result = await act(ctx, resolved, 'press')
      if (result.after && !result.after.states?.includes(want)) {
        throw failure('ACTION_FAILED', `Pressed it, but it isn't ${want} (${result.after.states?.join(', ') || 'no state reported'}).`)
      }
      return { ...result, changed: true }
    }, { positional: ['ref'] })
  ),

  def('interact', 'expand', true, 'expand <ref>', 'Open a disclosure triangle, tree item or outline row.', async (args, ctx) => act(ctx, resolveRef(ctx, args), 'expand'), { positional: ['ref'] }),
  def('interact', 'collapse', true, 'collapse <ref>', 'Close a disclosure triangle, tree item or outline row.', async (args, ctx) => act(ctx, resolveRef(ctx, args), 'collapse'), { positional: ['ref'] }),

  def('interact', 'scroll', true, 'scroll <ref> [--direction down|up|left|right] [--units 3]', 'Scroll the scroll area an element is in.', async (args, ctx) => {
    const direction = str(args, 'direction') ?? 'down'
    if (!['up', 'down', 'left', 'right'].includes(direction)) throw failure('INVALID_ARGS', '`direction` is up, down, left or right.')
    return act(ctx, resolveRef(ctx, args), 'scroll', { direction, units: num(args, 'units', 3, 1, 50) })
  }, { positional: ['ref', 'direction'] }),

  def('interact', 'scroll-to', true, 'scroll-to <ref>', 'Scroll until an element is in view.', async (args, ctx) => act(ctx, resolveRef(ctx, args), 'scrolltovisible'), { positional: ['ref'] }),

  def('interact', 'menu', true, 'menu --app <app> <path>', 'Choose a menu-bar item by its path, like "File > Export…". The menu doesn’t have to be open.', async (args, ctx) => {
    const app = await resolveApp(ctx, args)
    const raw = Array.isArray(args.path) ? args.path.map(String) : (str(args, 'path', true) as string).split(/\s*(?:>|›|→)\s*/)
    const path = raw.map((part) => part.trim()).filter(Boolean)
    if (path.length < 2) throw failure('INVALID_ARGS', 'Give the whole path, from the menu title: "File > Save As…".')
    const taken = await snapshot(ctx, { app, scope: 'menubar', depth: path.length * 2 + 2, maxNodes: 6000 })
    const { node, level, seen } = findMenuPath(taken.tree, path)
    if (!node) throw failure('ELEMENT_NOT_FOUND', `${app.name} has no menu item “${path[level]}”${level > 0 ? ` under “${path.slice(0, level).join(' › ')}”` : ''}.`, seen.length ? `There: ${seen.slice(0, 30).join(', ')}.` : undefined)
    if (node.states?.includes('disabled')) throw failure('ACTION_FAILED', `“${path.join(' › ')}” is greyed out in ${app.name} right now.`)
    const resolved = resolveRef(ctx, { ref: node.ref })
    ctx.target = { label: `menu “${path.join(' › ')}” in ${app.name}` }
    const result = await act(ctx, resolved, 'press')
    return { ...result, menu: path.join(' › '), ...(await followUp(ctx, args, app)) }
  }, { positional: ['path'] }),

  /* keyboard */
  def('keyboard', 'press', true, 'press <keys> --app <app> | press <keys> --ref <ref>', 'Send a key or combo (return, escape, cmd+s, ctrl+shift+tab) to an app, without bringing it to the front. With a ref, focus that element first.', async (args, ctx) => {
    const keys = str(args, 'keys', true)
    let combo
    try {
      combo = parseCombo(keys)
    } catch (error) {
      throw failure('INVALID_ARGS', (error as Error).message)
    }
    if (!combo.key) throw failure('INVALID_ARGS', 'press needs a key, not only modifiers.')
    let app: AppInfo
    if (args.ref !== undefined) {
      const resolved = resolveRef(ctx, args)
      app = resolved.app
      await act(ctx, resolved, 'focus').catch(() => undefined)
    } else {
      app = await resolveApp(ctx, args)
      ctx.target = { label: app.name }
    }
    ctx.target.label = `${keys} in ${ctx.target.label ?? app.name}`
    await ctx.engine.call('keys', { pid: app.pid, key: combo.key, modifiers: combo.modifiers, repeat: num(args, 'repeat', 1, 1, 50) })
    return { app: app.name, pressed: keys, ...(await followUp(ctx, args, app)) }
  }, { positional: ['keys'] }),

  def('keyboard', 'key-down', true, 'key-down', 'Reserved: always refuses.', refused('RESERVED', 'key-down')),
  def('keyboard', 'key-up', true, 'key-up', 'Reserved: always refuses.', refused('RESERVED', 'key-up')),
  def('keyboard', 'mouse-down', true, 'mouse-down', 'Reserved: always refuses.', refused('RESERVED', 'mouse-down')),
  def('keyboard', 'mouse-up', true, 'mouse-up', 'Reserved: always refuses.', refused('RESERVED', 'mouse-up')),
  ...['hover', 'drag', 'mouse-move', 'mouse-click', 'mouse-wheel', 'triple-click'].map((name) =>
    def('keyboard', name, true, name, 'Needs the real pointer: refuses (use computer use).', refused('NEEDS_POINTER', name))
  ),

  /* waiting */
  def('wait', 'wait', false, 'wait <ref> --predicate <state> [--value <v>] | wait --app <app> --text <text> [--gone] | wait --app <app> --window <title> | wait --ms <ms>', 'Block until an element reaches a state, text appears (or goes), a window opens, or time passes. Fails with TIMEOUT.', async (args, ctx) => {
    const timeout = num(args, 'timeout', 10_000, 100, 120_000)
    const ms = optNum(args, 'ms')
    if (ms !== undefined) {
      await ctx.sleep(Math.min(60_000, Math.max(0, ms)))
      return { waited: Math.min(60_000, Math.max(0, ms)) }
    }
    if (args.ref !== undefined) {
      const resolved = resolveRef(ctx, args)
      const predicate = str(args, 'predicate') ?? 'exists'
      if (!ELEMENT_STATES.has(predicate)) throw failure('INVALID_ARGS', `\`predicate\` is one of ${[...ELEMENT_STATES].join(', ')}.`)
      const value = str(args, 'value')
      let last: UiNode | null = null
      const done = await waitUntil(ctx, timeout, async () => elementState((last = await readOrGone(ctx, resolved)), predicate, value, ctx.displays()), `${labelOf(resolved.summary, resolved.app)} to be ${predicate}${value !== undefined ? ` “${value}”` : ''}`)
      return { ...done, element: last }
    }
    const app = str(args, 'app') ? await resolveApp(ctx, args) : null
    const gone = bool(args, 'gone')
    const text = str(args, 'text')
    if (text) {
      if (!app) throw failure('INVALID_ARGS', '`app` is required to wait for text.')
      return waitUntil(ctx, timeout, async () => treeHasText((await snapshot(ctx, { app, scope: 'app', skipMenuBar: true, ephemeral: true, maxNodes: 3000 })).tree, text) !== gone, `text “${text}”${gone ? ' to go away' : ''} in ${app.name}`)
    }
    const windowTitle = str(args, 'window')
    if (windowTitle) {
      if (!app) throw failure('INVALID_ARGS', '`app` is required to wait for a window.')
      return waitUntil(ctx, timeout, async () => (await windowTitles(ctx, app)).some((title) => fold(title).includes(fold(windowTitle))) !== gone, `a window “${windowTitle}” in ${app.name}${gone ? ' to close' : ''}`)
    }
    const appName = str(args, 'launched')
    if (appName) {
      return waitUntil(ctx, timeout, async () => {
        try {
          pickApp(await runningApps(ctx, true), appName)
          return !gone
        } catch {
          return gone
        }
      }, `${appName} to ${gone ? 'quit' : 'start'}`)
    }
    throw failure('INVALID_ARGS', 'Say what to wait for: a ref and --predicate, --text, --window, --launched or --ms.')
  }, { positional: ['ref'], flags: ['gone'] }),

  /* clipboard */
  def('clipboard', 'clipboard-get', false, 'clipboard-get', 'The clipboard’s text (and whether it holds an image).', async (_args, ctx) => ({ text: ctx.clipboard.readText(), image: ctx.clipboard.hasImage() })),
  def('clipboard', 'clipboard-set', true, 'clipboard-set <text>', 'Put text on the clipboard.', async (args, ctx) => {
    const text = typeof args.text === 'string' ? args.text : str(args, 'text', true)
    ctx.clipboard.writeText(text)
    ctx.target = { label: 'the clipboard' }
    return { set: text.length }
  }, { positional: ['text'] }),
  def('clipboard', 'clipboard-clear', true, 'clipboard-clear', 'Empty the clipboard.', async (_args, ctx) => {
    ctx.clipboard.clear()
    ctx.target = { label: 'the clipboard' }
    return { cleared: true }
  }),

  /* system */
  def('system', 'status', false, 'status', 'Whether app control is on, which engine this OS uses, and whether it has the permission it needs.', async (_args, ctx) => ctx.status()),
  def('system', 'version', false, 'version', 'Versions of the envelope, the engine and Eaon.', async (_args, ctx) => ctx.version()),
  def('system', 'guide', false, 'guide', 'How to use app control well: read this first.', async (_args, ctx) => ({ guide: ctx.guide() })),
  def('system', 'trace', false, 'trace [--limit 50]', 'Recent app-control activity: who ran what on which app, and how it went.', async (args, ctx) => ({ entries: ctx.trace(num(args, 'limit', 50, 1, 500)) })),
  def('system', 'batch', true, 'batch --commands <json array>', 'Run up to 30 commands in order, e.g. [{"command":"click","ref":"@s…:e4"},{"command":"wait","ms":300}]. Stops at the first failure unless --keep-going.', async (args, ctx) => {
    let steps: unknown = args.commands
    if (typeof steps === 'string') {
      try {
        steps = JSON.parse(steps)
      } catch {
        throw failure('INVALID_ARGS', '`commands` must be a JSON array of {"command": …} objects.')
      }
    }
    if (!Array.isArray(steps) || steps.length === 0) throw failure('INVALID_ARGS', '`commands` must be a non-empty array.')
    if (steps.length > 30) throw failure('INVALID_ARGS', 'A batch runs at most 30 commands.')
    const results: unknown[] = []
    for (const step of steps) {
      if (!step || typeof step !== 'object' || typeof (step as Args).command !== 'string') throw failure('INVALID_ARGS', 'Each step needs a "command".')
      const { command, ...stepArgs } = step as Args
      if (command === 'batch') throw failure('INVALID_ARGS', 'A batch can’t contain another batch.')
      const outcome = await ctx.runStep(String(command), stepArgs)
      results.push({ command, ...outcome })
      if (!outcome.ok && !bool(args, 'keep_going')) break
    }
    return { ran: results.length, of: steps.length, results }
  }, { flags: ['keep-going'] })
]

export const COMMAND_NAMES = COMMANDS.map((command) => command.name)

/** A command by name, accepting snake_case (`list_apps`) as well as kebab-case. */
export function findCommand(name: string): CommandDef | undefined {
  const key = name.trim().toLowerCase().replace(/_/g, '-')
  return COMMANDS.find((command) => command.name === key)
}

export function commandInfo(): AppControlCommandInfo[] {
  return COMMANDS.map(({ name, group, summary, acts, usage }) => ({ name, group, summary, acts, usage }))
}

/** One line per command, for the guide and the agent tool's description. */
export function commandLines(groups?: AppControlCommandGroup[]): string {
  return COMMANDS.filter((command) => !groups || groups.includes(command.group))
    .filter((command) => !command.summary.startsWith('Reserved') && !command.summary.startsWith('Needs the real pointer'))
    .map((command) => `${command.usage}: ${command.summary}`)
    .join('\n')
}
