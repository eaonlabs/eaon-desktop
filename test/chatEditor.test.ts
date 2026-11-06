import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gutterMarks } from '../src/renderer/src/components/ide/gitGutter'
import { fuzzyFind, fuzzyScore } from '../src/renderer/src/components/ide/fuzzy'
import { editRequest, indentOf, languageName, lineRef, selectionSnippet } from '../src/renderer/src/components/ide/editorMeta'
import { parsePorcelain } from '../src/shared/chatCode'
import { inlineCode, userSegments } from '../src/renderer/src/components/chat/userText'

/** The editor beside the chat: git's marks, Quick Open's matching, and what ⌘L and ⌘K send. */

test('the gutter marks added, changed and removed lines against the last commit', () => {
  const base = 'a\nb\nc\nd\ne\n'
  assert.deepEqual([...gutterMarks(base, 'a\nb\nX\nd\ne\n')], [[3, 'changed']])
  assert.deepEqual([...gutterMarks(base, 'a\nb\nc\nnew\nd\ne\n')], [[4, 'added']])
  assert.deepEqual([...gutterMarks(base, 'a\nb\nd\ne\n')], [[3, 'deleted']])
  assert.deepEqual([...gutterMarks(base, 'a\nb\nc\nd\n')], [[4, 'deleted']])
  assert.equal(gutterMarks(null, 'anything').size, 0)
  assert.equal(gutterMarks(base, base).size, 0)
})

test('Quick Open matches letters in order, names before folders', () => {
  const files = ['src/app.ts', 'src/components/AppShell.tsx', 'apps/web/package.json', 'README.md', 'test/app.test.ts']
  assert.equal(fuzzyFind('app', files)[0].path, 'src/app.ts')
  assert.equal(fuzzyFind('apsh', files)[0].path, 'src/components/AppShell.tsx')
  assert.equal(fuzzyScore('xyz', 'src/app.ts'), null)
  assert.deepEqual(fuzzyScore('rd', 'README.md')?.at.length, 2)
  assert.equal(fuzzyFind('', files).length, files.length)
})

test('the status bar names the language and the indent', () => {
  assert.equal(languageName('ts'), 'TypeScript')
  assert.equal(languageName(''), 'Plain text')
  assert.equal(languageName('foo'), 'FOO')
  assert.equal(indentOf('a {\n  b {\n    c\n  }\n}\n'), 'Spaces: 2')
  assert.equal(indentOf('a {\n    b\n}\n'), 'Spaces: 4')
  assert.equal(indentOf('a {\n\tb\n}\n'), 'Tabs')
  assert.equal(indentOf('flat\ntext\n'), null)
})

test('⌘L and ⌘K send the selection under the place it came from', () => {
  assert.equal(lineRef('src/a.ts', 3, 3), 'src/a.ts:3')
  assert.equal(lineRef('src/a.ts', 3, 7), 'src/a.ts:3-7')
  assert.equal(selectionSnippet('src/a.ts', 2, 3, 'const a = 1\nconst b = 2\n', 'ts'), '`src/a.ts:2-3`\n```ts\nconst a = 1\nconst b = 2\n```\n')
  // Code holding a fence of its own gets a longer one around it.
  assert.match(selectionSnippet('README.md', 1, 3, '```js\nx\n```', 'md'), /^`README\.md:1-3`\n````md\n/)
  assert.equal(editRequest('src/a.ts', 4, 4, 'let x', 'ts', 'make it const'), 'In `src/a.ts` (line 4): make it const\n\n`src/a.ts:4`\n```ts\nlet x\n```\n')
})

test('git status rows become each path’s state, renames as their new path', () => {
  const out = ' M src/a.ts\0A  src/new.ts\0?? notes.txt\0R  src/b2.ts\0src/b.ts\0D  gone.ts\0UU both.ts\0'
  assert.deepEqual(parsePorcelain(out), {
    'src/a.ts': 'modified',
    'src/new.ts': 'added',
    'notes.txt': 'untracked',
    'src/b2.ts': 'added',
    'gone.ts': 'deleted',
    'both.ts': 'conflict'
  })
})

test('a message’s fenced code and its place show as a code block; inline code is split out', () => {
  const sent = 'In `src/a.ts` (lines 4–6): rename it\n\n`src/a.ts:4-6`\n```ts\nlet total = 0\n```\n'
  assert.deepEqual(userSegments(sent), [
    { kind: 'text', text: 'In `src/a.ts` (lines 4–6): rename it' },
    { kind: 'code', text: 'let total = 0', lang: 'ts', ref: 'src/a.ts:4-6' }
  ])
  assert.deepEqual(userSegments('plain words'), [{ kind: 'text', text: 'plain words' }])
  assert.deepEqual(userSegments('```\nnever closed'), [{ kind: 'text', text: '```\nnever closed' }])
  assert.deepEqual(inlineCode('run `npm test` now'), ['run ', 'npm test', ' now'])
})
