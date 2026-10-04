import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diffOps, fileDiff, parseUnified, toUnified } from '../cli/src/coding/diff'
import { replaceIn } from '../cli/src/coding/replace'
import { highlightLine, languageOf } from '../cli/src/tui/highlight'
import { globToRegExp } from '../cli/src/coding/tools'
import { diagnose, lspStatus, stopLanguageServers } from '../cli/src/coding/lsp'

/**
 * The CLI's coding layer: line diffs, opencode's edit matchers, the
 * highlighter, globs, instruction files and git snapshots.
 */

process.env.EAON_CLI_HOME = mkdtempSync(join(tmpdir(), 'eaon-cli-coding-'))

const apply = (a: string[], ops: ReturnType<typeof diffOps>): string[] => ops.filter((o) => o.kind !== '-').map((o) => o.text)

test('diff: the script turns old into new, and keeps unchanged lines', () => {
  const cases: [string[], string[]][] = [
    [[], ['a']],
    [['a'], []],
    [['a', 'b', 'c'], ['a', 'x', 'c']],
    [['a', 'b', 'c', 'd', 'e'], ['b', 'c', 'e', 'f']],
    [['x', 'a', 'b', 'x', 'a'], ['a', 'b', 'x', 'a', 'b', 'x']]
  ]
  for (const [a, b] of cases) {
    const ops = diffOps(a, b)
    assert.deepEqual(apply(a, ops), b)
    assert.deepEqual(
      ops.filter((o) => o.kind !== '+').map((o) => o.text),
      a
    )
  }
  // Random edits stay correct and minimal enough.
  let seed = 7
  const rand = (): number => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  for (let round = 0; round < 50; round++) {
    const a = Array.from({ length: 40 }, (_, i) => `line ${Math.floor(rand() * 12)} ${i % 3}`)
    const b = a.filter(() => rand() > 0.2).map((l) => (rand() > 0.85 ? `${l} changed` : l))
    const ops = diffOps(a, b)
    assert.deepEqual(apply(a, ops), b)
  }
})

test('diff: hunks carry line numbers and counts, and round-trip through unified text', () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  const after = before.replace('line 10\n', 'line ten\n').replace('line 25\n', '')
  const diff = fileDiff('a.txt', before, after)
  assert.equal(diff.additions, 1)
  assert.equal(diff.deletions, 2)
  assert.equal(diff.hunks.length, 2)
  const first = diff.hunks[0]
  assert.equal(first.oldStart, 7)
  assert.equal(first.lines.find((l) => l.kind === 'del')?.oldNo, 10)
  assert.equal(first.lines.find((l) => l.kind === 'add')?.newNo, 10)
  const text = `diff --git a/a.txt b/a.txt\n${toUnified(diff)}`
  const parsed = parseUnified(text)[0]
  assert.equal(parsed.additions, 1)
  assert.equal(parsed.deletions, 2)
  assert.deepEqual(parsed.hunks.map((h) => h.oldStart), diff.hunks.map((h) => h.oldStart))
  assert.equal(fileDiff('new.ts', null, 'a\nb\n').status, 'added')
})

test('replace: exact first, then the forgiving matchers, and refusals', () => {
  const file = 'function a() {\n    return 1\n}\n\nfunction b() {\n    return 2\n}\n'
  assert.equal(replaceIn(file, '    return 1', '    return 10').strategy, 'exact')
  // Wrong indentation still finds the one place.
  const indented = replaceIn(file, 'function b() {\n  return 2\n}', 'function b() {\n    return 20\n}')
  assert.notEqual(indented.strategy, 'exact')
  assert.match(indented.content, /return 20/)
  assert.match(indented.content, /return 1\n/)
  // Ambiguous: two "return" lines.
  assert.throws(() => replaceIn('x = 1\nx = 1\n', 'x = 1', 'x = 2'), /more than one place/)
  assert.equal(replaceIn('x = 1\nx = 1\n', 'x = 1', 'x = 2', true).occurrences, 2)
  assert.throws(() => replaceIn(file, 'nothing like this', 'y'), /not found/)
  assert.throws(() => replaceIn(file, 'same', 'same'), /identical/)
  // Escaped newlines in old_text.
  assert.match(replaceIn('const s = "a\\nb"\n', 'const s = "a\\\\nb"', 'const s = "c"').content, /"c"/)
  // Found by ignoring indentation: the new text takes the file's indentation, not the model's.
  const avg = 'function avg(v) {\n  let t = 0\n  0\n}\n'
  assert.equal(replaceIn(avg, '0', 'return v.length ? t / v.length : 0').content, 'function avg(v) {\n  let t = 0\n  return v.length ? t / v.length : 0\n}\n')
  const deeper = 'if (x) {\n    call()\n    done()\n}\n'
  assert.equal(replaceIn(deeper, '  call()\n  done()', '  call()\n  if (y) {\n    more()\n  }\n  done()').content, 'if (x) {\n    call()\n    if (y) {\n      more()\n    }\n    done()\n}\n')
})

test('highlight: keywords, strings, comments and multi-line comments', () => {
  const tokens = highlightLine('const x = "hi" // note', 'ts')
  assert.equal(tokens[0].text, 'const')
  assert.ok(tokens.some((t) => t.text === '"hi"'))
  assert.ok(tokens[tokens.length - 1].text.startsWith('//'))
  const state = {}
  highlightLine('/* start', 'ts', state)
  const inside = highlightLine('still comment */ let y', 'ts', state)
  assert.ok(inside[0].text.startsWith('still'))
  assert.equal(languageOf('src/app/main.py'), 'py')
  assert.equal(languageOf('README'), 'plain')
})

test('glob: patterns with and without folders', () => {
  assert.ok(globToRegExp('*.ts').test('src/a/b.ts'))
  assert.ok(!globToRegExp('*.ts').test('src/a/b.tsx'))
  assert.ok(globToRegExp('src/**/*.{ts,tsx}').test('src/x/y/z.tsx'))
  assert.ok(globToRegExp('src/**/*.{ts,tsx}').test('src/z.ts'))
  assert.ok(!globToRegExp('src/**/*.ts').test('lib/z.ts'))
})

test('instructions: the nearest AGENTS.md up to the git root', async () => {
  const { loadInstructions } = await import('../cli/src/coding/instructions')
  const root = mkdtempSync(join(tmpdir(), 'eaon-inst-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  mkdirSync(join(root, 'pkg', 'sub'), { recursive: true })
  writeFileSync(join(root, 'AGENTS.md'), 'Use tabs.')
  writeFileSync(join(root, 'pkg', 'AGENTS.md'), 'Package rules.')
  const found = loadInstructions(join(root, 'pkg', 'sub'))
  assert.equal(found.files.filter((f) => f.endsWith('AGENTS.md') && f.startsWith(root)).length, 2)
  assert.match(found.text, /Package rules\.[\s\S]*Use tabs\./)
})

test('snapshots: a turn sees files changed by any means, and undo puts them back', async () => {
  const { Snapshots } = await import('../cli/src/coding/snapshot')
  const repo = mkdtempSync(join(tmpdir(), 'eaon-snap-'))
  const g = (...args: string[]): void => void execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  g('init', '-q')
  g('config', 'user.email', 't@t')
  g('config', 'user.name', 't')
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
  writeFileSync(join(repo, '.gitignore'), 'ignored.log\n')
  g('add', '.')
  g('commit', '-qm', 'init')
  const snaps = await Snapshots.for(repo)
  assert.ok(snaps)
  const before = await snaps!.track()
  assert.ok(before)
  writeFileSync(join(repo, 'a.txt'), 'one\nTWO\n')
  writeFileSync(join(repo, 'b.txt'), 'new file\n')
  writeFileSync(join(repo, 'ignored.log'), 'noise\n')
  const after = await snaps!.track()
  const changes = await snaps!.diff(before!, after!)
  assert.deepEqual(changes.map((c) => [c.path, c.status]).sort(), [
    ['a.txt', 'modified'],
    ['b.txt', 'added']
  ])
  assert.equal(changes.find((c) => c.path === 'a.txt')!.additions, 1)
  await snaps!.restore(before!, changes)
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'one\ntwo\n')
  assert.ok(!existsSync(join(repo, 'b.txt')))
  assert.ok(existsSync(join(repo, 'ignored.log')))
  // The project's own repository is untouched: still one commit, clean index.
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })
  assert.equal(status.trim(), '')
})

test('tools: the wrapped edit, write, grep and glob keep the app rules and record diffs', async () => {
  process.env.EAON_CLI_NO_LSP = '1'
  await import('../src/main/localTools')
  const { installCodingTools, toolMeta, previewChange } = await import('../cli/src/coding/tools')
  const { toolsFor } = await import('../src/main/agent/tools')
  const { store } = await import('../src/main/store')
  installCodingTools()
  installCodingTools() // twice is harmless
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-tools-'))
  writeFileSync(join(cwd, 'app.ts'), 'export function f() {\n    return 1\n}\n')
  writeFileSync(join(cwd, 'win.txt'), 'one\r\ntwo\r\n')
  const settings = store.getSettings()
  const request = { chatId: 'c', messageId: 'm', providerId: '', modelId: '', effort: 'medium' as const, mode: 'work' as const, history: [], summary: null, projectInstructions: '', cwd, work: { swarm: false, plan: false }, goal: null }
  const tools = toolsFor({ mode: 'work', cwd, depth: 0, readOnly: false, settings, request })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  assert.ok(tool('glob'), 'glob is offered')
  assert.equal(tool('edit_file').mutating, true)
  let n = 0
  const ctx = () => ({ request, turn: { notes: [] }, cwd, signal: new AbortController().signal, emit: () => {}, toolId: `t${++n}`, depth: 0, readOnly: false, settings, progress: () => {}, confirm: async () => true })

  // Wrong indentation still lands, and the diff is recorded.
  const c1 = ctx()
  const out = String(await tool('edit_file').run({ path: 'app.ts', old_text: 'export function f() {\n  return 1\n}', new_text: 'export function f() {\n    return 2\n}' }, c1))
  assert.match(out, /\+1 -1/)
  assert.match(readFileSync(join(cwd, 'app.ts'), 'utf8'), /return 2/)
  const meta = toolMeta.get(c1.toolId)!
  assert.equal(meta.diff?.additions, 1)
  assert.ok(meta.strategy)
  assert.equal(meta.before, 'export function f() {\n    return 1\n}\n')

  // CRLF files keep CRLF.
  await tool('edit_file').run({ path: 'win.txt', old_text: 'two', new_text: 'TWO' }, ctx())
  assert.equal(readFileSync(join(cwd, 'win.txt'), 'utf8'), 'one\r\nTWO\r\n')

  // An empty old_text creates a file; a missing file otherwise says so.
  await tool('edit_file').run({ path: 'src/new.ts', old_text: '', new_text: 'export const x = 1\n' }, ctx())
  assert.ok(existsSync(join(cwd, 'src/new.ts')))
  await assert.rejects(() => Promise.resolve(tool('edit_file').run({ path: 'missing.ts', old_text: 'a', new_text: 'b' }, ctx())), /does not exist/)

  // The approval preview shows the diff without writing.
  const preview = previewChange('edit_file', { path: 'app.ts', old_text: 'return 2', new_text: 'return 3' }, cwd)
  assert.equal(preview?.diff?.additions, 1)
  assert.match(readFileSync(join(cwd, 'app.ts'), 'utf8'), /return 2/)

  // write_file over an existing file reports the diff.
  const c2 = ctx()
  await tool('write_file').run({ path: 'app.ts', content: 'export const f = () => 3\n' }, c2)
  assert.equal(toolMeta.get(c2.toolId)?.diff?.status, 'modified')

  // Search.
  const c3 = ctx()
  const found = String(await tool('grep').run({ pattern: 'export const' }, c3))
  assert.match(found, /app\.ts/)
  assert.ok((toolMeta.get(c3.toolId)?.count ?? 0) >= 2)
  const globbed = String(await tool('glob').run({ pattern: '**/*.ts' }, ctx()))
  assert.match(globbed, /src\/new\.ts/)

  // The app's safety rules still hold: credentials are off limits.
  await assert.rejects(() => Promise.resolve(tool('read_file').run({ path: '~/.ssh/id_rsa' }, ctx())), /credentials/)
})

// Real language servers: npm-installs them into a temp profile, so it only runs when asked.
const LSP_TEST = process.env.EAON_CLI_LSP_TEST === '1'

test('lsp: TypeScript reports the error an edit made, natively (7+) and through tsserver (≤6)', { skip: !LSP_TEST && 'set EAON_CLI_LSP_TEST=1 (downloads language servers)', timeout: 300_000 }, async () => {
  const bad = 'export function f(): number {\n  return "x"\n}\n'
  const good = 'export function f(): number {\n  return 1\n}\n'
  // diagnose() gives up on a server still starting (null) and lets it carry on: ask until it answers.
  const ask = async (path: string, text: string, root: string) => {
    for (const started = Date.now(); Date.now() - started < 240_000; ) {
      const found = await diagnose(path, text, root)
      if (found) return found
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error(`no diagnostics: ${JSON.stringify(lspStatus())}`)
  }
  delete process.env.EAON_CLI_NO_LSP
  try {
    // No compiler in the project: the profile's own TypeScript, whose language server is built in.
    const native = mkdtempSync(join(tmpdir(), 'eaon-lsp-native-'))
    writeFileSync(join(native, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}\n')
    writeFileSync(join(native, 'a.ts'), bad)
    const errors = await ask(join(native, 'a.ts'), bad, native)
    assert.ok(errors.some((d) => /not assignable/.test(d.message)), JSON.stringify(errors))
    assert.deepEqual(await diagnose(join(native, 'a.ts'), good, native), [])

    // The project's TypeScript 5 (this repo's), through typescript-language-server and its tsserver.
    const older = mkdtempSync(join(tmpdir(), 'eaon-lsp-tsserver-'))
    mkdirSync(join(older, 'node_modules'))
    symlinkSync(join(process.cwd(), 'node_modules', 'typescript'), join(older, 'node_modules', 'typescript'))
    writeFileSync(join(older, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}\n')
    writeFileSync(join(older, 'b.ts'), bad)
    const viaTsserver = await ask(join(older, 'b.ts'), bad, older)
    assert.ok(viaTsserver.some((d) => /not assignable/.test(d.message)), JSON.stringify(viaTsserver))
  } finally {
    stopLanguageServers()
  }
})
