import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { store } from '../src/main/store'
import { WorkersEngine } from '../src/main/features/workers/engine'
import { MAX_VERSIONS, normalizeVersions } from '@shared/workerVersions'
import type { Worker, WorkerDraft } from '@shared/workers'

/** A worker's earlier setups: kept on every change, restorable, and the restore itself undoable. */

let root = ''
let saved: Worker[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'eaon-versions-'))
  store.patchSettings({ work: { ...store.getSettings().work, defaultFolder: root } })
  saved = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function boot(): WorkersEngine {
  const engine = new WorkersEngine({
    runAgent: async () => ({ text: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    getSettings: () => store.getSettings(),
    loadWorkers: () => saved,
    saveWorkers: (workers) => {
      saved = JSON.parse(JSON.stringify(workers))
    },
    loadThread: () => null,
    saveThread: () => undefined,
    deleteThread: () => undefined
  })
  engine.load()
  return engine
}

const draft = (name: string, over: Partial<WorkerDraft> = {}): WorkerDraft => ({ name, personality: 'Calm', purpose: 'Triage the inbox', ...over })

test('a change keeps the setup it replaced, and says what changed', () => {
  const engine = boot()
  const nova = engine.save(draft('Nova'))
  assert.deepEqual(engine.versions(nova.id), [], 'nothing before the first change')
  engine.save(draft('Nova', { id: nova.id, purpose: 'Triage the inbox and draft replies' }))
  const versions = engine.versions(nova.id)
  assert.equal(versions.length, 1)
  assert.equal(versions[0].settings.purpose, 'Triage the inbox')
  assert.ok(versions[0].changed.includes('purpose'))
})

test('saving without a change adds no version', () => {
  const engine = boot()
  const nova = engine.save(draft('Nova'))
  engine.save(draft('Nova', { id: nova.id }))
  assert.equal(engine.versions(nova.id).length, 0)
})

test('restoring puts the setup back, and keeps the one it replaced so the restore can be undone', () => {
  const engine = boot()
  const nova = engine.save(draft('Nova'))
  engine.save(draft('Nova', { id: nova.id, purpose: 'Write the weekly report', access: 'read-only' }))
  const [first] = engine.versions(nova.id)
  const restored = engine.restoreVersion(nova.id, first.id)
  assert.equal(restored.purpose, 'Triage the inbox')
  assert.equal(restored.access, 'autonomous')
  const after = engine.versions(nova.id)
  assert.equal(after.length, 2)
  assert.equal(after[1].settings.purpose, 'Write the weekly report', 'the setup the restore replaced is kept')
  // Undo the restore.
  const undone = engine.restoreVersion(nova.id, after[1].id)
  assert.equal(undone.purpose, 'Write the weekly report')
  assert.equal(undone.access, 'read-only')
})

test('versions survive a restart, and an unknown version is refused', () => {
  const engine = boot()
  const nova = engine.save(draft('Nova'))
  engine.save(draft('Nova', { id: nova.id, personality: 'Brisk' }))
  const again = boot()
  assert.equal(again.versions(nova.id).length, 1)
  assert.throws(() => again.restoreVersion(nova.id, 'nope'), /no longer kept/)
})

test('only the newest versions are kept, and damaged entries are dropped on reading', () => {
  const engine = boot()
  const nova = engine.save(draft('Nova'))
  for (let i = 0; i < MAX_VERSIONS + 5; i++) engine.save(draft('Nova', { id: nova.id, purpose: `Purpose ${i}` }))
  const versions = engine.versions(nova.id)
  assert.equal(versions.length, MAX_VERSIONS)
  assert.equal(versions.at(-1)!.settings.purpose, `Purpose ${MAX_VERSIONS + 3}`)
  assert.deepEqual(normalizeVersions([{ id: 'x' }, null, 'junk', { id: 'y', savedAt: 1, settings: { name: 'A', purpose: 'p', personality: 'q' }, changed: ['purpose', 4] }]).map((v) => [v.id, v.changed]), [['y', ['purpose']]])
})

/* ------------------------------------------------------------ the worker's tables */

test('a worker keeps tables the engine saves, reads back and removes with it', async () => {
  const files = new Map<string, unknown>()
  const engine = new WorkersEngine({
    runAgent: async () => ({ text: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    getSettings: () => store.getSettings(),
    loadWorkers: () => saved,
    saveWorkers: (workers) => {
      saved = JSON.parse(JSON.stringify(workers))
    },
    loadThread: () => null,
    saveThread: () => undefined,
    deleteThread: () => undefined,
    loadTables: (id) => files.get(id) ?? [],
    saveTables: (id, tables) => void files.set(id, JSON.parse(JSON.stringify(tables))),
    deleteTables: (id) => void files.delete(id)
  })
  engine.load()
  const nova = engine.save(draft('Nova'))
  assert.match(engine.readTable(nova.id, ''), /no tables yet/)
  assert.match(engine.writeTable(nova.id, 'Leads', [{ Email: 'a@x.dev', Stage: 'new' }, { Email: 'b@x.dev', Stage: 'new' }]), /added 2/)
  assert.match(engine.writeTable(nova.id, 'Leads', [{ Email: 'a@x.dev', Stage: 'won' }], 'Email'), /updated 1/)
  assert.match(engine.readTable(nova.id, 'leads', { where: { stage: 'won' } }), /Leads: 1 row/)
  assert.match(engine.readTable(nova.id, ''), /Leads: 2 rows; columns Email, Stage/)
  assert.throws(() => engine.readTable(nova.id, 'Missing'), /no table called Missing/)
  assert.match(engine.deleteTableRows(nova.id, 'Leads', { Stage: 'new' }), /removed 1 row\./)
  assert.equal(engine.tables(nova.id)[0].rows.length, 1)
  assert.deepEqual(engine.removeTable(nova.id, 'LEADS'), [])
  engine.writeTable(nova.id, 'Again', [{ a: '1' }])
  await engine.remove(nova.id)
  assert.equal(files.has(nova.id), false, 'removing the worker removes its tables')
})
