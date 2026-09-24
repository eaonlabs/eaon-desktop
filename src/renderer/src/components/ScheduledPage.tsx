import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarClock, Plus, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { ScheduledTask } from '@shared/scheduler'
import { Card, Modal, Row, Section } from './ui'
import { CollapsedNav } from './CollapsedNav'
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
  const { sidebarOpen, models, providers } = useApp(
    useShallow((s) => ({ sidebarOpen: s.sidebarOpen, models: s.availableModels(), providers: s.providers }))
  )
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null)
  const [editing, setEditing] = useState<ScheduledTask | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [deleting, setDeleting] = useState<ScheduledTask | null>(null)
  const [error, setError] = useState<string | null>(null)
  const now = useNow(30_000)

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

  const modelLabel = (task: ScheduledTask): string | null => {
    if (!task.model) return null
    const model = models.find((m) => m.providerId === task.model!.providerId && m.id === task.model!.modelId)
    if (model) return model.label
    // Not in the list can just mean the list is stale (a local runtime not
    // refreshed yet); only call it unavailable when the provider itself is.
    const provider = providers.find((p) => p.id === task.model!.providerId)
    const usable = provider && provider.enabled && (provider.hasKey || provider.local)
    return usable ? task.model.modelId : `${task.model.modelId} (${provider?.name ?? task.model.providerId} unavailable)`
  }

  return (
    <div className="page">
      <div className="page__bar" data-collapsed={!sidebarOpen || undefined}>
        {!sidebarOpen && <CollapsedNav />}
        <div className="page__bar-spacer" />
        <button className="btn btn--primary" onClick={() => openEditor(null)}>
          <Plus size={14} strokeWidth={2} />
          New schedule
        </button>
      </div>

      <div className="page__scroll scroll">
        <div className="page__inner page__inner--sched">
          <h1 className="page__title">Scheduled</h1>
          <p className="page__subtitle">
            Prompts that run on their own, even with the window closed. Each run lands in Recents as a new chat.
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
