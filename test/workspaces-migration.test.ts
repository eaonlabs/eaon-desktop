import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { store } from '../src/main/store'
import type { Chat, Project, Workspace } from '@shared/types'

/**
 * Chat absorbed the old Work tab, and the tabs are now Chat · Workers · ADE.
 * Nothing on disk may disappear on the way: chats and projects that lived in
 * Work are re-homed to Chat, the folder chosen for Work comes along (Chat works
 * in it now), and an install left on the Work tab opens on Chat.
 */

const dir = (): string => join(app.getPath('userData'), 'store')

function reset(): void {
  rmSync(dir(), { recursive: true, force: true })
  mkdirSync(dir(), { recursive: true })
}

function chat(id: string, workspaceId: string): Chat {
  return {
    id,
    workspaceId,
    projectId: null,
    title: id,
    messages: [],
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    pinned: false,
    unread: false,
    modelId: null,
    effort: 'light'
  }
}

test('Chat · Work · Code becomes Chat · Workers · ADE, and Work’s history moves into Chat', async () => {
  reset()
  await store.flushWrites()
  store.saveWorkspaces([
    { id: 'work', name: 'Chat', kind: 'chat' },
    { id: 'code', name: 'Work', kind: 'work', cwd: '/Users/me/site' },
    { id: 'eaon-code', name: 'Code', kind: 'code', cwd: '/Users/me/app' }
  ])
  store.saveChats([chat('a', 'work'), chat('b', 'code'), chat('c', 'eaon-code')])
  await store.flushWrites()
  store.saveProjects([{ id: 'p', workspaceId: 'code', name: 'Launch', instructions: '', createdAt: 0 } satisfies Project])
  store.patchSettings({ activeWorkspaceId: 'code' })

  store.migrateWorkspaces()

  const workspaces = store.getWorkspaces()
  assert.deepEqual(
    workspaces.map((w: Workspace) => [w.id, w.name, w.kind]),
    [
      ['work', 'Chat', 'chat'],
      ['workers', 'Workers', 'workers'],
      ['eaon-code', 'ADE', 'code']
    ]
  )
  assert.equal(workspaces[0].cwd, '/Users/me/site', 'the folder picked for Work is where Chat works now')
  assert.equal(workspaces[2].cwd, '/Users/me/app', 'the ADE keeps its folder')
  assert.deepEqual(
    store.getChats().map((c) => [c.id, c.workspaceId]),
    [
      ['a', 'work'],
      ['b', 'work'],
      ['c', 'eaon-code']
    ]
  )
  assert.equal(store.getProjects()[0].workspaceId, 'work')
  assert.equal(store.getSettings().activeWorkspaceId, 'work', 'left on the Work tab, it opens on Chat')

  // Running it again changes nothing.
  store.migrateWorkspaces()
  assert.equal(store.getWorkspaces().length, 3)
})

test('Open on launch picks the mode at startup; "last" leaves it alone', () => {
  reset()
  store.migrateWorkspaces()
  store.patchSettings({ activeWorkspaceId: 'work', general: { ...store.getSettings().general, launchMode: 'workers' } })
  store.applyLaunchMode()
  assert.equal(store.getSettings().activeWorkspaceId, 'workers')

  store.patchSettings({ general: { ...store.getSettings().general, launchMode: 'ade' } })
  store.applyLaunchMode()
  assert.equal(store.getSettings().activeWorkspaceId, 'eaon-code')

  store.patchSettings({ activeWorkspaceId: 'work', general: { ...store.getSettings().general, launchMode: 'last' } })
  store.applyLaunchMode()
  assert.equal(store.getSettings().activeWorkspaceId, 'work')
})
