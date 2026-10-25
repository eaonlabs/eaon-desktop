import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blocksFromHunks, countChanges, diffLines, splitLines, splitPairs, toBlocks, unwindEdits, wordDiff, wordMarks, type DiffRow } from '../src/renderer/src/components/chatCode/diff/model'
import { lineTokens, pieces } from '../src/renderer/src/components/chatCode/diff/tokens'
import { agentFiles, collectEdits, editTurns, relativePath, toPatch, type AgentEdit } from '../src/renderer/src/components/chatCode/changes/build'
import type { ChatMessage } from '../src/shared/types'

/** Chat's diff viewer: the line diff, its folds and word marks, and the agent's edits worked back from disk. */

const kinds = (rows: DiffRow[]): string => rows.map((r) => (r.kind === 'ctx' ? ' ' : r.kind === 'add' ? '+' : '-')).join('')
const lines = (n: number, prefix = 'line'): string[] => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`)

test('a line diff numbers both sides and puts a changed line’s old version above its new one', () => {
  const rows = diffLines(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'd', 'e'])
  assert.equal(kinds(rows), ' -+ ' + ' +')
  assert.deepEqual(rows[1], { kind: 'del', text: 'b', old: 2, cur: null })
  assert.deepEqual(rows[2], { kind: 'add', text: 'B', old: null, cur: 2 })
  assert.deepEqual(rows[5], { kind: 'add', text: 'e', old: null, cur: 5 })
  assert.equal(kinds(diffLines([], ['x', 'y'])), '++')
  assert.equal(kinds(diffLines(['x'], [])), '-')
  // Interleaved changes still come out removed-then-added within each run.
  assert.equal(kinds(diffLines(['1', 'a', '2', 'b', '3'], ['1', 'A', 'X', '2', 'B', '3'])), ' -++ -+ ')
  assert.deepEqual(countChanges('a\nb\n', 'a\nc\nd\n'), { added: 2, removed: 1 })
})

test('lines: a final newline ends the last line, and \\r\\n reads as \\n', () => {
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b'])
  assert.deepEqual(splitLines('a\r\nb'), ['a', 'b'])
  assert.deepEqual(splitLines(''), [])
})

test('long unchanged runs fold, keeping three lines of context either side of a change', () => {
  const before = lines(30)
  const after = before.slice()
  after[14] = 'changed'
  const blocks = toBlocks(diffLines(before, after))
  assert.deepEqual(
    blocks.map((b) => (b.type === 'gap' ? `gap ${b.count}@${b.cur}` : b.type === 'rows' ? `rows ${b.rows.length}` : 'break')),
    ['gap 11@1', 'rows 8', 'gap 12@19']
  )
  // The fold keeps its rows, so it opens in place.
  const gap = blocks[0]
  assert.ok(gap.type === 'gap' && gap.rows?.length === 11 && gap.rows[0].text === 'line 1')
  // A short unchanged run between two changes is shown, not folded.
  const near = before.slice()
  near[10] = 'x'
  near[16] = 'y'
  assert.deepEqual(toBlocks(diffLines(before, near)).map((b) => b.type), ['gap', 'rows', 'gap'])
})

test('a patch’s hunks become blocks, with the lines between them folded and opening from the file', () => {
  const now = lines(40)
  const hunks = [
    { header: '@@ -4,3 +4,3 @@', lines: [
      { kind: 'ctx' as const, text: 'line 4', old: 4, cur: 4 },
      { kind: 'del' as const, text: 'old 5', old: 5, cur: null },
      { kind: 'add' as const, text: 'line 5', old: null, cur: 5 },
      { kind: 'ctx' as const, text: 'line 6', old: 6, cur: 6 }
    ] },
    { header: '@@ -30,2 +30,3 @@', lines: [
      { kind: 'ctx' as const, text: 'line 30', old: 30, cur: 30 },
      { kind: 'add' as const, text: 'line 31', old: null, cur: 31 },
      { kind: 'ctx' as const, text: 'line 32', old: 31, cur: 32 }
    ] }
  ]
  const blocks = blocksFromHunks(hunks, now)
  assert.deepEqual(blocks.map((b) => (b.type === 'gap' ? `gap ${b.count}@${b.cur}${b.rows ? '' : '?'}` : b.type)), ['gap 3@1', 'rows', 'gap 23@7', 'rows', 'gap 8@33'])
  const middle = blocks[2]
  assert.ok(middle.type === 'gap' && middle.rows?.[0].text === 'line 7' && middle.rows[0].old === 7)
  // Without the file, a fold says how many lines and nothing past the last hunk.
  assert.deepEqual(blocksFromHunks(hunks, null).map((b) => (b.type === 'gap' ? `gap ${b.count}${b.rows ? '' : '?'}` : b.type)), ['gap 3?', 'rows', 'gap 23?', 'rows'])
})

test('word marks: the words that changed in an edited line, none for a rewritten one', () => {
  const d = wordDiff('  return total + 1', '  return total + step')
  assert.deepEqual(d, { a: [{ from: 17, to: 18 }], b: [{ from: 17, to: 21 }] })
  assert.equal(wordDiff('const a = 1', 'import { x } from "y"'), null)
  assert.equal(wordDiff('same', 'same'), null)
  // Two changed words a space apart are one mark.
  const joined = wordDiff('let big red box = 1', 'let small blue box = 1')
  assert.deepEqual(joined?.b, [{ from: 4, to: 14 }])
  const rows = diffLines(['x = 1', 'keep'], ['x = 2', 'keep'])
  const marks = wordMarks(rows)
  assert.deepEqual(marks.get(rows[0]), [{ from: 4, to: 5 }])
  assert.deepEqual(marks.get(rows[1]), [{ from: 4, to: 5 }])
})

test('side by side: a removed line sits beside the line that replaced it', () => {
  const rows = diffLines(['a', 'b', 'c'], ['a', 'B', 'B2', 'c'])
  assert.deepEqual(
    splitPairs(rows).map((p) => `${p.left?.text ?? '·'}|${p.right?.text ?? '·'}`),
    ['a|a', 'b|B', '·|B2', 'c|c']
  )
})

test('edits work back from the file on disk, and stop where one can’t be undone', () => {
  const steps = [
    { kind: 'write' as const, before: '', after: 'a\nb\n' },
    { kind: 'edit' as const, before: 'b', after: 'B' },
    { kind: 'edit' as const, before: 'a', after: 'A' }
  ]
  assert.deepEqual(unwindEdits('A\nB\nc\n', steps), ['', 'a\nb\nc\n', 'a\nB\nc\n', 'A\nB\nc\n'])
  // The user changed the line the last edit wrote: nothing earlier can be known.
  assert.deepEqual(unwindEdits('Z\nB\n', steps), [null, null, null, 'Z\nB\n'])
  // An edit whose new text appears twice is ambiguous.
  assert.deepEqual(unwindEdits('x x', [{ kind: 'edit', before: 'y', after: 'x' }]), [null, 'x x'])
  assert.deepEqual(unwindEdits('x x', [{ kind: 'edit', before: 'y', after: 'x', replaceAll: true }]), ['y y', 'x x'])
})

const message = (role: 'user' | 'assistant', parts: ChatMessage['parts']): ChatMessage => ({ id: Math.random().toString(36), role, parts, createdAt: 0 }) as unknown as ChatMessage
const tool = (name: string, input: Record<string, unknown>, status = 'done'): ChatMessage['parts'][number] =>
  ({ type: 'tool', id: Math.random().toString(36), name, input, status }) as unknown as ChatMessage['parts'][number]

test('the agent’s changes per file: the whole chat, one turn, and edits that can’t be placed', () => {
  const messages = [
    message('user', []),
    message('assistant', [
      tool('write_file', { path: '/p/src/new.ts', content: 'export const a = 1\n' }),
      tool('edit_file', { path: 'src/app.ts', old_text: 'one', new_text: 'ONE' }),
      tool('edit_file', { path: 'src/app.ts', old_text: 'skip', new_text: 'nope' }, 'error')
    ]),
    message('user', []),
    message('assistant', [tool('edit_file', { path: 'src/app.ts', old_text: 'three', new_text: 'THREE' }), tool('edit_file', { path: 'gone.ts', old_text: 'q', new_text: 'Q' })])
  ]
  const edits = collectEdits(messages)
  assert.equal(edits.length, 4)
  assert.deepEqual(editTurns(edits), [1, 2])
  assert.equal(relativePath('/p', '/p/src/new.ts'), 'src/new.ts')
  assert.equal(relativePath('/p/', './src/x.ts'), 'src/x.ts')

  const app = lines(12).join('\n').replace('line 2', 'ONE').replace('line 10', 'THREE') + '\n'
  const disk = new Map<string, string | null>([
    ['src/app.ts', app],
    ['src/new.ts', 'export const a = 1\n'],
    ['gone.ts', null]
  ])
  // A file that can't be read falls back to its edits on their own.
  const chat = agentFiles(edits, '/p', disk, { kind: 'chat' })
  assert.deepEqual(chat.map((f) => `${f.path} ${f.status} +${f.added} -${f.removed}`), ['gone.ts modified +1 -1', 'src/app.ts modified +2 -2', 'src/new.ts added +1 -0'])

  // Turn 2 alone: only its edit to app.ts, numbered where it sits.
  const turn2 = agentFiles(edits, '/p', disk, { kind: 'turn', turn: 2 })
  const appTurn = turn2.find((f) => f.path === 'src/app.ts')!
  const changed = appTurn.blocks.flatMap((b) => (b.type === 'rows' ? b.rows.filter((r) => r.kind !== 'ctx') : []))
  assert.deepEqual(changed.map((r) => `${r.kind} ${r.text} ${r.old ?? r.cur}`), ['del three 10', 'add THREE 10'])
  // The file that can't be read shows its edit on its own, unnumbered.
  const gone = turn2.find((f) => f.path === 'gone.ts')!
  assert.ok(gone.blocks.every((b) => b.type !== 'rows' || b.rows.every((r) => r.old === null && r.cur === null)))

  const patch = toPatch([appTurn])
  assert.match(patch, /^diff --git a\/src\/app\.ts b\/src\/app\.ts\n--- a\/src\/app\.ts\n\+\+\+ b\/src\/app\.ts\n@@ -7,6 \+7,6 @@\n/)
  assert.match(patch, /\n-three\n\+THREE\n/)
})

test('an edit undone by a later one leaves the file out', () => {
  const edits: AgentEdit[] = [
    { path: 'a.ts', turn: 1, kind: 'edit', before: 'x', after: 'y' },
    { path: 'a.ts', turn: 2, kind: 'edit', before: 'y', after: 'x' }
  ]
  assert.deepEqual(agentFiles(edits, null, new Map([['a.ts', 'x\n']]), { kind: 'chat' }), [])
  assert.equal(agentFiles(edits, null, new Map([['a.ts', 'x\n']]), { kind: 'turn', turn: 1 }).length, 1)
})

test('colouring follows a comment across lines, and word marks cut tokens at their edges', () => {
  const tokens = lineTokens(['/* a', 'b */ const x = 1'], 'ts')
  assert.equal(tokens[1][0].kind, 'comment')
  assert.equal(tokens[1][0].text, 'b */')
  const cut = pieces([{ text: 'return', kind: 'keyword' }, { text: ' total', kind: null }], [{ from: 4, to: 8 }])
  assert.deepEqual(cut.map((p) => `${p.text}${p.em ? '*' : ''}`), ['retu', 'rn*', ' t*', 'otal'])
})

test('a long file with edits all through it diffs quickly, and a rewrite past the limit still comes out whole', () => {
  const before = lines(6000)
  const after = before.slice()
  for (let i = 0; i < after.length; i += 37) after[i] = `changed ${i}`
  const start = performance.now()
  const rows = diffLines(before, after)
  assert.ok(performance.now() - start < 1500, 'took too long')
  assert.equal(rows.filter((r) => r.kind === 'add').length, Math.ceil(6000 / 37))
  // Nothing in common at all: drawn as removed then added, not hung on.
  const other = lines(3000, 'other')
  const all = diffLines(lines(3000), other)
  assert.equal(all.length, 6000)
  assert.equal(kinds(all.slice(2999, 3001)), '-+')
})
