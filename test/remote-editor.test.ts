import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { remoteCwd } from '../src/shared/adeRemote'
import { chatCodeFeature } from '../src/main/features/chatCode'
import { sshHosts } from '../src/main/features/ade'
import { allowed, workspaceFilesFeature } from '../src/main/features/workspaceFiles'
import { setHostFinder } from '../src/main/remoteWork'
import { store } from '../src/main/store'
import type { FeatureContext } from '../src/main/features/types'

/**
 * The editor and Git panel beside the chat, on a project on another machine:
 * workspace-files and chat-code with an `ssh://` folder. The "ssh" is a
 * stand-in that runs the command line here (EAON_SSH_BIN), so the folder is a
 * real git repository in a temp dir.
 */

const scratch = mkdtempSync(join(tmpdir(), 'eaon-remote-editor-'))
const savedProjects = store.getProjects()
test.after(() => {
  store.saveProjects(savedProjects)
  rmSync(scratch, { recursive: true, force: true })
})

const standIn = join(scratch, 'fake-ssh')
writeFileSync(standIn, '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n')
chmodSync(standIn, 0o755)
process.env.EAON_SSH_BIN = standIn
setHostFinder(null)

const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' })

const repo = realpathSync(mkdtempSync(join(scratch, 'repo-')))
git(repo, 'init', '-q', '-b', 'main')
writeFileSync(join(repo, 'a.txt'), 'one\n')
mkdirSync(join(repo, 'src'))
writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = 1\n')
git(repo, 'add', '.')
git(repo, 'commit', '-q', '-m', 'first')
writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
writeFileSync(join(repo, 'new.txt'), 'fresh\n')

const host = sshHosts.add({ hostname: 'box.example' })
test.after(() => sshHosts.remove(host.id))
const cwd = remoteCwd(host.id, repo)
store.saveProjects([{ id: 'p-remote', workspaceId: 'chat', name: 'remote', instructions: '', createdAt: 1, folder: cwd }])

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const context = { ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) } } as unknown as FeatureContext
workspaceFilesFeature.register(context)
chatCodeFeature.register(context)
const call = <T>(channel: string, ...args: unknown[]): Promise<T> => Promise.resolve(handlers.get(channel)!({}, ...args)) as Promise<T>

const at = (rel: string): string => remoteCwd(host.id, `${repo}/${rel}`)

test('the editor may open a project’s remote folder and what is in it, nothing else', async () => {
  assert.equal(await allowed(at('src/b.ts')), at('src/b.ts'))
  await assert.rejects(allowed(remoteCwd(host.id, `${repo}/src/../a.txt`)), /outside the work folder/, 'a path that climbs is refused even when it comes back in')
  await assert.rejects(allowed(remoteCwd(host.id, '/etc/passwd')), /outside the work folder/)
  await assert.rejects(allowed(remoteCwd(host.id, `${repo}/../other`)), /outside the work folder/)
  await assert.rejects(allowed(remoteCwd('cfg:somewhere-else', `${repo}/a.txt`)), /outside the work folder/)
})

test('the file tree lists a remote folder, folders first, as ssh:// paths', async () => {
  const entries = await call<{ name: string; path: string; directory: boolean }[]>('workspace-files:list', cwd)
  assert.deepEqual(
    entries.map((e) => [e.name, e.directory, e.path]),
    [
      ['.git', true, at('.git')],
      ['src', true, at('src')],
      ['a.txt', false, at('a.txt')],
      ['new.txt', false, at('new.txt')]
    ]
  )
  const inner = await call<{ name: string }[]>('workspace-files:list', at('src'))
  assert.deepEqual(inner.map((e) => e.name), ['b.ts'])
})

test('a remote file opens in the editor and saves back to the host', async () => {
  const file = await call<{ kind: string; text: string; modified: number; path: string }>('workspace-files:read', at('a.txt'))
  assert.equal(file.kind, 'text')
  assert.equal(file.text, 'one\ntwo\n')
  assert.equal(file.path, at('a.txt'))
  assert.ok(file.modified > 0)
  const modified = await call<number>('workspace-files:write', at('src/b.ts'), 'export const b = 2\n')
  assert.ok(modified > 0)
  assert.equal(readFileSync(join(repo, 'src', 'b.ts'), 'utf8'), 'export const b = 2\n')
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2]))
  assert.equal((await call<{ kind: string }>('workspace-files:read', at('bin.dat'))).kind, 'binary')
  await assert.rejects(call('workspace-files:read', remoteCwd(host.id, '/etc/hosts')), /outside the work folder/)
})

test('a link inside the project that leads out can’t be opened or overwritten from the editor', async () => {
  const outside = realpathSync(mkdtempSync(join(scratch, 'out-')))
  writeFileSync(join(outside, 'secret'), 'nope')
  symlinkSync(join(outside, 'secret'), join(repo, 'leak'))
  await assert.rejects(call('workspace-files:read', at('leak')), /outside the project/)
  await assert.rejects(call('workspace-files:write', at('leak'), 'overwritten'), /outside the project/)
  assert.equal(readFileSync(join(outside, 'secret'), 'utf8'), 'nope')
  rmSync(join(repo, 'leak'))
})

test('the Git panel sees a remote project: branch, changes, file marks and the committed text', async () => {
  const status = await call<{ repo: boolean; branch: string | null; changes: { files: number } | null }>('chat-code:status', cwd)
  assert.equal(status.repo, true)
  assert.equal(status.branch, 'main')
  assert.ok(status.changes && status.changes.files >= 2)

  const states = await call<Record<string, string>>('chat-code:file-states', cwd)
  assert.ok(Object.keys(states).length >= 2 && Object.keys(states).every((key) => key.startsWith('ssh://')), 'marks are keyed by ssh:// paths, as the tree names its files')
  assert.ok(states[at('a.txt')], 'a.txt is marked changed')
  assert.ok(states[at('new.txt')], 'new.txt is marked new')

  assert.equal(await call('chat-code:text-at-head', cwd, at('a.txt')), 'one\n')
  assert.equal(await call('chat-code:text-at-head', cwd, remoteCwd(host.id, '/etc/hosts')).catch(() => null), null)

  const diff = await call<{ ok: boolean; files: { path: string }[] }>('chat-code:diff', cwd)
  assert.equal(diff.ok, true)
  assert.ok(diff.files.some((f) => f.path === 'a.txt'))
})

test('the @ menu’s files and the project search read the host’s repository', async () => {
  const files = await call<string[]>('chat-code:files', cwd)
  assert.ok(files.includes('a.txt') && files.includes('new.txt') && files.includes('src/b.ts'))
  const found = await call<{ matches: { path: string; line: number }[] }>('chat-code:search', cwd, 'two', {})
  assert.deepEqual(found.matches.map((m) => [m.path, m.line]), [['a.txt', 2]])
})

test('opening a remote project in an app on this computer says it can’t, instead of opening nothing', async () => {
  await assert.rejects(call('chat-code:open-in', cwd, 'vscode', null, null), /another machine/)
})
