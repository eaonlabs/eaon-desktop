import { useState } from 'react'
import { CalendarClock, Plus, Trash2 } from 'lucide-react'
import { Card, Modal, Row, Section, Select, Switch } from './ui'
import { CollapsedNav } from './CollapsedNav'
import { useApp } from '../state/store'

interface ScheduledTask {
  id: string
  prompt: string
  cadence: string
  enabled: boolean
}

const load = (): ScheduledTask[] => {
  try {
    return JSON.parse(localStorage.getItem('scheduled') ?? '[]') as ScheduledTask[]
  } catch {
    return []
  }
}

/** Recurring prompts that run on a cadence. */
export function ScheduledPage(): JSX.Element {
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const [tasks, setTasks] = useState<ScheduledTask[]>(load)
  const [adding, setAdding] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [cadence, setCadence] = useState('Every day')

  const save = (next: ScheduledTask[]): void => {
    setTasks(next)
    localStorage.setItem('scheduled', JSON.stringify(next))
  }

  return (
    <div className="page">
      <div className="page__bar" data-collapsed={!sidebarOpen || undefined}>
        {!sidebarOpen && <CollapsedNav />}
        <div className="page__bar-spacer" />
        <button className="btn btn--primary" onClick={() => setAdding(true)}>
          <Plus size={14} strokeWidth={2} />
          New schedule
        </button>
      </div>

      <div className="page__scroll scroll">
        <div className="page__inner">
          <h1 className="page__title">Scheduled</h1>
          <p className="page__subtitle">Prompts that run on their own and land in your Recents.</p>

          <Section>
            {tasks.length === 0 ? (
              <Card>
                <Row
                  title="Nothing scheduled"
                  description="Create a schedule to run a prompt every day, week, or hour"
                >
                  <button className="btn" onClick={() => setAdding(true)}>
                    <CalendarClock size={14} strokeWidth={1.9} />
                    Create
                  </button>
                </Row>
              </Card>
            ) : (
              <Card>
                {tasks.map((task) => (
                  <Row key={task.id} title={task.prompt} description={task.cadence}>
                    <Switch
                      label={task.prompt}
                      checked={task.enabled}
                      onChange={(on) => save(tasks.map((t) => (t.id === task.id ? { ...t, enabled: on } : t)))}
                    />
                    <button
                      className="icon-btn"
                      aria-label="Delete schedule"
                      onClick={() => save(tasks.filter((t) => t.id !== task.id))}
                    >
                      <Trash2 size={15} strokeWidth={1.9} />
                    </button>
                  </Row>
                ))}
              </Card>
            )}
          </Section>
        </div>
      </div>

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="New schedule"
        actions={
          <>
            <button className="btn btn--ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button
              className="btn btn--primary"
              disabled={!prompt.trim()}
              onClick={() => {
                save([
                  ...tasks,
                  { id: Math.random().toString(36).slice(2), prompt: prompt.trim(), cadence, enabled: true }
                ])
                setPrompt('')
                setAdding(false)
              }}
            >
              Create
            </button>
          </>
        }
      >
        <label className="modal__field" style={{ display: 'block' }}>
          <div style={{ marginBottom: 6 }}>Prompt</div>
          <textarea
            className="input"
            style={{ minHeight: 84 }}
            value={prompt}
            placeholder="Summarize what changed in the repo today"
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <label className="modal__field" style={{ display: 'block', marginBottom: 0 }}>
          <div style={{ marginBottom: 6 }}>Runs</div>
          <Select
            value={cadence}
            onChange={setCadence}
            width={200}
            options={[
              { value: 'Every hour', label: 'Every hour' },
              { value: 'Every day', label: 'Every day' },
              { value: 'Every weekday', label: 'Every weekday' },
              { value: 'Every week', label: 'Every week' }
            ]}
          />
        </label>
      </Modal>
    </div>
  )
}
