import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RULES_BUDGET, RULE_FILE_CAP, composeRules, cursorRule, parseFrontMatter, withRules } from '../src/shared/projectRules'
import { HostBook } from '../src/main/features/ade/hosts'
import { makeRunner } from '../src/main/features/ade/runner'
import { loadProjectRules, withProjectRules } from '../src/main/features/chatContext/rules'

/** The rules files Chat gives the agent (shared/projectRules.ts, main/features/chatContext/rules.ts). */

test('front matter is read as key: value lines and taken off the text', () => {
  const text = '---\ndescription: "Style"\nglobs: src/**/*.ts\nalwaysApply: false\n---\nUse tabs.\n'
  assert.deepEqual(parseFrontMatter(text), { data: { description: 'Style', globs: 'src/**/*.ts', alwaysApply: 'false' }, body: 'Use tabs.\n', has: true })
  assert.deepEqual(parseFrontMatter('Just rules.\n'), { data: {}, body: 'Just rules.\n', has: false })
  assert.equal(parseFrontMatter('--- not front matter\nx').has, false)
})

test('a Cursor rule goes in when it always applies or has no front matter; the rest say why not', () => {
  assert.deepEqual(cursorRule('Plain.\n'), { applies: true, body: 'Plain.\n' })
  assert.deepEqual(cursorRule('---\nalwaysApply: true\n---\nAlways.'), { applies: true, body: 'Always.' })
  assert.deepEqual(cursorRule('---\nglobs: *.ts\nalwaysApply: false\n---\nx'), { applies: false, reason: 'applies only to files that match its pattern' })
  assert.deepEqual(cursorRule('---\ndescription: When asked\n---\nx'), { applies: false, reason: 'is used only when the model asks for it' })
  assert.deepEqual(cursorRule('---\nfoo: bar\n---\nx'), { applies: false, reason: 'is not set to always apply' })
})

test('rules are composed in order, cut when long, deduplicated and kept within the budget', () => {
  const src = (name: string, body: string) => ({ path: `/p/${name}`, name, body })
  const made = composeRules([src('AGENTS.md', 'Use pnpm.\n'), src('.cursorrules', 'Use pnpm.'), src('empty.md', '  \n'), src('big.md', 'x'.repeat(RULE_FILE_CAP + 500))])
  assert.deepEqual(
    made.files.map((f) => [f.name, f.cut]),
    [
      ['AGENTS.md', false],
      ['big.md', true]
    ]
  )
  assert.deepEqual(made.skipped, [{ name: '.cursorrules', path: '/p/.cursorrules', reason: 'has the same text as a file already used' }])
  assert.ok(made.text.startsWith("The project's own rules files, found in its folder. Follow them:\n\nFrom AGENTS.md:\nUse pnpm."))
  assert.ok(made.text.includes('From big.md:\n') && /file is cut here/.test(made.text))

  // Three big files: the third would pass the budget and is listed, not dropped quietly.
  const three = composeRules([1, 2, 3].map((n) => src(`r${n}.md`, `${n}${'y'.repeat(RULE_FILE_CAP)}`)))
  assert.equal(three.files.length, 2)
  assert.ok(three.text.length <= RULES_BUDGET + 200)
  assert.equal(three.skipped[0].name, 'r3.md')
  assert.match(three.skipped[0].reason, /would pass the limit of 25,000 characters/)

  assert.deepEqual(composeRules([]), { files: [], skipped: [], text: '' })
  assert.equal(withRules('Be brief.', composeRules([src('A.md', 'Rule.')])), "Be brief.\n\nThe project's own rules files, found in its folder. Follow them:\n\nFrom A.md:\nRule.")
  assert.equal(withRules('', composeRules([])), '')
  assert.equal(withRules('Be brief.', composeRules([])), 'Be brief.')
})

/* ------------------------------------------------------------------- disk */

let tmp = ''
const run = makeRunner(new HostBook({ load: () => [], save: () => undefined, readConfig: async () => [] }))
const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com' }
const write = (root: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}
const project = (name: string, git = true): string => {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir, { recursive: true })
  if (git) execFileSync('git', ['-C', dir, 'init', '-q'], { env })
  return dir
}

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-rules-')))
})
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('AGENTS.md is read from the folder up to the top of the repository, nearest first, and CLAUDE.md is not stacked on it', async () => {
  const repo = project('repo')
  write(repo, 'AGENTS.md', 'Root rules.')
  write(repo, 'CLAUDE.md', 'Claude copy.')
  write(repo, 'packages/app/AGENTS.md', 'App rules.')
  const found = await loadProjectRules(run, path.join(repo, 'packages/app'))
  assert.deepEqual(found.files.map((f) => f.name), ['AGENTS.md', '../../AGENTS.md'])
  assert.ok(found.text.indexOf('App rules.') < found.text.indexOf('Root rules.'))
  assert.ok(!found.text.includes('Claude copy.'))
})

test('without AGENTS.md, CLAUDE.md is used; outside a repository only the folder itself is looked in', async () => {
  const repo = project('claude-only')
  write(repo, 'CLAUDE.md', 'Claude rules.')
  assert.deepEqual((await loadProjectRules(run, repo)).files.map((f) => f.name), ['CLAUDE.md'])

  const loose = project('loose', false)
  write(path.dirname(loose), 'AGENTS.md', 'Above, not part of any repository.')
  write(loose, 'GEMINI.md', 'Gemini rules.')
  const found = await loadProjectRules(run, loose)
  assert.deepEqual(found.files.map((f) => f.name), ['GEMINI.md'])
  fs.rmSync(path.join(path.dirname(loose), 'AGENTS.md'))
})

test('other tools’ rules are read after it: .cursorrules, always-on Cursor rules, Copilot, Cline; the rest are listed as skipped', async () => {
  const repo = project('others')
  write(repo, 'AGENTS.md', 'Main.')
  write(repo, '.cursorrules', 'Cursor old-style.')
  write(repo, '.cursor/rules/always.mdc', '---\nalwaysApply: true\n---\nAlways on.')
  write(repo, '.cursor/rules/ts.mdc', '---\nglobs: *.ts\nalwaysApply: false\n---\nTypeScript only.')
  write(repo, '.cursor/rules/plain.md', 'No front matter.')
  write(repo, '.github/copilot-instructions.md', 'Copilot text.')
  write(repo, '.clinerules/one.md', 'Cline one.')
  write(repo, '.windsurfrules', 'Windsurf.')
  write(repo, 'notes.txt', 'Not a rules file.')
  const found = await loadProjectRules(run, repo)
  assert.deepEqual(found.files.map((f) => f.name), [
    'AGENTS.md',
    '.cursorrules',
    '.windsurfrules',
    '.github/copilot-instructions.md',
    '.cursor/rules/always.mdc',
    '.cursor/rules/plain.md',
    '.clinerules/one.md'
  ])
  assert.ok(found.text.includes('Always on.') && !found.text.includes('alwaysApply'), 'front matter is not sent')
  assert.ok(!found.text.includes('TypeScript only.'))
  assert.deepEqual(found.skipped.map((s) => [s.name, s.reason]), [['.cursor/rules/ts.mdc', 'applies only to files that match its pattern']])
})

test('a folder with no rules, an empty file, a binary file or a huge one gives nothing', async () => {
  const repo = project('nothing')
  assert.deepEqual(await loadProjectRules(run, repo), { files: [], skipped: [], text: '' })
  write(repo, 'AGENTS.md', '   \n')
  write(repo, '.cursorrules', 'bin\0ary')
  write(repo, '.windsurfrules', 'x'.repeat(250_000))
  assert.deepEqual((await loadProjectRules(run, repo)).files, [])
})

test('instructions typed into the project come first, then the rules; only a project chat on Eaon’s own loop gets them', async () => {
  const repo = project('turn')
  write(repo, 'AGENTS.md', 'Run tests with pnpm.')
  const base = { cwd: repo, projectInstructions: 'Be brief.' }
  const given = await withProjectRules(run, base)
  assert.ok(given.startsWith("Be brief.\n\nThe project's own rules files"))
  assert.ok(given.includes('From AGENTS.md:\nRun tests with pnpm.'))
  assert.equal(await withProjectRules(run, { ...base, engine: 'codex' }), 'Be brief.', 'Codex reads AGENTS.md itself')
  assert.equal(await withProjectRules(run, { ...base, cwd: null }), 'Be brief.', 'an ordinary chat has no project')
  assert.equal(await withProjectRules(run, { ...base, rawSystem: 'x' }), 'Be brief.')
  assert.equal(await withProjectRules(run, { ...base, workerId: 'w' }), 'Be brief.')
  assert.equal(await withProjectRules(run, { cwd: path.join(tmp, 'missing-folder'), projectInstructions: 'Hi.' }), 'Hi.', 'a folder that is gone is no reason to fail')
})
