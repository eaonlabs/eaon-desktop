import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortChats, sortProjects } from '../src/renderer/src/components/chatSidebar'
import type { Project } from '../src/shared/types'

/** Chat's sidebar: the order of its Projects and Chats sections. */

const project = (id: string, name: string, createdAt: number): Project => ({ id, workspaceId: 'chat', name, instructions: '', createdAt })
const chat = (projectId: string | null, updatedAt: number, archived = false) => ({ projectId, updatedAt, archived })

test('projects: by their latest chat, by when they were made, or by name', () => {
  const projects = [project('a', 'Trip 10', 1), project('b', 'trip 9', 2), project('c', 'Budget', 3)]
  const chats = [chat('a', 50), chat('b', 20), chat('b', 70, true), chat(null, 99)]
  const ids = (list: Project[]): string[] => list.map((p) => p.id)
  assert.deepEqual(ids(sortProjects(projects, chats, 'recent')), ['a', 'b', 'c'], 'an archived chat is not activity; one without chats counts from when it was made')
  assert.deepEqual(ids(sortProjects(projects, [], 'recent')), ['c', 'b', 'a'])
  assert.deepEqual(ids(sortProjects(projects, chats, 'created')), ['c', 'b', 'a'])
  assert.deepEqual(ids(sortProjects(projects, chats, 'name')), ['c', 'b', 'a'], 'names compare as people read them: case aside, 9 before 10')
  assert.deepEqual(ids(projects), ['a', 'b', 'c'], 'the list passed in is left as it was')
})

test('chats: recent order is the list’s own; by date made keeps pinned chats first', () => {
  const items = [
    { id: 'pinned-old', pinned: true },
    { id: 'new-reply', pinned: false },
    { id: 'made-last', pinned: false }
  ]
  const createdAt = { 'pinned-old': 1, 'new-reply': 2, 'made-last': 3 }
  assert.equal(sortChats(items, 'recent', createdAt), items, 'nothing to sort, and the same list back so the sidebar does not redraw')
  assert.deepEqual(
    sortChats(items, 'created', createdAt).map((c) => c.id),
    ['pinned-old', 'made-last', 'new-reply']
  )
})
