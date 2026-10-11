import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { TradingSnapshot } from '@shared/trading'
import { feedStep, runResearchTool, traderTools, tradePrompt, type McpToolDef, type TraderHost } from './claudeTrader'
import type { TradingEngine } from './engine'
import type { Settings } from '@shared/types'

/**
 * The MCP server the Claude Code pane on the Trading tab trades through.
 *
 * Loopback only, on a port the OS picks, and every request must carry this
 * run's random key (the pane's MCP config file holds it). It answers MCP over
 * streamable HTTP, statelessly: one server per request, as the control API
 * does. The tools are the trader tools Eaon CLI offers Claude Code
 * (`claudeTrader.ts`) plus quotes — nothing that changes the limits, the
 * account or the kill switch, which stay the user's, on the desk.
 *
 * A wait for the next check is answered within `WAIT_MS`: an HTTP client
 * gives up on a response that takes minutes to start, so a long wait (for the
 * start time, overnight) comes back as "call again".
 */

export const CLAUDE_SERVER_NAME = 'eaon-trading'
/** What the user types in Claude Code to hand it the session (Claude Code names MCP prompts so). */
export const TRADE_COMMAND = `/mcp__${CLAUDE_SERVER_NAME}__trade`
const WAIT_MS = 4 * 60_000

const INSTRUCTIONS =
  'This server is Eaon’s trading desk, the app this session runs in. When the user hands you a trading session (the /mcp__eaon-trading__trade command), you are its trading agent: loop on eaon_wait_for_check, research with eaon_history, eaon_scan, eaon_news, eaon_quote and eaon_account, trade with eaon_order, protect holdings with eaon_set_exit, and end each check with eaon_log_decision, until the session ends. Every order passes the user’s limits and the kill switch inside Eaon.'

export interface ClaudeServerDeps {
  engine: TradingEngine
  settings: () => Settings
  /** Whether the user let Claude Code trade real money (the desk's switch). */
  mayTradeLive: () => boolean
}

export function claudeTraderHost(deps: ClaudeServerDeps): TraderHost {
  const { engine } = deps
  const settled = async <T>(work: Promise<T>): Promise<T> => {
    const result = await work
    await engine.refresh()
    return result
  }
  return {
    snapshot: async () => engine.snapshot(),
    waitSession: (ms) => engine.waitForSession(ms),
    waitCheck: (id, ms) => engine.waitForCheck(id, ms),
    logDecision: async (id, text) => engine.logDecision(id, text),
    // An order queues a refresh without waiting for it; the answer reads the new holding and its exit, so wait.
    sessionOrder: (id, request) => settled(engine.sessionOrder(id, request)),
    placeOrder: (request) => settled(engine.placeOrder(request, 'agent')),
    cancelOrder: (id) => engine.cancelOrder(id),
    closePosition: (symbol) => engine.closePosition(symbol),
    setExit: async (request) => {
      const session = engine.activeSession()
      await engine.setExit(request, session?.driver === 'claude-code' ? 'session' : 'agent', session?.driver === 'claude-code' ? session.id : null)
      return engine.snapshot()
    },
    research: (tool, args) => runResearchTool(engine, deps.settings(), tool, args),
    liveRefusal: (snap: TradingSnapshot) =>
      snap.config.broker === 'alpaca-live' && !deps.mayTradeLive()
        ? 'That would trade real money (Alpaca live). The user hasn’t let Claude Code trade real money: in Eaon’s Trading tab, under Claude Code, switch on “Let Claude Code trade real money”.'
        : null
  }
}

/** The tools, and a call that also shows each trading step in the desk's feed. */
export function claudeTraderTools(deps: ClaudeServerDeps): { tools: McpToolDef[]; call: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }> } {
  const host = claudeTraderHost(deps)
  const tools: McpToolDef[] = [
    ...traderTools(host, { waitMs: WAIT_MS }),
    {
      name: 'eaon_quote',
      description: () => 'Latest prices for up to 10 US stocks or ETFs, from the same feed Eaon trades on.',
      inputSchema: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' }, description: 'Tickers, e.g. ["AAPL", "SPY"]' } }, required: ['symbols'] },
      run: (args) => host.research('trading_quote', { symbols: args.symbols })
    }
  ]
  const call = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
    const tool = tools.find((t) => t.name === name)
    if (!tool) return { text: `Unknown tool ${name}.`, isError: true }
    let result: { text: string; isError: boolean }
    try {
      result = { text: await tool.run(args ?? {}), isError: false }
    } catch (error) {
      result = { text: error instanceof Error ? error.message : String(error), isError: true }
    }
    const step = feedStep(name, args ?? {})
    if (step) deps.engine.recordExternalTool(step.name, step.input, result.text, !result.isError)
    return result
  }
  return { tools, call }
}

const HOWTO = 'open the Trading tab, write the goal, pick when to start and stop, and press Start trading'

function mcpServer(deps: ClaudeServerDeps, tools: ReturnType<typeof claudeTraderTools>): Server {
  const server = new Server({ name: CLAUDE_SERVER_NAME, version: '1.0.0' }, { capabilities: { tools: {}, prompts: {} }, instructions: INSTRUCTIONS })
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{ name: 'trade', description: 'Take over the Eaon trading session waiting for Claude Code, and run it as its trading agent until it ends.' }]
  }))
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    if (req.params.name !== 'trade') throw new Error(`Unknown prompt ${req.params.name}`)
    const text = tradePrompt(deps.engine.snapshot(), HOWTO)
    return { description: 'Run the Eaon trading session', messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] }
  })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.tools.map((t) => ({ name: t.name, description: t.description(), inputSchema: t.inputSchema as { type: 'object' } }))
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await tools.call(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>)
    return { content: [{ type: 'text' as const, text: result.text }], ...(result.isError ? { isError: true } : {}) }
  })
  return server
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 1_000_000) throw new Error('Request too large')
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : undefined
}

export class ClaudeTradingServer {
  private http: HttpServer | null = null
  private starting: Promise<{ url: string; token: string }> | null = null
  private readonly token = randomBytes(24).toString('hex')
  private readonly tools: ReturnType<typeof claudeTraderTools>

  constructor(private readonly deps: ClaudeServerDeps) {
    this.tools = claudeTraderTools(deps)
  }

  /** Listening, with where and the key to send. Starts it the first time. */
  start(): Promise<{ url: string; token: string }> {
    if (!this.starting) {
      this.starting = new Promise((resolve, reject) => {
        const http = createServer((req, res) => {
          void this.handle(req, res).catch((error) => {
            if (!res.headersSent) json(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: String(error) }, id: null })
            else res.end()
          })
        })
        http.on('error', (error) => {
          this.starting = null
          reject(error)
        })
        // Loopback only: these tools place orders.
        http.listen(0, '127.0.0.1', () => {
          this.http = http
          const { port } = http.address() as AddressInfo
          resolve({ url: `http://127.0.0.1:${port}/mcp`, token: this.token })
        })
      })
    }
    return this.starting
  }

  stop(): void {
    this.http?.closeAllConnections()
    this.http?.close()
    this.http = null
    this.starting = null
  }

  private authorised(req: IncomingMessage): boolean {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim() ?? ''
    const sent = Buffer.from(bearer)
    const key = Buffer.from(this.token)
    return sent.length === key.length && timingSafeEqual(sent, key)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A web page can reach a loopback port; it always sends an Origin, and Claude Code never does.
    const host = (req.headers.host ?? '').replace(/:\d+$/, '')
    if (req.headers.origin !== undefined || (host !== '127.0.0.1' && host !== 'localhost')) {
      json(res, 403, { error: { message: 'Forbidden.' } })
      return
    }
    if (!this.authorised(req)) {
      json(res, 401, { error: { message: 'This server only answers the Claude Code pane Eaon opened.' } })
      return
    }
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/\/+$/, '')
    if (path !== '/mcp') {
      json(res, 404, { error: { message: `No route for ${req.method} ${path}` } })
      return
    }
    if (req.method !== 'POST') {
      // Stateless: no standalone event stream to open, no session to end.
      res.setHeader('Allow', 'POST')
      json(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null })
      return
    }
    let body: unknown
    try {
      body = await readJson(req)
    } catch {
      json(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null })
      return
    }
    const server = mcpServer(this.deps, this.tools)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }
}
