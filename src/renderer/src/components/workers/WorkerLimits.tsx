import { useState } from 'react'
import { PauseCircle } from 'lucide-react'
import { Select } from '../ui'
import { useWorkers } from './workersStore'
import { BUDGET_PERIODS, budgetUsageLines, normalizeBudget, type BudgetPeriod, type SiteRules, type ToolRules, type WorkerBudget, type WorkerRetry } from '@shared/workerLimits'
import type { Worker } from '@shared/workers'

/**
 * What the owner holds a worker to, in the Edit dialog: how much it may use
 * (spend cap), when a failed run is tried again, which sites its browser may
 * open, and which tools it has to ask about. The values are the draft's
 * (`WorkerDraft`), saved with Save; the rules themselves are in
 * shared/workerLimits.ts and the engine.
 */

export interface LimitsDraft {
  budget: WorkerBudget | null
  retry: WorkerRetry | null
  sites: SiteRules | null
  toolRules: ToolRules | null
}

/** The limits a worker has now, as the dialog starts from them. */
export function limitsOf(worker: Worker | null): LimitsDraft {
  return { budget: worker?.budget ?? null, retry: worker?.retry ?? null, sites: worker?.sites ?? null, toolRules: worker?.toolRules ?? null }
}

/** Whether any limit is set, so the section starts open for a worker that has one. */
const anySet = (value: LimitsDraft): boolean => Boolean(value.budget || value.retry || value.sites || value.toolRules)

export function WorkerLimitsFields({ worker, value, onChange }: { worker: Worker | null; value: LimitsDraft; onChange: (next: LimitsDraft) => void }): JSX.Element {
  return (
    <details className="worker-limits" open={anySet(value) || undefined}>
      <summary className="worker-limits__summary">Limits and safety</summary>
      <div className="worker-limits__body">
        <SpendCapField worker={worker} value={value.budget} onChange={(budget) => onChange({ ...value, budget })} />
      </div>
    </details>
  )
}

/* ------------------------------------------------------------ spend cap */

function SpendCapField({ worker, value, onChange }: { worker: Worker | null; value: WorkerBudget | null; onChange: (next: WorkerBudget | null) => void }): JSX.Element {
  const [tokens, setTokens] = useState(value?.tokens ? String(value.tokens) : '')
  const [usd, setUsd] = useState(value?.usd ? String(value.usd) : '')
  const [period, setPeriod] = useState<BudgetPeriod>(value?.period ?? 'day')
  const update = (next: { tokens?: string; usd?: string; period?: BudgetPeriod }): void => {
    const t = next.tokens ?? tokens
    const u = next.usd ?? usd
    const p = next.period ?? period
    if (next.tokens !== undefined) setTokens(next.tokens)
    if (next.usd !== undefined) setUsd(next.usd)
    if (next.period !== undefined) setPeriod(next.period)
    onChange(normalizeBudget({ tokens: t, usd: u, period: p }))
  }
  // What it has used so far comes from the saved worker, so it is only shown for the cap as saved.
  const now = useWorkers((s) => s.now)
  const used = worker?.budget ? budgetUsageLines(worker.budget, worker.spend, now) : []
  return (
    <div className="field">
      <span className="field-label">Spend cap</span>
      <div className="worker-limits__row">
        <input
          className="input worker-limits__number"
          type="number"
          min={1}
          inputMode="numeric"
          aria-label="Token cap"
          placeholder="No cap"
          value={tokens}
          onChange={(e) => update({ tokens: e.target.value })}
        />
        <span className="worker-limits__unit">tokens</span>
        <input
          className="input worker-limits__number"
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          aria-label="Dollar cap"
          placeholder="No cap"
          value={usd}
          onChange={(e) => update({ usd: e.target.value })}
        />
        <span className="worker-limits__unit">dollars</span>
        <Select width={120} label="Cap period" value={period} onChange={(next: BudgetPeriod) => update({ period: next })} options={BUDGET_PERIODS.map((p) => ({ value: p.id, label: `per ${p.id}` }))} />
      </div>
      <p className="worker-editor__hint">
        Counts the input and output tokens each run shows. Dollars count only runs billed per token on a model with a known price; runs on a plan or a local model count tokens only. It is checked before each run, so a run already going finishes
        even if it passes the cap. At the cap the worker pauses and says why; raise the cap here to let it carry on.
      </p>
      {used.length > 0 && <p className="worker-editor__hint worker-limits__used">Used so far: {used.join(' · ')}.</p>}
    </div>
  )
}

/* ------------------------------------------------------------------ banner */

/** On a worker's page while it is paused for reaching its cap: why, and the way to raise it. */
export function WorkerHoldBanner({ worker }: { worker: Worker }): JSX.Element | null {
  const openEditor = useWorkers((s) => s.openEditor)
  if (!worker.budgetHold) return null
  return (
    <div className="worker-hold" role="status">
      <PauseCircle size={16} strokeWidth={1.9} />
      <span className="worker-hold__text">{worker.budgetHold.reason}</span>
      <button className="btn btn--sm" onClick={() => openEditor(worker.id)}>
        Raise the cap
      </button>
    </div>
  )
}
