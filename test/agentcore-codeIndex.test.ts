import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { app } from 'electron'
import { buildIndex, clearIndex, findSymbol, indexedPaths, listProjectFiles, setIndexStatusListener } from '../src/main/codeIndex'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import type { IndexStatus } from '@shared/types'

/**
 * The code index is read on every agent turn (whether the search tools are
 * offered) and by every search, so it is kept in memory between reads — these
 * check that the copy in memory never outlives a rebuild or a clear.
 */

test('a rebuild is seen at once by lookups, and unchanged files keep their chunks', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-index-'))
  writeFileSync(join(cwd, 'a.ts'), 'export function alphaThing() {\n  return 1\n}\n')
  writeFileSync(join(cwd, 'b.ts'), 'export function steadyThing() {\n  return 2\n}\n')
  await buildIndex(cwd)
  assert.equal(findSymbol(cwd, 'alphaThing').length, 1)

  writeFileSync(join(cwd, 'a.ts'), 'export function betaThing() {\n  return 3\n}\n')
  await buildIndex(cwd)
  assert.equal(findSymbol(cwd, 'alphaThing').length, 0, 'the old symbol is gone')
  assert.equal(findSymbol(cwd, 'betaThing').length, 1, 'the new one is found')
  const steady = findSymbol(cwd, 'steadyThing')
  assert.equal(steady.length, 1)
  assert.match(steady[0].text, /return 2/, 'an unchanged file keeps its chunk text')

  clearIndex(cwd)
  assert.deepEqual(indexedPaths(cwd), [])
})

const manifestOf = (cwd: string): string =>
  join(app.getPath('userData'), 'code-index', `${createHash('sha256').update(cwd).digest('hex').slice(0, 16)}.json`)

test('a rebuild reads only files whose size or mtime changed; a manifest from before mtimes were kept is read in full once', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-index-'))
  const file = join(cwd, 'a.ts')
  // A whole second, so setting it again below matches exactly (a Date drops the sub-millisecond part).
  const mtime = new Date('2026-01-01T00:00:00Z')
  writeFileSync(file, 'export function alphaThing() {\n  return 1\n}\n')
  utimesSync(file, mtime, mtime)
  // Binary despite its extension: read every time, never indexed.
  writeFileSync(join(cwd, 'blob.json'), 'a\u0000b')
  await buildIndex(cwd)
  const manifest = manifestOf(cwd)
  const written = statSync(manifest).mtimeMs
  await buildIndex(cwd)
  assert.equal(statSync(manifest).mtimeMs, written, 'nothing changed, so nothing was written')

  // Same size and mtime, different text: a rebuild that trusts the stat never sees it.
  writeFileSync(file, 'export function gammaThing() {\n  return 1\n}\n')
  utimesSync(file, mtime, mtime)
  await buildIndex(cwd)
  assert.equal(findSymbol(cwd, 'alphaThing').length, 1, 'the unchanged-looking file was not read again')

  // An older manifest has no mtimes, so every file is read once more…
  const strip = (): void => {
    const old = JSON.parse(readFileSync(manifest, 'utf8')) as { files: { mtimeMs?: number }[] }
    for (const entry of old.files) delete entry.mtimeMs
    writeFileSync(manifest, JSON.stringify(old))
  }
  strip()
  await buildIndex(cwd)
  assert.equal(findSymbol(cwd, 'gammaThing').length, 1, 'read again, with no mtime to trust')
  // …and when nothing in them changed, only the mtimes are written: the chunks stay as they were.
  strip()
  const before = JSON.parse(readFileSync(manifest, 'utf8')) as { updatedAt: number; chunks: unknown[] }
  await buildIndex(cwd)
  const after = JSON.parse(readFileSync(manifest, 'utf8')) as { updatedAt: number; chunks: unknown[]; files: { mtimeMs?: number }[] }
  assert.ok(after.files.every((entry) => typeof entry.mtimeMs === 'number'), 'mtimes recorded for next time')
  assert.equal(after.updatedAt, before.updatedAt)
  assert.deepEqual(after.chunks, before.chunks)
})

test('a second window asking for the folder being indexed waits for that build instead of restarting it', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-index-'))
  writeFileSync(join(cwd, 'a.ts'), 'export const a = 1\n')
  const first = buildIndex(cwd)
  const second = buildIndex(cwd)
  assert.equal(second, first, 'the same build')
  assert.equal((await first).state, 'ready')
  assert.deepEqual(indexedPaths(cwd), ['a.ts'])
})

test('the index and the project listing both skip OS folders a home folder is full of', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-index-'))
  mkdirSync(join(cwd, 'src'))
  mkdirSync(join(cwd, 'Library', 'Caches'), { recursive: true })
  mkdirSync(join(cwd, 'AppData', 'Local'), { recursive: true })
  writeFileSync(join(cwd, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(cwd, 'Library', 'Caches', 'x.js'), 'const x = 1\n')
  writeFileSync(join(cwd, 'AppData', 'Local', 'y.js'), 'const y = 1\n')
  await buildIndex(cwd)
  assert.deepEqual(indexedPaths(cwd), ['src/a.ts'])
  assert.deepEqual((await listProjectFiles(cwd, 100)).paths, ['src/a.ts'])
})

test('reading the index again costs next to nothing while it is unchanged', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-index-'))
  for (let d = 0; d < 15; d++) {
    mkdirSync(join(cwd, `pkg${d}`))
    for (let f = 0; f < 100; f++) {
      const body = Array.from({ length: 200 }, (_, i) => (i % 20 === 0 ? `export function fn_${d}_${f}_${i}() {` : `  const v${i} = ${i} // padding ${d} ${f}`))
      writeFileSync(join(cwd, `pkg${d}`, `f${f}.ts`), body.join('\n'))
    }
  }
  await buildIndex(cwd)
  assert.equal(indexedPaths(cwd).length, 1500)
  const started = performance.now()
  for (let i = 0; i < 20; i++) indexedPaths(cwd)
  const elapsed = performance.now() - started
  console.log(`20 index reads: ${elapsed.toFixed(1)} ms`)
  // Parsing the ~20 MB manifest each time took ~15 ms a read.
  assert.ok(elapsed < 100, `took ${elapsed} ms`)
})

test('the project listing honours .gitignore and the always-skipped folders, and reports a cap', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-list-'))
  mkdirSync(join(cwd, 'src'))
  mkdirSync(join(cwd, 'generated'))
  mkdirSync(join(cwd, 'node_modules'))
  writeFileSync(join(cwd, '.gitignore'), 'generated/\n*.log\n')
  writeFileSync(join(cwd, 'src', 'a.ts'), '')
  writeFileSync(join(cwd, 'Dockerfile'), '')
  writeFileSync(join(cwd, 'debug.log'), '')
  writeFileSync(join(cwd, 'generated', 'x.ts'), '')
  writeFileSync(join(cwd, 'node_modules', 'y.js'), '')
  const all = await listProjectFiles(cwd, 100)
  assert.deepEqual(all.paths.sort(), ['Dockerfile', 'src/a.ts'])
  assert.equal(all.truncated, false)
  const capped = await listProjectFiles(cwd, 1)
  assert.equal(capped.paths.length, 1)
  assert.equal(capped.truncated, true)
})

test('a build superseded by a newer one neither publishes its status nor writes its index', async () => {
  // An embedding endpoint whose first request is slow, as a busy local model is.
  let requests = 0
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const { input } = JSON.parse(Buffer.concat(chunks).toString()) as { input: string[] }
    if (requests++ === 0) await new Promise((r) => setTimeout(r, 600))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: input.map((_, index) => ({ embedding: [1, 0, 0], index })) }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  store.saveProviderConfig({
    'fake-embed': { name: 'Fake Embed', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, models: [] }
  })
  secrets.set('fake-embed', 'key')
  store.patchSettings({ codeIndex: { embeddingProviderId: 'fake-embed', embeddingModelId: 'm' } })

  const first = mkdtempSync(join(tmpdir(), 'eaon-index-a-'))
  writeFileSync(join(first, 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(first, 'b.ts'), 'export const b = 2\n')
  const second = mkdtempSync(join(tmpdir(), 'eaon-index-b-'))
  writeFileSync(join(second, 'c.ts'), 'export const c = 3\n')

  const published: IndexStatus[] = []
  setIndexStatusListener((status) => published.push(status))
  try {
    const stale = buildIndex(first)
    while (requests === 0) await new Promise((r) => setTimeout(r, 5))
    const fresh = await buildIndex(second)
    await stale
    assert.equal(fresh.state, 'ready')
    assert.equal(fresh.files, 1)
    assert.deepEqual(published.at(-1), fresh, 'the last word is the newer build')
    assert.deepEqual(indexedPaths(first), [], 'the superseded build wrote nothing')
  } finally {
    setIndexStatusListener(() => {})
    store.patchSettings({ codeIndex: { embeddingProviderId: null, embeddingModelId: null } })
    server.closeAllConnections()
    server.close()
  }
})
