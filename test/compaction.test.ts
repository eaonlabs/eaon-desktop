import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compactionProgress, expectedSummaryChars } from '@shared/compaction'
import { isContextOverflow } from '../src/main/providers/errors'

test('compaction progress: the reading stretch fills the first tenth, writing the rest, never full before done', () => {
  assert.equal(compactionProgress(0, 0, 2000), 0)
  const reading = compactionProgress(30_000, 0, 2000)
  assert.ok(reading > 0.09 && reading <= 0.1, `reading ${reading}`)
  assert.ok(compactionProgress(1000, 0, 2000) < compactionProgress(2000, 0, 2000), 'reading creeps up with time')
  assert.equal(compactionProgress(500, 1000, 2000), 0.1 + 0.85 * 0.5)
  assert.equal(compactionProgress(500, 2000, 2000), 0.95)
  assert.equal(compactionProgress(500, 50_000, 2000), 0.95, 'a longer summary than expected waits at 95%')
  // The first words never send the bar back below where reading had it.
  assert.ok(compactionProgress(30_000, 1, 2000) >= reading)
})

test('the expected summary length follows the transcript, within a page or so to a few', () => {
  assert.equal(expectedSummaryChars(1000), 1200)
  assert.equal(expectedSummaryChars(40_000), 4800)
  assert.equal(expectedSummaryChars(500_000), 8000)
})

test('context overflows are recognised in each provider’s words', () => {
  const said = (status: number | undefined, message: string): Error => Object.assign(new Error(message), status ? { status } : {})
  for (const error of [
    said(400, 'prompt is too long: 215000 tokens > 200000 maximum'),
    said(400, "This model's maximum context length is 128000 tokens. However, your messages resulted in 130211 tokens."),
    said(400, 'context_length_exceeded'),
    said(400, 'The input token count (1100000) exceeds the maximum number of tokens allowed (1048576).'),
    said(400, 'Prompt contains 40000 tokens and 0 draft tokens, too large for model with 32768 maximum context length'),
    said(400, 'the request exceeds the available context size, try increasing it'),
    said(undefined, '400: This endpoint\'s maximum context length is 65536 tokens.'),
    said(413, 'Request too large: please reduce the length of the messages or completion.')
  ]) {
    assert.ok(isContextOverflow(error), error.message)
  }
  for (const error of [
    said(401, 'invalid x-api-key'),
    said(429, 'rate limit: maximum context length requests per minute'),
    said(500, 'prompt is too long'),
    said(400, 'messages: text content blocks must be non-empty')
  ]) {
    assert.ok(!isContextOverflow(error), error.message)
  }
})
