import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ThinkTagSplitter } from '../src/main/providers/adapters/thinkTags'

/** Feeds `chunks` through a splitter and returns what came out as text and as reasoning. */
function run(chunks: string[]): { text: string; reasoning: string } {
  const splitter = new ThinkTagSplitter()
  let text = ''
  let reasoning = ''
  for (const piece of [...chunks.map((chunk) => splitter.push(chunk)), splitter.flush()]) {
    text += piece.text
    reasoning += piece.reasoning
  }
  return { text, reasoning }
}

test('a leading <think> block becomes reasoning', () => {
  assert.deepEqual(run(['<think>plan it</think>\n\nThe answer.']), { text: 'The answer.', reasoning: 'plan it' })
})

test('tags split across chunks at every position are still recognised', () => {
  const whole = '<think>abc</think>done'
  for (let i = 1; i < whole.length; i++) {
    for (let j = i + 1; j < whole.length; j++) {
      const result = run([whole.slice(0, i), whole.slice(i, j), whole.slice(j)])
      assert.deepEqual(result, { text: 'done', reasoning: 'abc' }, `split at ${i},${j}`)
    }
  }
})

test('leading whitespace before <think> is allowed', () => {
  assert.deepEqual(run(['\n  <thi', 'nk>x</think>y']), { text: 'y', reasoning: 'x' })
})

test('a <think> tag later in the answer stays text (a model explaining the tag)', () => {
  assert.deepEqual(run(['Use a ', '<think> tag like <think>this']), { text: 'Use a <think> tag like <think>this', reasoning: '' })
})

test('a stray closing tag (opening tag was in the prompt template) is dropped', () => {
  assert.deepEqual(run(['Answer</th', 'ink> more']), { text: 'Answer more', reasoning: '' })
})

test('an unterminated block ends as reasoning, and a held partial tag is flushed', () => {
  assert.deepEqual(run(['<think>still thinking</thi']), { text: '', reasoning: 'still thinking</thi' })
  assert.deepEqual(run(['text ending in <']), { text: 'text ending in <', reasoning: '' })
})

test('plain text passes through untouched', () => {
  assert.deepEqual(run(['Hel', 'lo ', 'world']), { text: 'Hello world', reasoning: '' })
})
