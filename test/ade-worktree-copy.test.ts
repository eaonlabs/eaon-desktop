import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  COPY_MAX_FILES,
  DEFAULT_COPY_PATTERNS,
  cleanCopySettings,
  copiedSummary,
  parsePatterns,
  patternMatches,
  planCopy
} from '../src/shared/worktreeCopy'
import { copyIgnored, ignoredFiles, previewCopy } from '../src/main/features/ade/worktreeCopy'

/**
 * Copying .env and other ignored files into a new worktree: which names a
 * pattern means, what is refused whatever the pattern says (dependency
 * folders, big files, symlinks), and the copy itself against a real
 * repository: only ignored files, nothing overwritten, nothing tracked.
 */

test('a pattern with no slash names a file or folder of that name at any depth', () => {
  assert.equal(patternMatches('.env', '.env'), true)
  assert.equal(patternMatches('.env', 'apps/web/.env'), true)
  assert.equal(patternMatches('.env', '.env.local'), false)
  assert.equal(patternMatches('.env.*', '.env.local'), true)
  assert.equal(patternMatches('.env.*', 'apps/api/.env.production'), true)
  assert.equal(patternMatches('.env*', '.environment'), true)
  assert.equal(patternMatches('*.pem', 'certs/dev.pem'), true)
  assert.equal(patternMatches('?.key', 'a.key'), true)
  assert.equal(patternMatches('?.key', 'ab.key'), false)
})

test('a pattern with a slash starts at the project root, and ** crosses folders', () => {
  assert.equal(patternMatches('config/local.json', 'config/local.json'), true)
  assert.equal(patternMatches('config/local.json', 'app/config/local.json'), false)
  assert.equal(patternMatches('config/*.json', 'config/a.json'), true)
  assert.equal(patternMatches('config/*.json', 'config/deep/a.json'), false)
  assert.equal(patternMatches('config/**/*.json', 'config/deep/er/a.json'), true)
  assert.equal(patternMatches('**/secrets.yml', 'a/b/secrets.yml'), true)
  assert.equal(patternMatches('/.env', '.env'), true)
  assert.equal(patternMatches('/.env', 'app/.env'), false)
})

test('a folder name, with or without a trailing slash, takes everything in it', () => {
  assert.equal(patternMatches('secrets/', 'secrets/key.json'), true)
  assert.equal(patternMatches('secrets/', 'app/secrets/key.json'), true)
  assert.equal(patternMatches('secrets', 'app/secrets/deep/key.json'), true)
  assert.equal(patternMatches('config/private/', 'config/private/a/b.txt'), true)
  assert.equal(patternMatches('config/private/', 'other/config/private/a.txt'), false)
  assert.equal(patternMatches('', 'a'), false)
})

test('a settings box becomes patterns: blank lines, comments and negations are dropped', () => {
  assert.deepEqual(parsePatterns('.env\n\n  # keys\n.env.*  \n!.env.example\nsecrets/\n'), ['.env', '.env.*', 'secrets/'])
})

test('the plan drops dependency folders, big files and anything past the limits, and says why', () => {
  const small = (p: string, size = 10) => ({ path: p, size })
  const plan = planCopy(
    [small('.env'), small('node_modules/x/.env'), small('packages/a/node_modules/.env'), small('.env.big', 2_000_000), small('notes.txt'), small('apps/.env')],
    ['.env', '.env.*']
  )
  assert.deepEqual(
    plan.copy.map((c) => c.path),
    ['.env', 'apps/.env']
  )
  assert.deepEqual(
    plan.skipped.map((s) => [s.path, s.reason]),
    [
      ['.env.big', 'over 1 MB'],
      ['node_modules/x/.env', 'in a dependency or build folder'],
      ['packages/a/node_modules/.env', 'in a dependency or build folder']
    ]
  )
  // Files no pattern names are not mentioned at all.
  assert.ok(!plan.skipped.some((s) => s.path === 'notes.txt'))

  const many = Array.from({ length: COPY_MAX_FILES + 5 }, (_, i) => small(`d${String(i).padStart(3, '0')}/.env`))
  const capped = planCopy(many, ['.env'])
  assert.equal(capped.copy.length, COPY_MAX_FILES)
  assert.equal(capped.skipped.length, 5)
  assert.match(capped.skipped[0].reason, /more than 100 files/)

  // The total counts too: six 2 MB files are 12 MB, past 10.
  const heavy = planCopy(
    Array.from({ length: 6 }, (_, i) => small(`h${i}/.env`, 900_000)),
    ['.env']
  )
  assert.equal(heavy.copy.length, 6)
  const bigger = planCopy(
    Array.from({ length: 12 }, (_, i) => small(`h${String(i).padStart(2, '0')}/.env`, 900_000)),
    ['.env']
  )
  assert.equal(bigger.copy.length, 11)
  assert.equal(bigger.skipped[0].reason, 'over 10 MB in all')
})

test('settings read back from a file are made current, and the defaults are .env files only', () => {
  assert.deepEqual(cleanCopySettings(null), { enabled: false, patterns: DEFAULT_COPY_PATTERNS })
  assert.deepEqual(cleanCopySettings({ enabled: true, patterns: [' .env ', '', 3, 'secrets/'] }), { enabled: true, patterns: ['.env', 'secrets/'] })
  assert.deepEqual(cleanCopySettings({ enabled: 'yes', patterns: 'no' }), { enabled: false, patterns: DEFAULT_COPY_PATTERNS })
  assert.equal(copiedSummary(['.env']), '.env')
  assert.equal(copiedSummary(['a', 'b', 'c', 'd', 'e', 'f']), 'a, b, c, d and 2 more')
  assert.equal(copiedSummary([]), '')
})

let tmp = ''
let repo = ''
let tree = ''
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ade-copy-')))
  repo = path.join(tmp, 'app')
  tree = path.join(tmp, 'worktree')
  fs.mkdirSync(path.join(repo, 'apps', 'web'), { recursive: true })
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test'
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com'
  git(repo, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n.env.*\n!.env.example\nnode_modules/\nsecrets/\n*.log\n')
  fs.writeFileSync(path.join(repo, '.env.example'), 'KEY=\n')
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'first')
  // Ignored files, the kind a worktree lacks.
  fs.writeFileSync(path.join(repo, '.env'), 'KEY=secret\n', { mode: 0o600 })
  fs.writeFileSync(path.join(repo, '.env.local'), 'LOCAL=1\n')
  fs.writeFileSync(path.join(repo, 'apps', 'web', '.env'), 'WEB=1\n')
  fs.writeFileSync(path.join(repo, '.env.big'), 'x'.repeat(1_100_000))
  fs.mkdirSync(path.join(repo, 'secrets', 'nested'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'secrets', 'key.json'), '{"k":1}\n')
  fs.writeFileSync(path.join(repo, 'secrets', 'nested', 'b.txt'), 'b\n')
  fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'node_modules', 'pkg', '.env'), 'NO=1\n')
  fs.writeFileSync(path.join(repo, 'debug.log'), 'noise\n')
  fs.symlinkSync('/etc/hosts', path.join(repo, '.env.link'))
  git(repo, 'worktree', 'add', '-q', '-b', 'feature/x', tree)
})

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('the ignored files git lists are plain files with sizes; tracked files and dependency folders are not among them', async () => {
  const files = (await ignoredFiles(repo)).map((f) => f.path).sort()
  assert.ok(files.includes('.env') && files.includes('.env.local') && files.includes('apps/web/.env'))
  assert.ok(files.includes('secrets/key.json') && files.includes('secrets/nested/b.txt'))
  // Tracked, though a pattern would name it.
  assert.ok(!files.includes('.env.example'))
  // A symlink is not a file to copy.
  assert.ok(!files.includes('.env.link'))
  assert.ok(!files.some((f) => f.startsWith('node_modules')))
})

test('a preview says what would be copied and what was refused, and copies nothing', async () => {
  const plan = await previewCopy(repo, ['.env', '.env.*', 'secrets/'])
  assert.deepEqual(
    plan.copy.map((c) => c.path),
    ['.env', '.env.local', 'apps/web/.env', 'secrets/key.json', 'secrets/nested/b.txt']
  )
  assert.deepEqual(plan.skipped, [{ path: '.env.big', reason: 'over 1 MB' }])
  assert.equal(fs.existsSync(path.join(tree, '.env')), false)
})

test('the copy puts the named ignored files in the worktree, keeps their mode, and reports them', async () => {
  const report = await copyIgnored(repo, tree, ['.env', '.env.*', 'secrets/'])
  assert.deepEqual(report.copied, ['.env', '.env.local', 'apps/web/.env', 'secrets/key.json', 'secrets/nested/b.txt'])
  assert.deepEqual(report.skipped, [{ path: '.env.big', reason: 'over 1 MB' }])
  assert.equal(fs.readFileSync(path.join(tree, '.env'), 'utf8'), 'KEY=secret\n')
  assert.equal(fs.readFileSync(path.join(tree, 'apps', 'web', '.env'), 'utf8'), 'WEB=1\n')
  assert.equal(fs.readFileSync(path.join(tree, 'secrets', 'nested', 'b.txt'), 'utf8'), 'b\n')
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(tree, '.env')).mode & 0o777, 0o600)
  // Left behind: the dependency folder, the log, the symlink, the big file.
  assert.equal(fs.existsSync(path.join(tree, 'node_modules')), false)
  assert.equal(fs.existsSync(path.join(tree, 'debug.log')), false)
  assert.equal(fs.existsSync(path.join(tree, '.env.link')), false)
  assert.equal(fs.existsSync(path.join(tree, '.env.big')), false)
  // The project folder is as it was.
  assert.equal(fs.readFileSync(path.join(repo, '.env'), 'utf8'), 'KEY=secret\n')
  // What was copied is ignored there too: it does not show up as changes.
  assert.equal(git(tree, 'status', '--porcelain'), '')
})

test('a second copy never writes over a file that is there', async () => {
  fs.writeFileSync(path.join(tree, '.env'), 'KEY=mine\n')
  const report = await copyIgnored(repo, tree, ['.env'])
  assert.deepEqual(report.copied, [])
  assert.ok(report.skipped.some((s) => s.path === '.env' && s.reason === 'already in the worktree'))
  assert.equal(fs.readFileSync(path.join(tree, '.env'), 'utf8'), 'KEY=mine\n')
})

test('patterns that name nothing copy nothing', async () => {
  const report = await copyIgnored(repo, tree, ['no-such-file.cfg'])
  assert.deepEqual(report, { copied: [], skipped: [] })
})
