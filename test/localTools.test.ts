import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/localTools'
import { buildIndex } from '../src/main/codeIndex'
import { toolsFor, type ToolContext } from '../src/main/agent/tools'
import { store } from '../src/main/store'
import type { StreamRequest } from '@shared/types'

function tools(cwd: string) {
  const settings = store.getSettings()
  const request = { mode: 'work', work: { swarm: false, plan: false }, goal: null } as unknown as StreamRequest
  const list = toolsFor({ mode: 'work', cwd, depth: 0, readOnly: false, settings, request })
  const controller = new AbortController()
  const ctx = { cwd, settings, signal: controller.signal, progress: () => {} } as unknown as ToolContext
  return { get: (name: string) => list.find((t) => t.name === name)!, ctx, controller }
}

test('edit_file tolerates line-number prefixes copied from read_file', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-edit-'))
  writeFileSync(join(cwd, 'a.py'), 'def f():\n    return 1\n')
  const { get, ctx } = tools(cwd)
  const out = await get('edit_file').run({ path: 'a.py', old_text: '1\tdef f():\n2\t    return 1', new_text: '1\tdef f():\n2\t    return 2' }, ctx)
  assert.match(String(out), /Edited a.py/)
  assert.equal(readFileSync(join(cwd, 'a.py'), 'utf8'), 'def f():\n    return 2\n')
})

test('edit_file still refuses ambiguous and missing snippets', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-edit-'))
  writeFileSync(join(cwd, 'b.txt'), 'x\nx\n')
  const { get, ctx } = tools(cwd)
  await assert.rejects(get('edit_file').run({ path: 'b.txt', old_text: 'x', new_text: 'y' }, ctx), /appears 2 times/)
  await assert.rejects(get('edit_file').run({ path: 'b.txt', old_text: 'nope', new_text: 'y' }, ctx), /not found/)
  const all = await get('edit_file').run({ path: 'b.txt', old_text: 'x', new_text: 'y', replace_all: true }, ctx)
  assert.match(String(all), /2 places/)
})

test('credential folders are off limits and paths outside home are refused', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-edit-'))
  const { get, ctx } = tools(cwd)
  await assert.rejects(get('read_file').run({ path: '~/.ssh/id_rsa' }, ctx), /credentials/)
  await assert.rejects(get('read_file').run({ path: '/etc/passwd' }, ctx), /outside your home folder/)
})

test('run_command gives commands no stdin, so one that reads input ends instead of hanging', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-cmd-'))
  const { get, ctx } = tools(cwd)
  const started = Date.now()
  const out = String(await get('run_command').run({ command: 'read x; echo "got:[$x]"', timeout_seconds: 20 }, ctx))
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`)
  assert.match(out, /got:\[\]/)
})

test('run_command keeps a character split across two writes intact', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-cmd-'))
  const { get, ctx } = tools(cwd)
  const out = String(await get('run_command').run({ command: "printf '\\342\\234'; sleep 0.2; printf '\\223 ok\\n'" }, ctx))
  assert.match(out, /✓ ok/)
})

test('run_command keeps the start of a huge output and counts what it left out', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-cmd-'))
  const { get, ctx } = tools(cwd)
  // seq 1 200000 prints 1,288,895 characters.
  const out = String(await get('run_command').run({ command: 'seq 1 200000' }, ctx))
  assert.match(out, /^exit code 0\n1\n2\n3\n/)
  assert.match(out, /200000$/)
  const omitted = Number(out.match(/…\[([\d,]+) characters omitted\]…/)?.[1].replace(/,/g, ''))
  assert.ok(omitted > 1_250_000 && omitted < 1_288_895, `omitted ${omitted}`)
  assert.ok(out.length < 17_000)
})

test('run_command returns on Stop even when a detached process still holds its output open', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-cmd-'))
  const { get, ctx, controller } = tools(cwd)
  const started = Date.now()
  setTimeout(() => controller.abort(), 500)
  // The backgrounded perl leaves the process group (setsid) with stdout inherited.
  const out = String(await get('run_command').run({ command: "echo start; (perl -MPOSIX -e 'POSIX::setsid(); sleep 15' &); echo shell-done" }, ctx))
  assert.ok(Date.now() - started < 6000, `took ${Date.now() - started}ms`)
  assert.match(out, /shell-done/)
})

test('a background command in a missing folder is reported, not thrown past the tool', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-cmd-'))
  const { get, ctx } = tools(cwd)
  rmSync(cwd, { recursive: true })
  let uncaught: unknown = null
  const onUncaught = (error: unknown): void => {
    uncaught = error
  }
  process.on('uncaughtException', onUncaught)
  try {
    await assert.rejects(Promise.resolve(get('run_command').run({ command: 'echo hi', background: true }, ctx)), /does not exist/)
    await assert.rejects(Promise.resolve(get('run_command').run({ command: 'echo hi' }, ctx)), /does not exist/)
  } finally {
    process.off('uncaughtException', onUncaught)
  }
  assert.equal(uncaught, null)
})

test('edit_file matches a snippet sent with \\n line endings in a CRLF file, and keeps CRLF', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-edit-'))
  writeFileSync(join(cwd, 'w.cs'), 'class A {\r\n  int x = 1;\r\n  int y = 2;\r\n}\r\n')
  const { get, ctx } = tools(cwd)
  await get('edit_file').run({ path: 'w.cs', old_text: '  int x = 1;\n  int y = 2;', new_text: '  int x = 10;\n  int y = 20;' }, ctx)
  assert.equal(readFileSync(join(cwd, 'w.cs'), 'utf8'), 'class A {\r\n  int x = 10;\r\n  int y = 20;\r\n}\r\n')
  // A one-line snippet grown into several lines keeps the file's line endings too.
  await get('edit_file').run({ path: 'w.cs', old_text: '  int x = 10;', new_text: '  int x = 10;\n  int z = 30;' }, ctx)
  assert.equal(readFileSync(join(cwd, 'w.cs'), 'utf8'), 'class A {\r\n  int x = 10;\r\n  int z = 30;\r\n  int y = 20;\r\n}\r\n')
})

test('read_file treats zero or null line bounds as unset, and does not count the final newline as a line', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-read-'))
  writeFileSync(join(cwd, 'r.txt'), 'one\ntwo\nthree\n')
  const { get, ctx } = tools(cwd)
  const whole = String(await get('read_file').run({ path: 'r.txt', start_line: 0, end_line: 0 }, ctx))
  assert.equal(whole, '1\tone\n2\ttwo\n3\tthree')
  assert.equal(String(await get('read_file').run({ path: 'r.txt', start_line: null, end_line: null }, ctx)), whole)
  assert.equal(String(await get('read_file').run({ path: 'r.txt', start_line: 1, end_line: 2 }, ctx)), '1\tone\n2\ttwo\n…(1 more lines; read from 3 to continue)')
  assert.match(String(await get('read_file').run({ path: 'r.txt', start_line: 4 }, ctx)), /only 3 lines/)
})

test('grep and find_file see files the index does not: new ones, and non-code ones', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-grep-'))
  mkdirSync(join(cwd, 'src'))
  writeFileSync(join(cwd, 'src', 'a.ts'), 'export const indexed_symbol = 1\n')
  writeFileSync(join(cwd, 'Makefile'), 'build:\n\tneedle_in_makefile\n')
  mkdirSync(join(cwd, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(cwd, 'node_modules', 'dep', 'index.js'), 'needle_in_makefile\n')
  await buildIndex(cwd)
  writeFileSync(join(cwd, 'src', 'b.ts'), 'export const brand_new_symbol = 2\n')
  const { get, ctx } = tools(cwd)
  assert.match(String(await get('grep').run({ pattern: 'brand_new_symbol' }, ctx)), /src\/b\.ts:1:/)
  const make = String(await get('grep').run({ pattern: 'needle_in_makefile' }, ctx))
  assert.match(make, /^Makefile:2:/)
  assert.doesNotMatch(make, /node_modules/)
  assert.match(String(await get('find_file').run({ query: 'Makefile' }, ctx)), /^Makefile$/m)
  assert.match(String(await get('find_file').run({ query: 'b.ts' }, ctx)), /src\/b\.ts/)
})

test('grep include accepts globs as well as path fragments', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-grep-'))
  mkdirSync(join(cwd, 'src', 'ui'), { recursive: true })
  writeFileSync(join(cwd, 'src', 'ui', 'view.tsx'), 'const token = 1\n')
  writeFileSync(join(cwd, 'src', 'main.ts'), 'const token = 2\n')
  writeFileSync(join(cwd, 'notes.md'), 'token\n')
  const { get, ctx } = tools(cwd)
  const grep = async (include: string): Promise<string[]> =>
    String(await get('grep').run({ pattern: 'token', include }, ctx))
      .split('\n')
      .map((line) => line.split(':')[0])
      .sort()
  assert.deepEqual(await grep('*.ts'), ['src/main.ts'])
  assert.deepEqual(await grep('*.{ts,tsx}'), ['src/main.ts', 'src/ui/view.tsx'])
  assert.deepEqual(await grep('src/**/*.tsx'), ['src/ui/view.tsx'])
  assert.deepEqual(await grep('**/*.md'), ['notes.md'])
  assert.deepEqual(await grep('src/'), ['src/main.ts', 'src/ui/view.tsx'])
})

test('in auto-approve, run_command asks before writing outside the work folder', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-risky-'))
  const { get, ctx } = tools(cwd)
  const risky = (command: string): boolean => Boolean(get('run_command').risky?.({ command }, ctx))
  assert.equal(risky('echo hi > notes.txt'), false, 'inside the folder')
  assert.equal(risky('npm test 2>&1 | tee test.log'), false)
  assert.equal(risky('echo "alias ls=rm" >> ~/.zshrc'), true)
  assert.equal(risky('echo x > $HOME/.profile'), true)
  assert.equal(risky('mv ~/Documents ./docs'), true, 'moves the user\'s folder away')
  assert.equal(risky('echo x > /tmp/scratch.txt'), false, 'scratch space')
})
