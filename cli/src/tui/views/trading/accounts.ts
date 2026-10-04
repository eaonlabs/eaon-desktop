import { randomUUID } from 'node:crypto'
import { BROKER_PLUGINS, type McpCatalogEntry } from '@shared/mcpCatalog'
import type { PluginSignInResult } from '@shared/plugins'
import type { TradingSnapshot } from '@shared/trading'
import type { McpServer, McpServerStatus } from '@shared/types'
import { getStatuses, syncMcpServers } from '@main/mcp'
import { store } from '@main/store'
import { shell } from 'electron'
import { invoke } from '../../../runtime/ipc'
import { EditForm } from '../../form'
import type { InputEvent } from '../../input'
import { ConfirmModal, frame, PromptModal, type Modal } from '../../modals'
import type { Canvas } from '../../screen'
import { truncate, wrap } from '../../term'
import { C, S } from '../../theme'
import { keyHints, spinner } from '../../widgets'
import { linkAlpaca, openSetup, setConfig } from './forms'
import type { TradingView } from './index'

/**
 * Linked trading accounts. First the accounts the agent's sessions trade:
 * Alpaca paper and live, by API key, with Eaon's limits in front of every
 * order (ACCOUNT on the desk picks which). Then brokers connected over MCP,
 * by browser sign-in (OAuth) or an API key — Robinhood's agentic account,
 * Interactive Brokers, Webull, Tradier — plus any other broker's MCP server
 * added by hand (Alpaca's, tastytrade's, Coinbase's local servers…).
 *
 * Linking writes the same MCP server rows and vault entries the desktop's
 * plugin catalog does (the `plugins:*` channels), so a linked account is a
 * plugin like any other: the trading chat, workers and Claude Code can use
 * its tools, and every order through it asks the user first (or is
 * confirmed in the broker's own app), as the trading-access rules say. The
 * agent's sessions keep trading the desk's account (simulator or Alpaca),
 * where Eaon's own limits stand in front of every order.
 */

type Row = { kind: 'alpaca'; mode: 'paper' | 'live' } | { kind: 'broker'; entry: McpCatalogEntry } | { kind: 'custom'; server: McpServer } | { kind: 'add' }

const ALPACA_KEYS_URL = 'https://app.alpaca.markets'

const serverIdFor = (pluginId: string): string => `plugin-${pluginId}`
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class LinkedAccountsModal implements Modal {
  close?: () => void
  private selected = 0
  private connected = new Set<string>()
  private waiting: string | null = null
  private note = ''

  constructor(private readonly view: TradingView) {
    void this.refresh()
  }

  private async refresh(): Promise<void> {
    try {
      this.connected = new Set(await invoke<string[]>('plugins:connected'))
    } catch {
      /* plugins not registered in this session */
    }
    this.view.app.invalidate()
  }

  /** The agent's Alpaca accounts, brokers from the catalog, then servers the user added that look like brokers, then "add another". */
  private rows(): Row[] {
    const pluginIds = new Set(BROKER_PLUGINS().map((e) => e.id))
    const custom = store.getMcpServers().filter((s) => !s.pluginId && s.id.startsWith('broker-'))
    return [
      { kind: 'alpaca', mode: 'paper' },
      { kind: 'alpaca', mode: 'live' },
      ...BROKER_PLUGINS().map((entry): Row => ({ kind: 'broker', entry })), ...custom.filter((s) => !pluginIds.has(s.id)).map((server): Row => ({ kind: 'custom', server })), { kind: 'add' }]
  }

  private status(serverId: string): McpServerStatus | undefined {
    return getStatuses().find((s) => s.serverId === serverId)
  }

  draw(c: Canvas): void {
    const bg = '#111113'
    const rows = this.rows()
    this.selected = Math.max(0, Math.min(this.selected, rows.length - 1))
    const width = Math.min(c.w - 4, 110)
    const height = Math.min(c.h - 2, rows.length + 16)
    const inner = frame(c, width, height, '⇄ Linked trading accounts')
    const intro = wrap(
      'Link the account the agent trades — Alpaca, with its API keys — and brokers over MCP (a browser sign-in or an API key), whose tools reach the trading chat, workers and Claude Code.',
      inner.w
    )
    intro.forEach((line, i) => inner.text(0, 1 + i, line, { fg: C.muted, bg }))
    let y = 2 + intro.length
    const header = ['ACCOUNT', 'HOW', 'STATUS', 'WHAT THE AGENT CAN DO']
    const xs = [2, 26, 38, 54]
    header.forEach((h, i) => inner.text(xs[i], y, h, { fg: C.amber, bg, bold: true }))
    y++
    rows.forEach((row, i) => {
      const active = i === this.selected
      const rowBg = active ? C.teal : bg
      inner.fill(0, y, inner.w, 1, { bg: rowBg })
      if (row.kind === 'alpaca') {
        const keys = this.view.snapshot?.keys[row.mode]
        const trading = this.view.snapshot?.config.broker === `alpaca-${row.mode}`
        const state = !keys ? { text: 'not linked', style: { fg: C.muted } } : trading ? { text: '● agent trades it', style: { fg: C.green, bold: true } } : { text: '● linked', style: { fg: C.green } }
        inner.text(2, y, `${row.mode === 'paper' ? '◇' : '◆'} Alpaca ${row.mode}`, { fg: active ? C.tealText : row.mode === 'live' ? C.red : C.text, bg: rowBg, bold: true })
        inner.text(xs[1], y, 'API keys', { fg: C.muted, bg: rowBg })
        inner.text(xs[2], y, state.text, { ...state.style, bg: rowBg })
        inner.text(xs[3], y, truncate(`the agent trades it · Eaon’s limits on every order${row.mode === 'live' ? ' · real money' : ''}`, inner.w - xs[3]), { fg: active ? C.tealText : C.muted, bg: rowBg })
      } else if (row.kind === 'add') {
        inner.text(2, y, '+ Another broker’s MCP server…', { fg: active ? C.tealText : C.cyan, bg: rowBg, bold: active })
        inner.text(xs[3], y, 'Alpaca, tastytrade, Coinbase, Kraken… any MCP server', { fg: C.muted, bg: rowBg }, inner.w - xs[3])
      } else {
        const id = row.kind === 'broker' ? row.entry.id : row.server.id
        const serverId = row.kind === 'broker' ? serverIdFor(id) : row.server.id
        const linked = row.kind === 'broker' ? this.connected.has(id) : true
        const st = this.status(serverId)
        const state =
          this.waiting === id
            ? { text: `${spinner()} signing in…`, style: { fg: C.amber } }
            : !linked
              ? { text: 'not linked', style: { fg: C.muted } }
              : st?.state === 'ready'
                ? { text: `● linked · ${st.toolCount} tools`, style: { fg: C.green } }
                : st?.state === 'needs-auth'
                  ? { text: '◐ sign in again', style: { fg: C.yellow } }
                  : st?.state === 'error'
                    ? { text: '✗ error', style: { fg: C.red } }
                    : { text: '◌ connecting', style: { fg: C.muted } }
        const name = row.kind === 'broker' ? row.entry.displayName : row.server.name
        const how = row.kind === 'broker' ? (row.entry.authMode === 'oauth' ? 'sign-in' : 'API key') : row.server.transport === 'http' ? 'MCP URL' : 'local'
        const what = row.kind === 'broker' ? (row.entry.tradingNote ?? row.entry.summary) : 'Your own server: its orders always ask you first.'
        inner.text(2, y, `${row.kind === 'broker' && row.entry.realMoney === false ? '◇' : '◆'} ${name}`, { fg: active ? C.tealText : C.text, bg: rowBg, bold: true })
        inner.text(xs[1], y, how, { fg: C.muted, bg: rowBg })
        inner.text(xs[2], y, state.text, { ...state.style, bg: rowBg })
        inner.text(xs[3], y, truncate(what, inner.w - xs[3]), { fg: active ? C.tealText : C.muted, bg: rowBg })
      }
      y++
    })
    y++
    // About the selected one.
    const row = rows[this.selected]
    const detail =
      row?.kind === 'alpaca'
        ? [
            `Alpaca ${row.mode}: the agent’s sessions trade it — Eaon’s agent or Claude Code — and every order passes your limits first. ${row.mode === 'paper' ? 'Practice money.' : 'Real money: switching the agent to it asks you to type a confirmation.'}`,
            this.view.snapshot?.keys[row.mode] ? '⏎ has the agent trade it; d unlinks.' : `⏎ pastes its API keys (o opens ${ALPACA_KEYS_URL}).`
          ]
        : row?.kind === 'broker'
        ? [
            `${row.entry.displayName}: ${row.entry.summary} ${row.entry.realMoney === false ? 'Practice money.' : 'Real money.'}`,
            ...(row.entry.tokenHint ? [row.entry.tokenHint] : []),
            ...(this.status(serverIdFor(row.entry.id))?.error ? [`Last error: ${this.status(serverIdFor(row.entry.id))!.error}`] : [])
          ]
        : row?.kind === 'custom'
          ? [`${row.server.name}: ${row.server.transport === 'http' ? row.server.url : [row.server.command, ...row.server.args].join(' ')}`]
          : ['Add a broker’s own MCP server: a URL (sign in with the browser if it asks) or a local command, e.g. uvx alpaca-mcp-server.']
    for (const line of detail.flatMap((d) => wrap(d, inner.w - 2))) if (y < inner.h - 4) inner.text(0, y++, line, { fg: C.muted, bg })
    const footer =
      'The agent’s sessions trade the simulator or an Alpaca account, where Eaon’s limits check every order. Brokers linked over MCP are for the trading chat (0), workers and Claude Code; each order through one asks you first or is confirmed in the broker’s app.'
    const footLines = wrap(footer, inner.w)
    footLines.forEach((line, i) => inner.text(0, inner.h - 2 - footLines.length + i, line, { fg: C.faint, bg }))
    if (this.note) inner.text(0, inner.h - 2, this.note, { fg: C.yellow, bg }, inner.w)
    keyHints(inner, 0, inner.h - 1, [['↑↓', 'account'], ['⏎', row?.kind === 'alpaca' && this.view.snapshot?.keys[row.mode] ? 'agent trades it' : 'link'], ['d', 'unlink'], ['o', 'get a key'], ['esc', 'close']], inner.w, bg)
  }

  onEvent(event: InputEvent): void {
    if (event.type !== 'key') return
    const rows = this.rows()
    const row = rows[this.selected]
    switch (event.name) {
      case 'escape':
        if (this.waiting) {
          void invoke('plugins:cancel-sign-in', { pluginId: this.waiting }).catch(() => {})
          this.waiting = null
          this.note = 'Sign-in cancelled.'
          return
        }
        return this.close?.()
      case 'up':
        this.selected = Math.max(0, this.selected - 1)
        this.note = ''
        return
      case 'down':
        this.selected = Math.min(rows.length - 1, this.selected + 1)
        this.note = ''
        return
      case 'enter':
        if (!row) return
        if (row.kind === 'alpaca') return this.useAlpaca(row.mode)
        if (row.kind === 'add') return this.addServer()
        if (row.kind === 'broker') return this.link(row.entry)
        return
    }
    if (event.ch === 'd' && row?.kind === 'alpaca') {
      if (!this.view.snapshot?.keys[row.mode]) return
      this.view.app.push(
        new ConfirmModal({
          title: `Unlink Alpaca ${row.mode}?`,
          body: `Eaon forgets its API keys.${this.view.snapshot?.config.broker === `alpaca-${row.mode}` ? ' The agent goes back to the simulator, and a running session stops.' : ''} Nothing changes in the account itself.`,
          yes: 'unlink',
          onAnswer: (yes) => {
            if (!yes) return
            void invoke<TradingSnapshot>('trading:clear-keys', row.mode)
              .then((snapshot) => (this.view.snapshot = snapshot))
              .catch((error) => (this.note = message(error)))
          }
        })
      )
      return
    }
    if (event.ch === 'o' && row?.kind === 'alpaca') return void shell.openExternal(ALPACA_KEYS_URL)
    if (event.ch === 'd' && row && row.kind !== 'add' && row.kind !== 'alpaca') {
      const name = row.kind === 'broker' ? row.entry.displayName : row.server.name
      this.view.app.push(
        new ConfirmModal({
          title: `Unlink ${name}?`,
          body: 'Eaon forgets its sign-in or key, and its tools go away. Nothing changes in the account itself.',
          yes: 'unlink',
          onAnswer: (yes) => {
            if (!yes) return
            const work =
              row.kind === 'broker'
                ? invoke('plugins:disconnect', row.entry.id)
                : (async () => {
                    store.saveMcpServers(store.getMcpServers().filter((s) => s.id !== row.server.id))
                    await syncMcpServers()
                  })()
            void work.then(() => this.refresh()).catch((error) => (this.note = message(error)))
          }
        })
      )
    }
    if (event.ch === 'o' && row?.kind === 'broker' && row.entry.tokenCreationURL) void shell.openExternal(row.entry.tokenCreationURL)
  }

  /** ⏎ on an Alpaca row: link it (its keys), then offer to have the agent trade it. */
  private useAlpaca(mode: 'paper' | 'live'): void {
    const broker = `alpaca-${mode}` as const
    const switchTo = (): void => {
      const s = this.view.snapshot
      if (!s || s.config.broker === broker) return
      // Real money takes its typed confirmation, which the setup asks for.
      if (mode === 'live' && !s.config.liveConfirmedAt) {
        this.close?.()
        return openSetup(this.view)
      }
      this.view.app.push(
        new ConfirmModal({
          title: `Have the agent trade Alpaca ${mode}?`,
          body: `Its sessions — Eaon’s agent or Claude Code — trade this account from now on${mode === 'live' ? ', with real money' : ''}, with your limits in front of every order.${s.activeSession ? ' The running session stops.' : ''}`,
          yes: 'switch',
          danger: mode === 'live',
          onAnswer: (yes) => {
            if (!yes) return
            void setConfig(this.view, { broker })
              .then(() => this.view.app.toast(`The agent trades Alpaca ${mode}`, mode === 'live' ? 'error' : 'success'))
              .catch((error) => (this.note = message(error)))
          }
        })
      )
    }
    if (this.view.snapshot?.keys[mode]) return switchTo()
    linkAlpaca(this.view, mode, switchTo)
  }

  private link(entry: McpCatalogEntry): void {
    if (entry.authMode === 'pastedToken') {
      this.view.app.push(
        new PromptModal({
          title: `${entry.displayName} — API key`,
          label: `${entry.tokenHint ?? ''}${entry.tokenCreationURL ? `${entry.tokenHint ? '\n' : ''}Get one at ${entry.tokenCreationURL} (o opens it).` : ''}`,
          placeholder: entry.tokenFieldPlaceholder,
          mask: true,
          onSubmit: async (token) => {
            if (!token.trim()) return 'Paste the key.'
            try {
              await invoke('plugins:connect', entry.id, token.trim())
              await this.refresh()
              this.view.app.toast(`${entry.displayName} linked`, 'success')
            } catch (error) {
              return message(error)
            }
          }
        })
      )
      return
    }
    // Browser sign-in: Eaon opens the broker's page and waits for it to send the browser back.
    const signIn = (client?: { clientId: string; clientSecret?: string }): void => {
      this.waiting = entry.id
      this.note = `Finish signing in to ${entry.displayName} in your browser. Esc cancels.`
      void invoke<PluginSignInResult>('plugins:sign-in', { pluginId: entry.id }, client)
        .then((result) => {
          this.waiting = null
          if (result.ok) {
            this.note = ''
            this.view.app.toast(`${entry.displayName} linked`, 'success')
          } else if (result.needsClientId) {
            this.note = ''
            this.askClientId(entry, signIn)
          } else this.note = result.error ?? 'The sign-in didn’t finish.'
          return this.refresh()
        })
        .catch((error) => {
          this.waiting = null
          this.note = message(error)
        })
    }
    signIn()
  }

  private askClientId(entry: McpCatalogEntry, retry: (client: { clientId: string; clientSecret?: string }) => void): void {
    this.view.app.push(
      new EditForm({
        title: `${entry.displayName} needs an app of yours`,
        intro: `${entry.displayName} doesn’t register apps on its own. Create an OAuth app${entry.manualClientIdSetupURL ? ` at ${entry.manualClientIdSetupURL}` : ' in its developer settings'}${entry.manualClientIdHint ? ` (${entry.manualClientIdHint})` : ''}, then paste its client id.`,
        width: 90,
        fields: [
          { key: 'clientId', label: 'Client id', kind: 'text' },
          ...(entry.manualClientNeedsSecret ? [{ key: 'clientSecret', label: 'Client secret', kind: 'secret' as const }] : [])
        ],
        onSubmit: (v) => {
          if (!v.clientId?.trim()) return 'Paste the client id.'
          retry({ clientId: v.clientId.trim(), ...(v.clientSecret?.trim() ? { clientSecret: v.clientSecret.trim() } : {}) })
        }
      })
    )
  }

  private addServer(): void {
    this.view.app.push(
      new EditForm({
        title: 'Link another broker’s MCP server',
        intro: 'A URL for a hosted server (Eaon signs in through your browser if it asks), or the command that starts a local one. Orders through it always ask you first.',
        width: 92,
        fields: [
          { key: 'name', label: 'Name', kind: 'text', placeholder: 'e.g. Alpaca MCP' },
          { key: 'target', label: 'URL or command', kind: 'text', placeholder: 'https://… or uvx alpaca-mcp-server serve' },
          { key: 'env', label: 'Environment', kind: 'text', placeholder: 'optional: KEY=value KEY2=value (API keys for a local server)' }
        ],
        onSubmit: async (v) => {
          const name = v.name?.trim()
          const target = v.target?.trim()
          if (!name || !target) return 'Give it a name and a URL or command.'
          const http = /^https?:\/\//.test(target)
          const parts = target.split(/\s+/)
          const env = Object.fromEntries(
            (v.env ?? '')
              .split(/\s+/)
              .filter((pair) => pair.includes('='))
              .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)])
          )
          const server: McpServer = {
            id: `broker-${randomUUID().slice(0, 8)}`,
            name,
            transport: http ? 'http' : 'stdio',
            command: http ? '' : parts[0],
            args: http ? [] : parts.slice(1),
            env,
            url: http ? target : '',
            enabled: true,
            official: false
          }
          store.saveMcpServers([...store.getMcpServers(), server])
          try {
            await syncMcpServers()
          } catch (error) {
            return message(error)
          }
          if (http && getStatuses().find((s) => s.serverId === server.id)?.state === 'needs-auth') {
            void invoke<PluginSignInResult>('plugins:sign-in', { serverId: server.id }).then((r) => (this.note = r.ok ? `${name} linked` : (r.error ?? 'Sign-in didn’t finish.')))
            this.note = `Finish signing in to ${name} in your browser.`
          }
          await this.refresh()
        }
      })
    )
  }
}

/** How many accounts are linked, for mission control: Alpaca's (from the snapshot) and brokers over MCP. */
export function linkedCount(snapshot?: TradingSnapshot | null): number {
  const servers = store.getMcpServers()
  const plugins = new Set(servers.map((s) => s.pluginId).filter(Boolean))
  const alpaca = (snapshot?.keys.paper ? 1 : 0) + (snapshot?.keys.live ? 1 : 0)
  return alpaca + BROKER_PLUGINS().filter((e) => plugins.has(e.id)).length + servers.filter((s) => s.id.startsWith('broker-')).length
}
