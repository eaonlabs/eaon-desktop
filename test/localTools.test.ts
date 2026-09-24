import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/localTools'
import { toolsFor, type ToolContext } from '../src/main/agent/tools'
import { store } from '../src/main/store'
import type { StreamRequest } from '@shared/types'

function tools(cwd: string) {
  const settings = store.getSettings()
  const request = { mode: 'work', work: { swarm: false, plan: false }, goal: null } as unknown as StreamRequest
  const list = toolsFor({ mode: 'work', cwd, depth: 0, readOnly: false, settings, request })
  const ctx = { cwd, settings, signal: new AbortController().signal, progress: () => {} } as unknown as ToolContext
  return { get: (name: string) => list.find((t) => t.name === name)!, ctx }
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
