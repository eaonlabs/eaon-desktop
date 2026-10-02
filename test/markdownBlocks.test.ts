import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMarkdown } from '../src/renderer/src/components/agent/markdownBlocks'

/**
 * The chat's Markdown renderer re-parses a streaming reply from its last
 * settled block instead of from the top. That is only safe if the result is
 * exactly what a whole parse would give, at every point a stream can stop.
 */

const PIECES = [
  'A paragraph with **bold**, `code` and a [link](https://example.com).',
  'A second line of the same paragraph.',
  '',
  '   ',
  '# Heading',
  '### Smaller heading',
  '- first item',
  '- second item',
  '* star item',
  '1. numbered',
  '2) numbered again',
  '> quoted',
  '> still quoted',
  '---',
  '```ts',
  'const x = 1',
  '',
  'function f() {}',
  '```',
  '```',
  'plain text again'
]

/** Deterministic, so a failure reproduces. */
function random(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
}

function document(rand: () => number, lines: number): string {
  const out: string[] = []
  for (let i = 0; i < lines; i++) out.push(PIECES[Math.floor(rand() * PIECES.length)])
  return out.join('\n')
}

test('parsing on from the settled prefix matches a whole parse at every step of a stream', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rand = random(seed)
    const text = document(rand, 40)
    let previous = null as ReturnType<typeof parseMarkdown> | null
    let at = 0
    while (at < text.length) {
      at = Math.min(text.length, at + 1 + Math.floor(rand() * 12))
      const prefix = text.slice(0, at)
      const incremental = parseMarkdown(prefix, previous)
      assert.deepEqual(incremental.blocks, parseMarkdown(prefix).blocks, `seed ${seed}, ${at} chars`)
      previous = incremental
    }
  }
})

test('settled blocks come back as the same objects, so the renderer can skip them', () => {
  const first = parseMarkdown('Intro paragraph.\n\n- a\n- b\n\nStill writ')
  assert.equal(first.settledBlocks, 2)
  const next = parseMarkdown('Intro paragraph.\n\n- a\n- b\n\nStill writing this one', first)
  assert.equal(next.blocks[0], first.blocks[0])
  assert.equal(next.blocks[1], first.blocks[1])
  assert.notEqual(next.blocks[2], first.blocks[2])
  assert.deepEqual(next.blocks[2], { kind: 'para', text: 'Still writing this one' })
})

test('a blank line inside an open fence settles nothing, and a trailing blank line waits for the next one', () => {
  const open = parseMarkdown('```js\nconst a = 1\n\nconst b = 2\n')
  assert.equal(open.settledChars, 0)
  assert.deepEqual(open.blocks, [{ kind: 'code', lang: 'js', code: 'const a = 1\n\nconst b = 2\n', streaming: true }])

  // "para\n" ends in an unfinished (empty) line: more text can still join the paragraph.
  const growing = parseMarkdown('para\n')
  assert.equal(growing.settledChars, 0)
  assert.deepEqual(parseMarkdown('para\nmore', growing).blocks, [{ kind: 'para', text: 'para\nmore' }])
})

test('text that is not an extension of the last parse is parsed whole', () => {
  const first = parseMarkdown('One.\n\nTwo.')
  const other = parseMarkdown('Different.\n\n# Title', first)
  assert.deepEqual(other.blocks, [
    { kind: 'para', text: 'Different.' },
    { kind: 'heading', level: 1, text: 'Title' }
  ])
})
