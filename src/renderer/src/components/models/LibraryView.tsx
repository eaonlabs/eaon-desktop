import { useMemo, useState } from 'react'
import { MemoryStick, Sparkles } from 'lucide-react'
import { useApp } from '../../state/store'
import { useLibrary } from './libraryStore'
import { Capabilities, DEVICE, ErrorLine, FitBadge, GetButton, InstalledMark, fitExplanation, releasedLabel, useVariantError } from './parts'
import {
  LIBRARY_CATEGORIES,
  findInstalledVariant,
  formatContext,
  formatModelSize,
  nominalRamGB,
  pickVariant,
  suggestFor,
  type LibraryCategory,
  type LibraryModel
} from '@shared/modelLibrary'

/**
 * The curated library: what suits this machine first, then everything,
 * filterable by what a model is for. Every size and badge is for the variant
 * Get would pull here, chosen from the model's RAM tiers.
 */
export function LibraryView(): JSX.Element {
  const catalog = useLibrary((s) => s.catalog)
  const state = useLibrary((s) => s.state)
  const [category, setCategory] = useState<LibraryCategory | 'all'>('all')

  const ram = state?.ramBytes ?? 0
  // The three the design spec names come first, on their own, whatever this
  // machine can run — then what else suits it.
  const recommended = useMemo(() => catalog.filter((m) => m.featured), [catalog])
  const suggested = useMemo(() => (ram ? suggestFor(catalog, ram).filter((m) => !m.featured) : []), [catalog, ram])
  const filtered = useMemo(
    () =>
      catalog
        .filter((m) => category === 'all' || m.categories.includes(category))
        .sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)) || b.released.localeCompare(a.released)),
    [catalog, category]
  )

  return (
    <>
      <section className="mlib-section">
        <div className="mlib-section__head">
          <h2 className="mlib-section__title">Recommended</h2>
          {state && (
            <span className="mlib-machine">
              <MemoryStick size={14} strokeWidth={1.9} />
              {state.chip ? `${state.chip} · ` : ''}
              {nominalRamGB(state.ramBytes)} GB memory
            </span>
          )}
        </div>
        <div className="mlib-grid">
          {recommended.map((model) => (
            <LibraryCard key={model.id} model={model} />
          ))}
        </div>
      </section>

      {suggested.length > 0 && (
        <section className="mlib-section">
          <div className="mlib-section__head">
            <h2 className="mlib-section__title">Also good on this {DEVICE}</h2>
          </div>
          <div className="mlib-grid">
            {suggested.map((model) => (
              <LibraryCard key={model.id} model={model} />
            ))}
          </div>
        </section>
      )}

      <section className="mlib-section">
        <div className="mlib-section__head">
          <h2 className="mlib-section__title">All models</h2>
          <span className="mlib-section__count">{filtered.length}</span>
        </div>
        <div className="mlib-chips" role="tablist" aria-label="Filter by category">
          {[{ id: 'all' as const, label: 'All' }, ...LIBRARY_CATEGORIES].map((c) => (
            <button
              key={c.id}
              role="tab"
              aria-selected={category === c.id}
              className="mlib-chip"
              data-active={category === c.id || undefined}
              onClick={() => setCategory(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="mlib-list">
          {filtered.map((model) => (
            <LibraryRow key={model.id} model={model} />
          ))}
        </div>
      </section>
    </>
  )
}

function useModelView(model: LibraryModel) {
  const state = useLibrary((s) => s.state)
  const pick = pickVariant(model, state?.ramBytes ?? 0)
  const installed = state ? findInstalledVariant(model, state.installed, pick.variant) : undefined
  return { state, pick, installed }
}

function openDetail(model: LibraryModel): void {
  useApp.getState().setModelsRepo(`library:${model.id}`)
}

/** Big card for the Suggested grid. */
function LibraryCard({ model }: { model: LibraryModel }): JSX.Element {
  const { state, pick, installed } = useModelView(model)
  const error = useVariantError(model, pick.variant)

  return (
    <article
      className="mlib-card"
      tabIndex={0}
      onClick={() => openDetail(model)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') openDetail(model)
      }}
    >
      <div className="mlib-card__top">
        {model.featured ? (
          <span className="mlib-featured">
            <Sparkles size={12} strokeWidth={2} /> Recommended
          </span>
        ) : (
          <span className="mlib-card__org">{model.org}</span>
        )}
        {state && !model.unsupported && <FitBadge level={pick.fit} title={fitExplanation(pick.fit)} />}
      </div>
      <h3 className="mlib-card__name">{model.name}</h3>
      <div className="mlib-meta">
        {model.featured && <span>{model.org}</span>}
        <span>{model.params}</span>
        <span>{formatContext(model.contextLength)} context</span>
        <span>{releasedLabel(model.released)}</span>
      </div>
      <p className="mlib-card__desc">{model.description}</p>
      <Capabilities list={model.capabilities} />
      <div className="mlib-card__foot">
        <span className="mlib-card__pick">
          {pick.variant.quant} · {formatModelSize(pick.variant.sizeBytes)}
        </span>
        {installed ? <InstalledMark /> : <GetButton model={model} variant={pick.variant} />}
      </div>
      <ErrorLine text={error} />
    </article>
  )
}

/** Compact row for the full list. */
function LibraryRow({ model }: { model: LibraryModel }): JSX.Element {
  const { state, pick, installed } = useModelView(model)
  const error = useVariantError(model, pick.variant)

  return (
    <div
      className="mlib-row"
      role="button"
      tabIndex={0}
      onClick={() => openDetail(model)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') openDetail(model)
      }}
    >
      <div className="mlib-row__main">
        <div className="mlib-row__title">
          <span className="mlib-row__name">{model.name}</span>
          {model.featured && (
            <span className="mlib-featured mlib-featured--quiet">
              <Sparkles size={11} strokeWidth={2} /> Recommended
            </span>
          )}
        </div>
        <div className="mlib-meta">
          <span>{model.org}</span>
          <span>{model.params}</span>
          <span>{formatContext(model.contextLength)} context</span>
          <span>{releasedLabel(model.released)}</span>
        </div>
        <Capabilities list={model.capabilities} />
        <ErrorLine text={error} />
      </div>
      <div className="mlib-row__side">
        <div className="mlib-row__size">
          {state && !model.unsupported && <FitBadge level={pick.fit} title={fitExplanation(pick.fit)} />}
          <span className="mlib-row__pick">
            {pick.variant.quant} · {formatModelSize(pick.variant.sizeBytes)}
          </span>
        </div>
        {installed ? <InstalledMark quant={installed.variant.quant} /> : <GetButton model={model} variant={pick.variant} />}
      </div>
    </div>
  )
}
