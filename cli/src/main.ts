import { readFileSync } from 'node:fs'
import { CLI_BETA, CLI_VERSION } from './core/version'
import { boot, localModelsReady, shutdown } from './runtime/boot'
import { cliHome, desktopHome } from './runtime/paths'

/**
 * `eaon`: Eaon in a terminal. With no command it opens the full-screen
 * app (Chat · Workers · Trading); the commands below are for scripts, for
 * other agents, and for checking on things without opening it.
 */

const VERSION = CLI_VERSION

const HELP = `eaon ${VERSION}${CLI_BETA ? ' (beta)' : ''} — Eaon in your terminal: chat, workers and agentic trading

Usage
  eaon                     open the app on the Chat tab
  eaon trading [page]      open on the trading desk (agent, home, market,
                           portfolio, orders, sessions, watchlist, lookup,
                           rates, chat)
  eaon workers             open on the Workers tab

  eaon ask "<prompt>"      answer once and exit (also: -p "<prompt>")
                           --allow  let it make changes without asking
  eaon status              the trading desk in a few lines
  eaon quote AAPL MSFT …   quotes (indexes, futures, FX and crypto too)
  eaon order buy 10 AAPL   place an order through your limits (also $500,
                           --limit, --stop, --target, --trail, --reason;
                           order close AAPL, order cancel <id>)

  eaon import              bring keys, models, plugins and the trading
                           setup over from Eaon Desktop (--all, --dry-run)
  eaon desktop             what Eaon Desktop has, read-only

  eaon peers               other Eaon, Claude Code and Codex sessions
  eaon send <to> <msg>     message a session (--wait <seconds>)
  eaon connect claude      let Claude Code sessions talk to Eaon (or codex)
  eaon disconnect claude
  eaon mcp                 the MCP server Claude Code and Codex load

  eaon doctor              where things are and what is available
  eaon update              install the newest version from npm (--check
                           only looks)

Options
  --no-mouse               leave the mouse to your terminal (its own text selection; PgUp/PgDn scroll)
  --version, --help

Profile: ${cliHome()}   (EAON_CLI_HOME moves it)
`

function flag(args: string[], name: string): string | undefined {
  const at = args.findIndex((a) => a === name || a.startsWith(`${name}=`))
  if (at === -1) return undefined
  const arg = args[at]
  if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1)
  return args[at + 1]
}

async function doctor(): Promise<number> {
  await boot({ engines: false, mcp: false })
  await localModelsReady()
  const { listProviders } = await import('@main/providers')
  const { toolsFor } = await import('@main/agent/tools')
  const { store } = await import('@main/store')
  const { findDesktop } = await import('./core/desktop')
  const { listPeers, readEngineLock } = await import('./bus/bus')
  const settings = store.getSettings()
  const usable = listProviders().filter((p) => p.enabled && (p.hasKey || p.local || p.signedIn))
  const tools = toolsFor({
    mode: 'work',
    cwd: process.cwd(),
    depth: 0,
    readOnly: false,
    settings,
    request: { chatId: 'doctor', messageId: 'doctor', providerId: '', modelId: '', effort: 'medium', mode: 'work', history: [], summary: null, projectInstructions: '', cwd: process.cwd(), work: { swarm: false, plan: false }, goal: null }
  })
  const desktop = findDesktop()
  const lock = readEngineLock()
  console.log(`eaon       ${VERSION}${CLI_BETA ? ' (beta)' : ''} on Node ${process.versions.node}`)
  console.log(`profile    ${cliHome()}`)
  console.log(`desktop    ${desktop ? `${desktopHome()}${desktop.running ? ' (running)' : ''}` : 'not found'}`)
  console.log(`providers  ${usable.map((p) => `${p.id}(${p.models.length})`).join(', ') || 'none with a key — run eaon import, or /key in the app'}`)
  console.log(`model      ${settings.selectedModelId ?? 'first available'}`)
  console.log(`tools      ${tools.map((t) => t.name).join(', ')}`)
  console.log(`sessions   ${listPeers().length} on the bus${lock ? `, engines in pid ${lock.pid}` : ', engines not running'}`)
  await shutdown()
  return 0
}

async function ask(args: string[]): Promise<number> {
  const allow = args.includes('--allow')
  const prompt = args.filter((a) => a !== '--allow' && a !== '-p').join(' ').trim() || (!process.stdin.isTTY ? readFileSync(0, 'utf8').trim() : '')
  if (!prompt) {
    console.error('Usage: eaon ask "<prompt>"')
    return 2
  }
  await boot({ engines: false })
  await localModelsReady()
  // With the app open in another terminal, its trading tools are available here too.
  const { BusNode } = await import('./bus/bus')
  const bus = await new BusNode({ kind: 'eaon', name: 'eaon-shell', mode: 'cmd' }).open()
  if (bus.owner()) await (await import('./runtime/engines')).joinEngines(bus)
  const { runAgent } = await import('@main/agent/loop')
  const { store } = await import('@main/store')
  const { chatModel } = await import('./core/models')
  const { randomUUID } = await import('node:crypto')
  const settings = store.getSettings()
  const model = chatModel(settings)
  if (!model) {
    console.error('No model is set up. Run `eaon import`, or open eaon and use /key or /login.')
    await bus.close()
    await shutdown()
    return 1
  }
  const tty = process.stderr.isTTY
  const dim = (t: string): string => (tty ? `\x1b[2m${t}\x1b[22m` : t)
  const outcome = await runAgent(
    {
      chatId: `cli-ask-${randomUUID()}`,
      messageId: randomUUID(),
      providerId: model.providerId,
      modelId: model.id,
      effort: settings.effort,
      mode: 'work',
      history: [{ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: prompt }], createdAt: Date.now() }],
      summary: null,
      projectInstructions: '',
      cwd: process.cwd(),
      work: { swarm: false, plan: false },
      goal: null
    },
    (event) => {
      if (event.type === 'delta') process.stdout.write(event.text)
      else if (event.type === 'tool-call') process.stderr.write(dim(`\n· ${event.name} ${JSON.stringify(event.input).slice(0, 120)}\n`))
      else if (event.type === 'error') process.stderr.write(`\n${event.error}\n`)
    },
    // Nobody is there to approve a change: refuse them, unless --allow.
    { approver: async () => allow, unattended: allow ? 'autonomous' : 'read-only' }
  )
  process.stdout.write('\n')
  ;(await import('./runtime/engines')).leaveEngines()
  await bus.close()
  await shutdown()
  return outcome.error ? 1 : 0
}

async function quote(symbols: string[]): Promise<number> {
  if (symbols.length === 0) {
    console.error('Usage: eaon quote AAPL MSFT ^VIX GC=F BTC-USD')
    return 2
  }
  const { Market } = await import('./core/market')
  const market = new Market()
  market.start()
  for (const s of symbols) market.quote(s)
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline && symbols.some((s) => !market.quote(s) && !market.errorOf(s))) await new Promise((r) => setTimeout(r, 150))
  market.stop()
  let code = 0
  for (const s of symbols) {
    const q = market.quote(s)
    if (!q) {
      console.log(`${s.toUpperCase().padEnd(10)} ${market.errorOf(s) ?? 'no answer'}`)
      code = 1
      continue
    }
    const sign = q.change > 0 ? '+' : ''
    console.log(`${q.symbol.padEnd(10)} ${q.price.toFixed(q.price < 1 ? 4 : 2).padStart(12)}  ${`${sign}${q.change.toFixed(2)}`.padStart(9)}  ${`${sign}${q.changePct.toFixed(2)}%`.padStart(8)}  ${q.name ?? ''}`)
  }
  return code
}

async function status(): Promise<number> {
  const { BusNode } = await import('./bus/bus')
  const { formatTradingSummary, localTradingSnapshot } = await import('./bus/summaries')
  const bus = await new BusNode({ kind: 'eaon', name: 'eaon-shell', mode: 'cmd' }).open()
  try {
    if (bus.owner()) {
      const snapshot = await bus.invokeOwner<import('@shared/trading').TradingSnapshot>('trading:refresh', [])
      console.log(formatTradingSummary(snapshot, true))
      return 0
    }
    const snapshot = localTradingSnapshot()
    if (!snapshot) {
      console.log('The trading desk has never been opened in the CLI. Run `eaon trading`.')
      return 0
    }
    console.log(formatTradingSummary(snapshot, false))
    return 0
  } finally {
    await bus.close()
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === '--version' || command === '-v') {
    console.log(VERSION)
    return 0
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP)
    return 0
  }
  switch (command) {
    case 'doctor':
      return doctor()
    case 'ask':
    case '-p':
      return ask(rest)
    case 'quote':
      return quote(rest)
    case 'status':
      return status()
    case 'order':
      return (await import('./commands/trade')).runOrderCommand(rest)
    case 'import':
      return (await import('./commands/import')).runImportCommand(rest)
    case 'desktop':
      return (await import('./commands/import')).runDesktopCommand(rest)
    case 'peers':
    case 'sessions':
      return (await import('./commands/peers')).runPeersCommand(rest)
    case 'send':
      return (await import('./commands/peers')).runSendCommand(rest)
    case 'connect':
      return (await import('./commands/peers')).runConnectCommand(rest)
    case 'disconnect':
      return (await import('./commands/peers')).runConnectCommand(rest, true)
    case 'mcp':
      await (await import('./bus/mcpServer')).runMcpServer({ control: rest.includes('--control') })
      return -1
    case 'update':
    case 'upgrade':
      return (await import('./commands/update')).runUpdateCommand(rest)
  }

  // The app itself.
  const args = argv
  const modeArg = ['chat', 'workers', 'trading'].includes(command ?? '') ? (command as 'chat' | 'workers' | 'trading') : undefined
  if (command && !modeArg && !command.startsWith('-')) {
    console.error(`Unknown command “${command}”. eaon --help lists them.`)
    return 2
  }
  const snapshotArg = flag(args, '--snapshot')
  const [snapMode, snapPage] = (snapshotArg ?? '').split(':')
  const pageArg = modeArg === 'trading' && rest[0] && !rest[0].startsWith('-') ? rest[0] : snapPage
  const { runTui } = await import('./tui/start')
  if (!snapshotArg && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    console.error('eaon needs a terminal. For scripts, use `eaon ask "…"`, `eaon status` or `eaon quote`.')
    return 2
  }
  const size = (flag(args, '--size') ?? '160x48').split('x').map(Number)
  return runTui({
    mode: (snapshotArg ? snapMode : modeArg) as 'chat' | 'workers' | 'trading' | undefined,
    page: pageArg as import('./tui/views/trading/index').Page | undefined,
    mouse: !args.includes('--no-mouse'),
    ...(snapshotArg
      ? {
          snapshot: {
            width: size[0] || 160,
            height: size[1] || 48,
            html: flag(args, '--html'),
            waitMs: Number(flag(args, '--wait') ?? 3000),
            keys: args.filter((_, i) => args[i - 1] === '--keys')
          }
        }
      : {})
  })
}

/** After a one-shot command: a line about a newer version the app's last check found (no network here). */
async function updateNotice(command: string | undefined): Promise<void> {
  if (!command || !['doctor', 'ask', '-p', 'quote', 'status', 'order', 'import', 'desktop', 'peers', 'sessions', 'send', 'connect', 'disconnect'].includes(command)) return
  if (!process.stderr.isTTY) return
  const { knownUpdate } = await import('./core/update')
  const latest = knownUpdate()
  if (latest) process.stderr.write(`\x1b[33meaon ${latest} is out (you have ${VERSION}). Run \`eaon update\` to install it.\x1b[0m\n`)
}

main(process.argv.slice(2)).then(
  async (code) => {
    if (code < 0) return
    await updateNotice(process.argv[2]).catch(() => {})
    process.exit(code)
  },
  (error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error)
    process.exit(1)
  }
)
