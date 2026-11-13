import { answersText, MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS, parseQuestions } from '@shared/askQuestions'
import { registerToolSource, type AgentTool } from './tools'
import { requestAnswers } from './questions'

/**
 * `ask_user_question`: the agent stops to put a few multiple-choice questions
 * to the user in a pop-up, instead of guessing at what they meant. Only in a
 * conversation with someone there: not a worker, a scheduled task or a
 * sub-agent, which have nobody to answer.
 */

const askUserQuestion: AgentTool = {
  name: 'ask_user_question',
  description: `Ask the user up to ${MAX_QUESTIONS} multiple-choice questions in a pop-up and wait for the answers. Use it when the request is ambiguous or you need a decision that is theirs (which approach, which option, what to keep), not for things you can find out yourself. Give ${MIN_OPTIONS} to ${MAX_OPTIONS} options each, put the one you recommend first and say so in its label; the user can always type something else. You get the answers back.`,
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        items: {
          type: 'object',
          properties: {
            header: { type: 'string', description: 'A word or two naming the question (max 24 characters)' },
            question: { type: 'string', description: 'The whole question, ending with a question mark' },
            options: {
              type: 'array',
              minItems: MIN_OPTIONS,
              maxItems: MAX_OPTIONS,
              items: {
                type: 'object',
                properties: { label: { type: 'string', description: 'Short choice, 1 to 5 words' }, description: { type: 'string', description: 'What choosing it means' } },
                required: ['label']
              }
            },
            multiSelect: { type: 'boolean', description: 'Allow picking several options' }
          },
          required: ['question', 'options']
        }
      }
    },
    required: ['questions']
  },
  mutating: false,
  describe: (input) => {
    const first = Array.isArray(input.questions) ? (input.questions[0] as { question?: unknown } | undefined)?.question : undefined
    return typeof first === 'string' && first ? `Ask: ${first.slice(0, 80)}` : 'Ask the user'
  },
  run: async (input, ctx) => {
    if (ctx.policy?.unattended || ctx.request.workerId) return { text: 'Nobody is here to answer. Make the choice yourself and say what you assumed.', isError: true }
    const parsed = parseQuestions(input.questions)
    if (!parsed.ok) return { text: parsed.error, isError: true }
    if (ctx.signal.aborted) return { text: 'Stopped.', isError: true }
    const answers = await requestAnswers(ctx.request.messageId, parsed.questions, ctx.emit)
    if (!answers) return 'The user dismissed the questions without answering. Carry on with your best judgment, or ask once more in plain text if you truly cannot.'
    return `The user answered:\n${answersText(parsed.questions, answers)}`
  }
}

registerToolSource({
  id: 'ask',
  tools: (query) => (query.mode === 'work' && query.depth === 0 && !query.request.workerId ? [askUserQuestion] : []),
  guidance: (query) =>
    query.mode === 'work' && query.depth === 0 && !query.request.workerId
      ? 'When a request is ambiguous or a decision is the user’s, use ask_user_question once, with your recommendation first, rather than guessing or asking in prose.'
      : null
})
