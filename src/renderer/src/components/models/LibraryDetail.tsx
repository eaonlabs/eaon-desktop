import type { ReactNode } from 'react'
import { ArrowLeft, CircleAlert, ExternalLink, Sparkles } from 'lucide-react'
import { useLibrary } from './libraryStore'
import { Capabilities, DEVICE, ErrorLine, FitBadge, GetButton, InstalledMark, fitExplanation, releasedLabel, useVariantError } from './parts'
import { ConfirmDelete } from './InstalledView'
import {
  findInstalled,
  fitFor,
  formatContext,
  formatModelSize,
  minRamGB,
  pickVariant,
  runtimeGap,
  type LibraryModel,
  type LibraryVariant
} from '@shared/modelLibrary'

/** One library model: what it is, and every variant with its fit on this machine. */
export function LibraryDetail({ modelId, onBack }: { modelId: string; onBack: () => void }): JSX.Element {
  const model = useLibrary((s) => s.catalog.find((m) => m.id === modelId))
  const state = useLibrary((s) => s.state)

  if (!model) {
    return (
      <>
        <BackButton onBack={onBack} />
        <div className="models-empty">That model isn’t in the library.</div>
      </>
    )
  }

  const pick = pickVariant(model, state?.ramBytes ?? 0)
  // Only when the name undersells the weights (K2 Horizon's "7B" is a 7B core
  // in 9B total), not for ordinary rounding like 27B vs 27.8B.
  const named = parseFloat(model.params)
  const totalNote = named && model.paramsB > named * 1.15 ? ` (${model.paramsB}B total)` : ''

  return (
    <>
      <BackButton onBack={onBack} />
      <div className="mlib-detail__head">
        <h1 className="page__title mlib-detail__title">{model.name}</h1>
        {model.featured && (
          <span className="mlib-featured">
            <Sparkles size={12} strokeWidth={2} /> Recommended
          </span>
        )}
      </div>
      <div className="mlib-meta mlib-detail__byline">
        <span>{model.org}</span>
        <span>{model.family}</span>
        <span>Released {releasedLabel(model.released)}</span>
      </div>
      <p className="mlib-detail__desc">{model.description}</p>
      <Capabilities list={model.capabilities} />

      {runtimeGap(model, state?.runtime) && (
        <div className="mlib-notice">
          <CircleAlert size={15} strokeWidth={2} />
          <span>{runtimeGap(model, state?.runtime)}</span>
        </div>
      )}
      {model.requires && !runtimeGap(model, state?.runtime) && (
        <p className="mlib-note">
          Runs on Eaon&rsquo;s llama.cpp, which adds support for the {model.requires.architecture} architecture before upstream
          llama.cpp does (PR #{model.requires.pull}).
        </p>
      )}

      <dl className="mlib-facts">
        <Fact label="Parameters" value={`${model.params}${totalNote}`} />
        <Fact label="Context" value={`${formatContext(model.contextLength)} tokens`} />
        <Fact label="Minimum memory" value={`${minRamGB(model)} GB`} />
        <Fact
          label="License"
          value={
            model.license.url ? (
              <a className="mlib-link" href={model.license.url} target="_blank" rel="noreferrer">
                {model.license.name}
              </a>
            ) : (
              model.license.name
            )
          }
        />
      </dl>

      <div className="mlib-links">
        {model.links.huggingFace && (
          <a className="btn btn--sm btn--ghost" href={`https://huggingface.co/${model.links.huggingFace}`} target="_blank" rel="noreferrer">
            Hugging Face <ExternalLink size={12} strokeWidth={2} />
          </a>
        )}
      </div>

      <div className="section-head section-head--ruled mlib-detail__variants-head">
        <span className="section-head__title">Variants</span>
        {state && (
          <span className="mlib-section__count">
            {pick.tierGB ? `Recommended for ${pick.tierGB} GB+: ${pick.variant.quant}` : `This ${DEVICE} is below the ${minRamGB(model)} GB minimum`}
          </span>
        )}
      </div>
      <div className="mlib-variants">
        <div className="mlib-variants__row mlib-variants__row--head">
          <span>Quantization</span>
          <span>Source</span>
          <span>Size</span>
          <span>On this {DEVICE}</span>
          <span />
        </div>
        {model.variants.map((variant) => (
          <VariantRow key={variant.id} model={model} variant={variant} recommended={variant === pick.variant} />
        ))}
      </div>
    </>
  )
}

function BackButton({ onBack }: { onBack: () => void }): JSX.Element {
  return (
    <button className="model-detail__back" onClick={onBack}>
      <ArrowLeft size={16} strokeWidth={1.9} /> Back to Models
    </button>
  )
}

function Fact({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div className="mlib-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function VariantRow({ model, variant, recommended }: { model: LibraryModel; variant: LibraryVariant; recommended: boolean }): JSX.Element {
  const state = useLibrary((s) => s.state)
  const remove = useLibrary((s) => s.remove)
  const removeError = useLibrary((s) => {
    const id = s.state ? findInstalled(variant, s.state.installed)?.id : undefined
    return id ? s.errors[id] : undefined
  })
  const error = useVariantError(model, variant)
  const installed = state ? findInstalled(variant, state.installed) : undefined
  const fit = state ? fitFor(variant.sizeBytes, state.ramBytes) : null
  const source = variant.source

  return (
    <div className="mlib-variants__row" data-recommended={recommended || undefined}>
      <span className="mlib-variants__quant">
        {variant.quant}
        {recommended && <span className="mlib-recommended">Recommended</span>}
      </span>
      <span className="mlib-variants__source" title={`${source.repo} · ${source.files.join(', ')}`}>
        Hugging Face · {source.repo.split('/')[0]}
      </span>
      <span className="mlib-variants__size">{formatModelSize(variant.sizeBytes)}</span>
      <span>{fit && !model.unsupported ? <FitBadge level={fit} title={fitExplanation(fit)} /> : <span className="mlib-dim">—</span>}</span>
      <span className="mlib-variants__action">
        {installed ? (
          <>
            <InstalledMark />
            <ConfirmDelete label={`Delete ${installed.label}`} onConfirm={() => void remove(installed.id)} />
          </>
        ) : (
          <GetButton model={model} variant={variant} />
        )}
      </span>
      {(error || removeError) && (
        <div className="mlib-variants__error">
          <ErrorLine text={error ?? removeError} />
        </div>
      )}
    </div>
  )
}
