import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInput, type KeyEvent } from '../cli/src/tui/input'
import { Screen } from '../cli/src/tui/screen'
import { plainOutput, strWidth, to256, truncate, wrap } from '../cli/src/tui/term'
import { scanner, SCANNER_FRAME_MS, TextField } from '../cli/src/tui/widgets'
import { drawSpinningLogo, logoWidth } from '../cli/src/tui/logo3d'
import { App } from '../cli/src/tui/app'
import { renderMarkdown, wrapSegments } from '../cli/src/tui/markdown'
import { bar, bucketCandles, lineChart, sparkline } from '../cli/src/tui/charts'
import { applyEvent } from '../cli/src/core/chat'
import { signedPct, signedUsd, usd, usdShort } from '../cli/src/tui/views/trading/format'
import type { Chat } from '../src/shared/types'

/**
 * The terminal UI's building blocks: what keys parse into, how wide text
 * is, what a frame writes, the text field's editing, markdown, charts, the
 * desk's number formats, and folding stream events into a chat.
 */

const keys = (data: string): KeyEvent[] => parseInput(data).events.filter((e): e is KeyEvent => e.type === 'key')

test('keys: printable, control, arrows with modifiers, function keys', () => {
  assert.deepEqual(
    keys('aB').map((k) => [k.name, k.ch, k.shift]),
    [
      ['a', 'a', false],
      ['b', 'B', true]
    ]
  )
  assert.equal(keys('\x03')[0].name, 'c')
  assert.equal(keys('\x03')[0].ctrl, true)
  assert.equal(keys('\r')[0].name, 'enter')
  assert.equal(keys('\x7f')[0].name, 'backspace')
  const up = keys('\x1b[1;5A')[0]
  assert.deepEqual([up.name, up.ctrl, up.shift], ['up', true, false])
  assert.equal(keys('\x1bOP')[0].name, 'f1')
  assert.equal(keys('\x1b[15~')[0].name, 'f5')
  const backtab = keys('\x1b[Z')[0]
  assert.deepEqual([backtab.name, backtab.shift], ['tab', true])
  // Shift+Enter in kitty's and xterm's extended forms.
  assert.equal(keys('\x1b[13;2u')[0].shift, true)
  assert.equal(keys('\x1b[27;2;13~')[0].name, 'enter')
  // Option+Enter as Esc+CR.
  assert.deepEqual([keys('\x1b\r')[0].name, keys('\x1b\r')[0].meta], ['enter', true])
})

test('keys: a sequence cut in half waits for the rest; a paste arrives whole', () => {
  const half = parseInput('a\x1b[1;')
  assert.equal(half.events.length, 1)
  assert.equal(half.rest, '\x1b[1;')
  const paste = parseInput('\x1b[200~line one\r\nline two\x1b[201~')
  assert.deepEqual(paste.events, [{ type: 'paste', text: 'line one\nline two' }])
  const mouse = parseInput('\x1b[<64;10;5M').events[0]
  assert.deepEqual(mouse, { type: 'mouse', action: 'wheelup', button: 0, x: 9, y: 4 })
})

test('width: wide characters take two columns, combining marks none', () => {
  assert.equal(strWidth('abc'), 3)
  assert.equal(strWidth('比亚迪'), 6)
  assert.equal(strWidth('é'), 1)
  assert.equal(strWidth('é'), 1)
  assert.equal(truncate('比亚迪电子', 5), '比亚…')
  assert.deepEqual(wrap('the quick brown fox', 9), ['the quick', 'brown fox'])
  assert.deepEqual(wrap('abcdefghij', 4), ['abcd', 'efgh', 'ij'])
})

test('program output: colours, links and progress redraws come out as plain text', () => {
  assert.equal(plainOutput('\x1b[41m\x1b[37m red \x1b[0m done'), ' red  done')
  assert.equal(plainOutput('\x1b]8;;https://x.dev\x07link\x1b]8;;\x07'), 'link')
  assert.equal(plainOutput('10%\r50%\r100%\nnext'), '100%\nnext')
  assert.equal(plainOutput('windows\r\nlines\r\n'), 'windows\nlines\n')
  assert.equal(plainOutput('spinner\r'), 'spinner')
})

test('colour: hex to the nearest of the 256', () => {
  assert.equal(to256('#000000'), 16)
  assert.equal(to256('#ffffff'), 231)
  assert.equal(to256('#808080'), 244)
  assert.equal(to256('#ff0000'), 196)
})

test('screen: a frame redraws only what changed, and keeps wide characters whole', () => {
  let written = ''
  const out = { write: (data: string) => void (written += data), columns: 20, rows: 4 }
  const screen = new Screen(out)
  screen.render((c) => c.text(0, 0, 'hello'))
  assert.match(written, /\x1b\[2J/)
  written = ''
  screen.render((c) => c.text(0, 0, 'help!'))
  // Only the changed span of the first row: from column 4 ("l") to 5 ("o" → "!").
  assert.match(written, /\x1b\[1;4H/)
  assert.ok(!written.includes('\x1b[2J'))
  written = ''
  screen.render((c) => c.text(0, 0, 'help!'))
  assert.ok(!/\x1b\[\d+;\d+H[^\x1b]/.test(written), 'an unchanged frame writes no text')
  const shot = Screen.snapshot(10, 1, (c) => {
    c.text(0, 0, '比亚迪')
    c.text(1, 0, 'x')
  })
  // Writing over half of 比 blanks the other half.
  assert.equal(shot.text, ' x亚迪')
})

test('text field: editing keys, words, history, and multiline enter', () => {
  const field = new TextField({ multiline: true })
  const key = (name: string, extra: Partial<KeyEvent> = {}): KeyEvent => ({ type: 'key', name, ctrl: false, meta: false, shift: false, ...extra })
  field.handle({ type: 'paste', text: 'hello world' })
  assert.equal(field.value, 'hello world')
  field.handle(key('w', { ctrl: true }))
  assert.equal(field.value, 'hello ')
  field.handle(key('a', { ctrl: true }))
  field.handle(key('x', { ch: 'X' }))
  assert.equal(field.value, 'Xhello ')
  assert.equal(field.handle(key('enter', { shift: true })), 'changed')
  assert.equal(field.value, 'X\nhello ')
  assert.equal(field.handle(key('enter')), 'submit')
  field.remember('first')
  field.clear()
  field.handle(key('up'))
  assert.equal(field.value, 'first')
  const secret = new TextField({ mask: true })
  secret.value = 'sk-123'
  const shot = Screen.snapshot(12, 1, (c) => secret.draw(c))
  assert.equal(shot.text, '••••••')
})

test('markdown: headings, lists, code, tables and inline styles', () => {
  const lines = renderMarkdown('# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n\n```ts\nconst a = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |', 40)
  const text = lines.map((l) => l.map((s) => s.text).join(''))
  assert.equal(text[0], 'Title')
  assert.ok(text.includes('Some bold and code.'))
  assert.ok(text.includes('• one'))
  assert.ok(text.some((t) => t.includes('const a = 1')))
  assert.ok(text.some((t) => t.startsWith('┌')))
  const bold = lines.flat().find((s) => s.text === 'bold')
  assert.equal(bold?.style?.bold, true)
  // A reply still streaming, cut inside a fence, still renders.
  assert.ok(renderMarkdown('```js\nlet x', 30).length > 0)
  const wrapped = wrapSegments([{ text: 'aaa bbb ccc' }], 7, [{ text: '• ' }], [{ text: '  ' }])
  assert.deepEqual(
    wrapped.map((l) => l.map((s) => s.text).join('')),
    ['• aaa', '  bbb', '  ccc']
  )
})

test('charts: sparkline, bars, candles and a braille line', () => {
  assert.equal(sparkline([1, 2, 3, 4, 5, 6, 7, 8], 8), '▁▂▃▄▅▆▇█')
  assert.equal(bar(0.5, 4), '██')
  assert.equal(bar(1 / 8, 1), '▏')
  assert.equal(bucketCandles([{ o: 1, h: 5, l: 0, c: 2 }, { o: 2, h: 3, l: 1, c: 4 }], 1)[0].h, 5)
  const shot = Screen.snapshot(10, 2, (c) => lineChart(c, [1, 2, 3, 4, 5]))
  assert.ok(/[⠀-⣿]/.test(shot.text))
})

test('desk formats: signed money and percentages never show -0', () => {
  assert.equal(usd(1234.5), '$1,234.50')
  assert.equal(usd(-0.001), '$0.00')
  assert.equal(signedUsd(-0.001), '$0.00')
  assert.equal(signedUsd(12), '+$12.00')
  assert.equal(signedPct(-0.0001), '0.00%')
  assert.equal(signedPct(1.234), '+1.23%')
  assert.equal(usdShort(494_300), '$494.3K')
  assert.equal(usdShort(1_250_000), '$1.25M')
})

test('chat: stream events fold into the transcript as the desktop folds them', () => {
  let chat: Chat = {
    id: 'c',
    workspaceId: 'work',
    projectId: null,
    title: 't',
    messages: [{ id: 'm', role: 'assistant', parts: [], createdAt: 0 }],
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    pinned: false,
    unread: false,
    modelId: null,
    effort: 'medium'
  }
  chat = applyEvent(chat, { type: 'delta', messageId: 'm', text: 'Hel' })
  chat = applyEvent(chat, { type: 'delta', messageId: 'm', text: 'lo' })
  chat = applyEvent(chat, { type: 'tool-call', messageId: 'm', toolId: 't1', name: 'read_file', input: { path: 'a' } })
  chat = applyEvent(chat, { type: 'tool-progress', messageId: 'm', toolId: 't1', output: 'reading' })
  chat = applyEvent(chat, { type: 'tool-result', messageId: 'm', toolId: 't1', output: 'contents', status: 'done' })
  chat = applyEvent(chat, { type: 'compacted', messageId: 'm', chatId: 'c', summary: 's', throughMessageId: 'm' })
  const parts = chat.messages[0].parts
  assert.deepEqual(parts[0], { type: 'text', text: 'Hello' })
  assert.equal(parts[1].type === 'tool' && parts[1].status, 'done')
  assert.equal(parts[1].type === 'tool' && parts[1].progress, undefined)
  assert.deepEqual(chat.summary, { text: 's', throughMessageId: 'm' })
})

test('scanner: a light sweeps right and back along eight cells, with a fading tail', () => {
  const at = (frame: number) => scanner(frame * SCANNER_FRAME_MS + 1, '#FFA028')
  for (let f = 0; f < 60; f++) assert.equal(at(f).length, 8)
  // Going right: the head leads and the tail is behind it, to the left.
  const third = at(3)
  assert.equal(third[3].text, '■')
  assert.equal(third[3].style.fg, '#ffa028')
  assert.ok(third.slice(4).every((cell) => cell.text === '⬝'))
  assert.ok(third.slice(0, 3).every((cell) => cell.text === '■'))
  // Coming back (after 8 steps out and a 9-frame rest): the head is left of the far end, its tail to the right.
  const back = at(8 + 9 + 2)
  const head = back.findIndex((cell) => cell.style.fg === '#ffa028')
  assert.equal(head, 4)
  assert.equal(back[3].text, '⬝')
})

test('logo: face-on, the arrow is cut through the middle of the tile', () => {
  const rows = 22
  const frame = Screen.snapshot(logoWidth(rows), rows, (c) => drawSpinningLogo(c, 0, 0, rows, 0)).text.split('\n')
  const mid = Math.floor(logoWidth(rows) / 2)
  // The tile's left and right edges are solid halfway down; the arrow's middle is open.
  const row = frame[Math.floor(rows * 0.55)]
  assert.equal(row.trim().startsWith('■'), true)
  assert.equal(row.trimEnd().endsWith('■'), true)
  assert.notEqual(row[mid], '■')
  // Above the arrow's tip, the tile is solid across.
  assert.equal(frame[2][mid] === '■' || frame[2][mid - 1] === '■' || frame[2][mid + 1] === '■', true)
})

test('selection: dragging over text copies it; a plain click copies nothing', () => {
  const written: string[] = []
  const app = new App({ chat: { approvals: [] } as never, bus: null, role: () => null, output: { write: (d) => void written.push(d), columns: 40, rows: 6 } })
  app.headless = true
  app.views = { chat: { draw() {}, onEvent: () => false }, workers: { draw() {}, onEvent: () => false }, trading: { draw() {}, onEvent: () => false } } as never
  const copied: string[] = []
  app.copy = (text) => void copied.push(text)
  app.screen.render((c) => {
    c.text(2, 2, 'hello world')
    c.text(0, 3, 'second line here')
  })
  const mouse = (action: 'down' | 'drag' | 'up', x: number, y: number) => app.handle({ type: 'mouse', action, button: 0, x, y })
  mouse('down', 2, 2)
  mouse('drag', 6, 2)
  mouse('up', 6, 2)
  assert.deepEqual(copied, ['hello'])
  mouse('down', 8, 2)
  mouse('drag', 5, 3)
  mouse('up', 5, 3)
  assert.equal(copied[1], 'world\nsecond')
  mouse('down', 3, 3)
  mouse('up', 3, 3)
  assert.equal(copied.length, 2)
})
