import { Fragment, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type RefObject } from 'react'
import { CircleAlert, Plus, Search, Star } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { Provider } from '@shared/types'
import { clampEffort } from '@shared/effort'
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
import { EffortControl } from './EffortControl'
import { markKey, ProviderMark } from './ProviderMark'
import { useSetupAction } from './setupActions'
import { useEngineModels } from './ModelSelect'
import { useChatEngine } from './chatEngine'
import { ENGINE_LABEL } from '@shared/engines'
import './model-picker.css'

/**
 * The composer's model picker. A row of provider tabs (Starred first, then
 * every linked provider by its mark, the open one with its name and an
 * underline, and + to link more), a search box, the tab's models with ⌘1–⌘9
 * and a star each, and the model's effort slider at the foot. Linking an
 * account or adding a key puts its tab here straight away.
 *
 * What is listed, how search ranks and what the saved choice resolves to all
 * come from shared/modelSelection, the same rules every other picker uses. A
 * chosen model that can't be used now stays named at the top with why,
 * rather than the picker quietly highlighting some other model.
 */

const STARRED = '__starred'
/** The tab of Codex's own models: picking one runs Chat on Codex, with Codex's sign-in. */
const CODEX_TAB = '__engine:codex'

export function ModelPicker({ anchor, open, onClose }: { anchor: RefObject<HTMLElement>; open: boolean; onClose: () => void }): JSX.Element {
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
  const engineChoice = useChatEngine()
  const current = engineChoice ? null : selection.model
  // Codex, when Eaon has checked for it: its own models, or why they can't be used yet.
  const codex = useEngineModels('codex')
  const codexOptions = useMemo(() => engineOptions('codex', codex.models, codex.status), [codex.models, codex.status])
  const codexReadiness = codex.status ? engineReadiness('codex', codex.status) : null
  const [codexBusy, setCodexBusy] = useState(false)
  const [linking, setLinking] = useState(false)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<string>(STARRED)
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
    ? [...searchOptions(options, q, prefs), ...searchOptions(codexOptions, q, prefs)]
    : tab === STARRED
      ? [...starred, ...recent]
      : tab === CODEX_TAB
        ? codexOptions
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
    const start = engineChoice ? CODEX_TAB : (current?.providerId ?? selection.wanted?.providerId ?? linked[0]?.id ?? STARRED)
    const startTab = start === CODEX_TAB || linked.some((p) => p.id === start) ? start : STARRED
    setTab(startTab)
    const inTab = startTab === STARRED ? [...starred, ...recent] : startTab === CODEX_TAB ? codexOptions : options.filter((o) => o.providerId === startTab)
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
    selectModel(option.modelId, option.providerId)
    onClose()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.metaKey && /^[1-9]$/.test(event.key)) {
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
            {codex.status && (
              <button
                role="tab"
                className="mp__tab"
                data-active={(!q && tab === CODEX_TAB) || undefined}
                aria-selected={!q && tab === CODEX_TAB}
                aria-label={codexReadiness?.state === 'ready' ? 'Codex' : `Codex, ${codexReadiness?.label ?? 'not ready'}`}
                title={codexReadiness?.state === 'ready' ? 'Codex — Chat runs on Codex with your Codex sign-in' : `Codex — ${codexReadiness?.reason ?? ''}`}
                onClick={() => {
                  setQuery('')
                  setTab(CODEX_TAB)
                  setActive(Math.max(0, currentKey ? codexOptions.findIndex((o) => o.key === currentKey) : 0))
                }}
              >
                <span className="mp__tab-mark">
                  <ProviderMark providerId="codex" name="Codex" size={16} />
                  {codexReadiness?.state !== 'ready' && <span className="mp__tab-badge" data-tone="warn" aria-hidden="true" />}
                </span>
                {!q && tab === CODEX_TAB && <span className="mp__tab-name">{ENGINE_LABEL.codex}</span>}
              </button>
            )}
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
            placeholder={options.length ? `Search ${options.length} models...` : 'Search models...'}
            aria-label="Search models"
            spellCheck={false}
          />
        </label>

        {selection.status === 'unavailable' && selection.wanted && (
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
        {!q && tab === CODEX_TAB && codexReadiness && codexReadiness.state !== 'ready' && (
          <div className="mp__notice" role="status">
            <CircleAlert size={13} strokeWidth={2} />
            <span>{codexReadiness.reason ?? 'Codex can’t run right now.'} Chat on Codex uses your Codex sign-in and plan.</span>
            {(codexReadiness.action === 'sign-in' || codexReadiness.action === 'reconnect') && (
              <button
                className="mp__notice-action"
                disabled={codexBusy}
                onClick={() => {
                  setCodexBusy(true)
                  window.api.engines
                    .login('codex')
                    .catch(() => undefined)
                    .finally(() => setCodexBusy(false))
                }}
              >
                {codexBusy ? 'Waiting for the browser…' : 'Sign in to Codex'}
              </button>
            )}
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
          {options.length === 0 && codexOptions.length === 0 ? (
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
                    title={option.reason ?? (option.label !== option.modelId ? option.modelId : undefined)}
                    onMouseMove={() => i !== active && setActive(i)}
                    onClick={() => pick(option)}
                  >
                    {mixed && <ProviderMark providerId={option.groupId} name={option.groupLabel} size={13} />}
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
                    {i < 9 && <kbd className="mp__kbd">⌘{i + 1}</kbd>}
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

        {(current || engineChoice) && effort && efforts.length >= 2 && (
          <div className="mp__foot">
            <EffortControl
              levels={efforts}
              value={effort}
              defaultLevel={clampEffort(undefined, efforts) ?? effort}
              onChange={(level) => setEffort(level)}
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
