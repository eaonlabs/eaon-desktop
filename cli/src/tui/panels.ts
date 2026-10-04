import type { ModelInfo, Provider } from '@shared/types'
import { CLI_BETA, CLI_VERSION } from '../core/version'
import type { ProviderAuthStatus } from '@shared/providers'
import type { TradingSnapshot } from '@shared/trading'
import { EFFORT_LABEL } from '@shared/effort'
import { listProviders, refreshModels } from '@main/providers'
import { secrets } from '@main/secrets'
import { store } from '@main/store'
import { getStatuses } from '@main/mcp'
import type { BusNode, PeerInfo } from '../bus/bus'
import { claudeSessions, codexSessions, connect, connectionStatus, disconnect, openInTerminal, type ConnectionStatus } from '../bus/external'
import type { ChatController } from '../core/chat'
import { continueDesktopChat, declineFirstRunImport, desktopChats, findDesktop, importFromDesktop, planImport, type ImportChoices } from '../core/desktop'
import { availableModels, chatModel, effortsOf, modelLabel, providerName, roleRows, type ModelRole } from '../core/models'
import { events, hasHandler, invoke } from '../runtime/ipc'
import type { App } from './app'
import type { InputEvent } from './input'
import { ConfirmModal, FormModal, frame, PickerModal, PromptModal, TextModal, type FormRow, type Modal, type PickItem } from './modals'
import type { Canvas } from './screen'
import { strWidth, truncate } from './term'
import { C, S } from './theme'
import { ago, keyHints } from './widgets'

/**
 * The dialogs behind the slash commands: models, keys and sign-in, chats,
 * other sessions, the desktop import, plugins and help.
 */

/* ================================================================ models */

/** All models as picker items, grouped by provider. */
function modelItems(models: ModelInfo[], extra: PickItem<ModelInfo | null>[] = []): PickItem<ModelInfo | null>[] {
  return [
    ...extra,
    ...models.map((m) => ({
      label: modelLabel(m),
      detail: m.id !== modelLabel(m) ? m.id : undefined,
      tag: `${providerName(m.providerId)}${m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k` : ''}${m.reasoning ? ' · thinks' : ''}`,
      value: m as ModelInfo | null
    }))
  ]
}

export function openModelPicker(app: App, onPick: (model: ModelInfo | null) => void, options: { title?: string; follow?: string; current?: ModelInfo | null } = {}): void {
  const models = availableModels()
  if (models.length === 0) {
    app.toast('No models yet — /keys, /import or /login first', 'error')
    return
  }
  app.push(
    new PickerModal<ModelInfo | null>({
      title: options.title ?? 'Pick a model',
      items: modelItems(models, options.follow ? [{ label: options.follow, tag: 'default', value: null }] : []),
      onPick,
      initial: (m) => (options.current ? m?.id === options.current.id && m?.providerId === options.current.providerId : m === null),
      width: 100
    })
  )
}

/**
 * Models per job, in the "model chains" style: chat, trading sessions,
 * swarm sub-agents and plugin routing, each with its model and effort.
 */
export function openModelChains(app: App): void {
  let trading: TradingSnapshot['config'] | null = null
  const loadTrading = (): void => {
    if (!hasHandler('trading:snapshot')) return
    void invoke<TradingSnapshot>('trading:snapshot').then((s) => {
      trading = s.config
      app.invalidate()
    }, () => {})
  }
  loadTrading()
  const onTrading = (snapshot: TradingSnapshot): void => {
    trading = snapshot.config
  }
  events.on('trading:changed', onTrading)

  const step = <T>(list: T[], current: number, by: 1 | -1): T => list[(current + by + list.length) % list.length]
  const setRole = async (role: ModelRole, model: ModelInfo | null): Promise<void> => {
    if (role === 'chat') {
      if (model) store.patchSettings({ selectedModelId: model.id, selectedProviderId: model.providerId })
    } else if (role === 'trading') {
      if (!hasHandler('trading:set-config')) throw new Error('The trading desk isn’t running in this session.')
      const snapshot = await invoke<TradingSnapshot>('trading:set-config', { model: model ? { providerId: model.providerId, modelId: model.id } : null })
      trading = snapshot.config
    } else if (role === 'subagents') {
      store.patchSettings({ work: { ...store.getSettings().work, subagentModelId: model?.id ?? null } })
    } else {
      store.patchSettings({ mcp: { ...store.getSettings().mcp, useDedicatedRoutingModel: model !== null, routingModelId: model?.id ?? null } })
    }
  }

  const modal = new FormModal({
    title: '⍑ EAON · Model chains',
    columns: ['ROLE', 'HEAD MODEL', 'EFFORT', 'STATE'],
    width: 108,
    rows: () => {
      const models = availableModels()
      const settings = store.getSettings()
      return roleRows(trading?.model ?? null, settings).map((row): FormRow => {
        const efforts = effortsOf(row.effective)
        return {
          label: row.label,
          value: () => (row.model ? modelLabel(row.model) : row.role === 'chat' ? 'no model' : `${modelLabel(row.effective)}  (follows chat)`),
          valueStyle: () => (row.model || row.role === 'chat' ? { fg: C.text } : { fg: C.muted }),
          level: () => {
            if (!row.effort || efforts.length === 0) return null
            return { index: efforts.indexOf(row.effort), count: efforts.length, label: EFFORT_LABEL[row.effort].toLowerCase() + (row.role === 'chat' ? '' : ' (chat’s)') }
          },
          state: () => (row.override ? 'override' : 'default'),
          cycle: async (by) => {
            const options: (ModelInfo | null)[] = row.role === 'chat' ? models : [null, ...models]
            const at = options.findIndex((m) => (m === null ? row.model === null : row.model?.id === m.id && row.model?.providerId === m.providerId))
            await setRole(row.role, step(options, Math.max(0, at), by))
          },
          adjust:
            row.role === 'chat' && efforts.length
              ? (by) => {
                  const at = Math.max(0, efforts.indexOf(row.effort ?? efforts[0]))
                  const next = efforts[Math.max(0, Math.min(efforts.length - 1, at + by))]
                  store.patchSettings({ effort: next })
                }
              : undefined,
          edit: () =>
            openModelPicker(app, (model) => void setRole(row.role, model).catch((e) => app.toast(String(e instanceof Error ? e.message : e), 'error')), {
              title: `Model for ${row.label}`,
              follow: row.role === 'chat' ? undefined : 'Follow the chat model',
              current: row.model
            }),
          reset: async () => {
            if (row.role === 'chat') store.patchSettings({ selectedModelId: null, selectedProviderId: null })
            else await setRole(row.role, null)
          },
          detail: () => {
            const m = row.effective
            return [
              row.description,
              m
                ? `${providerName(m.providerId)} · ${m.id}${m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k context` : ''}${efforts.length ? ` · effort ${efforts.map((e) => EFFORT_LABEL[e].toLowerCase()).join(', ')}` : ''}`
                : 'No model available.'
            ]
          }
        }
      })
    },
    footer: () => {
      const models = availableModels()
      const providers = new Set(models.map((m) => m.providerId)).size
      return `${models.length} model${models.length === 1 ? '' : 's'} from ${providers} provider${providers === 1 ? '' : 's'} · changes save as you make them`
    },
    hints: [['↑↓', 'role'], ['←→', 'head model'], ['-/+', 'effort'], ['⏎', 'pick from list'], ['d', 'default'], ['esc', 'close']]
  })
  const originalClose = (): void => {
    events.off('trading:changed', onTrading)
  }
  // Wraps the form so closing it also stops listening for the desk's changes.
  app.push({
    draw: (c) => modal.draw(c),
    onEvent: (e) => modal.onEvent(e),
    set close(fn: (() => void) | undefined) {
      modal.close = () => {
        originalClose()
        fn?.()
      }
    },
    get close() {
      return modal.close
    }
  } as Modal)
}

/* ========================================================== keys, sign-in */

function providerTag(p: Provider): { tag: string; style: { fg: string } } {
  if (p.local) return { tag: 'local', style: { fg: C.muted } }
  if (p.auth === 'oauth') return p.signedIn ? { tag: 'signed in', style: { fg: C.green } } : { tag: 'sign in', style: { fg: C.muted } }
  return p.hasKey ? { tag: `key ✓ ${p.models.length} models`, style: { fg: C.green } } : { tag: 'no key', style: { fg: C.faint } }
}

/** Runs a provider's browser sign-in and shows its progress (the URL, a device code) until it ends. */
export function signIn(app: App, providerId?: string): void {
  if (!hasHandler('provider-auth:sign-in')) return app.toast('Sign-in isn’t available', 'error')
  if (!providerId) {
    const oauth = listProviders().filter((p) => p.auth === 'oauth')
    app.push(
      new PickerModal<Provider>({
        title: 'Sign in',
        items: oauth.map((p) => ({ label: p.name, detail: p.description, tag: p.signedIn ? 'signed in' : '', tagStyle: { fg: C.green }, value: p })),
        onPick: (p) => signIn(app, p.id)
      })
    )
    return
  }
  let status: ProviderAuthStatus | null = null
  const onStatus = (next: ProviderAuthStatus): void => {
    if (next.providerId !== providerId) return
    status = next
    app.invalidate()
  }
  events.on('provider-auth:status', onStatus)
  const name = listProviders().find((p) => p.id === providerId)?.name ?? providerId
  const modal: Modal = {
    draw(c: Canvas) {
      const inner = frame(c, 76, 11, `Sign in · ${name}`)
      const bg = '#111113'
      if (!status || status.state === 'pending') {
        inner.text(0, 1, 'Finish signing in in your browser.', { fg: C.text, bg })
        if (status?.prompt?.url) inner.text(0, 3, truncate(status.prompt.url, inner.w), { fg: C.cyan, bg, underline: true })
        if (status?.prompt?.code) inner.segments(0, 5, [{ text: 'Code: ', style: { fg: C.muted, bg } }, { text: status.prompt.code, style: { fg: C.amber, bg, bold: true } }])
        if (status?.prompt?.message) inner.text(0, 6, status.prompt.message, { fg: C.muted, bg }, inner.w)
      } else if (status.signedIn) {
        inner.text(0, 1, `Signed in${status.account ? ` as ${status.account}` : ''}.`, { fg: C.green, bg, bold: true })
      } else inner.text(0, 1, status.error ?? 'Sign-in didn’t finish.', { fg: C.red, bg }, inner.w)
      keyHints(inner, 0, inner.h - 1, [['esc', status?.state === 'pending' || !status ? 'cancel' : 'close']], inner.w, bg)
    },
    onEvent(event: InputEvent) {
      if (event.type === 'key' && (event.name === 'escape' || event.name === 'enter')) {
        if (!status || status.state === 'pending') void invoke('provider-auth:cancel', providerId)
        events.off('provider-auth:status', onStatus)
        modal.close?.()
      }
    }
  }
  app.push(modal)
  void invoke<ProviderAuthStatus>('provider-auth:sign-in', providerId).then(
    (final) => {
      onStatus(final)
      if (final.signedIn) {
        events.emit('providers:changed')
        app.toast(`${name}: signed in`, 'success')
      }
    },
    (error) => app.toast(error instanceof Error ? error.message : String(error), 'error')
  )
}

/* ================================================================= chats */

export function openChats(app: App, chat: ChatController): void {
  type Item = { kind: 'cli'; id: string } | { kind: 'desktop'; id: string } | { kind: 'new' }
  app.push(
    new PickerModal<Item>({
      title: 'Chats',
      width: 100,
      items: () => {
        const items: PickItem<Item>[] = [{ label: '+ New chat', value: { kind: 'new' } }]
        for (const c of chat.list())
          items.push({
            label: `${c.pinned ? '★ ' : ''}${c.title}`,
            detail: `${c.messages} messages`,
            tag: `${chat.isRunning(c.id) ? '● ' : ''}${ago(c.updatedAt)} ago${c.origin === 'desktop' ? ' · from desktop' : ''}`,
            tagStyle: { fg: chat.isRunning(c.id) ? C.amber : C.muted },
            value: { kind: 'cli', id: c.id }
          })
        if (findDesktop())
          for (const d of desktopChats().slice(0, 40))
            items.push({ label: d.title, detail: `${d.messages.length} messages`, tag: `Eaon Desktop · ${ago(d.updatedAt)} ago`, tagStyle: { fg: C.purple }, value: { kind: 'desktop', id: d.id } })
        return items
      },
      onPick: (item) => {
        if (item.kind === 'new') return chat.newChat()
        if (item.kind === 'cli') return void chat.open(item.id)
        const copy = continueDesktopChat(item.id)
        if (copy) {
          chat.open(copy.id)
          app.toast('Continuing the desktop chat here (the desktop copy is unchanged)')
        }
      },
      hints: [['⌃D', 'delete'], ['⌃E', 'pin']],
      onKey: (key, item) => {
        if (item.kind !== 'cli') return false
        if (key === 'ctrl+d') {
          void chat.remove(item.id)
          app.toast('Chat deleted')
          return true
        }
        if (key === 'ctrl+e') {
          chat.togglePin(item.id)
          return true
        }
        return false
      }
    })
  )
}

/* ============================================================== sessions */

/** Other sessions on this machine, and Claude Code and Codex: who's there, and connecting to them. */
export function openSessions(app: App, bus: BusNode | null, cwd: string): void {
  if (!bus) return app.toast('This session isn’t on the bus', 'error')
  let status: ConnectionStatus | null = null
  void connectionStatus().then((s) => {
    status = s
    app.invalidate()
  })
  let selected = 0
  const claude = claudeSessions(cwd, 3)
  const codex = codexSessions(cwd, 3)
  const modal: Modal = {
    draw(c: Canvas) {
      const peers = bus.peers()
      const height = Math.min(c.h - 2, 18 + peers.length + claude.length + codex.length)
      const inner = frame(c, 104, height, 'Sessions')
      const bg = '#111113'
      let y = 0
      inner.segments(0, y++, [
        { text: 'This session  ', style: { fg: C.muted, bg } },
        { text: bus.self.name, style: { fg: C.cyan, bg, bold: true } },
        { text: `   ${bus.self.owner ? 'runs the workers and trading engines' : 'uses the engines of the session that runs them'}`, style: { fg: C.faint, bg } }
      ])
      y++
      inner.text(0, y++, 'LIVE SESSIONS', { fg: C.amber, bg, bold: true })
      if (peers.length === 0) inner.text(2, y++, 'No other sessions. Open eaon in another terminal, or connect Claude Code / Codex below.', { fg: C.faint, bg }, inner.w - 2)
      selected = Math.min(selected, Math.max(0, peers.length - 1))
      peers.forEach((p: PeerInfo, i) => {
        const active = i === selected
        const rowBg = active ? C.teal : bg
        inner.fill(0, y, inner.w, 1, { bg: rowBg })
        inner.text(0, y, active ? '▌' : ' ', { fg: C.cyan, bg: rowBg })
        inner.text(2, y, truncate(p.name, 28), { fg: active ? C.tealText : C.text, bg: rowBg, bold: true })
        const kind = p.kind === 'claude-code' ? 'Claude Code' : p.kind === 'codex' ? 'Codex' : p.kind === 'eaon' ? 'Eaon CLI' : 'other'
        inner.text(32, y, kind, { fg: p.kind === 'eaon' ? C.amber : C.purple, bg: rowBg })
        inner.text(46, y, truncate(p.cwd.replace(process.env.HOME ?? '', '~'), 34), { fg: C.muted, bg: rowBg })
        inner.text(82, y, `${p.mode ?? ''}${p.owner ? ' ◆' : ''}`, { fg: C.muted, bg: rowBg }, inner.w - 82)
        y++
      })
      y++
      inner.text(0, y++, 'CLAUDE CODE AND CODEX', { fg: C.amber, bg, bold: true })
      const line = (label: string, s: { installed: boolean; connected: boolean } | undefined, keys: string): void => {
        const state = !s ? 'checking…' : !s.installed ? 'not installed' : s.connected ? 'connected — its sessions can message Eaon' : 'not connected'
        inner.segments(2, y++, [
          { text: label.padEnd(14), style: { fg: C.text, bg, bold: true } },
          { text: state.padEnd(46), style: { fg: s?.connected ? C.green : C.muted, bg } },
          { text: keys, style: { fg: C.faint, bg } }
        ])
      }
      line('Claude Code', status?.claude, 'c connect · C open in a new terminal')
      line('Codex', status?.codex, 'x connect · X open in a new terminal')
      const recent = [...claude.map((s) => ({ ...s, who: 'Claude Code' })), ...codex.map((s) => ({ ...s, who: 'Codex' }))]
      if (recent.length) {
        y++
        inner.text(0, y++, 'RECENT IN THIS FOLDER', { fg: C.amber, bg, bold: true })
        for (const s of recent.slice(0, 5)) {
          inner.segments(2, y++, [
            { text: s.who.padEnd(13), style: { fg: C.purple, bg } },
            { text: truncate(s.title || '(untitled)', inner.w - 30).padEnd(Math.min(inner.w - 30, 70)), style: { fg: C.text, bg } },
            { text: `  ${ago(s.updatedAt)} ago`, style: { fg: C.faint, bg } }
          ])
        }
      }
      keyHints(inner, 0, inner.h - 1, [['↑↓', 'session'], ['⏎', 'message it'], ['r', 'rename me'], ['esc', 'close']], inner.w, bg)
    },
    onEvent(event: InputEvent) {
      if (event.type !== 'key') return
      const peers = bus.peers()
      if (event.name === 'escape') return modal.close?.()
      if (event.name === 'up') selected = Math.max(0, selected - 1)
      else if (event.name === 'down') selected = Math.min(peers.length - 1, selected + 1)
      else if (event.name === 'enter' && peers[selected]) {
        const peer = peers[selected]
        app.push(
          new PromptModal({
            title: `Message ${peer.name}`,
            label: 'Their agent answers (Eaon sessions reply on their own; Claude Code and Codex read it with eaon_inbox).',
            multiline: true,
            hint: 'send',
            onSubmit: async (text) => {
              const result = await bus.send(peer.id, text, { waitMs: peer.kind === 'eaon' ? 120_000 : undefined })
              if (!result.delivered) return result.error ?? 'Not delivered.'
              app.toast(`Sent to ${peer.name}${peer.kind === 'eaon' ? ' — its answer will appear in your chats' : ''}`, 'success')
              if (result.reply) {
                app.push(new TextModal(`Reply from ${peer.name}`, () => result.reply!.text.split('\n').map((t) => [{ text: t }])))
              }
            }
          })
        )
      } else if (event.ch === 'r') {
        app.push(
          new PromptModal({
            title: 'Name this session',
            initial: bus.self.name,
            onSubmit: (name) => {
              if (!/^[\w.@-]{1,40}$/.test(name)) return 'Letters, digits and . _ @ - only.'
              bus.update({ name })
            }
          })
        )
      } else if (event.ch === 'c' || event.ch === 'x') {
        const target = event.ch === 'c' ? 'claude' : 'codex'
        void connect(target).then((r) => {
          app.toast(r.message, r.ok ? 'success' : 'error', 7000)
          void connectionStatus().then((s) => (status = s))
        })
      } else if (event.ch === 'C' || event.ch === 'X') {
        void openInTerminal(event.ch === 'C' ? 'claude' : 'codex', cwd).then((r) => app.toast(r.message, r.ok ? 'success' : 'error'))
      }
    }
  }
  app.push(modal)
}

export async function runConnect(app: App, target: string, remove = false): Promise<void> {
  const t = target === 'claude' || target === 'claude-code' ? 'claude' : target === 'codex' ? 'codex' : null
  if (!t) return app.toast('Say claude or codex', 'error')
  const result = remove ? await disconnect(t) : await connect(t)
  app.toast(result.message, result.ok ? 'success' : 'error', 7000)
}

/* ========================================================== desktop import */

export function openImport(app: App, firstRun = false): void {
  const desktop = findDesktop()
  if (!desktop) {
    app.toast('Eaon Desktop isn’t installed on this computer (or has never been opened)', 'error')
    return
  }
  const plan = planImport()
  const choices: ImportChoices = { keys: true, providers: true, settings: true, mcp: true, trading: true }
  const rows: { key: keyof ImportChoices; label: string; detail: string }[] = [
    {
      key: 'keys',
      label: 'API keys and sign-ins',
      detail: plan.keys === null ? 'encrypted — macOS will ask you to allow access once' : `${plan.keys} saved`
    },
    { key: 'providers', label: 'Model providers', detail: `${plan.providers} configured` },
    { key: 'settings', label: 'Model choice and preferences', detail: plan.settings ? 'model, effort, approvals, plugins' : 'nothing to bring' },
    { key: 'mcp', label: 'MCP servers (plugins)', detail: `${plan.mcpServers} servers` },
    {
      key: 'trading',
      label: 'Trading setup',
      detail: plan.trading.config ? `broker, limits${plan.trading.schedules ? `, ${plan.trading.schedules} schedules (imported switched off)` : ''}` : 'nothing set up'
    }
  ]
  let selected = 0
  let running = false
  const log: string[] = []
  const modal: Modal = {
    draw(c: Canvas) {
      const inner = frame(c, 92, 14 + rows.length + log.length, firstRun ? 'Welcome — bring your setup over from Eaon Desktop?' : 'Import from Eaon Desktop')
      const bg = '#111113'
      inner.text(0, 1, `Found Eaon Desktop${desktop.running ? ' (running)' : ''}. Choose what to copy into the CLI; the desktop app is never changed.`, { fg: C.text, bg }, inner.w)
      rows.forEach((row, i) => {
        const active = i === selected
        const rowBg = active ? C.teal : bg
        inner.fill(0, 3 + i, inner.w, 1, { bg: rowBg })
        inner.text(1, 3 + i, choices[row.key] ? '☑' : '☐', { fg: choices[row.key] ? C.green : C.muted, bg: rowBg })
        inner.text(4, 3 + i, row.label, { fg: active ? C.tealText : C.text, bg: rowBg, bold: active })
        inner.text(36, 3 + i, row.detail, { fg: active ? '#9CC7D6' : C.muted, bg: rowBg }, inner.w - 36)
      })
      let y = 4 + rows.length
      inner.text(0, y++, 'Chats, workers and the desktop’s trading history stay where they are; /chats can continue a desktop chat here.', { fg: C.faint, bg }, inner.w)
      inner.text(0, y++, 'Real-money trading has to be confirmed again in the CLI.', { fg: C.faint, bg }, inner.w)
      y++
      for (const line of log) inner.text(0, y++, line, { fg: line.startsWith('✗') ? C.red : C.green, bg }, inner.w)
      keyHints(inner, 0, inner.h - 1, running ? [['', 'importing…']] : [['space', 'toggle'], ['⏎', 'import'], ['esc', firstRun ? 'not now' : 'cancel'], ...(firstRun ? ([['n', 'never ask']] as [string, string][]) : [])], inner.w, bg)
    },
    onEvent(event: InputEvent) {
      if (event.type !== 'key' || running) return
      if (event.name === 'escape') return modal.close?.()
      if (event.name === 'n' && firstRun) {
        declineFirstRunImport()
        return modal.close?.()
      }
      if (event.name === 'up') selected = Math.max(0, selected - 1)
      if (event.name === 'down') selected = Math.min(rows.length - 1, selected + 1)
      if (event.name === 'space') choices[rows[selected].key] = !choices[rows[selected].key]
      if (event.name === 'enter') {
        if (log.length) return modal.close?.()
        running = true
        void importFromDesktop(choices, { onStatus: (line) => (log.push(`· ${line}`), app.invalidate()) }).then(
          (report) => {
            running = false
            if (report.keys) log.push(report.keys.error ? `✗ keys: ${report.keys.error}` : `✓ ${report.keys.added} keys added, ${report.keys.updated} updated`)
            if (report.providers !== undefined) log.push(`✓ ${report.providers} providers`)
            if (report.settings) log.push('✓ model choice and preferences')
            if (report.mcpServers !== undefined) log.push(`✓ ${report.mcpServers} MCP servers`)
            if (report.trading) log.push(`✓ trading setup${report.trading.schedules ? `, ${report.trading.schedules} schedules (${report.trading.disabled} switched off)` : ''}`)
            for (const error of report.errors) log.push(`✗ ${error}`)
            log.push('Press Enter to close.')
            events.emit('providers:changed')
            app.invalidate()
          },
          (error) => {
            running = false
            log.push(`✗ ${error instanceof Error ? error.message : String(error)}`)
          }
        )
      }
    }
  }
  app.push(modal)
}

/* ================================================================== misc */

export function openMcp(app: App): void {
  app.push(
    new TextModal('Plugins (MCP servers)', () => {
      const servers = store.getMcpServers()
      const statuses = new Map(getStatuses().map((s) => [s.serverId, s]))
      const lines: { text: string; style?: { fg: string } }[][] = []
      if (servers.length === 0) lines.push([{ text: 'No MCP servers. /import brings the desktop’s over.', style: { fg: C.muted } }])
      for (const server of servers) {
        const s = statuses.get(server.id)
        const color = s?.state === 'ready' ? C.green : s?.state === 'error' ? C.red : s?.state === 'needs-auth' ? C.yellow : C.muted
        lines.push([
          { text: `${server.enabled ? '●' : '○'} `, style: { fg: color } },
          { text: server.name.padEnd(28), style: { fg: C.text } },
          { text: `${s?.state ?? (server.enabled ? 'stopped' : 'off')}${s?.toolCount ? ` · ${s.toolCount} tools` : ''}`, style: { fg: color } }
        ])
        if (s?.error) lines.push([{ text: `   ${s.error}`, style: { fg: C.red } }])
      }
      return lines
    })
  )
}

export function helpLines(): { text: string; style?: { fg: string; bold?: boolean } }[][] {
  const h = (text: string) => [{ text, style: { fg: C.amber, bold: true } }]
  const row = (k: string, d: string) => [
    { text: `  ${k}`.padEnd(22), style: { fg: C.text, bold: true } },
    { text: d, style: { fg: C.muted } }
  ]
  return [
    h('EVERYWHERE'),
    row('⇥ / ⇧⇥', 'next / previous tab: Chat · Workers · Trading (also F1–F3, ⌥1–⌥3, a click)'),
    row('⌃C', 'stop a reply; twice to quit'),
    row('?', 'this help'),
    row('⌃L', 'redraw the screen'),
    row('/update', `install the newest version from npm (the header shows ⬆ when one is out) · this is ${CLI_VERSION}`),
    [],
    h('CHAT'),
    row('⏎ / ⇧⏎ / ⌃J', 'send / new line (also end a line with \\)'),
    row('@file', 'add a file to the message (⇥ completes)'),
    row('!command', 'run a command here; the agent sees its output next message'),
    row('⌃Z  /undo', 'take back the last turn and its file changes · /redo'),
    row('/diff', 'review every file changed in this chat'),
    row('⌃B', 'side panel: context, changed files, checklist, language servers'),
    row('⇧⇥ (in Chat)', 'cycle approvals: ask · approve for me · full access'),
    row('esc', 'stop the reply, or clear the box'),
    row('⌃P ⌃R ⌃N ⌃G', 'model · chats · new chat · sessions'),
    row('⌃O', 'details: every thought and all tool output in full'),
    row('wheel  ⇞ ⇟  ⇧↑↓', 'scroll back through everything the agent did · ⌃Home top · ⌃End follow'),
    row('drag', 'select text and copy it (/mouse hands the mouse back to your terminal)'),
    [],
    h('TRADING'),
    row('1–9 0', 'pages: agent desk, home, market, portfolio, orders, sessions, watchlist, lookup, rates, chat'),
    row('/', 'go to a symbol'),
    row('B S', 'buy / sell ticket'),
    row('G N X', 'agent desk: start the agent (or arm it for the open) · check now · stop it, mission and all'),
    row('RUN FOR', 'mission control: every market day — open to close, again at each open — or one session'),
    row('T', 'agent desk: talk to the agent while it trades'),
    row('AGENT', 'mission control: Eaon’s agent, or Claude Code (G opens it; type /mcp__eaon__trade there)'),
    row('‹ ›', 'agent desk: page through past sessions'),
    row('←→ ⏎ -/+', 'agent desk: pick a mission-control setting · change it · step it'),
    row('D  [ ]', 'agent desk: every step in full · chart range'),
    row('E (X elsewhere)', 'exit (stop, target, trailing) on the selected holding'),
    row('K', 'kill switch: no orders, no sessions'),
    row('M', 'account, keys, limits and the trading model'),
    row('R', 'refresh now'),
    [],
    h('CLAUDE CODE'),
    row('/claude  esc', 'open Claude Code · go back to the tab you were on'),
    row('⏎  ⌃]', 'give Claude Code the keyboard · take it back'),
    row('/accounts', 'link broker accounts (Robinhood, IBKR, Webull, Tradier…)'),
    [],
    h('WORKERS'),
    row('↑↓ ⏎', 'choose a worker · write to it'),
    row('N E D', 'new · edit · delete'),
    row('W P', 'check in now · pause or resume'),
    [],
    h('COMMANDS'),
    ...COMMAND_HELP.map(([k, d]) => row(k, d))
  ]
}

const COMMAND_HELP: [string, string][] = [
  ['/model', 'models per job (chat, trading sessions, sub-agents, routing)'],
  ['/keys /login', 'API keys for 100 providers (/key groq goes straight to one) · sign in with ChatGPT or Copilot'],
  ['/import', 'copy keys, models, plugins and trading setup from Eaon Desktop'],
  ['/chats /new', 'switch chat (desktop chats too) · start a new one'],
  ['/sessions', 'other Eaon, Claude Code and Codex sessions'],
  ['/send', '/send <session> <message>'],
  ['/connect', '/connect claude|codex — let them message Eaon'],
  ['/plan /goal /swarm', 'plan first · keep working toward a goal · parallel sub-agents'],
  ['/cwd', 'the folder the agent works in'],
  ['/mcp', 'plugin status'],
  ['/thinking', 'show the model’s reasoning']
]

export function openHelp(app: App): void {
  app.push(new TextModal(`Eaon CLI${CLI_BETA ? ' beta' : ''} · keys and commands`, helpLines, 100))
}

export function openConfirm(app: App, title: string, body: string, onYes: () => void, danger = false): void {
  app.push(new ConfirmModal({ title, body, danger, onAnswer: (yes) => yes && onYes() }))
}

export { chatModel, strWidth, S }
