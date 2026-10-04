import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { EffortLevel } from '@shared/types'
import { EFFORT_LABEL, EFFORT_ORDER } from '@shared/effort'
import { store } from '@main/store'
import type { BusNode } from '../bus/bus'
import { openInTerminal } from '../bus/external'
import type { ChatController } from '../core/chat'
import { chatModel, effortsOf } from '../core/models'
import type { App, Mode } from './app'
import { openChats, openConfirm, openHelp, openImport, openKeys, openMcp, openModelChains, openSessions, runConnect, signIn } from './panels'
import { DiffViewer } from './diffviewer'
import { LinkedAccountsModal } from './views/trading/accounts'
import type { TradingView } from './views/trading/index'
import { TextModal } from './modals'
import { openUpdate } from './update'
import { lspStatus } from '../coding/lsp'
import { loadInstructions } from '../coding/instructions'
import type { CliMessage } from '../core/chat'
import { C } from './theme'

/**
 * Slash commands, typed in the chat composer (and the trading desk's agent
 * box). Each has a one-line description for the autocomplete menu.
 */

export interface SlashContext {
  app: App
  chat: ChatController
  bus: BusNode | null
  /** The chat view's display switches. */
  view: { showThinking: boolean; verbose: boolean; sidebar?: boolean; setDraft?: (text: string) => void }
}

interface Command {
  name: string
  description: string
  takesArgs?: boolean
  run: (ctx: SlashContext, args: string) => void | Promise<void>
}

const parseUntil = (text: string): number | null => {
  const m = /(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(text)
  if (!m) return null
  let hour = Number(m[1])
  if (m[3]?.toLowerCase() === 'pm' && hour < 12) hour += 12
  if (m[3]?.toLowerCase() === 'am' && hour === 12) hour = 0
  const at = new Date()
  at.setHours(hour, Number(m[2]), 0, 0)
  if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1)
  return at.getTime()
}

const INIT_PROMPT = (focus: string): string => `Create or update AGENTS.md at the root of this project: a short instruction file that helps future agent sessions avoid mistakes here. Every line should answer "would an agent likely get this wrong without being told?"; leave out anything that isn't.

Read the sources that tell the truth first: README, manifests (package.json, pyproject.toml, Cargo.toml…), lockfiles, build/test/lint/typecheck config, CI workflows, and existing instruction files (AGENTS.md, CLAUDE.md, .cursorrules, .github/copilot-instructions.md). Look at a few representative source files only if the structure is still unclear. Trust scripts and config over prose when they disagree.

Capture: the exact commands to build, test (including one test), lint and typecheck, in the order that matters; package boundaries and real entry points; generated code, migrations and other toolchain quirks; conventions that differ from the defaults; setup prerequisites and gotchas. Leave out generic advice, long file trees and anything you couldn't verify.

If AGENTS.md exists, improve it in place rather than rewriting it. Keep it compact.${focus ? `\n\nFocus on: ${focus}` : ''}`

const mode = (ctx: SlashContext, m: Mode) => () => ctx.app.switchMode(m)

export const COMMANDS: Command[] = [
  { name: '/new', description: 'start a new chat', run: (ctx) => ctx.chat.newChat() },
  {
    name: '/undo',
    description: 'take back the last turn and the file changes it made (⌃Z)',
    run: async (ctx) => {
      const result = await ctx.chat.undo()
      if ('error' in result) return ctx.app.toast(result.error, 'error')
      ctx.view.setDraft?.(result.text)
      ctx.app.toast('Undone — files restored and your message is back in the box', 'success')
    }
  },
  {
    name: '/redo',
    description: 'put back what /undo took away',
    run: async (ctx) => {
      const result = await ctx.chat.redoTurn()
      if ('error' in result) return ctx.app.toast(result.error, 'error')
      ctx.view.setDraft?.('')
      ctx.app.toast('Redone', 'success')
    }
  },
  {
    name: '/diff',
    description: 'review changed files (this chat, or /diff turn for the last turn)',
    takesArgs: true,
    run: async (ctx, args) => {
      const chat = ctx.chat.active()
      if (!chat) return ctx.app.toast('No chat yet')
      const running = await ctx.chat.runningTurnChanges()
      let files = await ctx.chat.currentChanges()
      let title = running ? 'Changes so far' : 'Changes in this chat'
      if (args.trim().startsWith('turn') || files.length === 0) {
        const last = [...chat.messages].reverse().find((m) => (m as CliMessage).changes?.files.length) as CliMessage | undefined
        if (running?.length) {
          files = running
          title = 'Changes in this turn so far'
        } else if (last?.changes) {
          files = await ctx.chat.turnDiff(last.changes)
          title = 'Changes in the last turn'
        }
      }
      if (!files.length) return ctx.app.toast('No file changes in this chat yet')
      ctx.app.push(new DiffViewer(title, files, ctx.app.screen.width >= 150))
    }
  },
  {
    name: '/init',
    description: 'write or update AGENTS.md so the agent learns this project',
    takesArgs: true,
    run: (ctx, args) => void ctx.chat.send(INIT_PROMPT(args.trim()), { title: 'Write AGENTS.md' })
  },
  {
    name: '/instructions',
    description: 'which AGENTS.md / CLAUDE.md files the agent follows here',
    run: (ctx) => {
      const found = loadInstructions(ctx.chat.cwd)
      ctx.app.push(
        new TextModal('Project instructions', () =>
          found.files.length
            ? [
                ...found.files.map((f) => [{ text: f, style: { fg: C.cyan } }]),
                [],
                ...found.text.split('\n').slice(0, 400).map((l) => [{ text: l }])
              ]
            : [[{ text: 'No AGENTS.md or CLAUDE.md between here and the repository root. /init writes one.', style: { fg: C.muted } }]]
        )
      )
    }
  },
  {
    name: '/lsp',
    description: 'language servers checking the agent\'s edits',
    run: (ctx) => {
      const servers = lspStatus()
      ctx.app.toast(servers.length ? servers.map((s) => `${s.id}: ${s.state}`).join(' · ') : 'No language server started yet; one starts when the agent edits a TypeScript, Python, Go, Rust or C file')
    }
  },
  {
    name: '/sidebar',
    description: 'show or hide the side panel (⌃B)',
    run: (ctx) => {
      if (ctx.view.sidebar === undefined) return
      ctx.view.sidebar = !ctx.view.sidebar
    }
  },
  { name: '/chats', description: 'switch chat, or continue one from Eaon Desktop', run: (ctx) => openChats(ctx.app, ctx.chat) },
  { name: '/model', description: 'models for chat, trading, sub-agents and routing', run: (ctx) => openModelChains(ctx.app) },
  {
    name: '/effort',
    description: 'how hard the model thinks: low, medium, high, max…',
    takesArgs: true,
    run: (ctx, args) => {
      const wanted = args.trim().toLowerCase()
      const model = chatModel()
      const levels = effortsOf(model)
      const match = EFFORT_ORDER.find((e) => e === wanted || EFFORT_LABEL[e].toLowerCase() === wanted || (wanted === 'xhigh' && e === 'extra-high') || (wanted === 'max' && e === 'ultra'))
      if (!match) {
        ctx.app.toast(levels.length ? `Levels for this model: ${levels.map((l) => EFFORT_LABEL[l].toLowerCase()).join(', ')}` : 'This model has no effort setting')
        return
      }
      store.patchSettings({ effort: match as EffortLevel })
      ctx.app.toast(`Effort: ${EFFORT_LABEL[match]}${levels.length && !levels.includes(match) ? ' (this model gets the nearest it has)' : ''}`)
    }
  },
  {
    name: '/approvals',
    description: 'ask · auto (approve for me) · full access',
    takesArgs: true,
    run: (ctx, args) => {
      const value = args.trim().toLowerCase()
      const next = value.startsWith('a') ? 'auto' : value.startsWith('f') ? 'full' : value.startsWith('ask') ? 'ask' : null
      if (!next) return ctx.app.toast(`Approvals: ${store.getSettings().approvalMode}. Say ask, auto or full.`)
      store.patchSettings({ approvalMode: next })
      ctx.app.toast(`Approvals: ${next}`, next === 'full' ? 'error' : 'info')
    }
  },
  {
    name: '/plan',
    description: 'plan before acting (toggle)',
    run: (ctx) => {
      const next = !store.getSettings().planMode
      store.patchSettings({ planMode: next })
      ctx.app.toast(next ? 'Plan mode: the agent proposes a plan first' : 'Plan mode off')
    }
  },
  {
    name: '/swarm',
    description: 'let the agent start parallel sub-agents (toggle)',
    run: (ctx) => {
      const settings = store.getSettings()
      store.patchSettings({ work: { ...settings.work, swarm: !settings.work.swarm } })
      ctx.app.toast(settings.work.swarm ? 'Swarm off' : 'Swarm on')
    }
  },
  {
    name: '/goal',
    description: '/goal <objective> [until 17:30] — keep working until it is done',
    takesArgs: true,
    run: (ctx, args) => {
      const text = args.trim()
      if (!text) return ctx.app.toast('Say what the goal is: /goal get the tests passing')
      const until = parseUntil(text.match(/\buntil\s+(.+)$/i)?.[1] ?? '')
      void ctx.chat.send(text.replace(/\buntil\s+.+$/i, '').trim() || text, { goal: true, ...(until ? { until } : {}) })
    }
  },
  { name: '/stop', description: 'stop the reply', run: (ctx) => ctx.chat.stop() },
  {
    name: '/cwd',
    description: 'the folder the agent works in',
    takesArgs: true,
    run: (ctx, args) => {
      const raw = args.trim()
      if (!raw) return ctx.app.toast(`Working in ${ctx.chat.cwd}`)
      const path = resolve(ctx.chat.cwd, raw.replace(/^~(?=\/|$)/, homedir()))
      if (!existsSync(path) || !statSync(path).isDirectory()) return ctx.app.toast(`No folder at ${path}`, 'error')
      ctx.chat.cwd = path
      ctx.bus?.update({ cwd: path })
      ctx.app.toast(`Working in ${path}`)
    }
  },
  { name: '/key', description: 'add or change a provider’s API key', takesArgs: true, run: (ctx, args) => openKeys(ctx.app, args.trim() || undefined) },
  { name: '/login', description: 'sign in with ChatGPT, GitHub Copilot…', takesArgs: true, run: (ctx, args) => signIn(ctx.app, args.trim() || undefined) },
  { name: '/import', description: 'bring keys, models, plugins and trading setup from Eaon Desktop', run: (ctx) => openImport(ctx.app) },
  { name: '/sessions', description: 'other Eaon, Claude Code and Codex sessions', run: (ctx) => openSessions(ctx.app, ctx.bus, ctx.chat.cwd) },
  {
    name: '/send',
    description: '/send <session> <message> — message another session',
    takesArgs: true,
    run: async (ctx, args) => {
      const m = /^(\S+)\s+([\s\S]+)$/.exec(args.trim())
      if (!m || !ctx.bus) return ctx.app.toast('Usage: /send <session> <message>')
      const result = await ctx.bus.send(m[1], m[2])
      ctx.app.toast(result.delivered ? `Sent to ${result.to?.name}` : (result.error ?? 'Not delivered'), result.delivered ? 'success' : 'error')
    }
  },
  { name: '/connect', description: '/connect claude|codex — let them message Eaon', takesArgs: true, run: (ctx, args) => runConnect(ctx.app, args.trim()) },
  { name: '/disconnect', description: '/disconnect claude|codex', takesArgs: true, run: (ctx, args) => runConnect(ctx.app, args.trim(), true) },
  {
    name: '/open',
    description: '/open claude|codex — start it in a new terminal window here',
    takesArgs: true,
    run: async (ctx, args) => {
      const target = args.trim().startsWith('codex') ? 'codex' : args.trim().startsWith('claude') ? 'claude' : null
      if (!target) return ctx.app.toast('Say claude or codex')
      const result = await openInTerminal(target, ctx.chat.cwd)
      ctx.app.toast(result.message, result.ok ? 'success' : 'error')
    }
  },
  {
    name: '/autoreply',
    description: 'answer other sessions’ messages automatically (on/off)',
    takesArgs: true,
    run: (ctx, args) => {
      ctx.chat.autoReplyToPeers = args.trim() ? /^(on|yes|true)/i.test(args.trim()) : !ctx.chat.autoReplyToPeers
      ctx.app.toast(ctx.chat.autoReplyToPeers ? 'Other sessions’ messages get an answer from the agent' : 'Other sessions’ messages only show up as notices')
    }
  },
  {
    name: '/rename',
    description: 'rename this chat',
    takesArgs: true,
    run: (ctx, args) => {
      if (ctx.chat.activeId && args.trim()) ctx.chat.rename(ctx.chat.activeId, args)
    }
  },
  {
    name: '/delete',
    description: 'delete this chat',
    run: (ctx) => {
      const id = ctx.chat.activeId
      if (!id) return
      openConfirm(ctx.app, 'Delete this chat?', 'It is removed from this computer. This can’t be undone.', () => void ctx.chat.remove(id), true)
    }
  },
  { name: '/mcp', description: 'plugins and their status', run: (ctx) => openMcp(ctx.app) },
  {
    name: '/thinking',
    description: 'show the model’s reasoning (toggle)',
    run: (ctx) => {
      ctx.view.showThinking = !ctx.view.showThinking
      ctx.app.toast(ctx.view.showThinking ? 'Showing reasoning' : 'Hiding reasoning')
    }
  },
  { name: '/verbose', description: 'show tool output in full (toggle, ⌃O)', run: (ctx) => void (ctx.view.verbose = !ctx.view.verbose) },
  {
    name: '/mouse',
    description: 'mouse on or off: wheel scrolling and drag-to-copy, or your terminal\'s own selection',
    run: (ctx) => {
      ctx.app.setMouse(!ctx.app.mouse)
      ctx.app.toast(ctx.app.mouse ? 'Mouse on — the wheel scrolls; drag over text to copy it' : 'Mouse off — your terminal selects text; PgUp/PgDn scroll')
    }
  },
  { name: '/chat', description: 'the chat tab', run: (ctx) => mode(ctx, 'chat')() },
  { name: '/claude', description: 'Claude Code, connected to Eaon with full control (esc leaves)', run: (ctx) => mode(ctx, 'claude')() },
  {
    name: '/accounts',
    description: 'link trading accounts: Robinhood, IBKR, Webull, Tradier or any broker’s MCP server',
    run: (ctx) => {
      ctx.app.switchMode('trading')
      ctx.app.push(new LinkedAccountsModal(ctx.app.views.trading as unknown as TradingView))
    }
  },
  { name: '/workers', description: 'the workers tab', run: (ctx) => mode(ctx, 'workers')() },
  { name: '/trading', description: 'the trading desk', run: (ctx) => mode(ctx, 'trading')() },
  { name: '/update', description: 'install the newest Eaon CLI from npm, or check for one', run: (ctx) => openUpdate(ctx.app) },
  { name: '/help', description: 'keys and commands', run: (ctx) => openHelp(ctx.app) },
  { name: '/quit', description: 'leave Eaon', run: (ctx) => void ctx.app.quit() }
]

export function matchCommands(prefix: string): Command[] {
  const p = prefix.toLowerCase()
  const starts = COMMANDS.filter((c) => c.name.startsWith(p))
  return starts.length ? starts : COMMANDS.filter((c) => c.name.includes(p.slice(1)) || c.description.toLowerCase().includes(p.slice(1)))
}

export async function runSlash(ctx: SlashContext, line: string): Promise<void> {
  const [name, ...rest] = line.trim().split(/\s+/)
  const args = line.trim().slice(name.length).trim()
  const command = COMMANDS.find((c) => c.name === name.toLowerCase()) ?? (rest.length === 0 ? matchCommands(name)[0] : undefined)
  if (!command) {
    ctx.app.toast(`Unknown command ${name} — /help lists them`, 'error')
    return
  }
  try {
    await command.run(ctx, args)
  } catch (error) {
    ctx.app.toast(error instanceof Error ? error.message : String(error), 'error')
  }
  ctx.app.invalidate()
}
