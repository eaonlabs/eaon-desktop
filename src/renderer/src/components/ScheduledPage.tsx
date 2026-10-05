import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarClock, Plus, X } from 'lucide-react'
import type { ScheduledTask } from '@shared/scheduler'
import { resolveSelection } from '@shared/modelSelection'
import { Card, Modal, Row, Section, Switch } from './ui'
import { TopBar } from './TopBar'
import { revealChat, useApp } from '../state/store'
import { TaskCard } from './scheduled/TaskCard'
import { cleanError, TaskEditor } from './scheduled/TaskEditor'

/**
 * Scheduled tasks. The tasks themselves live in the main process
 * (`features/scheduler`), which runs them whether or not this page — or any
 * window — is open; the page only lists and edits them.
 */

/** Re-renders on an interval so "in 5 min" stays true while the page is open. */
function useNow(every: number): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(timer)
  }, [every])
  return now
}

export function ScheduledPage(): JSX.Element {
  const providers = useApp((s) => s.providers)
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null)
  const [editing, setEditing] = useState<ScheduledTask | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [deleting, setDeleting] = useState<ScheduledTask | null>(null)
  const [error, setError] = useState<string | null>(null)
  const now = useNow(30_000)
  const [background, setBackground] = useState<{ supported: boolean; enabled: boolean } | null>(null)
  const isMac = navigator.platform.startsWith('Mac')

  useEffect(() => {
    void window.api.app.background().then(setBackground)
  }, [])

  useEffect(() => {
    let live = true
    void window.api.scheduler.list().then((list) => live && setTasks(list))
    const off = window.api.scheduler.onTasks(setTasks)
    return () => {
      live = false
      off()
    }
  }, [])

  // Newest first, and stable: ordering by next run would make a card jump
  // away from the pointer the moment it starts running.
  const sorted = useMemo(() => (tasks ? [...tasks].sort((a, b) => b.createdAt - a.createdAt) : []), [tasks])

  const attempt = useCallback((action: () => Promise<unknown>): void => {
    setError(null)
    action().catch((e) => setError(cleanError(e)))
  }, [])

  const openEditor = useCallback((task: ScheduledTask | null) => {
    setEditing(task)
    setEditorOpen(true)
  }, [])
  const onToggle = useCallback(
    (task: ScheduledTask, enabled: boolean) => attempt(() => window.api.scheduler.setEnabled(task.id, enabled)),
    [attempt]
  )
  const onRunNow = useCallback((task: ScheduledTask) => attempt(() => window.api.scheduler.runNow(task.id)), [attempt])
  const onStop = useCallback((task: ScheduledTask) => attempt(() => window.api.scheduler.cancel(task.id)), [attempt])
  const onOpenChat = useCallback((chatId: string) => revealChat(chatId), [])

  // The same resolution the run itself uses (shared/modelSelection): a pinned
  // model that can't run says so here, before its next slot fails.
  const modelLabel = (task: ScheduledTask): string | null => {
    if (!task.model) return null
    const resolved = resolveSelection(task.model, providers)
    if (resolved.model) return resolved.model.label
    return `${resolved.wanted?.label ?? task.model.modelId} (unavailable: ${resolved.reason ?? 'not offered now'})`
  }

  return (
    <div className="page">
      <TopBar
        variant="page__bar"
        right={
          <button className="btn btn--primary" onClick={() => openEditor(null)}>
            <Plus size={14} strokeWidth={2} />
            New schedule
          </button>
        }
      />

      <div className="page__scroll scroll">
        <div className="page__inner page__inner--sched">
          <h1 className="page__title">Scheduled</h1>
          <p className="page__subtitle">
            Prompts that run on their own while Eaon is running. Each run lands in Recents as a new chat.
          </p>

          {error && (
            <div className="sched-alert" role="alert">
              <span>{error}</span>
              <button className="icon-btn" aria-label="Dismiss" onClick={() => setError(null)}>
                <X size={14} strokeWidth={2} />
              </button>
            </div>
          )}

          {tasks === null ? null : sorted.length === 0 ? (
            <Section>
              <Card>
                <Row title="Nothing scheduled" description="Run a prompt every morning, every few hours, on weekdays, or once at a set time.">
                  <button className="btn" onClick={() => openEditor(null)}>
                    <CalendarClock size={14} strokeWidth={1.9} />
                    Create
                  </button>
                </Row>
              </Card>
            </Section>
          ) : (
            <div className="sched-list">
              {sorted.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  now={now}
                  modelLabel={modelLabel(task)}
                  onEdit={openEditor}
                  onDelete={setDeleting}
                  onToggle={onToggle}
                  onRunNow={onRunNow}
                  onStop={onStop}
                  onOpenChat={onOpenChat}
                />
              ))}
            </div>
          )}

          {background?.supported && (
            <Section label="Background">
              <Card>
                <Row
                  title="Keep running in the background"
                  description={
                    isMac
                      ? 'Starts Eaon when you log in, without opening a window, so schedules keep running after a restart. Quitting Eaon stops them.'
                      : 'Starts Eaon when you sign in, and keeps it in the notification area when you close the window, so schedules keep running. Quit from that icon to stop them.'
                  }
                >
                  <Switch
                    checked={background.enabled}
                    onChange={(enabled) => attempt(() => window.api.app.setBackground(enabled).then(setBackground))}
                  />
                </Row>
              </Card>
            </Section>
          )}
        </div>
      </div>

      <TaskEditor open={editorOpen} task={editing} onClose={() => setEditorOpen(false)} />

      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete “${deleting?.name ?? ''}”?`}
        actions={
          <>
            <button className="btn btn--ghost" onClick={() => setDeleting(null)}>
              Cancel
            </button>
            <button
              className="btn btn--danger"
              onClick={() => {
                const task = deleting
                setDeleting(null)
                if (task) attempt(() => window.api.scheduler.remove(task.id))
              }}
            >
              Delete
            </button>
          </>
        }
      >
        It stops running. Chats from its earlier runs stay in Recents.
      </Modal>
    </div>
  )
}
