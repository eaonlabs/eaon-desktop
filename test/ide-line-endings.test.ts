import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toDisk, toEditor } from '../src/renderer/src/components/ide/lineEndings'

/** The code panel's editor holds `\n` text; a file saved from it keeps the line endings it had. */

test('a Windows file is edited with \\n and saved with \\r\\n again', () => {
  const read = toEditor('one\r\ntwo\r\nthree\r\n')
  assert.deepEqual(read, { text: 'one\ntwo\nthree\n', eol: '\r\n' })
  assert.equal(toDisk(read.text + 'four\n', read.eol), 'one\r\ntwo\r\nthree\r\nfour\r\n')
})

test('a Unix file is left exactly as it is', () => {
  const text = 'a\nb\n'
  const read = toEditor(text)
  assert.equal(read.text, text)
  assert.equal(read.eol, '\n')
  assert.equal(toDisk(read.text, read.eol), text)
})

test('mixed endings follow the ones most lines have', () => {
  assert.equal(toEditor('a\r\nb\r\nc\n').eol, '\r\n')
  assert.equal(toEditor('a\nb\nc\r\n').eol, '\n')
  assert.equal(toEditor('a\nb\nc\r\n').text, 'a\nb\nc\n', 'what the textarea would make of it either way')
})
