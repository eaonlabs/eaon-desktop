import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answersText, cleanAnswers, parseQuestions } from '@shared/askQuestions'
import { cancelQuestions, requestAnswers, resolveQuestion } from '../src/main/agent/questions'
import '../src/main/agent/askTools'
import { getToolSource, type ToolContext, type ToolQuery } from '../src/main/agent/tools'
import type { StreamEvent } from '@shared/types'

/** The agent's multiple-choice pop-up: what it accepts, how answers come back, and when it is offered. */

const good = [{ header: 'Approach', question: 'Which approach?', options: [{ label: 'Rewrite', description: 'Start over' }, { label: 'Patch' }], multiSelect: false }]

test('questions are read and repaired, or refused with a reason the model can act on', () => {
  const parsed = parseQuestions([{ question: '  Which   one?  ', options: ['A', 'a', 'B', { label: '' }] }])
  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.equal(parsed.questions[0].header, 'Question 1')
    assert.deepEqual(parsed.questions[0].options.map((o) => o.label), ['A', 'B'], 'a repeated option is dropped, whatever its case')
    assert.equal(parsed.questions[0].question, 'Which one?')
  }
  for (const bad of [null, [], 'x', [{ question: '', options: ['A', 'B'] }], [{ question: 'Q', options: ['only'] }], [{ question: 'Q', options: ['1', '2', '3', '4', '5'] }], Array(5).fill(good[0])]) {
    assert.equal(parseQuestions(bad).ok, false)
  }
})

test('answers are cut to what a question allows', () => {
  const parsed = parseQuestions([
    { question: 'One?', options: ['A', 'B'] },
    { question: 'Many?', options: ['A', 'B'], multiSelect: true },
    { question: 'None?', options: ['A', 'B'] }
  ])
  assert.ok(parsed.ok)
  if (!parsed.ok) return
  const answers = cleanAnswers([['A', 'B'], ['A', 'B', ' '], 'junk'], parsed.questions)
  assert.deepEqual(answers, [['A'], ['A', 'B'], []])
  assert.match(answersText(parsed.questions, answers), /One\?\n {2}Answer: A[\s\S]*Many\?\n {2}Answer: A; B[\s\S]*None\?\n {2}Answer: \(no answer\)/)
})

test('a question waits for its answer, which comes back cleaned; a dismissal and a stopped turn give none', async () => {
  const parsed = parseQuestions(good)
  assert.ok(parsed.ok)
  if (!parsed.ok) return
  const events: StreamEvent[] = []
  const asked = requestAnswers('m1', parsed.questions, (e) => events.push(e))
  const event = events[0]
  assert.equal(event.type, 'question-request')
  if (event.type !== 'question-request') return
  resolveQuestion(event.requestId, [['Patch', 'extra']])
  assert.deepEqual(await asked, [['Patch']])
  resolveQuestion(event.requestId, [['again']]) // already answered: ignored

  const dismissed = requestAnswers('m1', parsed.questions, (e) => events.push(e))
  resolveQuestion((events[1] as { requestId: string }).requestId, null)
  assert.equal(await dismissed, null)

  const stopped = requestAnswers('m2', parsed.questions, (e) => events.push(e))
  const other = requestAnswers('m3', parsed.questions, (e) => events.push(e))
  cancelQuestions('m2')
  assert.equal(await stopped, null)
  resolveQuestion((events[3] as { requestId: string }).requestId, [['Rewrite']])
  assert.deepEqual(await other, [['Rewrite']], 'stopping one turn leaves another turn’s question alone')
})

function ctxFor(over: Partial<ToolContext> & { events: StreamEvent[] }): ToolContext {
  return {
    request: { messageId: 'm9' },
    signal: new AbortController().signal,
    emit: (e: StreamEvent) => over.events.push(e),
    ...over
  } as unknown as ToolContext
}

test('the tool asks in a conversation, answers the model with the choices, and is not offered to a worker or sub-agent', async () => {
  const source = getToolSource('ask')!
  const query = (over: Record<string, unknown> = {}): ToolQuery => ({ mode: 'work', depth: 0, readOnly: false, request: {}, ...over }) as unknown as ToolQuery
  assert.equal(source.tools(query()).length, 1)
  assert.equal(source.tools(query({ depth: 1 })).length, 0)
  assert.equal(source.tools(query({ request: { workerId: 'w' } })).length, 0)
  assert.equal(source.tools(query({ mode: 'chat' })).length, 0)

  const tool = source.tools(query())[0]
  const events: StreamEvent[] = []
  const run = tool.run({ questions: good }, ctxFor({ events }))
  await new Promise((r) => setTimeout(r, 5))
  const asked = events[0] as { requestId: string }
  resolveQuestion(asked.requestId, [['Rewrite']])
  const result = await run
  assert.match(String(result), /The user answered:\n- Which approach\?\n {2}Answer: Rewrite/)

  const refused = await tool.run({ questions: [] }, ctxFor({ events }))
  assert.equal((refused as { isError?: boolean }).isError, true)
  const unattended = await tool.run({ questions: good }, ctxFor({ events, policy: { readOnly: false, unattended: 'safe' } as ToolContext['policy'] }))
  assert.match(String((unattended as { text: string }).text), /Nobody is here/)

  const skipped = tool.run({ questions: good }, ctxFor({ events }))
  await new Promise((r) => setTimeout(r, 5))
  resolveQuestion((events.at(-1) as { requestId: string }).requestId, null)
  assert.match(String(await skipped), /dismissed the questions/)
})
