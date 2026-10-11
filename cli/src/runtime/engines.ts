import type { AgentTool, ToolContext } from '@main/agent/tools'
import { registerToolSource, toolsFor, toolSourceOf } from '@main/agent/tools'
import { store } from '@main/store'
import { describeOrder } from '@main/features/trading/engine'
import { isRealMoney, type BrokerKind, type TradingSnapshot } from '@shared/trading'
import { claimEngines, releaseEngines, type BusNode, type RemoteToolSpec, type ToolCallMeta } from '../bus/bus'
import { startEngines } from './boot'
import { events, handlerNames, invoke, ipc } from './ipc'

/**
 * Who runs the engines, and how every other session reaches them.
 *
 * The first session on a profile takes `engines.lock` and runs workers,
 * trading and email itself (`owner`). A session opened while it runs
 * (`attached`) registers stand-ins for the owner's IPC channels that forward
 * over the bus, re-emits the owner's events locally, and offers the owner's
 * trading tools to its own chat agent. The TUI only ever calls `invoke` and
 * listens to `events`, so it works the same either way. When the owner
 * closes, the next session to notice takes the lock and starts the engines.
 */

export type EngineRole = 'owner' | 'attached'

/** Channels the engines serve; everything else (sign-in, plugins, skills) runs in every session. */
const ENGINE_PREFIXES = ['trading:', 'workers:', 'email:']
/** Tool sources that live with the engines. */
const ENGINE_SOURCES = new Set(['trading', 'email'])
const isEngineChannel = (channel: string): boolean => ENGINE_PREFIXES.some((p) => channel.startsWith(p))
/** Names of tools that only look, for the stand-ins: everything else is treated as a change. */
const LOOKS_ONLY = /^(trading_(account|quote|history|scan|news)|email_(read|list|inbox|search|status|get)\w*)$/

let role: EngineRole | null = null
let unsubscribe: (() => void) | null = null
let watcher: ReturnType<typeof setInterval> | null = null
let knownBroker: string | null = null
const proxied = new Set<string>()

export function engineRole(): EngineRole | null {
  return role
}

function setRole(next: EngineRole): void {
  role = next
  events.emit('engines:role', next)
}

/* ------------------------------------------------------------- the owner */

function engineQuery(meta?: ToolCallMeta): Parameters<typeof toolsFor>[0] {
  const settings = store.getSettings()
  return {
    mode: 'work',
    cwd: meta?.cwd ?? process.cwd(),
    depth: 0,
    readOnly: false,
    settings,
    request: {
      chatId: meta?.chatId ?? 'remote',
      messageId: meta?.messageId ?? 'remote',
      providerId: meta?.providerId ?? '',
      modelId: meta?.modelId ?? '',
      effort: settings.effort,
      mode: 'work',
      history: [],
      summary: null,
      projectInstructions: '',
      cwd: meta?.cwd ?? null,
      work: { swarm: false, plan: false },
      goal: null
    }
  }
}

function engineTools(meta?: ToolCallMeta): AgentTool[] {
  return toolsFor(engineQuery(meta)).filter((tool) => ENGINE_SOURCES.has(toolSourceOf(tool) ?? ''))
}

/** Lets other sessions call this one's engines, and sends them its engines' events. */
function serveEngines(bus: BusNode): void {
  bus.serve({
    channels: () => handlerNames().filter(isEngineChannel),
    invoke: async (channel, args) => {
      if (!isEngineChannel(channel)) throw new Error(`${channel} isn't served to other sessions.`)
      return invoke(channel, ...args)
    },
    tools: () =>
      engineTools().map(
        (tool): RemoteToolSpec => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          mutating: typeof tool.mutating === 'function' ? 'input' : tool.mutating ? 'always' : 'never',
          source: toolSourceOf(tool) ?? ''
        })
      ),
    tool: async (name, input, meta) => {
      const tool = engineTools(meta).find((t) => t.name === name)
      if (!tool) throw new Error(`${name} isn't available.`)
      const query = engineQuery(meta)
      const ctx: ToolContext = {
        request: query.request,
        turn: { notes: [] },
        cwd: query.cwd ?? process.cwd(),
        signal: new AbortController().signal,
        emit: () => {},
        toolId: `remote-${Date.now()}`,
        depth: 0,
        readOnly: false,
        settings: query.settings,
        progress: () => {},
        // The calling session's loop already asked its user; nothing more to confirm here.
        confirm: async () => false
      }
      const result = await tool.run(input, ctx)
      return typeof result === 'string' ? result : result.text
    }
  })
  // Everything the engines tell this session's screen goes to the others too.
  const emit = events.emit.bind(events)
  events.emit = ((channel: string | symbol, ...args: unknown[]) => {
    if (typeof channel === 'string' && isEngineChannel(channel)) bus.publish(channel, args)
    return emit(channel, ...args)
  }) as typeof events.emit
}

async function becomeOwner(bus: BusNode): Promise<void> {
  unsubscribe?.()
  unsubscribe = null
  // The stand-ins go; the real features register the same channels.
  for (const channel of proxied) ipc.removeHandler(channel)
  proxied.clear()
  registerToolSource({ id: 'remote-engines', tools: () => [] })
  await startEngines()
  serveEngines(bus)
  bus.update({ owner: true })
  setRole('owner')
}

/* ----------------------------------------------------------- attached */

function standIn(spec: RemoteToolSpec, bus: BusNode): AgentTool {
  const mutating = spec.mutating === 'never' ? false : spec.mutating === 'always' ? true : !LOOKS_ONLY.test(spec.name)
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    mutating,
    risky: () => true,
    // Real money always asks, whatever the approval mode.
    catastrophic: () => mutating && knownBroker !== null && isRealMoney(knownBroker as BrokerKind),
    describe: (input) =>
      spec.name === 'trading_order'
        ? describeOrder({ side: input.side, symbol: input.symbol, qty: input.qty, notional: input.notional, type: input.type, limitPrice: input.limit_price })
        : `${spec.name} ${JSON.stringify(input).slice(0, 120)}`,
    run: (input, ctx) =>
      bus.callOwnerTool(spec.name, input, {
        chatId: ctx.request.chatId,
        messageId: ctx.request.messageId,
        cwd: ctx.cwd,
        providerId: ctx.request.providerId,
        modelId: ctx.request.modelId
      })
  }
}

async function attach(bus: BusNode): Promise<boolean> {
  if (!bus.owner()) return false
  try {
    const [channels, tools] = await Promise.all([bus.ownerChannels(), bus.ownerTools()])
    for (const channel of channels) {
      proxied.add(channel)
      ipc.handle(channel, (_event: unknown, ...args: unknown[]) => bus.invokeOwner(channel, args))
    }
    const standIns = tools.map((spec) => standIn(spec, bus))
    registerToolSource({ id: 'remote-engines', tools: (query) => (query.mode === 'work' && query.depth === 0 ? standIns : []) })
    unsubscribe = bus.subscribeOwner(
      ENGINE_PREFIXES.map((p) => `${p}*`),
      (channel, args) => {
        if (channel === 'trading:changed') knownBroker = (args[0] as TradingSnapshot | undefined)?.config?.broker ?? knownBroker
        events.emit(channel, ...args)
      },
      () => void takeOverIfFree(bus)
    )
    void bus
      .invokeOwner<TradingSnapshot>('trading:snapshot', [])
      .then((snapshot) => (knownBroker = snapshot.config.broker))
      .catch(() => {})
    setRole('attached')
    return true
  } catch {
    return false
  }
}

let takingOver: Promise<void> | null = null

/** The owner went away: take the engines if they're free, otherwise follow whoever took them. */
function takeOverIfFree(bus: BusNode): Promise<void> {
  if (takingOver) return takingOver
  takingOver = (async () => {
    // Give a closing owner a moment to release the lock.
    await new Promise((r) => setTimeout(r, 300))
    if (role === 'owner') return
    if (bus.owner()) {
      unsubscribe?.()
      unsubscribe = null
      if (await attach(bus)) return
    }
    if (claimEngines(bus.self.id)) await becomeOwner(bus)
  })().finally(() => {
    takingOver = null
  })
  return takingOver
}

/**
 * Settles this session's part: owner if the engines are free, attached to
 * the owner otherwise. Returns the role taken.
 */
export async function joinEngines(bus: BusNode): Promise<EngineRole> {
  if (claimEngines(bus.self.id)) {
    await becomeOwner(bus)
  } else if (!(await attach(bus))) {
    // The lock's holder is alive but not answering (still starting up): try again shortly.
    await new Promise((r) => setTimeout(r, 1500))
    if (!(await attach(bus))) {
      if (claimEngines(bus.self.id)) await becomeOwner(bus)
      else setRole('attached')
    }
  }
  watcher = setInterval(() => {
    if (role === 'attached' && !bus.owner()) void takeOverIfFree(bus)
  }, 3000)
  watcher.unref?.()
  return role ?? 'attached'
}

export function leaveEngines(): void {
  if (watcher) clearInterval(watcher)
  watcher = null
  unsubscribe?.()
  unsubscribe = null
  if (role === 'owner') releaseEngines()
}
