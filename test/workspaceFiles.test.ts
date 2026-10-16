import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { store } from '../src/main/store'
import { workspaceFilesFeature } from '../src/main/features/workspaceFiles'
import type { FeatureContext } from '../src/main/features/types'
import { joinPath, touchedFiles } from '../src/renderer/src/components/ide/paths'
import type { ChatMessage } from '../src/shared/types'

function setup(): { call: (channel: string, ...args: unknown[]) => Promise<unknown>; work: string; outside: string } {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipcMain = { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler) }
  workspaceFilesFeature.register({ ipcMain } as unknown as FeatureContext)
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'eaon-ide-work-')))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'eaon-ide-outside-')))
  store.saveWorkspaces([{ id: 'chat', name: 'Chat', kind: 'chat', cwd: work }])
  return { call: async (channel, ...args) => handlers.get(channel)!(null, ...args), work, outside }
}

test('the code panel lists, reads and saves files in the work folder', async () => {
  const { call, work } = setup()
  mkdirSync(join(work, 'src'))
  writeFileSync(join(work, 'src', 'App.tsx'), 'export {}\n')
  writeFileSync(join(work, 'README.md'), '# hi\n')
  writeFileSync(join(work, '.DS_Store'), '')
  writeFileSync(join(work, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))

  assert.equal(await call('workspace-files:root'), work)
  const list = (await call('workspace-files:list', work)) as { name: string; directory: boolean }[]
  // Folders first, then files by name; noise files left out.
  assert.deepEqual(
    list.map((e) => [e.name, e.directory]),
    [
      ['src', true],
      ['logo.png', false],
      ['README.md', false]
    ]
  )

  const file = join(work, 'src', 'App.tsx')
  const read = (await call('workspace-files:read', file)) as { kind: string; text: string }
  assert.equal(read.kind, 'text')
  assert.equal(read.text, 'export {}\n')
  assert.equal(((await call('workspace-files:read', join(work, 'logo.png'))) as { kind: string }).kind, 'binary')

  await call('workspace-files:write', file, 'export const a = 1\n')
  assert.equal(readFileSync(file, 'utf8'), 'export const a = 1\n')
})

test('the code panel refuses paths outside the work folder, including through a symlink', async () => {
  const { call, work, outside } = setup()
  const secret = join(outside, 'secret.txt')
  writeFileSync(secret, 'nope')
  symlinkSync(outside, join(work, 'escape'))

  await assert.rejects(() => call('workspace-files:read', secret) as Promise<unknown>, /outside the work folder/)
  await assert.rejects(() => call('workspace-files:list', outside) as Promise<unknown>, /outside the work folder/)
  await assert.rejects(() => call('workspace-files:read', join(work, 'escape', 'secret.txt')) as Promise<unknown>, /outside the work folder/)
  await assert.rejects(() => call('workspace-files:write', join(work, '..', 'x.txt'), 'x') as Promise<unknown>)
  await assert.rejects(() => call('workspace-files:read', 'relative/path.txt') as Promise<unknown>, /absolute/)
  // Saving never creates a file that is not there.
  await assert.rejects(() => call('workspace-files:write', join(work, 'new.txt'), 'x') as Promise<unknown>)
  assert.equal(readFileSync(secret, 'utf8'), 'nope')
})

test('agent paths resolve against the folder the way the tree lists them', () => {
  assert.equal(joinPath('/Users/me/Eaon', 'src/App.tsx'), '/Users/me/Eaon/src/App.tsx')
  assert.equal(joinPath('/Users/me/Eaon', './src/../README.md'), '/Users/me/Eaon/README.md')
  assert.equal(joinPath('/Users/me/Eaon', '/tmp/x.txt'), '/tmp/x.txt')
  assert.equal(joinPath('C:\\Users\\me\\Eaon', 'src\\App.tsx'), 'C:\\Users\\me\\Eaon\\src\\App.tsx')

  const tool = (name: string, path: string, status: 'done' | 'error' = 'done') => ({ type: 'tool' as const, id: path + name, name, input: { path }, output: '', status })
  const messages = [
    { id: '1', role: 'assistant', createdAt: 0, parts: [tool('read_file', 'a.ts'), tool('edit_file', 'b.ts'), tool('write_file', 'c.ts', 'error')] },
    { id: '2', role: 'assistant', createdAt: 0, parts: [tool('write_file', 'd.ts'), tool('edit_file', 'b.ts')] }
  ] as ChatMessage[]
  assert.deepEqual(touchedFiles(messages), ['b.ts', 'd.ts'])
})
