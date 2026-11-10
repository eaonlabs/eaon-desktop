import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  capText,
  chatTranscript,
  isBranchName,
  isCommitId,
  mentionFileName,
  terminalAttachment,
  terminalTail,
  type GitRefs
} from '../src/shared/chatContext'
import type { ChatMessage } from '../src/shared/types'
import { HostBook } from '../src/main/features/ade/hosts'
import { makeRunner } from '../src/main/features/ade/runner'
import { gitMentionText, gitRefs } from '../src/main/features/chatContext/git'
import { saveMention } from '../src/main/features/chatContext/save'
import { chatMentionItems, gitMentionItems, terminalMentionItems } from '../src/renderer/src/components/composer/contextSources'

/**
 * What the "@" menu attaches beside files (shared/chatContext.ts): git
 * changes, a branch or a commit, a terminal's output, an earlier chat.
 */

test('only names and ids git would accept as plain refs get through', () => {
  assert.equal(isBranchName('feature/x-1'), true)
  assert.equal(isBranchName('--upload-pack=x'), false, 'an option')
  assert.equal(isBranchName('a..b'), false, 'a range')
  assert.equal(isBranchName('x.lock'), false)
  assert.equal(isBranchName('dir/'), false)
  assert.equal(isBranchName(42), false)
  assert.equal(isCommitId('abc1234'), true)
  assert.equal(isCommitId('abc'), false, 'too short to be one')
  assert.equal(isCommitId('HEAD; rm'), false)
})

test('long text is cut at a line end and says how much is missing', () => {
  assert.deepEqual(capText('short', 100), { text: 'short', truncated: false })
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
  const cut = capText(lines, 100, 'diff')
  assert.equal(cut.truncated, true)
  assert.match(cut.text, /\[The diff is cut here: [\d,]+ more characters are left out\.\]/)
  assert.ok(cut.text.startsWith('line 0\n'))
  // Cut on a whole line, not through the middle of one.
  const body = cut.text.split('\n\n[The diff')[0]
  assert.ok(body.split('\n').every((l) => /^line \d+$/.test(l)))
})

test('a saved mention is named so its chip says what it is, with no path characters in it', () => {
  const when = new Date(2026, 10, 7, 9, 5, 3)
  assert.equal(mentionFileName('Commit abc1234', 'diff', when), 'Commit abc1234 2026-11-07 09.05.03.diff')
  assert.equal(mentionFileName('Branch feature/x: "wip"', 'diff', when), 'Branch feature x wip 2026-11-07 09.05.03.diff')
  assert.equal(mentionFileName('///', 'txt', when), 'Attached 2026-11-07 09.05.03.txt')
  assert.ok(mentionFileName('x'.repeat(200), 'txt', when).length < 100)
})

test('a terminal is attached as its last lines, without the empty ones at the end', () => {
  assert.deepEqual(terminalTail('a\nb\n\n\n', 5), { text: 'a\nb', lines: 2, cut: false })
  const many = Array.from({ length: 300 }, (_, i) => `out ${i}  `).join('\r\n')
  const tail = terminalTail(many, 200)
  assert.equal(tail.lines, 200)
  assert.equal(tail.cut, true)
  assert.ok(tail.text.startsWith('out 100\n') && tail.text.endsWith('out 299'))
  assert.equal(terminalAttachment('zsh', '  \n\n', '/p'), null, 'nothing printed')
  const made = terminalAttachment('npm run dev', 'error: boom\n', '/p/app')!
  assert.equal(made.label, 'Terminal npm run dev')
  assert.match(made.text, /^Output of the terminal "npm run dev" in \/p\/app, 1 line:\n\nerror: boom\n$/)
})

const message = (id: string, role: ChatMessage['role'], parts: ChatMessage['parts'], extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role, parts, createdAt: 1, ...extra })
const said = (text: string): ChatMessage['parts'] => [{ type: 'text', text }]
const tool = (name: string): ChatMessage['parts'][number] => ({ type: 'tool', id: name + Math.random(), name, input: {}, output: 'big output', status: 'done' })

test('an earlier chat is attached as what was said, with tool use as a line and the summary first', () => {
  const messages = [
    message('m1', 'user', said('Set up the build'), { attachments: ['/x/plan.md'] }),
    message('m2', 'assistant', [...said('Looking.'), tool('read_file'), tool('read_file'), tool('run_command'), ...said('Done.')]),
    message('m3', 'user', said('Now add tests')),
    message('m4', 'assistant', said('Added.')),
    message('s', 'system', said('hidden'))
  ]
  const plain = chatTranscript({ title: 'Build', updatedAt: Date.UTC(2026, 10, 3), messages })
  assert.equal(plain.summarized, false)
  assert.equal(plain.messages, 4)
  assert.match(plain.text, /^An earlier conversation, "Build" \(last active 2026-11-03\):/)
  assert.ok(plain.text.includes('User: Set up the build\n[attached: plan.md]'))
  assert.ok(plain.text.includes('Assistant: Looking.\n[used read_file x2, run_command]\nDone.'))
  assert.ok(!plain.text.includes('big output') && !plain.text.includes('hidden'))

  const summarized = chatTranscript({ title: 'Build', updatedAt: 1, messages, summary: { text: 'Build set up.', throughMessageId: 'm2' } })
  assert.equal(summarized.summarized, true)
  assert.match(summarized.text, /Summary of its earlier part:\nBuild set up\./)
  assert.ok(summarized.text.includes('What was said after that:\n\nUser: Now add tests'))
  assert.ok(!summarized.text.includes('Set up the build'), 'what the summary covers is not repeated')
})

test('a very long chat keeps its start and its latest turns', () => {
  const messages = Array.from({ length: 200 }, (_, i) => message(`m${i}`, i % 2 ? 'assistant' : 'user', said(`turn ${i} ${'x'.repeat(100)}`)))
  const made = chatTranscript({ title: 'Long', updatedAt: 1, messages }, 4000)
  assert.equal(made.cut, true)
  assert.ok(made.text.length < 4400)
  assert.ok(made.text.includes('turn 0 ') && made.text.includes('turn 199 '))
  assert.match(made.text, /\[[\d,]+ characters from the middle are left out\.\]/)
})

/* ------------------------------------------------------------------- rows */

const refs: GitRefs = {
  repo: true,
  base: 'main',
  current: 'feature/x',
  branches: ['feature/x', 'main', 'fix/login', 'feature/y'],
  commits: [
    { sha: 'a'.repeat(40), short: 'aaaaaaa', subject: 'Fix the login redirect', at: 0, author: 'Sam', local: false },
    { sha: 'b'.repeat(40), short: 'bbbbbbb', subject: 'Add settings page', at: 0, author: 'Jo', local: false }
  ]
}

test('the menu offers uncommitted changes, this branch and recent commits, and other branches once typed', () => {
  const picked: unknown[] = []
  const quiet = gitMentionItems({ refs, changedFiles: 3, query: '', now: 0, onPick: (m) => picked.push(m) })
  assert.deepEqual(
    quiet.map((i) => i.title),
    ['Uncommitted changes', 'Branch changes', 'Fix the login redirect', 'Add settings page']
  )
  assert.equal(quiet[0].hint, '3 files')
  assert.equal(quiet[1].description, 'feature/x compared with main')
  quiet[2].run?.()
  quiet[1].run?.()
  quiet[0].run?.()
  assert.deepEqual(picked, [{ kind: 'commit', sha: 'a'.repeat(40) }, { kind: 'branch', name: 'feature/x' }, { kind: 'uncommitted' }])

  const typed = gitMentionItems({ refs, changedFiles: 3, query: 'fix', now: 0, onPick: () => undefined })
  assert.ok(typed.some((i) => i.id === 'git:branch:fix/login'), 'a branch whose name has what was typed')
  assert.ok(!typed.some((i) => i.id === 'git:branch:main' || i.id === 'git:branch:feature/x'), 'not the base or the current branch twice')
  assert.ok(!quiet.some((i) => i.section === 'Branches'), 'other branches only when something is typed')
})

test('with nothing uncommitted, on the base branch, or outside git, those rows are not offered', () => {
  const titles = (r: GitRefs | null, changed: number | null): string[] => gitMentionItems({ refs: r, changedFiles: changed, query: '', now: 0, onPick: () => undefined }).map((i) => i.title)
  assert.ok(!titles(refs, 0).includes('Uncommitted changes'))
  assert.ok(titles(refs, null).includes('Uncommitted changes'), 'unknown: offered, and the read says if there is nothing')
  assert.ok(!titles({ ...refs, current: 'main' }, 2).includes('Branch changes'))
  assert.ok(!titles({ ...refs, base: null }, 2).includes('Branch changes'))
  assert.deepEqual(titles({ ...refs, repo: false }, 2), [])
  assert.deepEqual(titles(null, 2), [])
})

test('terminals with output are offered, named when there are several', () => {
  const rows = [
    { id: 't1', title: 'zsh', command: null, hasOutput: true },
    { id: 't2', title: 'dev', command: 'npm run dev', hasOutput: true },
    { id: 't3', title: 'empty', command: null, hasOutput: false }
  ]
  const many = terminalMentionItems(rows, () => undefined)
  assert.deepEqual(many.map((i) => i.title), ['Terminal output: zsh', 'Terminal output: dev'])
  assert.equal(many[1].description, 'Running npm run dev')
  assert.equal(many[0].description, 'The last 200 lines')
  assert.equal(terminalMentionItems([rows[0]], () => undefined)[0].title, 'Terminal output')
  assert.deepEqual(terminalMentionItems([rows[2]], () => undefined), [])
})

test('earlier chats are offered newest first, without the open one or archived ones, a few until something is typed', () => {
  const chat = (id: string, updatedAt: number, extra: Record<string, unknown> = {}) => ({
    id,
    workspaceId: 'w',
    projectId: null,
    title: `Chat ${id}`,
    messages: [message('u', 'user', said('hi')), message('a', 'assistant', said('hello'))],
    createdAt: 1,
    updatedAt,
    archived: false,
    pinned: false,
    unread: false,
    modelId: null,
    effort: 'medium' as const,
    ...extra
  })
  const chats = [
    chat('old', 100),
    chat('open', 900),
    chat('gone', 800, { archived: true }),
    chat('blank', 700, { messages: [] }),
    chat('summarized', 500, { summary: { text: 'It was about X.', throughMessageId: 'u' } }),
    ...Array.from({ length: 8 }, (_, i) => chat(`more${i}`, 200 + i))
  ]
  const quiet = chatMentionItems(chats, 'open', '', 1000, () => undefined)
  assert.equal(quiet.length, 5)
  assert.equal(quiet[0].title, 'Chat summarized')
  assert.equal(quiet[0].hint, 'Summarized')
  const all = chatMentionItems(chats, 'open', 'chat', 1000, () => undefined)
  assert.equal(all.length, 10)
  assert.ok(!all.some((i) => i.id === 'chat:open' || i.id === 'chat:gone' || i.id === 'chat:blank'))
  assert.match(all[0].description ?? '', /1 message from you/)
})

/* -------------------------------------------------------------------- git */

let tmp = ''
let repo = ''
const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com' }
const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim()
const run = makeRunner(new HostBook({ load: () => [], save: () => undefined, readConfig: async () => [] }))

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chat-context-')))
  repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const a = 1\n')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
  git('checkout', '-q', '-b', 'feature/thing')
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const a = 2\n')
  git('commit', '-q', '-am', 'Change a to two')
})

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('the repository tells the menu its base branch, branch, commits and branches', async () => {
  const found = await gitRefs(run, repo)
  assert.equal(found.repo, true)
  assert.equal(found.base, 'main')
  assert.equal(found.current, 'feature/thing')
  assert.deepEqual(found.commits.map((c) => c.subject), ['Change a to two', 'first'])
  assert.deepEqual(found.branches.sort(), ['feature/thing', 'main'])
  const outside = fs.mkdtempSync(path.join(tmp, 'plain-'))
  assert.deepEqual(await gitRefs(run, outside), { repo: false, base: null, current: null, commits: [], branches: [] })
})

test('a branch is its committed changes against main, with the commits listed first', async () => {
  const text = await gitMentionText(run, repo, { kind: 'branch', name: 'feature/thing' })
  assert.ok(text.ok)
  assert.equal(text.label, 'Branch feature/thing')
  assert.match(text.text, /^The changes on branch feature\/thing compared with main \(since [0-9a-f]{7}\), committed work only:\n  [0-9a-f]+ Change a to two\n\ndiff --git a\/app\.ts b\/app\.ts/)
  assert.ok(text.text.includes('-export const a = 1') && text.text.includes('+export const a = 2'))
  assert.equal(text.files, 1)
  const onBase = await gitMentionText(run, repo, { kind: 'branch', name: 'main' })
  assert.equal(onBase.ok, false)
  const missing = await gitMentionText(run, repo, { kind: 'branch', name: 'nope' })
  assert.deepEqual(missing, { ok: false, error: 'There is no branch called nope.' })
})

test('a commit is its message, stat and patch', async () => {
  const sha = git('rev-parse', 'HEAD')
  const text = await gitMentionText(run, repo, { kind: 'commit', sha })
  assert.ok(text.ok)
  assert.equal(text.label, `Commit ${sha.slice(0, 7)}`)
  assert.ok(text.text.includes('Change a to two') && text.text.includes('app.ts') && text.text.includes('+export const a = 2'))
  const bad = await gitMentionText(run, repo, { kind: 'commit', sha: 'deadbeef' })
  assert.equal(bad.ok, false)
})

test('uncommitted changes include edited and new files, and say so when there are none', async () => {
  const clean = await gitMentionText(run, repo, { kind: 'uncommitted' })
  assert.deepEqual(clean, { ok: false, error: 'There are no uncommitted changes.' })

  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const a = 3\n')
  fs.writeFileSync(path.join(repo, 'notes.md'), 'new file text\n')
  fs.writeFileSync(path.join(repo, 'huge.log'), 'x'.repeat(300_000))
  const text = await gitMentionText(run, repo, { kind: 'uncommitted' })
  assert.ok(text.ok)
  assert.match(text.text, /^The uncommitted changes in .* on branch feature\/thing, as git diff/)
  assert.ok(text.text.includes('+export const a = 3'))
  assert.ok(text.text.includes('new file text'), 'a file git does not track yet')
  assert.ok(!text.text.includes('xxxxxxxxxx'), 'a huge new file is left out')
  assert.equal(text.files, 2)
  git('checkout', '-q', '--', 'app.ts')
  fs.rmSync(path.join(repo, 'notes.md'))
  fs.rmSync(path.join(repo, 'huge.log'))
})

test('a diff past the cap is cut and the file says so', async () => {
  fs.writeFileSync(path.join(repo, 'big.txt'), Array.from({ length: 30_000 }, (_, i) => `line number ${i} of a big file`).join('\n'))
  git('add', 'big.txt')
  git('commit', '-q', '-m', 'A big file')
  const text = await gitMentionText(run, repo, { kind: 'commit', sha: git('rev-parse', 'HEAD') })
  assert.ok(text.ok)
  assert.equal(text.truncated, true)
  assert.ok(text.text.length < 410_000)
  assert.match(text.text, /The diff is cut here/)
})

test('a mention is saved as a text file under a readable name', async () => {
  const file = await saveMention('Commit abc1234', 'diff', 'diff --git a/x b/x\n')
  assert.ok(path.basename(file).startsWith('Commit abc1234 ') && file.endsWith('.diff'))
  assert.equal(fs.readFileSync(file, 'utf8'), 'diff --git a/x b/x\n')
  await assert.rejects(saveMention('Empty', 'txt', '  \n'), /nothing to attach/)
})
