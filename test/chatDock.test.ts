import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hash, Image, Settings, CodeXml, Package, KeyRound, Lock, Terminal } from 'lucide-react'
import { glyphFor, type Glyph } from '../src/renderer/src/components/agent/FileIcon'
import { colOf, columnsOf, groupOf, nextTitle, splitTabs, type PaneTab } from '../src/renderer/src/components/chatCode/terminalLayout'
import { linkedPulls, linkedPullsInText } from '../src/renderer/src/components/ide/surfaces/linkedPulls'
import type { ChatMessage } from '../src/shared/types'

/** The dock: file marks, terminal splits, and the pull requests a chat or the ADE's terminals link to. */

const mark = (g: Glyph): string => ('mark' in g ? g.mark : 'text' in g ? `text:${g.text}` : 'icon')
const icon = (g: Glyph): unknown => ('icon' in g ? g.icon : null)

test('file marks: languages by extension, whole names first, lines for the rest', () => {
  assert.equal(mark(glyphFor('app.py')), 'python')
  assert.equal(mark(glyphFor('src/app.ts')), 'ts')
  assert.equal(mark(glyphFor('index.mjs')), 'js')
  assert.equal(mark(glyphFor('README.md')), 'icon', 'a README is its own mark, not Markdown')
  assert.equal(mark(glyphFor('notes.md')), 'markdown')
  assert.equal(icon(glyphFor('style.css')), Hash)
  assert.equal(icon(glyphFor('theme.SCSS')), Hash, 'extensions in any case')
  assert.equal(icon(glyphFor('index.html')), CodeXml)
  assert.equal(icon(glyphFor('logo.png')), Image)
  assert.equal(icon(glyphFor('setup.cfg')), Settings)
  assert.equal(icon(glyphFor('package.json')), Package)
  assert.equal(mark(glyphFor('tsconfig.json')), 'icon')
  assert.equal(icon(glyphFor('.env.local')), KeyRound)
  assert.equal(icon(glyphFor('yarn.lock')), Lock)
  assert.equal(icon(glyphFor('deploy.sh')), Terminal)
  assert.equal(mark(glyphFor('.gitignore')), 'git')
  assert.equal(mark(glyphFor('main.go')), 'text:GO')
  assert.equal(mark(glyphFor('LICENSE')), 'icon')
  assert.equal(mark(glyphFor('notes.txt')), 'lines')
  assert.equal(mark(glyphFor('Procfile')), 'lines')
  assert.equal(mark(glyphFor('C:\\work\\main.rs')), 'icon', 'Windows paths too')
})

const pane = (id: string, extra: Partial<PaneTab> = {}): PaneTab => ({ id, title: id, ...extra })
const layout = (tabs: PaneTab[]): string =>
  [...new Set(tabs.map(groupOf))].map((g) => columnsOf(tabs.filter((t) => groupOf(t) === g)).map((col) => col.map((t) => t.id).join('/')).join(' | ')).join(' ; ')

test('terminal splits: right adds a column after the whole column, down stacks under the pane', () => {
  let tabs = [pane('a'), pane('z')]
  tabs = splitTabs(tabs, 'a', 'right', pane('b'))
  assert.equal(layout(tabs), 'a | b ; z')
  assert.equal(groupOf(tabs[0]), 'a', 'the first pane names the group')
  tabs = splitTabs(tabs, 'a', 'down', pane('c'))
  assert.equal(layout(tabs), 'a/c | b ; z')
  // Right of a pane in a column goes after the column, not between its panes.
  tabs = splitTabs(tabs, 'a', 'right', pane('d'))
  assert.equal(layout(tabs), 'a/c | d | b ; z')
  tabs = splitTabs(tabs, 'b', 'down', pane('e'))
  assert.equal(layout(tabs), 'a/c | d | b/e ; z')
  assert.equal(colOf(tabs.find((t) => t.id === 'e')!), 'b')
  // The first pane closing leaves the rest grouped by its name.
  tabs = tabs.filter((t) => t.id !== 'a')
  assert.equal(layout(tabs), 'c | d | b/e ; z')
  assert.equal(splitTabs(tabs, 'missing', 'right', pane('x')), tabs, 'an unknown pane changes nothing')
})

test('terminal titles: one past the highest in use', () => {
  assert.equal(nextTitle([]), 'Terminal 1')
  assert.equal(nextTitle([{ id: '1', title: 'Terminal' }]), 'Terminal 2', 'an unnumbered one counts as 1')
  assert.equal(nextTitle([{ id: '1', title: 'Terminal 1' }, { id: '3', title: 'Terminal 3' }, { id: 'd', title: 'dev' }]), 'Terminal 4')
})

const message = (parts: ChatMessage['parts']): ChatMessage => ({ id: Math.random().toString(36), role: 'assistant', parts, createdAt: 0 }) as ChatMessage

test('linked pull requests: each once, newest mention first, from replies and tool results', () => {
  const pulls = linkedPulls([
    message([{ type: 'text', text: 'Opened https://github.com/acme/web/pull/12 for review.' }]),
    message([
      {
        type: 'tool',
        id: 't1',
        name: 'run_command',
        input: { command: 'gh pr create' },
        output: 'https://github.com/acme/api/pull/7\n',
        status: 'done'
      }
    ]),
    message([{ type: 'text', text: 'Back to https://github.com/acme/web/pull/12/files and https://github.com/acme/web/issues/3' }])
  ])
  assert.deepEqual(
    pulls.map((p) => `${p.repo}#${p.number}`),
    ['acme/web#12', 'acme/api#7']
  )
  assert.equal(pulls[0].url, 'https://github.com/acme/web/pull/12')
  assert.deepEqual(linkedPulls([message([{ type: 'text', text: 'no links here' }])]), [])
})

test('linked pull requests in the ADE: read from its terminals, the last one named first', () => {
  const pulls = linkedPullsInText([
    '$ gh pr create --fill\nhttps://github.com/acme/web/pull/40\n',
    '⏺ Opened https://github.com/acme/api/pull/9 and updated\nhttps://github.com/acme/web/pull/40/files',
    'https://github.com/acme/web/issues/2'
  ])
  assert.deepEqual(
    pulls.map((p) => `${p.repo}#${p.number}`),
    ['acme/web#40', 'acme/api#9']
  )
  assert.deepEqual(linkedPullsInText(['', 'nothing linked']), [])
})
