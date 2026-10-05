import { Fragment, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { Check, ChevronDown, CircleAlert, Search } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { EngineId, EngineModels, EngineStatus } from '@shared/engines'
import { ENGINE_LABEL } from '@shared/engines'
import {
  engineOptions,
  groupOptions,
  moveActive,
  nativeOptions,
  resolveEngineSelection,
  resolveSelection,
  searchOptions,
  STAGE_LABEL,
  type ModelOption
} from '@shared/modelSelection'
import { useApp } from '../../state/store'
import { Popover } from '../ui'
import { ProviderMark } from './ProviderMark'
import './model-picker.css'

/** A saved model choice: a provider's model, or (with `providerId` null) an engine's own model or an id from before provider ids. */
export interface ModelRef {
  providerId: string | null
  modelId: string
}

/**
 * A model field for forms (a worker, a scheduled task, plugin routing): a
 * button showing the choice, and a searchable, grouped list under it built
 * by the same rules as the composer's picker (shared/modelSelection).
 *
 * `engine` scopes it: Eaon's own engine lists every connected provider's
 * models; `codex` lists Codex's own models from its signed-in account. With
 * `defaultLabel` set, null ("follow the default") is the first row. A saved
 * choice that can't be used now stays shown as unavailable with why, and is
 * kept until the user picks something else; nothing is truncated.
 */
export function ModelSelect({
  engine = 'native',
  value,
  onChange,
  defaultLabel,
  width = 260,
  filter,
  label = 'Model'
}: {
  engine?: EngineId
  value: ModelRef | null
  onChange: (value: ModelRef | null) => void
  defaultLabel?: string
  width?: number
  filter?: (option: ModelOption) => boolean
  /** For screen readers: what the field picks. */
  label?: string
}): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const { providers, favorites, recents } = useApp(
    useShallow((s) => ({ providers: s.providers, favorites: s.settings?.favoriteModels, recents: s.settings?.recentModels }))
  )
  const engineState = useEngineModels(engine)
  const prefs = useMemo(() => ({ favorites, recents }), [favorites, recents])

  const options = useMemo(() => {
    const all = engine === 'native' ? nativeOptions(providers) : engineOptions(engine, engineState.models, engineState.status)
    return filter ? all.filter(filter) : all
  }, [engine, providers, engineState, filter])

  // What the saved value is now: one of the options, or unavailable with why.
  const resolved = useMemo((): { option: ModelOption | null; unavailable: string | null; label: string | null } => {
    if (!value) return { option: null, unavailable: null, label: null }
    if (engine !== 'native') {
      const r = resolveEngineSelection(engine, value.modelId, engineState.models, engineState.status)
      return { option: r.option, unavailable: r.status === 'unavailable' ? r.reason : null, label: r.option?.label ?? value.modelId }
    }
    const r = resolveSelection(value, providers)
    const key = r.model ? `${r.model.providerId}:${r.model.id}` : null
    const option = key ? (options.find((o) => o.key === key) ?? null) : null
    return { option, unavailable: r.status === 'unavailable' ? r.reason : null, label: option?.label ?? r.wanted?.label ?? value.modelId }
  }, [value, engine, engineState, providers, options])

  const q = query.trim()
  const groups = useMemo(() => (q ? null : groupOptions(options, prefs)), [q, options, prefs])
  // One flat list for the keyboard: the default row, then each group's rows (or the ranked matches).
  const rows = useMemo(() => {
    const out: { option: ModelOption | null; group: string | null }[] = []
    if (defaultLabel && !q) out.push({ option: null, group: null })
    if (q) for (const option of searchOptions(options, q, prefs)) out.push({ option, group: null })
    else for (const group of groups ?? []) group.options.forEach((option, i) => out.push({ option, group: i === 0 ? group.label : null }))
    return out
  }, [defaultLabel, q, options, prefs, groups])

  const chosenKey = resolved.option?.key ?? null
  useEffect(() => {
    if (!open) return
    setQuery('')
    const index = rows.findIndex((row) => (row.option ? row.option.key === chosenKey : !value))
    setActive(Math.max(0, index))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const box = listRef.current
    const row = box?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    if (!box || !row) return
    if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop - 4
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight + 4
  }, [active, open])

  const pick = (option: ModelOption | null): void => {
    onChange(option ? { providerId: option.providerId, modelId: option.modelId } : null)
    setOpen(false)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    const next = moveActive(active, event.key, rows.length)
    if (next !== null) {
      event.preventDefault()
      setActive(next)
    } else if (event.key === 'Enter' && rows[active]) {
      event.preventDefault()
      pick(rows[active].option)
    }
  }

  const buttonLabel = !value ? (defaultLabel ?? 'Choose a model') : (resolved.label ?? value.modelId)
  const engineName = engineState.status?.name ?? ENGINE_LABEL[engine]
  const empty =
    engine === 'native'
      ? 'No usable model is connected. Add one in Settings → Model providers.'
      : engineState.status && !engineState.status.installed
        ? `${engineName} isn’t installed on this computer.`
        : `No ${engineName} models yet. Sign in to ${engineName} and Eaon reads its list.`

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="select ms__trigger"
        data-open={open || undefined}
        data-unavailable={resolved.unavailable ? true : undefined}
        style={{ width }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${buttonLabel}${resolved.unavailable ? ', unavailable' : ''}`}
        title={resolved.unavailable ? `Unavailable — ${resolved.unavailable}` : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {resolved.unavailable && <CircleAlert size={13} strokeWidth={2} className="ms__warn" />}
        <span className="ms__label">{buttonLabel}</span>
        {resolved.option && resolved.option.groupLabel && value && <span className="ms__via">{resolved.option.groupLabel}</span>}
        <span className="select__chevron">
          <ChevronDown size={14} strokeWidth={2} />
        </span>
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-start" width={Math.max(width, 300)} className="ms">
        <label className="ms__search">
          <Search size={12.5} strokeWidth={2} />
          <input
            autoFocus
            value={query}
            placeholder={options.length ? `Search ${options.length} models` : 'Search models'}
            aria-label="Search models"
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
          />
        </label>
        {resolved.unavailable && (
          <div className="ms__notice" role="status">
            <CircleAlert size={13} strokeWidth={2} />
            <span>
              <b>{resolved.label}</b> is unavailable. {resolved.unavailable}
            </span>
          </div>
        )}
        <div className="ms__list" ref={listRef} role="listbox" aria-label={label}>
          {rows.length === 0 ? (
            <div className="ms__empty">{q ? `No models match “${q}”.` : empty}</div>
          ) : (
            rows.map((row, i) => {
              const option = row.option
              const chosen = option ? option.key === chosenKey : !value
              return (
                <Fragment key={option ? `${row.group ?? ''}:${option.key}:${i}` : '__default'}>
                  {row.group && (
                    <div className="ms__group" role="presentation">
                      {row.group}
                    </div>
                  )}
                  <div
                    className="ms__row"
                    role="option"
                    aria-selected={chosen}
                    data-index={i}
                    data-active={i === active || undefined}
                    data-attention={option && option.availability !== 'ready' ? true : undefined}
                    title={option?.reason ?? (option && option.label !== option.modelId ? option.modelId : undefined)}
                    onMouseMove={() => i !== active && setActive(i)}
                    onClick={() => pick(option)}
                  >
                    {option ? <ProviderMark providerId={option.groupId} name={option.groupLabel} size={13} /> : <span className="ms__mark-gap" />}
                    <span className="ms__name">{option ? option.label : defaultLabel}</span>
                    {option?.isDefault && <span className="ms__tag">Default</span>}
                    {option?.stage && <span className="ms__tag">{STAGE_LABEL[option.stage]}</span>}
                    {option && option.availability !== 'ready' && <CircleAlert size={12} strokeWidth={2} className="ms__warn" aria-label="Needs attention" />}
                    {q && option && <span className="ms__via">{option.groupLabel}</span>}
                    <span className="ms__check">{chosen && <Check size={13} strokeWidth={2.2} />}</span>
                  </div>
                </Fragment>
              )
            })
          )}
        </div>
      </Popover>
    </>
  )
}

/**
 * An engine's status and model list, kept current by `engines:changed`.
 * Empty for Eaon's own engine, whose models are the providers'. Tolerates a
 * build without engines (the bridge missing) by staying empty.
 */
export function useEngineModels(engine: EngineId): { status: EngineStatus | null; models: EngineModels | null } {
  const [state, setState] = useState<{ status: EngineStatus | null; models: EngineModels | null }>({ status: null, models: null })
  useEffect(() => {
    if (engine === 'native' || !window.api.engines) return
    let alive = true
    const load = (): void =>
      void Promise.all([window.api.engines.status(), window.api.engines.models(engine)]).then(
        ([statuses, models]) => alive && setState({ status: statuses.find((s) => s.id === engine) ?? null, models }),
        () => {}
      )
    load()
    const off = window.api.engines.onChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [engine])
  return state
}
