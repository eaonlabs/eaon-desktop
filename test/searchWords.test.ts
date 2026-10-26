import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchesSearch } from '../src/shared/searchWords'

/** Settings' search and the providers list (shared/searchWords.ts). */

test('each word searched for begins a word, in any order', () => {
  assert.equal(matchesSearch('mode dark', 'Appearance theme dark light mode'), true)
  assert.equal(matchesSearch('appear', 'Appearance theme'), true)
  assert.equal(matchesSearch('', 'anything'), true)
  assert.equal(matchesSearch('   ', 'anything'), true)
  // Inside a word isn't a match: "port" was General (report) and Connect apps (import).
  assert.equal(matchesSearch('port', 'General update report issue bug'), false)
  assert.equal(matchesSearch('port', 'Connect apps import openclaw'), false)
  assert.equal(matchesSearch('port', 'Local API Server port api server'), true)
})

test('a plural finds its singular', () => {
  assert.equal(matchesSearch('goals', 'Code index goal goal mode continuations'), true)
  assert.equal(matchesSearch('tours', 'General tour take the tour'), true)
  assert.equal(matchesSearch('policies', 'Security audit log policy'), true)
  assert.equal(matchesSearch('switches', 'Accounts switch account'), true)
  assert.equal(matchesSearch('access', 'General full access permissions'), true)
})

test('words run together or split apart find each other', () => {
  assert.equal(matchesSearch('chat gpt', 'ChatGPT sign in'), true)
  assert.equal(matchesSearch('open ai', 'OpenAI api key'), true)
  assert.equal(matchesSearch('lmstudio', 'Model providers lm studio'), true)
  assert.equal(matchesSearch('whats new', 'General what’s new'), true)
  assert.equal(matchesSearch('see-through', 'Appearance see through glass'), true)
  assert.equal(matchesSearch('chat gpt', 'Chat history archive'), false)
})
