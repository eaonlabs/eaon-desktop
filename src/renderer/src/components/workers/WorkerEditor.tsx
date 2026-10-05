import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Check, Pipette } from 'lucide-react'
import { useApp } from '../../state/store'
import { Modal, Select } from '../ui'
import { ModelSelect } from '../composer/ModelSelect'
import { WorkerFace } from './WorkerFace'
import { WorkerTradingFields } from './WorkerTradingFields'
import { useWorkers } from './workersStore'
import { WORKER_ACCESS, WORKER_COLORS, WORKER_PERSONALITIES, type WorkerAccess, type WorkerMood, type WorkerTrading } from '@shared/workers'
import { ENGINE_LABEL, type EngineId, type EngineModels, type EngineStatus } from '@shared/engines'
import { EFFORT_LABEL, orderEfforts } from '@shared/effort'
import type { EffortLevel } from '@shared/types'

/**
 * The agent engines this computer has besides Eaon's own loop, with their
 * models — for the editor's Engine and Model fields. Empty until the first
 * check after launch; follows every later one.
 */
function useEngines(): { statuses: EngineStatus[]; models: Partial<Record<EngineId, EngineModels | null>> } {
  const [statuses, setStatuses] = useState<EngineStatus[]>([])
  const [models, setModels] = useState<Partial<Record<EngineId, EngineModels | null>>>({})
  useEffect(() => {
    let live = true
    const load = async (): Promise<void> => {
      const list = await window.api.engines.status()
      const lists = await Promise.all(list.filter((e) => e.id !== 'native' && e.installed).map(async (e) => [e.id, await window.api.engines.models(e.id)] as const))
      if (!live) return
      setStatuses(list)
      setModels(Object.fromEntries(lists))
    }
    void load().catch(() => {})
    const off = window.api.engines.onChanged(() => void load().catch(() => {}))
    return () => {
      live = false
      off()
    }
  }, [])
  return { statuses, models }
}

/** One line on whether an engine can run turns right now, and what to do if it can't. */
function engineNote(status: EngineStatus | undefined, name: string): { text: string; ok: boolean } {
  if (!status) return { text: `Checking ${name}…`, ok: true }
  if (!status.installed) return { text: `${name} isn't installed on this computer, so this worker can't run until it is.`, ok: false }
  if (status.outdated) return { text: `${name} ${status.version ?? ''} is too old for Eaon. ${status.updateHint ?? 'Update it'} first.`, ok: false }
  if (status.auth.state === 'expired') return { text: `${name}'s sign-in expired. Reconnect it in Settings → Model providers.`, ok: false }
  if (status.auth.state === 'signed-out') return { text: `${name} isn't signed in. Sign in under Settings → Model providers.`, ok: false }
  const plan = status.auth.plan ? ` (${status.auth.plan})` : ''
  return { text: `${name} ${status.version ?? ''}${status.foundIn ? ` from ${status.foundIn}` : ''} · signed in${plan}. It runs this worker with its own tools and models; Eaon still decides what it may do.`, ok: true }
}

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

  const [name, setName] = useState(existing?.name ?? '')
  const [color, setColor] = useState(existing?.color ?? pickColor(workers.map((w) => w.color)))
  const [personality, setPersonality] = useState(existing?.personality ?? WORKER_PERSONALITIES[0].text)
  const [purpose, setPurpose] = useState(existing?.purpose ?? '')
  const [model, setModel] = useState(existing?.model ? `${existing.model.providerId}::${existing.model.modelId}` : '')
  const [engine, setEngine] = useState<EngineId>(existing?.engine ?? 'native')
  // How hard it thinks; empty follows the app's setting (Chat's).
  const [effort, setEffort] = useState<EffortLevel | ''>(existing?.effort ?? '')
  const engines = useEngines()
  const otherEngines = engines.statuses.filter((e) => e.id !== 'native' && (e.installed || e.id === engine))
  // New workers are trusted to act on their own; the catastrophic floor still applies.
  const [access, setAccess] = useState<WorkerAccess>(existing?.access ?? 'autonomous')
  const [trading, setTrading] = useState<WorkerTrading | null>(existing?.trading ?? null)
  const [focus, setFocus] = useState<'name' | 'purpose' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const mood: WorkerMood = focus === 'purpose' ? 'curious' : name.trim() ? 'happy' : 'neutral'
  // The levels the chosen model takes, when known; otherwise none are offered
  // (an unknown model may not think in levels at all).
  const effortLevels = useMemo((): EffortLevel[] => {
    if (!model) return []
    const [providerId, modelId] = model.split('::')
    if (engine !== 'native') return orderEfforts(engines.models[engine]?.models.find((m) => m.id === modelId)?.efforts ?? [])
    return orderEfforts(models.find((m) => m.providerId === providerId && m.id === modelId)?.efforts ?? [])
  }, [model, engine, engines.models, models])
  const note = engine === 'native' ? null : engineNote(engines.statuses.find((e) => e.id === engine), ENGINE_LABEL[engine])

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
        engine,
        effort: effort || null,
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

        {(otherEngines.length > 0 || engine !== 'native') && (
          <div className="field field--inline">
            <span className="field-label">Engine</span>
            <Select
              width={240}
              value={engine}
              onChange={(next: EngineId) => {
                setEngine(next)
                // A model belongs to its engine.
                setModel('')
              }}
              options={[
                { value: 'native', label: 'Eaon (any provider)' },
                ...otherEngines.map((e) => ({ value: e.id, label: e.installed ? ENGINE_LABEL[e.id] : `${ENGINE_LABEL[e.id]} (not installed)` }))
              ]}
            />
          </div>
        )}
        {note && <p className="worker-editor__hint" data-warning={!note.ok || undefined}>{note.text}</p>}
        <div className="worker-editor__row">
          <div className="field field--inline">
            <span className="field-label">Model</span>
            <ModelSelect
              width={240}
              engine={engine}
              label="Model"
              value={model ? { providerId: model.split('::')[0], modelId: model.split('::')[1] } : null}
              onChange={(ref) => setModel(ref && ref.modelId ? `${ref.providerId ?? engine}::${ref.modelId}` : '')}
              defaultLabel={engine === 'native' ? 'Follow Chat’s model' : `${ENGINE_LABEL[engine]}’s default`}
            />
          </div>
          {effortLevels.length > 0 && (
            <div className="field field--inline">
              <span className="field-label">Thinking</span>
              <Select
                width={160}
                value={effort}
                onChange={(next: EffortLevel | '') => setEffort(next)}
                options={[{ value: '', label: 'Follow Chat' }, ...effortLevels.map((level) => ({ value: level, label: EFFORT_LABEL[level] }))]}
              />
            </div>
          )}
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
