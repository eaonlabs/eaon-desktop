import { useEffect, useState } from 'react'
import { FolderOpen, Hammer, MessagesSquare, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { draftError, type ScheduledTask, type TaskDraft } from '@shared/scheduler'
import type { AgentMode } from '@shared/types'
import { agentWorkspace, useApp } from '../../state/store'
import { Modal, Segmented, Switch } from '../ui'
import { ModelSelect } from '../composer/ModelSelect'
import { formFromSchedule, scheduleFromForm, SchedulePicker, type ScheduleForm } from './SchedulePicker'

/** New / Edit schedule. `task` is null for a new one. */

const DEFAULT_MODEL = ''
const modelKey = (providerId: string, modelId: string): string => `${providerId}::${modelId}`

/** ipcRenderer.invoke wraps main's message in its own prefix; the user only needs main's part. */
export function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function TaskEditor({
  open,
  task,
  onClose
}: {
  open: boolean
  task: ScheduledTask | null
  onClose: () => void
}): JSX.Element | null {
  const { current, workCwd } = useApp(
    useShallow((s) => ({
      current: s.currentModel(),
      workCwd: agentWorkspace(s.workspaces)?.cwd ?? null
    }))
  )
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<AgentMode>('chat')
  const [schedule, setSchedule] = useState<ScheduleForm>(() => formFromSchedule(null))
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [cwd, setCwd] = useState<string | null>(null)
  const [allowChanges, setAllowChanges] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset from the task each time the editor opens, not on every render.
  useEffect(() => {
    if (!open) return
    setName(task?.name ?? '')
    setPrompt(task?.prompt ?? '')
    setMode(task?.mode ?? 'chat')
    setSchedule(formFromSchedule(task?.schedule ?? null))
    setModel(task?.model ? modelKey(task.model.providerId, task.model.modelId) : DEFAULT_MODEL)
    setCwd(task?.cwd ?? null)
    setAllowChanges(task?.allowChanges ?? false)
    setSaving(false)
    setError(null)
  }, [open, task])


  const buildDraft = (): TaskDraft => {
    const next = scheduleFromForm(schedule, task?.schedule)
    // A one-off that already ran is switched off; giving it a new future time brings it back.
    const revived =
      task !== null &&
      !task.enabled &&
      next.kind === 'once' &&
      (task.schedule.kind !== 'once' || task.schedule.at !== next.at) &&
      next.at > Date.now()
    const [providerId, modelId] = model ? model.split('::') : []
    return {
      ...(task ? { id: task.id } : {}),
      name: name.trim() || prompt.trim().split('\n')[0].slice(0, 60),
      prompt,
      schedule: next,
      mode,
      model: providerId && modelId ? { providerId, modelId } : null,
      cwd: mode === 'work' ? cwd : null,
      allowChanges: mode === 'work' && allowChanges,
      enabled: task ? task.enabled || revived : true
    }
  }

  const draft = buildDraft()
  const invalid = draftError(draft, Date.now())

  const save = async (): Promise<void> => {
    if (invalid || saving) return
    setSaving(true)
    setError(null)
    try {
      await window.api.scheduler.save(draft)
      onClose()
    } catch (e) {
      setError(cleanError(e))
      setSaving(false)
    }
  }

  const chooseFolder = async (): Promise<void> => {
    const paths = await window.api.app.openFiles({ properties: ['openDirectory', 'createDirectory'] })
    if (paths[0]) setCwd(paths[0])
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={520}
      title={task ? 'Edit schedule' : 'New schedule'}
      actions={
        <>
          {error && (
            <span className="sched-form__error" role="alert">
              {error}
            </span>
          )}
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={Boolean(invalid) || saving} onClick={() => void save()}>
            {task ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <div className="sched-form">
        <label className="sched-field">
          <span className="field-label">Name</span>
          <input
            className="input"
            value={name}
            autoFocus
            placeholder={prompt.trim() ? prompt.trim().split('\n')[0].slice(0, 60) : 'Morning briefing'}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="sched-field">
          <span className="field-label">Prompt</span>
          <textarea
            className="input sched-form__prompt"
            value={prompt}
            placeholder="Summarise what changed in my GitHub notifications since yesterday, most important first."
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>

        <div className="sched-field">
          <span className="field-label">Runs in</span>
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              {
                value: 'chat',
                label: (
                  <span className="sched-seg">
                    <MessagesSquare size={14} strokeWidth={2} />
                    Answer
                  </span>
                )
              },
              {
                value: 'work',
                label: (
                  <span className="sched-seg">
                    <Hammer size={14} strokeWidth={2} />
                    Agent
                  </span>
                )
              }
            ]}
          />
          <span className="sched-field__hint">
            {mode === 'chat' ? 'Researches and answers with web search. Changes nothing.' : 'The full agent: files, shell, web and plugins.'}
          </span>
        </div>

        <div className="sched-field">
          <span className="field-label">Schedule</span>
          <SchedulePicker form={schedule} onChange={setSchedule} previous={task?.schedule} />
          <span className="sched-field__hint">
            Runs while Eaon is open, or in the background if you turn that on. A time missed while Eaon was closed or your
            computer slept runs once when it’s back, if it’s less than a day late. If a run is still going when the next one is
            due, that one is skipped.
          </span>
        </div>

        <div className="sched-field">
          <span className="field-label">Model</span>
          {/* The shared model field: a pinned model that's gone stays shown, with why, so saving never changes it silently. */}
          <ModelSelect
            width={300}
            value={model ? { providerId: model.slice(0, model.indexOf('::')), modelId: model.slice(model.indexOf('::') + 2) } : null}
            onChange={(ref) => setModel(ref?.providerId ? modelKey(ref.providerId, ref.modelId) : DEFAULT_MODEL)}
            defaultLabel={current ? `App default (${current.label})` : 'App default'}
          />
        </div>

        {mode === 'work' && (
          <>
            <div className="sched-field">
              <span className="field-label">Folder</span>
              <div className="sched-folder">
                <FolderOpen size={15} strokeWidth={1.9} />
                <span className="sched-folder__path" title={cwd ?? workCwd ?? undefined}>
                  {cwd ?? (workCwd ? `Chat's folder (${workCwd})` : "Chat's folder (~/Eaon)")}
                </span>
                {cwd && (
                  <button type="button" className="icon-btn" aria-label="Use Chat's folder" onClick={() => setCwd(null)}>
                    <X size={14} strokeWidth={2} />
                  </button>
                )}
                <button type="button" className="btn btn--sm sched-form__btn" onClick={() => void chooseFolder()}>
                  Choose…
                </button>
              </div>
            </div>

            <div className="sched-toggle">
              <div className="sched-toggle__body">
                <div className="sched-toggle__title">Allow changes</div>
                <div className="sched-toggle__desc">
                  Nobody is there to approve, so runs are read-only unless you allow this. On, the task can edit files and
                  run commands; risky actions (deleting outside the folder, git push, sudo) are still refused.
                </div>
              </div>
              <Switch label="Allow changes" checked={allowChanges} onChange={setAllowChanges} />
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
