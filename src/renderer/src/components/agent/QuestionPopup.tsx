import { useEffect, useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import type { AskQuestion } from '@shared/askQuestions'
import { agentWorkspace, useApp } from '../../state/store'
import { Modal } from '../ui'

/**
 * The agent's questions (`ask_user_question`), in a pop-up over the window:
 * each question's options to pick from, and a line to type something else.
 * It stays until answered or skipped. Clicking outside or pressing Escape
 * does not dismiss it, so a stray click can't throw the question away.
 */

/** What one question has so far: the picked option labels, and the typed text. */
interface Draft {
  picked: string[]
  other: string
}

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

export function QuestionPopup(): JSX.Element | null {
  const question = useApp((s) => s.pendingQuestions[0] ?? null)
  const answerQuestion = useApp((s) => s.answerQuestion)
  const [drafts, setDrafts] = useState<Draft[]>([])
  // The chat that is asking, when it isn't the one on screen: the pop-up says which.
  const from = useApp((s) => {
    if (!question) return null
    if (s.activeChat()?.messages.some((m) => m.id === question.messageId)) return null
    return s.chats.find((c) => c.messages.some((m) => m.id === question.messageId)) ?? null
  })

  // A fresh set of drafts for each question set that comes up.
  const requestId = question?.requestId
  useEffect(() => {
    setDrafts(question ? question.questions.map(() => ({ picked: [], other: '' })) : [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId])

  const answers = useMemo(() => (question ? question.questions.map((q, i) => answerOf(q, drafts[i] ?? { picked: [], other: '' })) : []), [question, drafts])
  if (!question) return null
  const complete = answers.length > 0 && answers.every((a) => a.length > 0)
  const patch = (i: number, change: Partial<Draft>): void => setDrafts((list) => list.map((d, j) => (j === i ? { ...d, ...change } : d)))
  const toggle = (i: number, q: AskQuestion, label: string): void => {
    const draft = drafts[i] ?? { picked: [], other: '' }
    if (q.multiSelect) patch(i, { picked: draft.picked.includes(label) ? draft.picked.filter((l) => l !== label) : [...draft.picked, label] })
    else patch(i, { picked: [label], other: '' })
  }

  return (
    <Modal
      open
      onClose={() => undefined}
      showClose={false}
      title={question.questions.length === 1 ? question.questions[0].header : 'A few questions'}
      width={560}
      actions={
        <>
          <button className="btn btn--ghost" onClick={() => answerQuestion(question.requestId, null)}>
            Skip
          </button>
          <button className="btn btn--primary" disabled={!complete} onClick={() => answerQuestion(question.requestId, answers)}>
            Send answers
          </button>
        </>
      }
    >
      <div className="ask">
        {from && (
          <div className="ask__from">
            <span>
              From <strong>{from.title}</strong>
            </span>
            <button type="button" className="ask__from-open" onClick={() => openAsking(from.id)}>
              Open chat
            </button>
          </div>
        )}
        {question.questions.map((q, i) => {
          const draft = drafts[i] ?? { picked: [], other: '' }
          return (
            <fieldset key={i} className="ask__question">
              <legend className="ask__legend">
                {question.questions.length > 1 && <span className="ask__header">{q.header}</span>}
                {q.question}
              </legend>
              {q.multiSelect && <div className="ask__hint">Pick any that apply</div>}
              <div className="ask__options" role={q.multiSelect ? 'group' : 'radiogroup'}>
                {q.options.map((o) => {
                  const on = draft.picked.includes(o.label) && (q.multiSelect || !draft.other.trim())
                  return (
                    <button
                      key={o.label}
                      type="button"
                      className="ask__option"
                      role={q.multiSelect ? 'checkbox' : 'radio'}
                      aria-checked={on}
                      data-on={on || undefined}
                      onClick={() => toggle(i, q, o.label)}
                    >
                      <span className="ask__mark" data-multi={q.multiSelect || undefined}>
                        {on && <Check size={11} strokeWidth={3} />}
                      </span>
                      <span className="ask__text">
                        <span className="ask__label">{o.label}</span>
                        {o.description && <span className="ask__desc">{o.description}</span>}
                      </span>
                    </button>
                  )
                })}
              </div>
              <input
                className="input ask__other"
                aria-label={`Something else for: ${q.question}`}
                placeholder="Something else…"
                value={draft.other}
                onChange={(e) => patch(i, { other: e.target.value, ...(q.multiSelect ? {} : { picked: [] }) })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && complete) answerQuestion(question.requestId, answers)
                }}
              />
            </fieldset>
          )
        })}
      </div>
    </Modal>
  )
}
