import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { BROKER_PLUGINS, type McpCatalogEntry } from '@shared/mcpCatalog'
import { BROKERS, type BrokerKind } from '@shared/trading'
import { TRADING_DESK, TRADING_INTERVALS, type WorkerAccess, type WorkerTrading } from '@shared/workers'
import { useApp } from '../../state/store'
import { Select, Switch } from '../ui'
import { PluginConnect } from '../plugins/PluginCatalog'
import { pluginServerId, useMcpStatuses } from '../plugins/usePlugins'

/**
 * The worker editor's trading section: make this worker a trader, pick where
 * it trades — the trading desk's account (Eaon's limits and stops in front of
 * every order) or a broker plugin such as Robinhood, connected right here —
 * and say how often it looks and whether it may place orders on its own.
 */

interface Venue {
  value: string
  label: string
  realMoney: boolean
  /** A catalog broker; null for the desk and hand-added servers. */
  entry: McpCatalogEntry | null
  connected: boolean
}

const STRATEGY_HINT =
  'e.g. “Swing-trade large US tech stocks and SPY/QQQ: buy names above their 20- and 50-day averages that are up on strong volume, with a stop under each. At most 4 positions.”'

export function WorkerTradingFields({
  value,
  onChange,
  access
}: {
  value: WorkerTrading | null
  onChange: (next: WorkerTrading | null) => void
  access: WorkerAccess
}): JSX.Element {
  const servers = useApp(useShallow((s) => s.mcpServers))
  const statuses = useMcpStatuses()
  const [deskBroker, setDeskBroker] = useState<BrokerKind>('simulator')
  // Until the user flips "place orders without asking", it follows the account: on for practice money, off for real.
  const [autoTouched, setAutoTouched] = useState(value !== null)

  useEffect(() => {
    void window.api.trading.snapshot().then(
      (snap) => setDeskBroker(snap.config.broker),
      () => undefined
    )
  }, [])

  const venues = useMemo((): Venue[] => {
    const desk = BROKERS.find((b) => b.id === deskBroker)
    const ready = (id: string): boolean => statuses.find((s) => s.serverId === id)?.state === 'ready'
    const list: Venue[] = [
      { value: TRADING_DESK, label: `Trading desk · ${desk?.label ?? 'Simulator'}`, realMoney: desk?.real ?? false, entry: null, connected: true }
    ]
    for (const entry of BROKER_PLUGINS()) {
      const id = pluginServerId(entry.id)
      const server = servers.find((s) => s.id === id)
      const connected = Boolean(server?.enabled) && ready(id)
      list.push({ value: id, label: `${entry.displayName}${connected ? '' : ' · not connected'}`, realMoney: entry.realMoney !== false, entry, connected })
    }
    // Any other server the user added by hand (a local Alpaca, tastytrade or Kraken MCP, say) —
    // not the general-purpose servers Eaon ships (Filesystem, Memory).
    for (const server of servers.filter((s) => !s.pluginId && !s.official)) {
      list.push({ value: server.id, label: `${server.name} · your server${server.enabled ? '' : ' (off)'}`, realMoney: true, entry: null, connected: server.enabled && ready(server.id) })
    }
    return list
  }, [deskBroker, servers, statuses])

  const enabled = value !== null
  const venue = venues.find((v) => v.value === value?.via) ?? null

  const set = (patch: Partial<WorkerTrading>): void => {
    if (!value) return
    onChange({ ...value, ...patch })
  }
  const pickVenue = (via: string): void => {
    const next = venues.find((v) => v.value === via)
    set({ via, ...(!autoTouched && next ? { autoPlace: !next.realMoney } : {}) })
  }
  const toggle = (on: boolean): void => {
    if (!on) return onChange(null)
    const desk = venues[0]
    onChange({ via: desk.value, strategy: '', everyMinutes: 15, autoPlace: !desk.realMoney })
  }

  return (
    <div className="worker-trading">
      <div className="worker-trading__head">
        <span className="worker-trading__title">
          <span className="field-label">Trading</span>
          <span className="worker-editor__hint">Let this worker trade stocks for you on a schedule.</span>
        </span>
        <Switch label="Trades for you" checked={enabled} onChange={toggle} />
      </div>

      {value && (
        <>
          <div className="field">
            <span className="field-label">Account</span>
            <Select width={320} value={value.via} onChange={pickVenue} options={venues.map((v) => ({ value: v.value, label: v.label }))} />
            <p className="worker-editor__hint">
              {!venue
                ? 'That account is gone. Pick another one.'
                : venue.value === TRADING_DESK
                  ? `Every order passes the limits and stops on the trading desk (ADE → Trading), where you can switch between the simulator and Alpaca.${venue.realMoney ? ' That account is real money.' : ''}`
                  : venue.entry
                    ? (venue.entry.tradingNote ?? '')
                    : 'A server you added. Eaon treats its orders as real money, and its own limits apply, not the trading desk’s.'}
            </p>
          </div>

          {venue?.entry && !venue.connected && (
            <div className="worker-trading__connect">
              <PluginConnect
                entry={venue.entry}
                connected={servers.some((s) => s.id === venue.value)}
                status={statuses.find((s) => s.serverId === venue.value)}
                hideNote
              />
            </div>
          )}

          <label className="field">
            <span className="field-label">Strategy</span>
            <textarea className="input" rows={3} value={value.strategy} placeholder={STRATEGY_HINT} onChange={(e) => set({ strategy: e.target.value })} />
          </label>

          <div className="worker-editor__row">
            <div className="field field--inline">
              <span className="field-label">Checks the market</span>
              <Select
                width={240}
                value={String(value.everyMinutes)}
                onChange={(minutes) => set({ everyMinutes: Number(minutes) })}
                options={[...new Set<number>([...TRADING_INTERVALS, value.everyMinutes])]
                  .sort((a, b) => a - b)
                  .map((m) => ({ value: String(m), label: `Every ${m === 60 ? 'hour' : `${m} min`} while it’s open` }))}
              />
            </div>
            <div className="field field--inline">
              <span className="field-label">Places orders without asking</span>
              <span className="worker-editor__switch">
                <Switch
                  label="Places orders without asking"
                  checked={value.autoPlace}
                  onChange={(on) => {
                    setAutoTouched(true)
                    set({ autoPlace: on })
                  }}
                />
              </span>
            </div>
          </div>
          <p className="worker-editor__hint worker-trading__warning" data-warn={(value.autoPlace && venue?.realMoney) || access !== 'autonomous' || undefined}>
            {access !== 'autonomous'
              ? `With Freedom set to “${access === 'safe' ? 'Careful' : 'Look only'}”, it can’t place orders at all — only watch and report. Set Freedom to Autonomous to let it trade.`
              : value.autoPlace
                ? venue?.realMoney
                  ? 'It places real-money orders on its own, within the account’s limits. The kill switch on the trading desk stops it at once.'
                  : 'It trades the practice account on its own.'
                : 'You approve each order: it asks first, and you tap Approve once on its page.'}
          </p>
        </>
      )}
    </div>
  )
}
