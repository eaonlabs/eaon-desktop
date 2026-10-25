import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeTargets, packageRunner, packageScripts, parseBranches, parseGrep, scriptIcon } from '../src/shared/chatCode'
import { parseFileRef } from '../src/renderer/src/components/agent/FileRef'
import { splitPairs } from '../src/renderer/src/components/chatCode/diff/model'
import { findTrigger } from '../src/renderer/src/components/composer/suggest'
import type { ReviewLine } from '../src/shared/adeReview'

/** Chat's coding controls: what main reads from git, scripts and paths, and the review's side-by-side rows. */

test('git grep output becomes matches, and the cap says there are more', () => {
  const out = 'src/a.ts\x003\x00const a = 1\nsrc/b.ts\x0010\x00  return a: b\n'
  assert.deepEqual(parseGrep(out).matches, [
    { path: 'src/a.ts', line: 3, text: 'const a = 1' },
    { path: 'src/b.ts', line: 10, text: '  return a: b' }
  ])
  assert.equal(parseGrep(out, 1).truncated, true)
  assert.equal(parseGrep('').matches.length, 0)
})

test('branches: local first by date, origin-only ones marked, origin/HEAD left out', () => {
  const local = 'main\t200\nfeature/x\t300\n'
  const remote = 'origin/HEAD\t300\norigin/main\t200\norigin/fix\t250\norigin\t1\n'
  assert.deepEqual(parseBranches(local, remote), [
    { name: 'feature/x', at: 300_000 },
    { name: 'fix', at: 250_000, remoteOnly: true },
    { name: 'main', at: 200_000 }
  ])
})

test('scripts come from package.json with the project’s own runner, and from Makefile targets', () => {
  assert.equal(packageRunner(['package.json', 'pnpm-lock.yaml']), 'pnpm')
  assert.equal(packageRunner(['bun.lock']), 'bun')
  assert.equal(packageRunner(['package.json']), 'npm')
  const json = JSON.stringify({ scripts: { dev: 'vite', test: 'vitest', pretest: 'x', prepare: 'husky' } })
  assert.deepEqual(
    packageScripts(json, 'npm').map((s) => s.command),
    ['npm run dev', 'npm run test', 'npm run prepare']
  )
  assert.deepEqual(packageScripts(json, 'yarn')[0], { name: 'dev', command: 'yarn dev', icon: 'play' })
  assert.deepEqual(packageScripts('not json', 'npm'), [])
  assert.deepEqual(
    makeTargets('.PHONY: all\nbuild: deps\n\tgo build\nX := 1\ntest:\n').map((s) => s.command),
    ['make build', 'make test']
  )
  assert.equal(scriptIcon('e2e'), 'test')
  assert.equal(scriptIcon('typecheck'), 'lint')
})

test('a path in a reply is a file; a method call or a version is not', () => {
  assert.deepEqual(parseFileRef('src/app.ts:42'), { path: 'src/app.ts', line: 42 })
  assert.deepEqual(parseFileRef('src/app.ts:42:7'), { path: 'src/app.ts', line: 42 })
  assert.deepEqual(parseFileRef('lib/x.py#L12-L20'), { path: 'lib/x.py', line: 12 })
  assert.deepEqual(parseFileRef('package.json'), { path: 'package.json', line: null })
  assert.deepEqual(parseFileRef('./scripts/run.sh'), { path: './scripts/run.sh', line: null })
  assert.deepEqual(parseFileRef('logs/out.log'), { path: 'logs/out.log', line: null })
  assert.deepEqual(parseFileRef('Makefile'), { path: 'Makefile', line: null })
  for (const not of ['console.log', 'process.env', 'v1.2', 'e.g', 'npm run dev', 'https://x.dev/a.ts', 'a.b', '/', 'foo.bar()']) {
    assert.equal(parseFileRef(not), null, not)
  }
})

test('side by side: changed lines pair up, the longer side leaves blanks', () => {
  const l = (kind: ReviewLine['kind'], old: number | null, cur: number | null): ReviewLine => ({ kind, old, cur, text: `${kind}${old ?? ''}${cur ?? ''}` })
  const ctx = l('ctx', 1, 1)
  const d1 = l('del', 2, null)
  const d2 = l('del', 3, null)
  const a1 = l('add', null, 2)
  const a2 = l('add', null, 4)
  const tail = l('ctx', 4, 5)
  const a3 = l('add', null, 3)
  assert.deepEqual(splitPairs([ctx, d1, d2, a1, tail]), [
    { left: ctx, right: ctx },
    { left: d1, right: a1 },
    { left: d2, right: null },
    { left: tail, right: tail }
  ])
  assert.deepEqual(splitPairs([a3, a2]), [
    { left: null, right: a3 },
    { left: null, right: a2 }
  ])
})

test('"@" takes a project path; "/" still doesn’t', () => {
  assert.deepEqual(findTrigger('see @src/app', 12), { char: '@', query: 'src/app', start: 4, end: 12 })
  assert.equal(findTrigger('/usr/bin', 8), null)
  assert.equal(findTrigger('@a@b', 4), null)
})
