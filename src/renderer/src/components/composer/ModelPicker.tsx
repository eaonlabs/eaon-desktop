import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type RefObject } from 'react'
import { Plus, Search, Star } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { ModelInfo, Provider } from '@shared/types'
import { clampEffort, orderEfforts } from '@shared/effort'
import { useApp } from '../../state/store'
import { Popover } from '../ui'
import { LinkAccounts } from '../LinkAccounts'
import { EffortControl } from './EffortControl'
import { markKey, ProviderMark } from './ProviderMark'
import './model-picker.css'

/**
 * The composer's model picker. A row of provider tabs (Starred first, then
 * every linked provider by its mark, the open one with its name and an
 * underline, and + to link more), a search box, the tab's models with ⌘1–⌘9
 * and a star each, and the model's effort slider at the foot. Linking an
 * account or adding a key puts its tab here straight away.
 */

const STARRED = '__starred'
const key = (m: ModelInfo): string => `${m.providerId}:${m.id}`

export function ModelPicker({ anchor, open, onClose }: { anchor: RefObject<HTMLElement>; open: boolean; onClose: () => void }): JSX.Element {
  const { settings, selectModel, setEffort, toggleFavorite, providers } = useApp(
    useShallow((s) => ({
      settings: s.settings,
      selectModel: s.selectModel,
      setEffort: s.setEffort,
      toggleFavorite: s.toggleFavorite,
      providers: s.providers
    }))
  )
  const models = useApp(useShallow((s) => s.availableModels()))
  const current = useApp((s) => s.currentModel())
  const [linking, setLinking] = useState(false)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<string>(STARRED)
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const tabs = useRef<HTMLDivElement>(null)

  const favorites = useMemo(() => new Set(settings?.favoriteModels ?? []), [settings?.favoriteModels])
  /** Providers with models to offer, in the providers list's order. */
  const linked = useMemo(() => {
    const ids = new Set(models.map((m) => m.providerId))
    return providers.filter((p) => ids.has(p.id))
  }, [models, providers])
  const starred = models.filter((m) => favorites.has(key(m)))

  const q = query.trim().toLowerCase()
  const nameOf = (id: string): string => providers.find((p) => p.id === id)?.name ?? id
  const shown = q
    ? models.filter((m) => `${m.label} ${m.id} ${nameOf(m.providerId)}`.toLowerCase().includes(q))
    : tab === STARRED
      ? starred
      : models.filter((m) => m.providerId === tab)
  const mixed = Boolean(q) || tab === STARRED

  // Each time it opens: the current model's tab, highlighted, no leftover search.
  useEffect(() => {
    if (!open) return
    setQuery('')
    const start = current?.providerId ?? linked[0]?.id ?? STARRED
    setTab(start)
    const inTab = models.filter((m) => m.providerId === start)
    setActive(Math.max(0, current ? inTab.findIndex((m) => key(m) === key(current)) : 0))
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

  const efforts = orderEfforts(current?.efforts ?? [])
  const effort = clampEffort(settings?.effort, efforts)

  const pick = (model: ModelInfo): void => {
    selectModel(model.id, model.providerId)
    onClose()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.metaKey && /^[1-9]$/.test(event.key)) {
      const model = shown[Number(event.key) - 1]
      if (model) {
        event.preventDefault()
        pick(model)
      }
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((i) => Math.min(shown.length - 1, i + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => Math.max(0, i - 1))
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
    return { provider: p, repeat }
  })

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
              aria-label="Starred"
              title="Starred"
              onClick={() => {
                setQuery('')
                setTab(STARRED)
                setActive(0)
              }}
            >
              <Star className="mp__tab-star" size={15} strokeWidth={0} fill="currentColor" />
              {!q && tab === STARRED && <span className="mp__tab-name">Starred</span>}
            </button>
            {tabList.map(({ provider, repeat }) => {
              const on = !q && tab === provider.id
              return (
                <button
                  key={provider.id}
                  role="tab"
                  className="mp__tab"
                  data-active={on || undefined}
                  aria-selected={on}
                  aria-label={provider.name}
                  title={provider.name}
                  onClick={() => {
                    setQuery('')
                    setTab(provider.id)
                    const inTab = models.filter((m) => m.providerId === provider.id)
                    setActive(Math.max(0, current ? inTab.findIndex((m) => key(m) === key(current)) : 0))
                  }}
                >
                  <span className="mp__tab-mark">
                    <ProviderMark providerId={provider.id} name={provider.name} size={16} />
                    {repeat && <span className="mp__tab-badge" aria-hidden="true" />}
                  </span>
                  {on && <span className="mp__tab-name">{provider.name}</span>}
                </button>
              )
            })}
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
            placeholder="Search models..."
            spellCheck={false}
          />
        </label>

        <div className="mp__list" ref={list} role="listbox" aria-label="Models">
          {models.length === 0 ? (
            <div className="mp__empty">
              <p>No models yet. Link an account or add an API key and its models show up here.</p>
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
              <p>{q ? `No models match “${query.trim()}”.` : 'Star a model to keep it here.'}</p>
            </div>
          ) : (
            shown.map((model, i) => {
              const fav = favorites.has(key(model))
              const isCurrent = current ? key(current) === key(model) : false
              return (
                <div
                  key={key(model)}
                  className="mp__row"
                  data-index={i}
                  data-active={i === active || undefined}
                  role="option"
                  aria-selected={isCurrent}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => pick(model)}
                >
                  {mixed && <ProviderMark providerId={model.providerId} name={nameOf(model.providerId)} size={13} />}
                  <span className="mp__row-name">{model.label}</span>
                  {i < 9 && <kbd className="mp__kbd">⌘{i + 1}</kbd>}
                  <button
                    className="mp__fav"
                    data-on={fav || undefined}
                    aria-label={fav ? `Unstar ${model.label}` : `Star ${model.label}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleFavorite(model.id, model.providerId)
                    }}
                  >
                    <Star size={14.5} strokeWidth={1.4} fill={fav ? 'currentColor' : 'none'} />
                  </button>
                </div>
              )
            })
          )}
        </div>

        {current && effort && efforts.length >= 2 && (
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
