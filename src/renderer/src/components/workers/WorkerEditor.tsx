import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Check, Pipette } from 'lucide-react'
import { useApp } from '../../state/store'
import { Modal, Select } from '../ui'
import { WorkerFace } from './WorkerFace'
import { WorkerTradingFields } from './WorkerTradingFields'
import { useWorkers } from './workersStore'
import { WORKER_ACCESS, WORKER_COLORS, WORKER_PERSONALITIES, type WorkerAccess, type WorkerMood, type WorkerTrading } from '@shared/workers'

/**
 * Creating (or editing) a worker: its colour, name, personality and purpose,
 * as the design spec lists them — plus the model it thinks with and whether it
 * may change things. The face on top is the real one, re-coloured live, and
 * it reacts: happy when a name goes in, serious while it is being given a job.
 */
export function WorkerEditor({ workerId }: { workerId: string | null }): JSX.Element {
  const { workers, save, closeEditor, select } = useWorkers(
    useShallow((s) => ({ workers: s.workers, save: s.save, closeEditor: s.closeEditor, select: s.select }))
  )
  const existing = workerId ? workers.find((w) => w.id === workerId) ?? null : null
  const models = useApp((s) => s.availableModels())
  const providers = useApp((s) => s.providers)

  const [name, setName] = useState(existing?.name ?? '')
  const [color, setColor] = useState(existing?.color ?? pickColor(workers.map((w) => w.color)))
  const [personality, setPersonality] = useState(existing?.personality ?? WORKER_PERSONALITIES[0].text)
  const [purpose, setPurpose] = useState(existing?.purpose ?? '')
  const [model, setModel] = useState(existing?.model ? `${existing.model.providerId}::${existing.model.modelId}` : '')
  // New workers are trusted to act on their own; the catastrophic floor still applies.
  const [access, setAccess] = useState<WorkerAccess>(existing?.access ?? 'autonomous')
  const [trading, setTrading] = useState<WorkerTrading | null>(existing?.trading ?? null)
  const [focus, setFocus] = useState<'name' | 'purpose' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const mood: WorkerMood = focus === 'purpose' ? 'serious' : name.trim() ? 'happy' : 'neutral'
  const modelOptions = useMemo(() => {
    const duplicated = new Set(models.filter((m, i) => models.findIndex((o) => o.id === m.id) !== i).map((m) => m.id))
    return [
      { value: '', label: 'Your selected model' },
      ...models.map((m) => ({
        value: `${m.providerId}::${m.id}`,
        label: duplicated.has(m.id) ? `${m.label} · ${providers.find((p) => p.id === m.providerId)?.name ?? m.providerId}` : m.label
      }))
    ]
  }, [models, providers])

  // A trading worker's strategy can stand in for its purpose.
  const valid = name.trim().length > 0 && (purpose.trim().length > 0 || Boolean(trading?.strategy.trim()))

  const submit = async (): Promise<void> => {
    if (!valid || saving) return
    setSaving(true)
    setError(null)
    try {
      const [providerId, modelId] = model ? model.split('::') : []
      const saved = await save({
        ...(existing ? { id: existing.id } : {}),
        name: name.trim(),
        color,
        personality: personality.trim(),
        purpose: purpose.trim() || (trading ? 'Trade for the user, following the strategy in the trading settings.' : ''),
        model: providerId && modelId ? { providerId, modelId } : null,
        access,
        trading
      })
      closeEditor()
      if (!existing) select(saved.id)
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={closeEditor}
      title={existing ? `Edit ${existing.name}` : 'New worker'}
      width={560}
      actions={
        <>
          <button className="btn btn--ghost" onClick={closeEditor}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={!valid || saving} onClick={() => void submit()}>
            {existing ? 'Save' : 'Create worker'}
          </button>
        </>
      }
    >
      <div className="worker-editor">
        <div className="worker-editor__preview">
          <WorkerFace color={color} mood={mood} size={104} follow />
          <span className="worker-editor__preview-name">{name.trim() || 'Your new worker'}</span>
        </div>

        <label className="field">
          <span className="field-label">Name</span>
          <input
            autoFocus={!existing}
            className="input"
            value={name}
            maxLength={40}
            placeholder="Nova"
            onFocus={() => setFocus('name')}
            onBlur={() => setFocus(null)}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="field">
          <span className="field-label">Colour</span>
          <div className="swatches" role="radiogroup" aria-label="Colour">
            {WORKER_COLORS.map((c) => (
              <button
                key={c}
                role="radio"
                aria-checked={c.toLowerCase() === color.toLowerCase()}
                aria-label={c}
                className="swatch"
                style={{ background: c }}
                onClick={() => setColor(c)}
              >
                {c.toLowerCase() === color.toLowerCase() && <Check size={14} strokeWidth={3} />}
              </button>
            ))}
            <label className="swatch swatch--custom" title="Any colour" data-active={!WORKER_COLORS.some((c) => c.toLowerCase() === color.toLowerCase()) || undefined} style={!WORKER_COLORS.some((c) => c.toLowerCase() === color.toLowerCase()) ? { background: color } : undefined}>
              <Pipette size={14} strokeWidth={2} />
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Pick any colour" />
            </label>
          </div>
        </div>

        <div className="field">
          <span className="field-label">Personality</span>
          <div className="persona-chips">
            {WORKER_PERSONALITIES.map((p) => (
              <button key={p.label} className="persona-chip" data-on={personality === p.text || undefined} onClick={() => setPersonality(p.text)}>
                {p.label}
              </button>
            ))}
          </div>
          <textarea
            className="input"
            rows={2}
            value={personality}
            placeholder="How it talks and behaves"
            onChange={(e) => setPersonality(e.target.value)}
            style={{ minHeight: 60 }}
          />
        </div>

        <label className="field">
          <span className="field-label">Purpose</span>
          <textarea
            className="input"
            rows={3}
            value={purpose}
            placeholder="What it is for — e.g. “Watch my model training runs, report the loss every hour and restart a run that crashes.”"
            onFocus={() => setFocus('purpose')}
            onBlur={() => setFocus(null)}
            onChange={(e) => setPurpose(e.target.value)}
          />
        </label>

        <div className="worker-editor__row">
          <div className="field field--inline">
            <span className="field-label">Model</span>
            <Select width={240} value={model} onChange={setModel} options={modelOptions} />
          </div>
          <div className="field field--inline">
            <span className="field-label">Freedom</span>
            <Select
              width={200}
              value={access}
              onChange={setAccess}
              options={WORKER_ACCESS.map((a) => ({ value: a.id, label: a.label }))}
            />
          </div>
        </div>
        <p className="worker-editor__hint worker-editor__access-hint">{WORKER_ACCESS.find((a) => a.id === access)?.description}</p>

        <WorkerTradingFields value={trading} onChange={setTrading} access={access} />

        {error && <div className="msg__error">{error}</div>}
      </div>
    </Modal>
  )
}

/** The first spec colour no worker is using yet, so a new team is colourful by default. */
function pickColor(used: string[]): string {
  const taken = new Set(used.map((c) => c.toLowerCase()))
  return WORKER_COLORS.find((c) => !taken.has(c.toLowerCase())) ?? WORKER_COLORS[used.length % WORKER_COLORS.length]
}
