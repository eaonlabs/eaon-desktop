import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Settings, StreamRequest } from '@shared/types'
import { store } from '../src/main/store'
import { guidanceFor, toolsFor, type ToolContext, type ToolResult } from '../src/main/agent/tools'
import {
  createSkill,
  discoverSkills,
  installSkillFromGithub,
  invalidateSkillCache,
  parseGithubUrl,
  parseSkillFile
} from '../src/main/features/skills'

// Every skill folder is resolved from $HOME at call time; point it somewhere
// disposable so the real ~/.claude/skills never leaks into these tests.
const home = mkdtempSync(join(tmpdir(), 'eaon-skills-home-'))
const project = mkdtempSync(join(tmpdir(), 'eaon-skills-project-'))
process.env.HOME = home

function skill(root: string, folder: string, frontmatter: string, body = 'Do the thing.', extra: Record<string, string> = {}): void {
  const dir = join(root, folder)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`)
  for (const [rel, text] of Object.entries(extra)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
}

const query = (settings: Settings, mode: 'work' | 'chat' = 'work') => ({
  mode,
  cwd: project,
  depth: 0,
  readOnly: false,
  settings,
  request: {} as StreamRequest
})

before(() => {
  const eaon = join(home, '.eaon', 'skills')
  const claude = join(home, '.claude', 'skills')
  skill(eaon, 'alpha', 'name: alpha\ndescription: >\n  Folded description\n  across two lines', '# Alpha\n\nStep one.', {
    'scripts/run.py': 'print(1)',
    'reference.md': 'ref'
  })
  skill(claude, 'beta', 'name: beta\ndescription: "Quoted: with a colon"')
  // Same name in a lower-precedence folder: the ~/.eaon one wins.
  skill(claude, 'alpha-copy', 'name: alpha\ndescription: should be shadowed')
  // Folders of symlinks are common in ~/.claude/skills.
  skill(join(home, 'elsewhere'), 'linked', 'name: linked\ndescription: reached through a symlink')
  symlinkSync(join(home, 'elsewhere', 'linked'), join(claude, 'linked'))
  mkdirSync(join(claude, 'not-a-skill'), { recursive: true })
  // Project skills beat personal ones.
  skill(join(project, '.claude', 'skills'), 'beta', 'name: beta\ndescription: the project beta')
  skill(join(project, '.eaon', 'skills'), 'gamma', "name: gamma\ndescription: 'It''s the project one'")
  invalidateSkillCache()
})

test('frontmatter: folded, quoted and plain values; body without the header', () => {
  const { meta, body } = parseSkillFile('---\nname: x\ndescription: |\n  line one\n  line two\nother: "a \\"b\\""\n---\n\nBody here\n')
  assert.equal(meta.name, 'x')
  assert.equal(meta.description, 'line one\nline two')
  assert.equal(meta.other, 'a "b"')
  assert.equal(body, '\nBody here\n')
  assert.deepEqual(parseSkillFile('no frontmatter').meta, {})
})

test('discovery reads all four folders, follows symlinks and applies precedence', () => {
  const skills = discoverSkills(project)
  const byName = Object.fromEntries(skills.map((s) => [s.name, s]))
  assert.deepEqual(Object.keys(byName).sort(), ['alpha', 'beta', 'gamma', 'linked'])
  assert.equal(byName.alpha.source, 'eaon')
  assert.equal(byName.alpha.description, 'Folded description across two lines')
  assert.equal(byName.beta.source, 'project-claude')
  assert.equal(byName.beta.description, 'the project beta')
  assert.equal(byName.gamma.source, 'project-eaon')
  assert.equal(byName.gamma.description, "It's the project one")
  assert.equal(byName.linked.source, 'claude')
  assert.equal(byName.alpha.removable, true)
  assert.equal(byName.linked.removable, false)
  // Without a Work folder only the personal ones remain, and beta falls back.
  const personal = discoverSkills(null)
  assert.equal(personal.find((s) => s.name === 'beta')?.description, 'Quoted: with a colon')
  assert.ok(!personal.some((s) => s.name === 'gamma'))
})

test('Work mode gets load_skill and a one-line-per-skill listing; Chat gets neither', () => {
  const settings = { ...store.getSettings(), disabledSkills: ['gamma'] }
  assert.ok(toolsFor(query(settings)).some((t) => t.name === 'load_skill'))
  assert.ok(!toolsFor(query(settings, 'chat')).some((t) => t.name === 'load_skill'))

  const text = guidanceFor(query(settings)).find((g) => g.includes('load_skill'))!
  assert.match(text, /- alpha: Folded description across two lines/)
  assert.match(text, /- beta: the project beta/)
  assert.ok(!text.includes('gamma'), 'disabled skills are not offered')
  // Bodies are not in the prompt — that is the point.
  assert.ok(!text.includes('Step one'))
})

test('the listing is capped so a big library stays cheap', () => {
  for (let i = 0; i < 45; i++) skill(join(home, '.eaon', 'skills'), `bulk-${String(i).padStart(2, '0')}`, `name: bulk-${String(i).padStart(2, '0')}\ndescription: bulk skill ${i}`)
  invalidateSkillCache()
  const text = guidanceFor(query({ ...store.getSettings(), disabledSkills: [] })).find((g) => g.includes('load_skill'))!
  assert.equal(text.split('\n').filter((l) => l.startsWith('- ')).length, 40)
  assert.match(text, /\(9 more/)
})

test('load_skill returns the body and the other files, and refuses disabled or unknown skills', async () => {
  const settings = { ...store.getSettings(), disabledSkills: ['beta'] }
  const tool = toolsFor(query(settings)).find((t) => t.name === 'load_skill')!
  const ctx = { cwd: project, settings } as unknown as ToolContext
  const loaded = (await tool.run({ name: 'Alpha' }, ctx)) as string
  assert.match(loaded, /^# Skill: alpha/)
  assert.match(loaded, /# Alpha\n\nStep one\./)
  assert.ok(!loaded.includes('description: >'), 'frontmatter is stripped')
  assert.match(loaded, /- reference\.md/)
  assert.match(loaded, /- scripts\/run\.py/)
  assert.ok(!/- SKILL\.md/.test(loaded))

  const disabled = (await tool.run({ name: 'beta' }, ctx)) as ToolResult
  assert.equal(disabled.isError, true)
  const unknown = (await tool.run({ name: 'nope' }, ctx)) as ToolResult
  assert.equal(unknown.isError, true)
  assert.match(unknown.text, /Available: .*alpha/)
})

test('creating a skill writes a SKILL.md that reads back', () => {
  const created = createSkill({ name: 'Release Notes', description: 'Use when: writing release notes', body: 'Summarise merged PRs.' })
  assert.equal(created.name, 'release-notes')
  assert.equal(created.description, 'Use when: writing release notes')
  assert.equal(created.source, 'eaon')
  assert.match(readFileSync(created.path, 'utf8'), /Summarise merged PRs\./)
  assert.throws(() => createSkill({ name: 'Release Notes', description: 'again', body: '' }), /already exists/)
  assert.throws(() => createSkill({ name: 'x', description: '  ', body: '' }), /Describe/)
})

test('GitHub links: folders, SKILL.md files and repo roots', () => {
  const tree = parseGithubUrl('https://github.com/anthropics/skills/tree/main/skills/pdf')
  assert.equal(tree.owner, 'anthropics')
  assert.equal(tree.repo, 'skills')
  assert.deepEqual(tree.candidates[0], { ref: 'main', path: 'skills/pdf' })
  // A branch with a slash in it is tried as well.
  assert.deepEqual(tree.candidates[1], { ref: 'main/skills', path: 'pdf' })
  const blob = parseGithubUrl('https://github.com/a/b/blob/dev/x/SKILL.md')
  assert.deepEqual(blob.candidates[0], { ref: 'dev', path: 'x' })
  assert.deepEqual(parseGithubUrl('https://github.com/a/b.git').candidates, [{ ref: null, path: '' }])
  assert.throws(() => parseGithubUrl('https://gitlab.com/a/b'), /github\.com/)
})

test('installs a real skill from GitHub', { timeout: 60_000 }, async (t) => {
  if (process.env.EAON_OFFLINE) return t.skip('offline')
  let skill
  try {
    skill = await installSkillFromGithub('https://github.com/anthropics/skills/tree/main/skills/internal-comms')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Anonymous GitHub API calls are limited to 60 an hour per address.
    if (/hourly limit|fetch failed|ENOTFOUND/i.test(message)) return t.skip(message)
    throw error
  }
  assert.equal(skill.name, 'internal-comms')
  assert.equal(skill.source, 'eaon')
  assert.ok(skill.description.length > 10)
  assert.ok(existsSync(join(skill.dir, 'LICENSE.txt')))
  assert.ok(existsSync(join(skill.dir, 'examples')), 'subfolders come along')
  // A folder that holds several skills says so instead of installing nothing useful.
  await assert.rejects(installSkillFromGithub('https://github.com/anthropics/skills/tree/main/skills'), /paste the link to one of them/)
})
