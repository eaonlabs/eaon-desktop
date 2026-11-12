import { useEffect, useMemo, useState, type JSX } from 'react'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import type { AskQuestion } from '@shared/askQuestions'
import { agentWorkspace, useApp } from '../../state/store'

/**
 * The agent's questions (`ask_user_question`), docked above the message box
 * where approvals ask: one question at a time, its options as rows to pick
 * from, and a line to type something else. It stays until answered or
 * skipped, and never takes the keyboard from the box beneath it.
 */

/** What one question has so far: the picked option labels, and the typed text. */
interface Draft {
  picked: string[]
  other: string
}
const EMPTY: Draft = { picked: [], other: '' }

const answerOf = (q: AskQuestion, draft: Draft): string[] => {
  const other = draft.other.trim()
  if (q.multiSelect) return [...draft.picked, ...(other ? [other] : [])]
  // One answer: typing something else replaces a pick.
  return other ? [other] : draft.picked.slice(0, 1)
}

/** Opens the chat that asked, from wherever the app is: Chat's tab, then the chat. */
function openAsking(chatId: string): void {
  const app = useApp.getState()
  const chat = agentWorkspace(app.workspaces)
  if (chat && chat.id !== app.settings?.activeWorkspaceId) app.setWorkspace(chat.id)
  app.openChat(chatId)
}

export function QuestionDock(): JSX.Element | null {
  const question = useApp((s) => s.pendingQuestions[0] ?? null)
  const answerQuestion = useApp((s) => s.answerQuestion)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [step, setStep] = useState(0)
  // The chat that is asking, when it isn't the one on screen: the card says which.
  const from = useApp((s) => {
    if (!question) return null
    if (s.activeChat()?.messages.some((m) => m.id === question.messageId)) return null
    return s.chats.find((c) => c.messages.some((m) => m.id === question.messageId)) ?? null
  })

  // A fresh set of drafts for each question set that comes up.
  const requestId = question?.requestId
  useEffect(() => {
    setDrafts(question ? question.questions.map(() => ({ ...EMPTY })) : [])
    setStep(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId])

  const answers = useMemo(() => (question ? question.questions.map((q, i) => answerOf(q, drafts[i] ?? EMPTY)) : []), [question, drafts])
  if (!question) return null

  const total = question.questions.length
  const at = Math.min(step, total - 1)
  const q = question.questions[at]
  const draft = drafts[at] ?? EMPTY
  const last = at === total - 1
  const here = answers[at]?.length > 0
  const complete = answers.length > 0 && answers.every((a) => a.length > 0)
  const patch = (change: Partial<Draft>): void => setDrafts((list) => list.map((d, j) => (j === at ? { ...d, ...change } : d)))
  const toggle = (label: string): void => {
    if (q.multiSelect) patch({ picked: draft.picked.includes(label) ? draft.picked.filter((l) => l !== label) : [...draft.picked, label] })
    else patch({ picked: [label], other: '' })
  }
  const advance = (): void => {
    if (!last) setStep(at + 1)
    else if (complete) answerQuestion(question.requestId, answers)
  }

  return (
    <section className="qdock" role="group" aria-label="The agent has a question">
      <div className="qdock__top">
        <span className="qdock__tag">{q.header}</span>
        {from && (
          <span className="qdock__from">
            from <strong>{from.title}</strong>
            <button type="button" onClick={() => openAsking(from.id)}>
              Open
            </button>
          </span>
        )}
        {total > 1 && (
          <span className="qdock__steps" aria-label={`Question ${at + 1} of ${total}`}>
            <button type="button" aria-label="Previous question" disabled={at === 0} onClick={() => setStep(at - 1)}>
              <ChevronLeft size={14} strokeWidth={2} />
            </button>
            <span>
              {at + 1} of {total}
            </span>
            <button type="button" aria-label="Next question" disabled={last || !here} onClick={() => setStep(at + 1)}>
              <ChevronRight size={14} strokeWidth={2} />
            </button>
          </span>
        )}
      </div>
      <div className="qdock__question">{q.question}</div>
      {q.multiSelect && <div className="qdock__hint">Pick any that apply</div>}
      <div className="qdock__options" role={q.multiSelect ? 'group' : 'radiogroup'} aria-label={q.question}>
        {q.options.map((o, n) => {
          const on = draft.picked.includes(o.label) && (q.multiSelect || !draft.other.trim())
          return (
            <button
              key={o.label}
              type="button"
              className="qdock__option"
              role={q.multiSelect ? 'checkbox' : 'radio'}
              aria-checked={on}
              data-on={on || undefined}
              onClick={() => toggle(o.label)}
            >
              <span className="qdock__num" aria-hidden="true">
                {on ? <Check size={12} strokeWidth={3} /> : n + 1}
              </span>
              <span className="qdock__text">
                <span className="qdock__label">{o.label}</span>
                {o.description && <span className="qdock__desc">{o.description}</span>}
              </span>
            </button>
          )
        })}
        <label className="qdock__option qdock__option--other" data-on={draft.other.trim() ? true : undefined}>
          <span className="qdock__num" aria-hidden="true">
            {q.options.length + 1}
          </span>
          <input
            aria-label={`Something else for: ${q.question}`}
            placeholder="Something else…"
            value={draft.other}
            onChange={(e) => patch({ other: e.target.value, ...(q.multiSelect ? {} : { picked: [] }) })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && here) advance()
            }}
          />
        </label>
      </div>
      <div className="qdock__foot">
        <button type="button" className="qdock__skip" onClick={() => answerQuestion(question.requestId, null)}>
          Skip
        </button>
        <button type="button" className="qdock__go" disabled={last ? !complete : !here} onClick={advance}>
          {last ? 'Send answers' : 'Next'}
        </button>
      </div>
    </section>
  )
}
