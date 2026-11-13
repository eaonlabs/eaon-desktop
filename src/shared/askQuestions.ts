/**
 * Questions the agent puts to the user in a pop-up (`ask_user_question`):
 * a few multiple-choice questions, each answered by picking an option or
 * typing something else. All the checking is here, so what the model sends,
 * what the pop-up shows and what comes back are read the same way.
 */

export interface AskOption {
  label: string
  description?: string
}

export interface AskQuestion {
  /** A word or two on the pop-up's tab for this question. */
  header: string
  question: string
  options: AskOption[]
  /** Several options may be picked. */
  multiSelect: boolean
}

/** What was chosen for one question: option labels, or the text typed in "Other". */
export type AskAnswer = string[]

export const MAX_QUESTIONS = 4
export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 4

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/**
 * The questions as the model sent them, repaired, or the reason they can't be
 * used (said to the model, which can send them again).
 */
export function parseQuestions(raw: unknown): { ok: true; questions: AskQuestion[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: `Send questions: 1 to ${MAX_QUESTIONS}, each with a question and ${MIN_OPTIONS} to ${MAX_OPTIONS} options.` }
  if (raw.length > MAX_QUESTIONS) return { ok: false, error: `Ask at most ${MAX_QUESTIONS} questions at once.` }
  const questions: AskQuestion[] = []
  for (const [i, item] of raw.entries()) {
    const q = (item ?? {}) as Record<string, unknown>
    const question = text(q.question, 300)
    if (!question) return { ok: false, error: `Question ${i + 1} has no question text.` }
    const options: AskOption[] = []
    for (const o of Array.isArray(q.options) ? q.options : []) {
      const option = (typeof o === 'string' ? { label: o } : (o ?? {})) as Record<string, unknown>
      const label = text(option.label, 80)
      const description = text(option.description, 200)
      if (label && !options.some((x) => x.label.toLowerCase() === label.toLowerCase())) options.push({ label, ...(description ? { description } : {}) })
    }
    if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) return { ok: false, error: `Question ${i + 1} needs ${MIN_OPTIONS} to ${MAX_OPTIONS} different options.` }
    questions.push({ header: text(q.header, 24) || `Question ${i + 1}`, question, options, multiSelect: q.multiSelect === true })
  }
  return { ok: true, questions }
}

/** Answers from the window, repaired: one list a question, only text, nothing for an unanswered one. */
export function cleanAnswers(raw: unknown, questions: readonly AskQuestion[]): AskAnswer[] {
  const given = Array.isArray(raw) ? raw : []
  return questions.map((q, i) => {
    const picked = Array.isArray(given[i]) ? (given[i] as unknown[]) : []
    const answers = picked.map((a) => text(a, 500)).filter(Boolean)
    return q.multiSelect ? answers.slice(0, 20) : answers.slice(0, 1)
  })
}

/** The answers as the model reads them. */
export function answersText(questions: readonly AskQuestion[], answers: readonly AskAnswer[]): string {
  return questions
    .map((q, i) => `- ${q.question}\n  Answer: ${answers[i]?.length ? answers[i].join('; ') : '(no answer)'}`)
    .join('\n')
}
