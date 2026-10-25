import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Chat, ChatMessage } from '@shared/types'
import { highlight, languageFamily } from '../src/renderer/src/components/agent/highlight'
import { estimateContext } from '../src/renderer/src/state/contextUse'

/** Code blocks' colours, and the context meter's estimate. */

const kinds = (code: string, lang: string): [string, string | null][] =>
  highlight(code, lang)
    .filter((token) => token.kind)
    .map((token) => [token.text, token.kind])

test('code is cut into the broad kinds, and every character comes back exactly once', () => {
  const samples: [string, string][] = [
    ['ts', 'const total = sum(items) // all of them\nexport type Row = { id: string }\nlet s = `x ${1}`'],
    ['python', 'def area(r):\n    """Circle."""\n    return 3.14 * r ** 2  # pi r squared\n@cache\nclass Shape: pass'],
    ['bash', 'npm run build --watch # dev\necho "$HOME" ${PATH}'],
    ['json', '{"name": "eaon", "count": 3, "ok": true, "none": null}'],
    ['sql', 'SELECT id, count(*) FROM users WHERE name = \'x\' -- who'],
    ['css', '.card { color: #fff; margin: 4px; }'],
    ['html', '<a href="/x" class="y">Hi</a><!-- note -->'],
    ['diff', '@@ -1 +1 @@\n-old\n+new\n same'],
    ['yaml', 'name: eaon # app\nversion: 2\non: true'],
    ['ruby', 'def hi(name)\n  puts "hi #{name}" # greet\nend']
  ]
  for (const [lang, code] of samples) {
    assert.equal(
      highlight(code, lang)
        .map((t) => t.text)
        .join(''),
      code,
      lang
    )
  }
  const ts = kinds(samples[0][1], 'ts')
  assert.ok(ts.some(([text, kind]) => text === 'const' && kind === 'keyword'))
  assert.ok(ts.some(([text, kind]) => text === 'sum' && kind === 'func'))
  assert.ok(ts.some(([text, kind]) => text === '// all of them' && kind === 'comment'))
  assert.ok(ts.some(([text, kind]) => text === 'Row' && kind === 'type'))
  const py = kinds(samples[1][1], 'py')
  assert.ok(py.some(([text, kind]) => text === '"""Circle."""' && kind === 'string'))
  assert.ok(py.some(([text, kind]) => text === '# pi r squared' && kind === 'comment'))
  assert.ok(py.some(([text, kind]) => text === '@cache' && kind === 'meta'))
  const json = kinds(samples[3][1], 'json')
  assert.deepEqual(json.slice(0, 2), [
    ['"name"', 'attr'],
    ['"eaon"', 'string']
  ])
  assert.deepEqual(kinds(samples[7][1], 'diff').map(([, kind]) => kind), ['meta', 'del', 'add'])
  assert.ok(kinds(samples[4][1], 'sql').some(([text, kind]) => text === 'SELECT' && kind === 'keyword'))
})

test('a comment left open runs to the end of the code, not just its first line', () => {
  const code = 'a()\n/* starts here\nand goes on'
  assert.deepEqual(kinds(code, 'js').at(-1), ['/* starts here\nand goes on', 'comment'])
})

test('an unknown or missing language, and a huge block, stay plain', () => {
  assert.equal(languageFamily(''), null)
  assert.equal(languageFamily('brainfuck'), null)
  assert.equal(languageFamily('TypeScript title="x.ts"'), 'c')
  assert.deepEqual(highlight('const x = 1', 'text'), [{ text: 'const x = 1', kind: null }])
  const big = 'x'.repeat(70_000)
  assert.deepEqual(highlight(big, 'js'), [{ text: big, kind: null }])
})

const msg = (id: string, role: ChatMessage['role'], parts: ChatMessage['parts'], extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role, parts, createdAt: 1, ...extra })
const chat = (messages: ChatMessage[], extra: Partial<Chat> = {}): Chat => ({
  id: 'c',
  workspaceId: 'w',
  projectId: null,
  title: 't',
  messages,
  createdAt: 1,
  updatedAt: 1,
  archived: false,
  pinned: false,
  unread: false,
  modelId: null,
  effort: 'medium',
  ...extra
})

test('the context estimate counts text, tool calls and pictures, and only what follows a summary', () => {
  const empty = estimateContext(chat([]))
  assert.ok(empty > 0, 'the system prompt and tools are always there')
  const said = estimateContext(chat([msg('u', 'user', [{ type: 'text', text: 'x'.repeat(3600) }])]))
  assert.equal(said - empty, 1000)
  const withPicture = estimateContext(chat([msg('u', 'user', [{ type: 'text', text: '' }], { attachments: ['/a.png', '/b.pdf'] })]))
  assert.equal(withPicture - empty, 1600)

  const tool = (output: string) => ({ type: 'tool' as const, id: 't', name: 'read', input: {}, output, status: 'done' as const })
  const old = estimateContext(chat([msg('a1', 'assistant', [tool('y'.repeat(36_000))]), msg('u2', 'user', [{ type: 'text', text: '' }])]))
  const latest = estimateContext(chat([msg('a1', 'assistant', [tool('y'.repeat(36_000))])]))
  assert.ok(latest - old > 9000, 'older tool output counts only as far as it is replayed')

  const long = [msg('u1', 'user', [{ type: 'text', text: 'z'.repeat(36_000) }]), msg('a1', 'assistant', [{ type: 'text', text: 'ok' }]), msg('u2', 'user', [{ type: 'text', text: 'next' }])]
  const summarized = estimateContext(chat(long, { summary: { text: 'short', throughMessageId: 'a1' } }))
  assert.ok(summarized < estimateContext(chat(long)) - 9000)
})
