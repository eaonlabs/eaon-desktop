import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { FileUp } from 'lucide-react'
import { resolveSelection } from '@shared/modelSelection'
import { ENGINE_LABEL } from '@shared/engines'
import { EFFORT_LABEL } from '@shared/effort'
import { WORKER_ACCESS, type Worker, type WorkerAccess } from '@shared/workers'
import { moneyText } from '@shared/workerLimits'
import { importAccess, listText, matchPlugins, parseWorkerSetup, routineWhen, SETUP_LEAVES_OUT, uniqueName, type WorkerSetup } from '@shared/workerSetup'
import { useApp } from '../../state/store'
import { Modal, Select } from '../ui'
import { notify } from '../Notice'
import { errorText, useWorkers } from './workersStore'

/**
 * Duplicate, export and import a worker. An export is a file of its setup:
 * what its Edit dialog sets, its routines and its playbooks, and nothing it
 * was signed in to, no key, no note and no message. Import shows everything a
 * file sets before anything is created, and a file's freedom level starts no
 * higher than Careful (shared/workerSetup.ts).
 */

/** Makes a copy of the worker and opens it. */
export async function duplicateWorker(worker: Worker): Promise<void> {
  try {
    const copy = await useWorkers.getState().duplicate(worker.id)
    notify(`Made ${copy.name} from ${worker.name}. Its apps and sign-ins aren’t copied.`)
  } catch (error) {
    notify(errorText(error), 'error')
  }
}

/** Writes the worker's setup file where the user chooses. */
export async function exportWorker(worker: Worker): Promise<void> {
  try {
    const made = await window.api.workers.exportSetup(worker.id)
    const path = await window.api.workers.saveSetupFile(made.fileName, made.text)
    if (!path) return
    const parts = [`${made.routines} ${made.routines === 1 ? 'routine' : 'routines'}`, `${made.playbooks} ${made.playbooks === 1 ? 'playbook' : 'playbooks'}`]
    notify(`Saved ${worker.name}’s setup with ${listText(parts)}. It has no sign-ins, keys, notes or messages.`)
  } catch (error) {
    notify(errorText(error), 'error')
  }
}

/* ------------------------------------------------------------------ import */

const accessLabel = (access: WorkerAccess): string => WORKER_ACCESS.find((a) => a.id === access)?.label ?? access

export function WorkerImport(): JSX.Element | null {
  const { open, setOpen, select, workers } = useWorkers(useShallow((s) => ({ open: s.importOpen, setOpen: s.setImportOpen, select: s.select, workers: s.workers })))
  if (!open) return null
  return <ImportDialog onClose={() => setOpen(false)} onDone={(worker) => select(worker.id)} taken={workers.map((w) => w.name)} />
}

function ImportDialog({ onClose, onDone, taken }: { onClose: () => void; onDone: (worker: Worker) => void; taken: string[] }): JSX.Element {
  const [picked, setPicked] = useState<{ file: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const parsed = useMemo(() => (picked ? parseWorkerSetup(picked.text) : null), [picked])
  const [name, setName] = useState('')
  const [access, setAccess] = useState<WorkerAccess>('safe')

  const choose = async (): Promise<void> => {
    setError(null)
    try {
      const file = await window.api.workers.openSetupFile()
      if (!file) return
      setPicked(file)
      const next = parseWorkerSetup(file.text)
      if (next.ok) {
        setName(uniqueName(next.setup.name, taken))
        setAccess(importAccess(next.setup.access))
      }
    } catch (e) {
      setError(errorText(e))
    }
  }

  const providers = useApp((s) => s.providers)
  const servers = useApp((s) => s.mcpServers)
  const setup = parsed?.ok ? parsed.setup : null
  // A model the file names that isn't connected here would only make every run fail: the worker follows Chat's instead.
  const modelHere = useMemo(() => {
    if (!setup?.model || setup.engine !== 'native') return null
    return resolveSelection(setup.model, providers).model ?? null
  }, [setup, providers])
  const dropModel = Boolean(setup?.model) && setup!.engine === 'native' && !modelHere

  const create = async (): Promise<void> => {
    if (!picked || !setup || busy) return
    setBusy(true)
    setError(null)
    try {
      const worker = await window.api.workers.importSetup(picked.text, { name: name.trim(), access, ...(dropModel ? { model: null } : {}) })
      onDone(worker)
      notify(`Made ${worker.name} from the file.`)
      onClose()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Import a worker"
      width={600}
      actions={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          {setup && (
            <button className="btn btn--primary" disabled={busy || !name.trim()} onClick={() => void create()}>
              Create worker
            </button>
          )}
        </>
      }
    >
      <div className="setup-import">
        {!picked && (
          <>
            <p className="setup-import__lead">Choose a worker setup file exported from Eaon. You’ll see everything it sets before anything is created.</p>
            <button className="btn" onClick={() => void choose()}>
              <FileUp size={15} strokeWidth={1.9} />
              Choose a file…
            </button>
          </>
        )}
        {parsed && !parsed.ok && (
          <>
            <div className="msg__error" role="alert">
              {parsed.error}
            </div>
            <button className="btn" onClick={() => void choose()}>
              Choose another file…
            </button>
          </>
        )}
        {setup && picked && (
          <>
            <p className="setup-import__lead">
              From <code>{picked.file.split(/[\\/]/).pop()}</code>. Nothing has been created yet.
            </p>
            <label className="field">
              <span className="field-label">Name</span>
              <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="field field--inline">
              <span className="field-label">Freedom</span>
              <Select width={200} value={access} onChange={setAccess} options={WORKER_ACCESS.map((a) => ({ value: a.id, label: a.label }))} />
            </div>
            <p className="worker-editor__hint">
              {access === setup.access
                ? `The file asks for ${accessLabel(setup.access)}, and that is what it gets. `
                : access === importAccess(setup.access)
                  ? `The file asks for ${accessLabel(setup.access)}. It starts at ${accessLabel(access)} until you have read what it does; raise it later with Edit. `
                  : `The file asks for ${accessLabel(setup.access)}; you chose ${accessLabel(access)}. `}
              {WORKER_ACCESS.find((a) => a.id === access)?.description}
            </p>
            <SetupPreview setup={setup} modelLabel={modelHere ? modelHere.label : null} dropModel={dropModel} servers={servers} />
            {parsed?.ok && parsed.ignored.length > 0 && (
              <p className="worker-editor__hint">
                The file also had {listText(parsed.ignored.map((k) => `“${k}”`))}, which Eaon doesn’t import.
              </p>
            )}
            <p className="worker-editor__hint">{SETUP_LEAVES_OUT}</p>
            <button className="btn btn--ghost btn--sm setup-import__again" onClick={() => void choose()}>
              Choose a different file…
            </button>
          </>
        )}
        {error && (
          <div className="msg__error" role="alert">
            {error}
          </div>
        )}
      </div>
    </Modal>
  )
}

/** Everything a setup file sets, in rows: nothing is left to find out after it is created. */
function SetupPreview({
  setup,
  modelLabel,
  dropModel,
  servers
}: {
  setup: WorkerSetup
  modelLabel: string | null
  dropModel: boolean
  servers: { id: string; name: string; pluginId?: string }[]
}): JSX.Element {
  const plugins = setup.plugins ? matchPlugins(setup.plugins, servers) : null
  const rows: { label: string; value: JSX.Element | string }[] = [
    { label: 'Purpose', value: setup.purpose },
    ...(setup.personality ? [{ label: 'Personality', value: setup.personality }] : []),
    {
      label: 'Model',
      value: !setup.model
        ? 'Follows Chat’s model'
        : setup.engine !== 'native'
          ? `${setup.model.modelId} on ${ENGINE_LABEL[setup.engine]}`
          : dropModel
            ? `${setup.model.modelId}, which isn’t connected here. It will follow Chat’s model.`
            : (modelLabel ?? setup.model.modelId)
    },
    ...(setup.engine !== 'native' && !setup.model ? [{ label: 'Engine', value: ENGINE_LABEL[setup.engine] }] : []),
    ...(setup.effort ? [{ label: 'Thinking', value: EFFORT_LABEL[setup.effort] }] : []),
    {
      label: 'Plugins',
      value: !plugins ? (
        'Every plugin you have connected'
      ) : plugins.length === 0 ? (
        'None'
      ) : (
        <ul className="setup-preview__list">
          {plugins.map((m) => (
            <li key={m.wanted.id || m.wanted.name}>
              {m.wanted.name || m.wanted.id} {m.here ? <span className="setup-preview__ok">connected here</span> : <span className="setup-preview__missing">not connected here, so it won’t have it</span>}
            </li>
          ))}
        </ul>
      )
    },
    {
      label: 'Routines',
      value:
        setup.routines.length === 0 ? (
          'None'
        ) : (
          <ul className="setup-preview__list">
            {setup.routines.map((r) => (
              <li key={r.name}>
                <strong>{r.name}</strong> · {routineWhen(r)}
                <div className="setup-preview__task">{r.task}</div>
              </li>
            ))}
          </ul>
        )
    },
    {
      label: 'Playbooks',
      value:
        setup.playbooks.length === 0 ? (
          'None'
        ) : (
          <ul className="setup-preview__list">
            {setup.playbooks.map((p) => (
              <li key={p.name}>
                <strong>{p.name}</strong>
                {p.summary ? ` · ${p.summary}` : ''}
              </li>
            ))}
          </ul>
        )
    },
    ...(setup.budget
      ? [
          {
            label: 'Spend cap',
            value: [
              setup.budget.tokens !== null ? `${setup.budget.tokens.toLocaleString('en-US')} tokens` : null,
              setup.budget.usd !== null ? moneyText(setup.budget.usd) : null
            ]
              .filter(Boolean)
              .join(' and ') + ` per ${setup.budget.period}`
          }
        ]
      : []),
    ...(setup.retry ? [{ label: 'Retries', value: `Up to ${setup.retry.attempts} ${setup.retry.attempts === 1 ? 'time' : 'times'}, the first after ${setup.retry.minutes} min` }] : []),
    ...(setup.sites
      ? [
          {
            label: 'Websites',
            value: [setup.sites.allow.length > 0 ? `Only ${setup.sites.allow.join(', ')}` : null, setup.sites.deny.length > 0 ? `Never ${setup.sites.deny.join(', ')}` : null].filter(Boolean).join('. ')
          }
        ]
      : []),
    ...(setup.toolRules
      ? [
          {
            label: 'Tool rules',
            value: Object.entries(setup.toolRules)
              .map(([tool, rule]) => `${tool}: ${rule === 'ask' ? 'asks first' : 'off'}`)
              .join(', ')
          }
        ]
      : [])
  ]
  return (
    <dl className="setup-preview">
      {rows.map((row) => (
        <div key={row.label} className="setup-preview__row">
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}
