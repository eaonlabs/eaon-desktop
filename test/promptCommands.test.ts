import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  INIT_COMMAND,
  commandName,
  expandCommandMessage,
  expandPrompt,
  matchCommand,
  mergeCommands,
  parseCommandFile,
  splitArguments,
  type PromptCommand
} from '../src/shared/promptCommands'
import { loadPromptCommands } from '../src/main/features/chatContext/commands'
import { promptCommandItems } from '../src/renderer/src/components/composer/contextSources'

/** Prompt files as "/" commands (shared/promptCommands.ts, main/features/chatContext/commands.ts). */

test('a file path is a command name: folders join with a colon, and what can’t be typed after a slash is refused', () => {
  assert.equal(commandName('review.md'), 'review')
  assert.equal(commandName('frontend/test.MD'), 'frontend:test')
  assert.equal(commandName('a\\b.md'), 'a:b')
  assert.equal(commandName('two words.md'), null)
  assert.equal(commandName('notes.txt'), null)
  assert.equal(commandName('.hidden.md'), null)
  assert.equal(commandName('btw.md'), null, 'the box’s own /btw')
  assert.equal(commandName('a/b/c/d.md'), null, 'too deep')
})

test('a command reads its description and argument hint from front matter, or from the first line of the prompt', () => {
  const full = parseCommandFile('review.md', '---\ndescription: Review a file\nargument-hint: <file>\n---\nReview $ARGUMENTS for bugs.\n', 'project', '/p/review.md')
  assert.deepEqual(full, { name: 'review', description: 'Review a file', argumentHint: '<file>', prompt: 'Review $ARGUMENTS for bugs.', source: 'project', path: '/p/review.md' })
  const bare = parseCommandFile('standup.md', '# Write my standup\n\nSummarise what I did yesterday.', 'mine', '/m/standup.md')
  assert.equal(bare?.description, 'Write my standup')
  assert.equal(bare?.argumentHint, '')
  assert.equal(parseCommandFile('empty.md', '---\ndescription: x\n---\n\n', 'mine', ''), null, 'no prompt')
  assert.equal(parseCommandFile('bad name.md', 'x', 'mine', ''), null)
})

test('arguments are split like a shell would, with quotes grouping words', () => {
  assert.deepEqual(splitArguments('src/app.ts  "two words" \'x y\' last'), ['src/app.ts', 'two words', 'x y', 'last'])
  assert.deepEqual(splitArguments('   '), [])
})

test('what is typed after the name fills $ARGUMENTS and $1 to $9; a prompt that names none gets it added after', () => {
  assert.equal(expandPrompt('Review $ARGUMENTS for bugs.', 'src/a.ts and b.ts'), 'Review src/a.ts and b.ts for bugs.')
  assert.equal(expandPrompt('Compare $1 with $2, then $3.', 'a.ts "b c.ts"'), 'Compare a.ts with b c.ts, then.')
  assert.equal(expandPrompt('Review $ARGUMENTS', ''), 'Review', 'nothing typed: the box shows the prompt to finish')
  assert.equal(expandPrompt('Write a changelog.', 'for v2'), 'Write a changelog.\n\nfor v2')
  assert.equal(expandPrompt('Write a changelog.', ''), 'Write a changelog.')
  assert.equal(expandPrompt('Use $ARGUMENTS and $ARGUMENTS.', 'x'), 'Use x and x.')
})

const cmd = (name: string, prompt: string, source: PromptCommand['source'] = 'project'): PromptCommand => ({ name, description: '', argumentHint: '', prompt, source, path: `/p/${name}.md` })

test('a message that begins with a command’s name is sent as its prompt; anything else is sent as typed', () => {
  const list = [cmd('review', 'Review $ARGUMENTS for bugs.'), cmd('fix:lint', 'Fix the lint errors.')]
  assert.equal(expandCommandMessage('/review src/app.ts', list), 'Review src/app.ts for bugs.')
  assert.equal(expandCommandMessage('  /Review\nsrc/app.ts', list), 'Review src/app.ts for bugs.', 'case and a line break after the name')
  assert.equal(expandCommandMessage('/fix:lint', list), 'Fix the lint errors.')
  assert.equal(expandCommandMessage('/review', list), 'Review for bugs.')
  assert.equal(expandCommandMessage('/unknown thing', list), '/unknown thing')
  assert.equal(expandCommandMessage('/usr/bin/review please', list), '/usr/bin/review please', 'a path is not a command')
  assert.equal(expandCommandMessage('please /review this', list), 'please /review this', 'only at the start')
  assert.deepEqual(matchCommand('/review a b', list)?.args, 'a b')
  assert.equal(expandCommandMessage('/init', [INIT_COMMAND]).startsWith('Look through this project and write an AGENTS.md'), true)
})

test('a name used twice keeps the project’s; the project’s folders go in order, and each group is sorted by name', () => {
  const merged = mergeCommands(
    [[cmd('zeta', 'eaon zeta'), cmd('shared', 'from .eaon')], [cmd('shared', 'from .claude'), cmd('alpha', 'claude alpha')]],
    [cmd('shared', 'mine', 'mine'), cmd('beta', 'mine beta', 'mine')]
  )
  assert.deepEqual(merged.map((c) => `${c.name}:${c.prompt}`), ['alpha:claude alpha', 'shared:from .eaon', 'zeta:eaon zeta', 'beta:mine beta'])
})

test('the menu lists commands with their source, and says where to add one when there are none', () => {
  const rows = promptCommandItems([cmd('review', 'Review $ARGUMENTS for bugs.'), cmd('standup', 'Write it.', 'mine')], '', () => undefined)
  assert.deepEqual(rows.map((r) => [r.title, r.hint]), [['review', 'Project'], ['standup', 'Yours']])
  assert.equal(rows[0].insert, 'Review for bugs.')
  assert.ok(rows.every((r) => r.section === 'Prompt files'))
  const none = promptCommandItems([INIT_COMMAND], '', () => undefined)
  assert.deepEqual(none.map((r) => r.title), ['init', 'Add a command'], 'only the built-in one: the way to add is shown')
  assert.equal(none[1].insert, undefined, 'it only does something')
  assert.deepEqual(promptCommandItems([cmd('a', 'x')], '', () => undefined).map((r) => r.title), ['a'])
  assert.ok(promptCommandItems([cmd('a', 'x')], 'add', () => undefined).some((r) => r.title === 'Add a command'), 'typed for')
})

/* ------------------------------------------------------------------- disk */

let tmp = ''
const write = (root: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-commands-')))
})
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('commands are found in the project’s folders and the user’s own, the project’s winning a shared name', async () => {
  const project = path.join(tmp, 'proj')
  const mine = path.join(tmp, 'mine')
  write(project, '.eaon/commands/review.md', '---\ndescription: Eaon review\n---\nReview $ARGUMENTS.')
  write(project, '.claude/commands/review.md', 'Claude review.')
  write(project, '.claude/commands/fix/lint.md', 'Fix lint.')
  write(project, '.cursor/commands/ship.md', 'Ship it.')
  write(project, '.eaon/commands/notes.txt', 'not a command')
  write(project, '.eaon/commands/bad name.md', 'x')
  write(project, '.eaon/commands/btw.md', 'reserved')
  write(project, '.eaon/commands/empty.md', '\n')
  write(project, '.eaon/commands/huge.md', 'x'.repeat(150_000))
  write(mine, 'review.md', 'My review.')
  write(mine, 'standup.md', 'Write my standup.')

  const found = await loadPromptCommands(project, mine)
  assert.deepEqual(
    found.map((c) => [c.name, c.source, c.prompt]),
    [
      ['fix:lint', 'project', 'Fix lint.'],
      ['review', 'project', 'Review $ARGUMENTS.'],
      ['ship', 'project', 'Ship it.'],
      ['standup', 'mine', 'Write my standup.']
    ]
  )
  assert.equal(found.find((c) => c.name === 'review')?.description, 'Eaon review')
  assert.equal(found.find((c) => c.name === 'review')?.path, path.join(project, '.eaon/commands/review.md'))

  // With no project, only the user's own.
  assert.deepEqual((await loadPromptCommands(null, mine)).map((c) => c.name), ['review', 'standup'])
  // Nothing there at all is an empty list, not an error.
  assert.deepEqual(await loadPromptCommands(path.join(tmp, 'missing'), path.join(tmp, 'also-missing')), [])
})
