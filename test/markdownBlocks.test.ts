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
  '3. **Bold lead:** after a blank line',
  '   - nested under the number',
  '     continued in the nested item',
  '  plain continuation of an item',
  '- [ ] a task',
  '- [x] a done task',
  '| Name | Size | Notes |',
  '|:-----|-----:|:-----:|',
  '| `a.ts` | 12 KB | ok |',
  '| b.ts | 3 KB | needs a look |',
  '\tindented with a tab',
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
  for (let seed = 1; seed <= 150; seed++) {
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

const list = (blocks: ReturnType<typeof parseMarkdown>['blocks'], at = 0) => {
  const block = blocks[at]
  assert.equal(block?.kind, 'list')
  return block as Extract<typeof block, { kind: 'list' }>
}

test('a numbered list spaced out with blank lines stays one list, numbered on', () => {
  const { blocks } = parseMarkdown('1. First\n\n2. Second\n\n3. Third\n\nAfter the list.')
  assert.equal(blocks.length, 2)
  const ol = list(blocks)
  assert.equal(ol.ordered, true)
  assert.equal(ol.start, 1)
  assert.deepEqual(ol.items.map((i) => i.text), ['First', 'Second', 'Third'])
  assert.deepEqual(blocks[1], { kind: 'para', text: 'After the list.' })
})

test('a list that starts at 4 keeps its number', () => {
  assert.equal(list(parseMarkdown('4. Fourth\n5. Fifth').blocks).start, 4)
})

test('sub-bullets and continuation lines stay inside their item', () => {
  const { blocks } = parseMarkdown('1. **Disk:** check usage\n   - Caches: 41 GB\n   - Mail: 3 GB\n2. **RAM:** fine\n   more about RAM')
  assert.equal(blocks.length, 1)
  const ol = list(blocks)
  assert.equal(ol.items.length, 2)
  assert.equal(ol.items[0].text, '**Disk:** check usage')
  assert.deepEqual(list(ol.items[0].children).items.map((i) => i.text), ['Caches: 41 GB', 'Mail: 3 GB'])
  assert.equal(ol.items[1].text, '**RAM:** fine\nmore about RAM')
})

test('code nested in a list item is a code block in that item', () => {
  const ol = list(parseMarkdown('1. Run this:\n\n   ```sh\n   npm test\n   ```\n2. Then this.').blocks)
  assert.equal(ol.items.length, 2)
  assert.deepEqual(ol.items[0].children, [{ kind: 'code', lang: 'sh', code: 'npm test', streaming: false }])
})

test('task items carry their box', () => {
  const ul = list(parseMarkdown('- [ ] write it\n- [x] test it\n- plain').blocks)
  assert.deepEqual(ul.items.map((i) => [i.text, i.checked]), [['write it', false], ['test it', true], ['plain', null]])
})

test('a pipe table becomes a table, with alignment and ragged rows evened out', () => {
  const { blocks } = parseMarkdown('Here:\n| Name | Size |\n|:--|--:|\n| a.ts | 12 KB |\n| b.ts |\n\nDone.')
  assert.deepEqual(blocks, [
    { kind: 'para', text: 'Here:' },
    { kind: 'table', align: ['left', 'right'], header: ['Name', 'Size'], rows: [['a.ts', '12 KB'], ['b.ts', '']] },
    { kind: 'para', text: 'Done.' }
  ])
})

test("lines that only look like lists or tables aren't", () => {
  assert.deepEqual(parseMarkdown('-5 degrees today').blocks, [{ kind: 'para', text: '-5 degrees today' }])
  assert.deepEqual(parseMarkdown('1.5 million rows').blocks, [{ kind: 'para', text: '1.5 million rows' }])
  assert.deepEqual(parseMarkdown('**Bold** start').blocks, [{ kind: 'para', text: '**Bold** start' }])
  assert.deepEqual(parseMarkdown('a | b\n---').blocks, [{ kind: 'para', text: 'a | b' }, { kind: 'rule' }])
  assert.deepEqual(parseMarkdown('---').blocks, [{ kind: 'rule' }])
})

test('after a list, a blank line settles only once the next line is plainly not more of it', () => {
  // The next line could still become "2. …".
  assert.equal(parseMarkdown('1. a\n\n2').settledBlocks, 0)
  // It can't any more.
  assert.equal(parseMarkdown('1. a\n\nSo').settledBlocks, 1)
})
