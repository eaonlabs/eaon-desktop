import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chat, ChatMessage } from '@shared/types'
import { chatToJson, chatToMarkdown, exportFileName } from '@shared/chatExport'
import { exportChat } from '../src/main/features/chatExport'

/** Export a chat to Markdown or JSON (shared/chatExport.ts, main/features/chatExport.ts). */

const NOW = Date.UTC(2026, 10, 7, 12)
const message = (id: string, role: ChatMessage['role'], extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role,
  parts: [],
  createdAt: Date.UTC(2026, 10, 6),
  ...extra
})

const chat: Chat = {
  id: 'c1',
  workspaceId: 'w',
  projectId: null,
  title: 'Plan the “launch” trip!',
  createdAt: Date.UTC(2026, 10, 6),
  updatedAt: Date.UTC(2026, 10, 6),
  archived: false,
  pinned: false,
  unread: false,
  modelId: 'gpt-x',
  effort: 'medium',
  summary: { text: 'Earlier: picked Lisbon.', throughMessageId: 'm0' },
  messages: [
    message('m1', 'user', { parts: [{ type: 'text', text: 'Which city?' }], attachments: ['/Users/jo/Pictures/map.png', 'C:\\Docs\\notes.txt'] }),
    message('m2', 'assistant', {
      model: 'gpt-x',
      parts: [
        { type: 'reasoning', text: 'secret thinking' },
        { type: 'tool', id: 't1', name: 'web_search', input: { query: 'lisbon' }, output: 'LONG RESULTS', status: 'done', progress: 'live', before: 'old file text' },
        { type: 'text', text: 'Lisbon.\n\n```ts\nconst a = 1\n```' }
      ]
    }),
    message('m3', 'system', { parts: [{ type: 'text', text: 'Compacted' }] }),
    message('m4', 'user', { parts: [{ type: 'text', text: 'Book it' }] }),
    message('m5', 'assistant', { parts: [{ type: 'tool', id: 't2', name: 'run_command', input: {}, output: null, status: 'denied' }], error: 'The provider\nsaid no.' }),
    message('m6', 'assistant', { parts: [] })
  ]
}

test('the Markdown has each turn, tool calls as one line, and nothing private to the screen', () => {
  const md = chatToMarkdown(chat, NOW)
  assert.match(md, /^# Plan the “launch” trip!\n\nExported from Eaon on 2026-11-07\. Chat started 2026-11-06\.\n/)
  assert.match(md, /## You\n\nAttached: map\.png, notes\.txt\n\nWhich city\?/)
  assert.ok(!md.includes('/Users/jo') && !md.includes('C:\\Docs'), 'attachments are file names, not paths')
  assert.match(md, /## Assistant \(gpt-x\)\n\nLisbon\.\n\n```ts\nconst a = 1\n```\n\n- Used web_search/)
  assert.ok(!md.includes('secret thinking') && !md.includes('LONG RESULTS'), 'reasoning and tool output stay out')
  assert.ok(!md.includes('Compacted'), 'system notes are left out')
  assert.match(md, /- Used run_command \(not allowed\)\n\n> Error: The provider said no\./)
  assert.equal(md.match(/## Assistant/g)?.length, 2, 'an empty reply adds nothing')
  assert.ok(md.endsWith('\n') && !md.endsWith('\n\n'))
})

test('the JSON keeps every message and tool call, and drops what only the screen used', () => {
  const data = JSON.parse(chatToJson(chat, NOW))
  assert.equal(data.format, 'eaon-chat')
  assert.equal(data.version, 1)
  assert.equal(data.exportedAt, '2026-11-07T12:00:00.000Z')
  assert.equal(data.chat.title, chat.title)
  assert.deepEqual(data.chat.summary, chat.summary)
  assert.equal(data.chat.messages.length, 6)
  const tool = data.chat.messages[1].parts.find((p: { type: string }) => p.type === 'tool')
  assert.equal(tool.output, 'LONG RESULTS')
  assert.deepEqual(tool.input, { query: 'lisbon' })
  assert.ok(!('progress' in tool) && !('before' in tool))
  assert.ok(data.chat.messages[1].parts.some((p: { type: string }) => p.type === 'reasoning'))
  assert.deepEqual(data.chat.messages[0].attachments, ['/Users/jo/Pictures/map.png', 'C:\\Docs\\notes.txt'])
  assert.equal(data.chat.messages[4].error, 'The provider\nsaid no.')
})

test('an old or half-written chat exports without throwing', () => {
  const bare = { id: 'x', title: '', createdAt: NaN, updatedAt: 0, messages: [{ id: 'a', role: 'user', createdAt: 1 }] } as unknown as Chat
  assert.match(chatToMarkdown(bare, NOW), /^# Chat\n\nExported from Eaon on 2026-11-07\.\n/)
  assert.equal(JSON.parse(chatToJson(bare, NOW)).chat.messages[0].parts.length, 0)
})

test('file names come from the title, safe and with the right extension', () => {
  assert.equal(exportFileName('Plan the “launch” trip!', 'markdown'), 'plan-the-launch-trip.md')
  assert.equal(exportFileName('Café ünïcode / ..\\evil', 'json'), 'cafe-unicode-evil.json')
  assert.equal(exportFileName('', 'markdown'), 'chat.md')
  assert.equal(exportFileName('🙂🙂', 'json'), 'chat.json')
  assert.equal(exportFileName(undefined, 'json'), 'chat.json')
  assert.ok(exportFileName('x'.repeat(200), 'markdown').length <= 63)
})

test('main asks where to save and writes only after a path is chosen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eaon-export-'))
  const asked: string[] = []
  const written: string[] = []

  const cancelled = await exportChat(chat, 'markdown', {
    pick: async (name) => (asked.push(name), null),
    write: async (path) => void written.push(path)
  })
  assert.deepEqual(cancelled, { ok: false, cancelled: true })
  assert.deepEqual(asked, ['plan-the-launch-trip.md'])
  assert.deepEqual(written, [], 'nothing is written when the dialog is cancelled')

  const target = join(dir, 'out.json')
  const saved = await exportChat(chat, 'json', { pick: async () => target, write: (path, text) => writeFile(path, text, 'utf8'), now: () => NOW })
  assert.deepEqual(saved, { ok: true, path: target })
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).exportedAt, '2026-11-07T12:00:00.000Z')

  const failed = await exportChat(chat, 'markdown', {
    pick: async () => join(dir, 'x.md'),
    write: async () => {
      throw new Error('EACCES: permission denied')
    }
  })
  assert.deepEqual(failed, { ok: false, error: 'EACCES: permission denied' })
})

test('a request that is not a chat in a known format is refused before any dialog', async () => {
  let asked = false
  const deps = { pick: async () => ((asked = true), null), write: async () => undefined }
  assert.equal((await exportChat({ title: 'no id' }, 'markdown', deps)).ok, false)
  assert.equal((await exportChat(chat, 'pdf', deps)).ok, false)
  assert.equal((await exportChat(null, 'json', deps)).ok, false)
  assert.equal(asked, false)
})
