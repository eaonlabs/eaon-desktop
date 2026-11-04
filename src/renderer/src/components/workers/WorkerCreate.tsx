import { useMemo, useState, type JSX } from 'react'
import { useMods, workerTemplatesOf } from '../../state/mods'
import { ArrowLeft, Sparkles } from 'lucide-react'
import { MAX_WORKERS, WORKER_COLORS, WORKER_PERSONALITIES, WORKER_SUGGESTIONS, type WorkerMood, type WorkerSuggestion } from '@shared/workers'
import { WORKER_SHAPES, type WorkerShape } from '@shared/workerLook'
import { workerApp, workerAppsEnabled } from '@shared/workerApps'
import { AppMark } from './WorkerCards'
import { TopBar } from '../TopBar'
import { WorkerFace } from './WorkerFace'
import { WorkerLookPicker } from './WorkerLookPicker'
import { AppPicker } from './WorkerApps'
import { errorText, useWorkers } from './workersStore'

/**
 * A new worker, on a page of its own: the face first (its shape and colour
 * picked right on it), a name, and Get started. A job and the apps it
 * handles are there for whoever wants them; the suggestions underneath fill
 * all of it in one tap. Everything else (model, freedom, plugins) is in its
 * editor afterwards.
 */
export function WorkerCreate(): JSX.Element {
  const workers = useWorkers((s) => s.workers)
  const [color, setColor] = useState(() => freeColor(workers.map((w) => w.color)))
  const [shape, setShape] = useState<WorkerShape>(() => freeShape(workers.map((w) => w.shape)))
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [personality, setPersonality] = useState(WORKER_PERSONALITIES[0].text)
  const [apps, setApps] = useState<string[]>([])
  const [picked, setPicked] = useState<string | null>(null)
  const [showApps, setShowApps] = useState(false)
  const [focus, setFocus] = useState<'name' | 'purpose' | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const labs = workerAppsEnabled()
  // The enabled mods' templates, after Eaon's suggestions.
  const modsOn = useMods((s) => s.enabled)
  const fromMods = useMemo(
    () => workerTemplatesOf(modsOn).map((t) => ({ id: t.key, name: t.name, blurb: t.blurb, color: t.color, shape: t.shape, purpose: t.purpose, personality: t.personality, apps: [] as string[], modName: t.modName })),
    [modsOn]
  )
  const full = workers.length >= MAX_WORKERS
  const taken = useMemo(() => new Set(workers.map((w) => w.name.toLowerCase())), [workers])

  const mood: WorkerMood = saving ? 'excited' : focus === 'purpose' ? 'thinking' : name.trim() ? 'happy' : 'neutral'

  const suggest = (s: WorkerSuggestion): void => {
    setPicked(s.id)
    setName(taken.has(s.name.toLowerCase()) ? '' : s.name)
    setColor(s.color)
    setShape(s.shape)
    setPurpose(s.purpose)
    setPersonality(s.personality)
    setApps(labs ? s.apps : [])
    setError(null)
  }

  const create = async (): Promise<void> => {
    if (!name.trim() || saving || full) return
    setSaving(true)
    setError(null)
    try {
      const saved = await useWorkers.getState().save({ name: name.trim(), color, shape, personality, purpose: purpose.trim(), ...(labs ? { apps } : {}) })
      useWorkers.getState().select(saved.id)
    } catch (e) {
      setError(errorText(e))
      setSaving(false)
    }
  }

  return (
    <div className="page worker-create">
      <TopBar
        variant="page__bar"
        left={
          <button className="header-btn worker-back" aria-label="Back to the team" onClick={() => useWorkers.getState().setCreating(false)}>
            <ArrowLeft size={14} strokeWidth={2} />
            <span>Team</span>
          </button>
        }
      />
      <div className="page__scroll scroll">
        <div className="worker-create__inner">
          <div className="worker-create__title">
            <WorkerFace color={color} shape={shape} size={22} mood={mood} />
            <span>{name.trim() || 'New worker'}</span>
          </div>

          <WorkerLookPicker color={color} shape={shape} mood={mood} onColor={setColor} onShape={setShape} />

          <form
            className="worker-create__form"
            onSubmit={(e) => {
              e.preventDefault()
              void create()
            }}
          >
            <label className="worker-create__field">
              <span>Name</span>
              <input
                autoFocus
                className="worker-create__input"
                value={name}
                maxLength={40}
                placeholder="New worker"
                onFocus={() => setFocus('name')}
                onBlur={() => setFocus(null)}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="worker-create__field">
              <span>
                Its job <em>optional</em>
              </span>
              <textarea
                className="worker-create__input worker-create__input--area"
                rows={2}
                value={purpose}
                placeholder="What it’s for — or leave it, and tell it in its first message."
                onFocus={() => setFocus('purpose')}
                onBlur={() => setFocus(null)}
                onChange={(e) => setPurpose(e.target.value)}
              />
            </label>
            {labs && (
              <div className="worker-create__field">
                <span>
                  Apps it handles <em>optional</em>
                </span>
                {showApps ? (
                  <AppPicker value={apps} onChange={setApps} />
                ) : (
                  <button type="button" className="worker-create__apps" onClick={() => setShowApps(true)}>
                    {apps.length > 0 ? (
                      <>
                        <span className="worker-create__marks">
                          {apps.map((id) => (
                            <AppMark key={id} app={workerApp(id)} small />
                          ))}
                        </span>
                        {apps.map((id) => workerApp(id)?.name).filter(Boolean).join(', ')} · Change
                      </>
                    ) : (
                      'Choose apps — DoorDash, Uber, Maps, Venmo, Amazon, Ring, Hue…'
                    )}
                  </button>
                )}
              </div>
            )}
            {error && <div className="msg__error">{error}</div>}
            <button className="worker-create__go" type="submit" disabled={!name.trim() || saving || full}>
              {full ? `You have ${MAX_WORKERS} workers already` : saving ? 'Starting…' : 'Get started'}
            </button>
          </form>

          <div className="worker-create__suggest">
            <span className="worker-create__suggest-title">
              <Sparkles size={14} strokeWidth={2} />
              Suggestions
            </span>
            <div className="suggest-grid">
              {[...WORKER_SUGGESTIONS.filter((s) => labs || s.apps.length === 0 || s.id === 'night-shift' || s.id === 'inbox-triage'), ...fromMods].map((s, i) => (
                <button key={s.id} className="suggest-card" data-on={picked === s.id || undefined} style={{ ['--i' as string]: i }} onClick={() => suggest(s)}>
                  <WorkerFace color={s.color} shape={s.shape} size={48} mood={picked === s.id ? 'happy' : 'neutral'} />
                  <span className="suggest-card__text">
                    <span className="suggest-card__name">{s.name}</span>
                    <span className="suggest-card__blurb">{s.blurb}</span>
                    {'modName' in s && <span className="suggest-card__from">From {String(s.modName)}</span>}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function freeColor(used: string[]): string {
  const taken = new Set(used.map((c) => c.toLowerCase()))
  return WORKER_COLORS.find((c) => !taken.has(c.toLowerCase())) ?? WORKER_COLORS[used.length % WORKER_COLORS.length]
}

function freeShape(used: (WorkerShape | undefined)[]): WorkerShape {
  const taken = new Set(used)
  return WORKER_SHAPES.find((s) => !taken.has(s.id))?.id ?? 'pebble'
}
