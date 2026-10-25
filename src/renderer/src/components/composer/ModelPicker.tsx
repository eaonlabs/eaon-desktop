import { Fragment, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type RefObject } from 'react'
import { Check, CircleAlert, Info, Plus, Search, Star } from 'lucide-react'
import { FREE_PROVIDER_ID } from '@shared/freeCredits'
import { useShallow } from 'zustand/react/shallow'
import type { ModelInfo, Provider } from '@shared/types'
import { clampEffort, EFFORT_LABEL, orderEfforts } from '@shared/effort'
import {
  groupOptions,
  modelKey,
  moveActive,
  nativeOptions,
  providerReadiness,
  searchOptions,
  STAGE_LABEL,
  type ModelOption,
  engineOptions,
  engineReadiness
} from '@shared/modelSelection'
import { useApp } from '../../state/store'
import { Popover } from '../ui'
import { LinkAccounts } from '../LinkAccounts'
import { ReasoningEffort } from './ReasoningEffort'
import { modKey, modLabel } from '../../lib/platform'
import { ENGINE_MARK, markKey, optionMark, ProviderMark } from './ProviderMark'
import { useSetupAction } from './setupActions'
import { useCliEngines } from './ModelSelect'
import { useChatEngine } from './chatEngine'
import { ENGINE_LABEL } from '@shared/engines'
import './model-picker.css'

/**
 * The composer's model picker. A row of provider tabs (Starred first, then
 * every linked provider by its mark, the open one with its name and an
 * underline, and + to link more), a search box, the tab's models with ⌘1–⌘9
 * (Ctrl+1–9 on Windows and Linux) and a star each, and the model's effort
 * slider at the foot. Linking an account or adding a key puts its tab here
 * straight away.
 *
 * What is listed, how search ranks and what the saved choice resolves to all
 * come from shared/modelSelection, the same rules every other picker uses. A
 * chosen model that can't be used now stays named at the top with why,
 * rather than the picker quietly highlighting some other model.
 */

const STARRED = '__starred'
/** An agent CLI's tab (`__engine:codex`): picking one of its models runs Chat on that CLI, with its own sign-in. */
const ENGINE_TAB = '__engine:'

export function ModelPicker({
  anchor,
  open,
  onClose,
  selected,
  onPick,
  follow
}: {
  anchor: RefObject<HTMLElement>
  open: boolean
  onClose: () => void
  /**
   * Picking for something else than the app (a worker): its model, and what
   * a pick does instead of changing the app's. The effort slider and the
   * agent CLIs' tabs are the app's, so they are left out then.
   */
  selected?: ModelInfo | null
  onPick?: (model: ModelInfo) => void
  /** A first row that goes back to following the app's model, with its label; set when `onPick` is. */
  follow?: { label: string; on: boolean; run: () => void }
}): JSX.Element {
  const { settings, selectModel, setEffort, toggleFavorite, providers, patchSettings } = useApp(
    useShallow((s) => ({
      settings: s.settings,
      selectModel: s.selectModel,
      setEffort: s.setEffort,
      toggleFavorite: s.toggleFavorite,
      providers: s.providers,
      patchSettings: s.patchSettings
    }))
  )
  const selection = useApp((s) => s.modelSelection())
  const chatEngine = useChatEngine()
  // Picking for a worker, the app's own choice (and the CLIs' tabs) doesn't apply.
  const engineChoice = onPick ? null : chatEngine
  const current = onPick ? (selected ?? null) : engineChoice ? null : selection.model
  // The agent CLIs: Codex once Eaon has checked for it, the others once installed. Each tab holds the
  // CLI's own models, or why they can't be used yet.
  const cliEngines = useCliEngines()
  const engineTabs = useMemo(
    () =>
      onPick
        ? []
        : cliEngines
            .filter((e) => e.status && (e.id === 'codex' || e.status.installed))
            .map((e) => ({
              id: e.id,
              tab: `${ENGINE_TAB}${e.id}`,
              name: e.status?.name ?? ENGINE_LABEL[e.id],
              options: engineOptions(e.id, e.models, e.status),
              readiness: engineReadiness(e.id, e.status),
              note: e.models?.note ?? null
            })),
    [onPick, cliEngines]
  )
  const engineOpts = useMemo(() => engineTabs.flatMap((e) => e.options), [engineTabs])
  const [engineBusy, setEngineBusy] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<string>(STARRED)
  const engineTab = engineTabs.find((e) => e.tab === tab) ?? null
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const tabs = useRef<HTMLDivElement>(null)
  const runAction = useSetupAction()

  const prefs = useMemo(() => ({ favorites: settings?.favoriteModels, recents: settings?.recentModels }), [settings?.favoriteModels, settings?.recentModels])
  const options = useMemo(() => nativeOptions(providers), [providers])
  const groups = useMemo(() => groupOptions(options, prefs), [options, prefs])
  const favorites = useMemo(() => new Set(prefs.favorites ?? []), [prefs.favorites])
  const currentKey = engineChoice ? engineChoice.key : current ? modelKey(current.providerId, current.id) : null

  /** Providers with models to offer, in the providers list's order. */
  const linked = useMemo(() => {
    const ids = new Set(options.map((o) => o.providerId))
    return providers.filter((p) => ids.has(p.id))
  }, [options, providers])
  const starred = groups.find((g) => g.kind === 'starred')?.options ?? []
  const recent = groups.find((g) => g.kind === 'recent')?.options ?? []

  const q = query.trim()
  const shown: ModelOption[] = q
    ? [...searchOptions(options, q, prefs), ...searchOptions(engineOpts, q, prefs)]
    : tab === STARRED
      ? [...starred, ...recent]
      : engineTab
        ? engineTab.options
        : (groups.find((g) => g.kind === 'provider' && g.id === tab)?.options ?? [])
  const mixed = Boolean(q) || tab === STARRED
  // In the Starred tab, recent models follow the starred ones under their own label.
  const recentFrom = !q && tab === STARRED && recent.length > 0 ? starred.length : -1
  const tabProvider = !q && tab !== STARRED ? providers.find((p) => p.id === tab) : undefined
  const tabReadiness = tabProvider ? providerReadiness(tabProvider) : null

  // Each time it opens: the current model's tab, highlighted, no leftover search.
  useEffect(() => {
    if (!open) return
    setQuery('')
    const start = engineChoice ? `${ENGINE_TAB}${engineChoice.engine}` : (current?.providerId ?? selection.wanted?.providerId ?? linked[0]?.id ?? STARRED)
    const startEngine = engineTabs.find((e) => e.tab === start)
    const startTab = startEngine || linked.some((p) => p.id === start) ? start : STARRED
    setTab(startTab)
    const inTab = startTab === STARRED ? [...starred, ...recent] : startEngine ? startEngine.options : options.filter((o) => o.providerId === startTab)
    setActive(Math.max(0, currentKey ? inTab.findIndex((o) => o.key === currentKey) : 0))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the open tab and the highlighted row in view. Set by hand rather than
  // with scrollIntoView, which also scrolls the panel itself (overflow:
  // hidden or not) and pushed the tabs and search out of sight.
  useEffect(() => {
    const strip = tabs.current
    const el = strip?.querySelector<HTMLElement>('[data-active]')
    if (!open || !strip || !el) return
    if (el.offsetLeft < strip.scrollLeft) strip.scrollLeft = el.offsetLeft
    else if (el.offsetLeft + el.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = el.offsetLeft + el.offsetWidth - strip.clientWidth
  }, [open, tab])

  useEffect(() => {
    const box = list.current
    const row = box?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    if (!box || !row) return
    if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop - 4.5
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight + 7
  }, [active, open, tab])

  const efforts = engineChoice ? engineChoice.efforts : (current?.efforts ?? [])
  const effort = clampEffort(settings?.effort, efforts)

  const pick = (option: ModelOption): void => {
    if (option.engine !== 'native') {
      // An engine's model: Chat runs on that engine from the next message.
      void patchSettings({
        selectedEngine: option.engine,
        selectedEngineModel: option.modelId
      })
      onClose()
      return
    }
    if (!option.providerId) return
    if (onPick) {
      const model = useApp
        .getState()
        .availableModels()
        .find((m) => m.id === option.modelId && m.providerId === option.providerId)
      if (model) onPick(model)
    } else selectModel(option.modelId, option.providerId)
    onClose()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (modKey(event) && /^[1-9]$/.test(event.key)) {
      const option = shown[Number(event.key) - 1]
      if (option) {
        event.preventDefault()
        pick(option)
      }
      return
    }
    const next = moveActive(active, event.key, shown.length)
    if (next !== null) {
      event.preventDefault()
      setActive(next)
    } else if (event.key === 'Enter' && shown[active]) {
      event.preventDefault()
      pick(shown[active])
    }
  }

  /** A second tab with the same mark (two OpenAI accounts, say) gets a dot so the two can be told apart. */
  const seen = new Set<string>()
  const tabList = linked.map((p: Provider) => {
    const mark = markKey(p.id)
    const repeat = seen.has(mark)
    seen.add(mark)
    return { provider: p, repeat, attention: providerReadiness(p).state === 'attention' }
  })

  const act = (action: Parameters<typeof runAction>[0], providerId: string | null | undefined): void => {
    if (action === 'connect') {
      onClose()
      setLinking(true)
      return
    }
    if (action === 'choose-model') return
    onClose()
    runAction(action, providerId ?? null)
  }

  return (
    <>
      <Popover anchor={anchor} open={open} onClose={onClose} placement="top-start" width={296} className="mp">
        <div className="mp__tabs">
          <div className="mp__tabs-scroll" ref={tabs} role="tablist" aria-label="Providers">
            <button
              role="tab"
              className="mp__tab"
              data-active={(!q && tab === STARRED) || undefined}
              aria-selected={!q && tab === STARRED}
              aria-label="Starred and recent"
              title="Starred and recent"
              onClick={() => {
                setQuery('')
                setTab(STARRED)
                setActive(0)
              }}
            >
              <Star className="mp__tab-star" size={15} strokeWidth={0} fill="currentColor" />
              {!q && tab === STARRED && <span className="mp__tab-name">Starred</span>}
            </button>
            {tabList.map(({ provider, repeat, attention }) => {
              const on = !q && tab === provider.id
              return (
                <button
                  key={provider.id}
                  role="tab"
                  className="mp__tab"
                  data-active={on || undefined}
                  aria-selected={on}
                  aria-label={attention ? `${provider.name}, needs attention` : provider.name}
                  title={attention ? `${provider.name} needs attention` : provider.name}
                  onClick={() => {
                    setQuery('')
                    setTab(provider.id)
                    const inTab = options.filter((o) => o.providerId === provider.id)
                    setActive(Math.max(0, currentKey ? inTab.findIndex((o) => o.key === currentKey) : 0))
                  }}
                >
                  <span className="mp__tab-mark">
                    <ProviderMark providerId={provider.id} name={provider.name} size={16} />
                    {(repeat || attention) && <span className="mp__tab-badge" data-tone={attention ? 'warn' : undefined} aria-hidden="true" />}
                  </span>
                  {on && <span className="mp__tab-name">{provider.name}</span>}
                </button>
              )
            })}
            {engineTabs.map((engine) => (
              <button
                key={engine.tab}
                role="tab"
                className="mp__tab"
                data-active={(!q && tab === engine.tab) || undefined}
                aria-selected={!q && tab === engine.tab}
                aria-label={engine.readiness.state === 'ready' ? engine.name : `${engine.name}, ${engine.readiness.label}`}
                title={
                  engine.readiness.state === 'ready'
                    ? `${engine.name} — Chat runs on ${engine.name} with your ${engine.name} sign-in`
                    : `${engine.name} — ${engine.readiness.reason ?? ''}`
                }
                onClick={() => {
                  setQuery('')
                  setTab(engine.tab)
                  setActive(Math.max(0, currentKey ? engine.options.findIndex((o) => o.key === currentKey) : 0))
                }}
              >
                <span className="mp__tab-mark">
                  <ProviderMark providerId={ENGINE_MARK[engine.id]} name={engine.name} size={16} />
                  {engine.readiness.state !== 'ready' && <span className="mp__tab-badge" data-tone="warn" aria-hidden="true" />}
                </span>
                {!q && tab === engine.tab && <span className="mp__tab-name">{engine.name}</span>}
              </button>
            ))}
          </div>
          <button
            className="mp__add"
            aria-label="Link accounts"
            title="Link accounts"
            onClick={() => {
              onClose()
              setLinking(true)
            }}
          >
            <Plus size={14} strokeWidth={1.6} />
          </button>
        </div>

        <label className="mp__search">
          <Search size={12.5} strokeWidth={2} />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
            placeholder={options.length + engineOpts.length ? `Search ${options.length + engineOpts.length} models...` : 'Search models...'}
            aria-label="Search models"
            spellCheck={false}
          />
        </label>

        {!onPick && selection.status === 'unavailable' && selection.wanted && (
          <div className="mp__notice" role="status">
            <CircleAlert size={13} strokeWidth={2} />
            <span>
              <b>{selection.wanted.label}</b> is unavailable. {selection.reason}
            </span>
            {selection.action && selection.action !== 'choose-model' && (
              <button className="mp__notice-action" onClick={() => act(selection.action!, selection.wanted?.providerId)}>
                {actionLabel(selection.action)}
              </button>
            )}
          </div>
        )}
        {!q && engineTab && engineTab.readiness.state !== 'ready' && (
          <div className="mp__notice" role="status">
            <CircleAlert size={13} strokeWidth={2} />
            <span>
              {engineTab.readiness.reason ?? `${engineTab.name} can’t run right now.`} Chat on {engineTab.name} uses your {engineTab.name} sign-in and plan.
            </span>
            {(engineTab.readiness.action === 'sign-in' || engineTab.readiness.action === 'reconnect') && (
              <button
                className="mp__notice-action"
                disabled={engineBusy !== null}
                onClick={() => {
                  setEngineBusy(engineTab.id)
                  window.api.engines
                    .login(engineTab.id)
                    .catch(() => undefined)
                    .finally(() => setEngineBusy(null))
                }}
              >
                {engineBusy === engineTab.id ? 'Waiting for you to sign in…' : `Sign in to ${engineTab.name}`}
              </button>
            )}
          </div>
        )}
        {!q && engineTab?.note && engineTab.readiness.state === 'ready' && (
          <div className="mp__notice mp__notice--info" role="status">
            <Info size={13} strokeWidth={2} />
            <span>{engineTab.note}</span>
          </div>
        )}
        {tabReadiness?.state === 'attention' && tabProvider && (
          <div className="mp__notice" role="status">
            <CircleAlert size={13} strokeWidth={2} />
            <span>{tabReadiness.reason}</span>
            {tabReadiness.action && (
              <button className="mp__notice-action" onClick={() => act(tabReadiness.action!, tabProvider.id)}>
                {actionLabel(tabReadiness.action)}
              </button>
            )}
          </div>
        )}

        <div className="mp__list" ref={list} role="listbox" aria-label="Models">
          {follow && !q && (
            <div
              className="mp__row mp__row--follow"
              role="option"
              aria-selected={follow.on}
              data-current={follow.on || undefined}
              onClick={() => {
                follow.run()
                onClose()
              }}
            >
              <span className="mp__row-name">{follow.label}</span>
              {follow.on && <Check size={13} strokeWidth={2.2} className="mp__check" />}
            </div>
          )}
          {options.length === 0 && engineOpts.length === 0 ? (
            <div className="mp__empty">
              <p>No usable model is connected. Sign in to a supported account, add an API key, or choose a local model.</p>
              <button
                className="btn btn--primary btn--sm"
                onClick={() => {
                  onClose()
                  setLinking(true)
                }}
              >
                Link accounts
              </button>
              {/* No account or key, at an event: Eaon Free's settings take the event code. */}
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  onClose()
                  useApp.getState().openProviderSettings(FREE_PROVIDER_ID)
                }}
              >
                Have an event code?
              </button>
            </div>
          ) : shown.length === 0 ? (
            <div className="mp__empty">
              <p>{q ? `No models match “${q}”.` : 'Star a model to keep it here. Models you pick show up here too.'}</p>
            </div>
          ) : (
            shown.map((option, i) => {
              const fav = favorites.has(option.key)
              const isCurrent = option.key === currentKey
              const stage = option.stage ? STAGE_LABEL[option.stage] : null
              return (
                <Fragment key={`${i < recentFrom || recentFrom === -1 ? 's' : 'r'}:${option.key}`}>
                  {i === recentFrom && (
                    <div className="mp__section" role="presentation">
                      Recent
                    </div>
                  )}
                  <div
                    className="mp__row"
                    data-index={i}
                    data-active={i === active || undefined}
                    data-current={isCurrent || undefined}
                    data-attention={option.availability !== 'ready' || undefined}
                    role="option"
                    aria-selected={isCurrent}
                    title={option.reason ?? option.model?.description ?? (option.label !== option.modelId ? option.modelId : undefined)}
                    onMouseMove={() => i !== active && setActive(i)}
                    onClick={() => pick(option)}
                  >
                    {mixed && <ProviderMark providerId={optionMark(option)} name={option.groupLabel} size={13} />}
                    <span className="mp__row-name">{option.label}</span>
                    {option.availability !== 'ready' && <CircleAlert className="mp__row-warn" size={12} strokeWidth={2} aria-label="Needs attention" />}
                    {stage && <span className="mp__tag">{stage}</span>}
                    {option.planNote && (
                      <span
                        className="mp__tag mp__tag--plan"
                        title="Your plan’s own model list doesn’t include it. Try it; if the plan doesn’t serve it, the reply says so."
                      >
                        {option.planNote}
                      </span>
                    )}
                    {i < 9 && <kbd className="mp__kbd">{modLabel}{i + 1}</kbd>}
                    {/* Stars are kept per provider; an engine's models have none. */}
                    {option.providerId && (
                      <button
                        className="mp__fav"
                        data-on={fav || undefined}
                        aria-label={fav ? `Unstar ${option.label}` : `Star ${option.label}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (option.providerId) toggleFavorite(option.modelId, option.providerId)
                        }}
                      >
                        <Star size={14.5} strokeWidth={1.4} fill={fav ? 'currentColor' : 'none'} />
                      </button>
                    )}
                  </div>
                </Fragment>
              )
            })
          )}
        </div>

        {!onPick && (current || engineChoice) && effort && efforts.length >= 2 && (
          <div className="mp__foot">
            <ReasoningEffort
              labels={efforts.map((level) => EFFORT_LABEL[level])}
              value={Math.max(0, efforts.indexOf(effort))}
              model={engineChoice?.label ?? current?.label ?? ''}
              onChange={(index) => setEffort(efforts[index])}
            />
          </div>
        )}
      </Popover>
      <LinkAccounts open={linking} onClose={() => setLinking(false)} />
    </>
  )
}

/** The button text for a fix. */
export function actionLabel(action: string): string {
  switch (action) {
    case 'reconnect':
      return 'Sign in again'
    case 'sign-in':
      return 'Sign in'
    case 'fix-key':
      return 'Fix key'
    case 'add-key':
      return 'Add key'
    case 'turn-on':
      return 'Turn on'
    case 'start-local':
    case 'open-settings':
      return 'Open settings'
    case 'get-local-model':
      return 'Get a model'
    case 'connect':
      return 'Link accounts'
    case 'choose-model':
      return 'Choose a model'
    case 'retry':
      return 'Try again'
    default:
      return 'Fix'
  }
}
