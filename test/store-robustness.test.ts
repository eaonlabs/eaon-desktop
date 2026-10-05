import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { defaultSettings, forgetChatsForTests, store } from '../src/main/store'
import { resetStoreHealthForTests, salvageJson, setStoreFs, storeHealth, sweepTempFiles } from '../src/main/storeFiles'
import { runMigrations, type Migration } from '../src/main/migrations'
import type { Chat, ChatMessage } from '@shared/types'

/**
 * The store against damaged files and a failing disk: truncated and garbage
 * JSON, the wrong shape, duplicate ids, unknown fields, ENOSPC and EACCES on
 * write (injected through storeFiles' fs layer), a crash mid-write. One bad
 * file must never stop Eaon starting or quietly replace what the user had.
 */

const dir = (): string => join(app.getPath('userData'), 'store')
const file = (name: string): string => join(dir(), name)
const put = (name: string, text: string): void => {
  mkdirSync(dir(), { recursive: true })
  writeFileSync(file(name), text)
}
const onDisk = (name: string): unknown => JSON.parse(readFileSync(file(name), 'utf8'))
const copies = (name: string): string[] => readdirSync(dir()).filter((f) => f.startsWith(`${name}.corrupt-`))
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code })

let restoreFs: (() => void) | null = null

beforeEach(() => {
  rmSync(dir(), { recursive: true, force: true })
  resetStoreHealthForTests()
  forgetChatsForTests()
})

afterEach(async () => {
  restoreFs?.()
  restoreFs = null
  await store.flushWrites()
  resetStoreHealthForTests()
})

function message(id: string, text = 'hi'): ChatMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }], createdAt: 1_700_000_000_000 }
}

function chat(id: string, extra: Partial<Chat> = {}): Chat {
  return {
    id,
    workspaceId: 'work',
    projectId: null,
    title: `Chat ${id}`,
    messages: [message(`${id}-m1`)],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    archived: false,
    pinned: false,
    unread: false,
    modelId: null,
    effort: 'medium',
    ...extra
  }
}

/* ------------------------------------------------------------- salvage */

test('salvage keeps every complete record before the cut, and gives up on nothing', () => {
  const full = JSON.stringify([{ id: 'a', t: 'x, y ] }' }, { id: 'b', t: 'q\\"' }, { id: 'c', t: 'z' }])
  const cut = full.slice(0, full.indexOf('"c"') + 2)
  assert.deepEqual(salvageJson(cut), [{ id: 'a', t: 'x, y ] }' }, { id: 'b', t: 'q\\"' }])
  // Objects too (settings), cut in the middle of a value.
  assert.deepEqual(salvageJson('{"a": 1, "b": {"c": [1, 2]}, "d": "unfinish'), { a: 1, b: { c: [1, 2] } })
  // Garbage in the middle: everything before it.
  assert.deepEqual(salvageJson('[{"id":"a"},{"id":"b"},{"id":\u0000\u0007garbage]]]],{"id":"c"}]'), [{ id: 'a' }, { id: 'b' }])
  assert.equal(salvageJson('\u0000\u0000\u0000\u0000'), undefined)
  assert.equal(salvageJson(''), undefined)
  assert.equal(salvageJson('[{"id":"a"'), undefined, 'not even one complete record')
})

/* --------------------------------------------------------------- reads */

test('a chats.json cut off mid-write keeps every complete chat and a copy of the damaged file', () => {
  const chats = [chat('a'), chat('b'), chat('c')]
  const text = JSON.stringify(chats)
  put('chats.json', text.slice(0, text.length - 40))

  const loaded = store.getChats()
  assert.deepEqual(
    loaded.map((c) => c.id),
    ['a', 'b']
  )
  assert.equal(copies('chats.json').length, 1, 'the damaged file is kept')
  assert.equal(readFileSync(join(dir(), copies('chats.json')[0]), 'utf8'), text.slice(0, text.length - 40))
  // Written back, so the next launch doesn't go through this again.
  assert.deepEqual(
    (onDisk('chats.json') as Chat[]).map((c) => c.id),
    ['a', 'b']
  )
  const [problem] = storeHealth().problems
  assert.equal(problem.kind, 'repaired')
  assert.equal(problem.label, 'Chats')
  assert.ok(problem.copy && existsSync(problem.copy))
})

test('garbage in settings.json falls back to the previous save', () => {
  store.saveSettings({ ...defaultSettings, selectedModelId: 'first' })
  store.patchSettings({ selectedModelId: 'second' })
  // The .bak is the save before the last one.
  writeFileSync(file('settings.json'), '\u0000\u0001{{{ not json')
  const settings = store.getSettings()
  assert.equal(settings.selectedModelId, 'first')
  assert.equal(storeHealth().problems[0].kind, 'restored')
  assert.equal(copies('settings.json').length, 1)
  assert.equal((onDisk('settings.json') as { selectedModelId: string }).selectedModelId, 'first')
})

test('an empty or wrong-shaped settings file never reaches the app as null', () => {
  for (const text of ['', 'null', '[]', '"settings"', '{"appearance": null, "general": 5, "shortcuts": {"new-chat": 7}}']) {
    rmSync(dir(), { recursive: true, force: true })
    resetStoreHealthForTests()
    put('settings.json', text)
    const settings = store.getSettings()
    assert.equal(settings.appearance.mode, defaultSettings.appearance.mode, `appearance from ${JSON.stringify(text)}`)
    assert.equal(settings.general.launchMode, defaultSettings.general.launchMode)
    assert.equal(typeof settings.shortcuts, 'object')
    assert.ok(!('new-chat' in settings.shortcuts) || typeof settings.shortcuts['new-chat'] === 'string')
  }
})

test('unknown options go back to their default; unknown fields from a newer Eaon are kept', () => {
  put(
    'settings.json',
    JSON.stringify({
      appearance: { mode: 'purple', fontSize: 0, appIcon: 'agent', futureGlow: true },
      effort: 'maximum',
      approvalMode: 'full',
      favoriteModels: ['a', 7, 'b'],
      futureSection: { enabled: true, level: 3 }
    })
  )
  const settings = store.getSettings() as typeof defaultSettings & { futureSection?: unknown }
  assert.equal(settings.appearance.mode, defaultSettings.appearance.mode)
  assert.equal(settings.appearance.fontSize, defaultSettings.appearance.fontSize)
  assert.equal(settings.appearance.appIcon, 'agent', 'a valid value stays')
  assert.equal(settings.effort, defaultSettings.effort)
  assert.equal(settings.approvalMode, 'full')
  assert.deepEqual(settings.favoriteModels, ['a', 'b'])
  // A patch and a reload later, the newer version's fields are still there.
  store.patchSettings({ planMode: true })
  const saved = onDisk('settings.json') as Record<string, Record<string, unknown>>
  assert.deepEqual(saved.futureSection, { enabled: true, level: 3 })
  assert.equal(saved.appearance.futureGlow, true)
  assert.equal(storeHealth().problems.length, 0, 'quiet fixes are not a notice')
})

test('a patch that would null out a whole section is refused field by field', () => {
  const next = store.patchSettings({ appearance: null as never, general: { launchMode: 'nonsense' as never } as never })
  assert.equal(next.appearance.mode, defaultSettings.appearance.mode)
  assert.equal(next.general.launchMode, defaultSettings.general.launchMode)
})

test('chats: no id, a repeated id and broken fields are set aside or repaired, never crash the list', () => {
  const now = Date.now()
  put(
    'chats.json',
    JSON.stringify([
      chat('a', { title: 'Newest a' }),
      { title: 'no id' },
      'not a chat',
      chat('a', { title: 'Older duplicate a' }),
      { ...chat('b'), messages: 'garbage', createdAt: 'yesterday', updatedAt: now + 365 * 86_400_000, pinned: 'yes', effort: 'maximum' },
      { ...chat('c'), messages: [message('m1'), message('m1'), { id: 'x', role: 'robot', parts: [] }, { ...message('m2'), parts: null }] }
    ])
  )
  const chats = store.getChats()
  assert.deepEqual(
    chats.map((c) => c.id),
    ['a', 'b', 'c']
  )
  assert.equal(chats[0].title, 'Newest a', 'the first of two with one id is kept')
  const b = chats[1]
  assert.deepEqual(b.messages, [])
  assert.ok(b.updatedAt <= now + 86_400_000, 'a time years ahead is brought back')
  assert.equal(typeof b.createdAt, 'number')
  assert.equal(b.pinned, false)
  assert.equal(b.effort, 'medium')
  const c = chats[2]
  assert.deepEqual(
    c.messages.map((m) => m.id),
    ['m1', 'm2']
  )
  assert.deepEqual(c.messages[1].parts, [])
  assert.equal(copies('chats.json').length, 1)
  assert.match(storeHealth().problems[0].detail, /set aside/)
})

test('a chat pointing at a project or workspace that is gone comes back into view', () => {
  store.saveProjects([{ id: 'p1', workspaceId: 'work', name: 'Kept', instructions: '', createdAt: 1 }])
  put(
    'chats.json',
    JSON.stringify([chat('in-kept', { projectId: 'p1' }), chat('orphan', { projectId: 'deleted' }), chat('lost-tab', { workspaceId: 'old-tab' })])
  )
  store.migrateWorkspaces()
  const byId = new Map(store.getChats().map((c) => [c.id, c]))
  assert.equal(byId.get('in-kept')!.projectId, 'p1')
  assert.equal(byId.get('orphan')!.projectId, null, 'shows in Recents again')
  assert.equal(byId.get('lost-tab')!.workspaceId, 'work')
  assert.ok(existsSync(join(dir(), 'backups')), 'rewriting chats backs them up first')
})

test('a feature document of the wrong shape is set aside, not handed over or saved over', () => {
  put('scheduled-tasks.json', '{"oops": true}')
  assert.deepEqual(store.getJson('scheduled-tasks.json', []), [])
  assert.equal(copies('scheduled-tasks.json').length, 1)
  assert.equal(readFileSync(join(dir(), copies('scheduled-tasks.json')[0]), 'utf8'), '{"oops": true}')
  assert.equal(storeHealth().problems[0].kind, 'reset')
})

test('a file Eaon may not read is moved aside, and the previous save used', () => {
  store.saveProjects([{ id: 'p1', workspaceId: 'work', name: 'One', instructions: '', createdAt: 1 }])
  store.saveProjects([{ id: 'p2', workspaceId: 'work', name: 'Two', instructions: '', createdAt: 1 }])
  const target = file('projects.json')
  restoreFs = setStoreFs({
    read: (path) => {
      if (path === target) throw errno('EACCES')
      return readFileSync(path, 'utf8')
    }
  })
  assert.deepEqual(
    store.getProjects().map((p) => p.id),
    ['p1']
  )
  assert.equal(copies('projects.json').length, 1, 'moved aside, not deleted')
})

test('a passing read error (EMFILE) gives the default but never writes over the file', () => {
  store.saveProjects([{ id: 'p1', workspaceId: 'work', name: 'One', instructions: '', createdAt: 1 }])
  const target = file('projects.json')
  let failing = true
  restoreFs = setStoreFs({
    read: (path) => {
      if (failing && path === target) throw errno('EMFILE')
      return readFileSync(path, 'utf8')
    }
  })
  assert.deepEqual(store.getProjects(), [])
  store.saveProjects([{ id: 'new', workspaceId: 'work', name: 'Built on nothing', instructions: '', createdAt: 1 }])
  assert.deepEqual(
    (onDisk('projects.json') as { id: string }[]).map((p) => p.id),
    ['p1'],
    'the real file is untouched'
  )
  assert.equal(storeHealth().problems[0].kind, 'unsaved')
  failing = false
  assert.deepEqual(
    store.getProjects().map((p) => p.id),
    ['p1']
  )
  assert.equal(storeHealth().problems.length, 0, 'a good read clears it')
})

/* -------------------------------------------------------------- writes */

test('ENOSPC on a save keeps the previous file, keeps the change in memory, says so, and saves it once it can', async () => {
  store.saveSettings({ ...defaultSettings, selectedModelId: 'before' })
  let full = true
  restoreFs = setStoreFs({
    writeDurable: (path, data) => {
      if (full) throw errno('ENOSPC')
      writeFileSync(path, data)
    },
    writeDurableAsync: async (path, data) => {
      if (full) throw errno('ENOSPC')
      writeFileSync(path, data)
    }
  })
  const next = store.patchSettings({ selectedModelId: 'after' })
  assert.equal(next.selectedModelId, 'after')
  assert.equal((onDisk('settings.json') as { selectedModelId: string }).selectedModelId, 'before', 'the good file is untouched')
  assert.equal(store.getSettings().selectedModelId, 'after', 'the app carries on with the change')
  const [problem] = storeHealth().problems
  assert.equal(problem.kind, 'unsaved')
  assert.equal(problem.code, 'ENOSPC')
  assert.match(problem.detail, /disk is full/)
  assert.deepEqual(
    readdirSync(dir()).filter((f) => f.endsWith('.tmp')),
    [],
    'no temp file left behind'
  )

  full = false
  await store.flushWrites()
  assert.equal((onDisk('settings.json') as { selectedModelId: string }).selectedModelId, 'after')
  assert.equal(storeHealth().problems.length, 0)
})

test('EACCES on the rename of an async chats save: reported, chats kept, saved on the next try', async () => {
  let denied = true
  restoreFs = setStoreFs({
    renameAsync: async (from, to) => {
      if (denied) throw errno('EACCES')
      const { renameSync } = await import('node:fs')
      renameSync(from, to)
    }
  })
  store.applyChats([chat('x')], [])
  await store.flushWrites()
  assert.equal(existsSync(file('chats.json')), false)
  assert.match(storeHealth().problems[0].detail, /isn’t allowed to write/)
  assert.deepEqual(
    store.getChats().map((c) => c.id),
    ['x']
  )
  denied = false
  await store.flushWrites()
  assert.deepEqual(
    (onDisk('chats.json') as Chat[]).map((c) => c.id),
    ['x']
  )
  assert.equal(storeHealth().problems.length, 0)
})

test('a crash in the middle of a write leaves the old file whole, and its temp file is swept at the next start', () => {
  store.saveProjects([{ id: 'kept', workspaceId: 'work', name: 'Kept', instructions: '', createdAt: 1 }])
  restoreFs = setStoreFs({
    writeDurable: (path, data) => {
      // Half the bytes reach the temp file, then the process "dies".
      writeFileSync(path, data.slice(0, data.length / 2))
      throw errno('EIO')
    },
    unlink: () => {
      /* a dead process cleans nothing up */
    }
  })
  store.saveProjects([{ id: 'lost', workspaceId: 'work', name: 'Lost', instructions: '', createdAt: 1 }])
  restoreFs()
  restoreFs = null
  resetStoreHealthForTests()
  assert.ok(readdirSync(dir()).some((f) => f.endsWith('.tmp')))
  sweepTempFiles()
  assert.deepEqual(
    readdirSync(dir()).filter((f) => f.endsWith('.tmp')),
    []
  )
  assert.deepEqual(
    store.getProjects().map((p) => p.id),
    ['kept']
  )
})

/* ----------------------------------------------------------- migrations */

test('migrations run once, in order, with a backup first; a failure stops there and retries next launch', () => {
  store.saveProjects([{ id: 'p', workspaceId: 'work', name: 'P', instructions: '', createdAt: 1 }])
  const ran: string[] = []
  let failSecond = true
  const migrations: Migration[] = [
    { version: 1, name: 'one', files: ['projects.json'], run: () => ran.push('one') },
    {
      version: 2,
      name: 'two',
      files: ['projects.json'],
      run: () => {
        ran.push('two')
        if (failSecond) throw new Error('boom')
      }
    }
  ]
  assert.deepEqual(runMigrations(migrations, 'test'), { from: 0, to: 1 })
  assert.equal((onDisk('store-meta.json') as { schema: number }).schema, 1)
  const backups = readdirSync(join(dir(), 'backups'))
  assert.ok(backups.some((b) => b.startsWith('before-one-')))
  assert.ok(existsSync(join(dir(), 'backups', backups.find((b) => b.startsWith('before-one-'))!, 'projects.json')))

  failSecond = false
  assert.deepEqual(runMigrations(migrations, 'test'), { from: 1, to: 2 })
  assert.deepEqual(runMigrations(migrations, 'test'), { from: 2, to: 2 })
  assert.deepEqual(ran, ['one', 'two', 'two'])

  // A profile from a newer Eaon is left alone.
  writeFileSync(file('store-meta.json'), JSON.stringify({ schema: 9 }))
  assert.deepEqual(runMigrations(migrations, 'test'), { from: 9, to: 9 })
  assert.equal(ran.length, 3)
})
