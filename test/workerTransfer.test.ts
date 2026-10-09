import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyTree, sizeOf, transferRefusal } from '../src/main/features/workers/transfer'

/**
 * Files one worker sends another: copied as a tree that reports progress,
 * can be stopped, never follows a link out of the folder, never overwrites,
 * and never carries credentials.
 */

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'eaon-transfer-'))
  const src = join(root, 'project')
  mkdirSync(join(src, 'sub'), { recursive: true })
  writeFileSync(join(src, 'a.txt'), 'a'.repeat(1000))
  writeFileSync(join(src, 'sub', 'b.txt'), 'b'.repeat(2000))
  symlinkSync('/etc/hosts', join(src, 'link'))
  return root
}

test('a folder is copied whole, links as links, with progress', async () => {
  const root = fixture()
  const seen: number[] = []
  const total = await sizeOf(join(root, 'project'), Infinity)
  assert.equal(total, 3000, 'links count as nothing; what they point at is not sent')
  await copyTree(join(root, 'project'), join(root, 'copy'), { total, onProgress: (p) => seen.push(p.bytes), everyMs: 0 })
  assert.equal(readFileSync(join(root, 'copy', 'sub', 'b.txt'), 'utf8').length, 2000)
  assert.ok(lstatSync(join(root, 'copy', 'link')).isSymbolicLink())
  assert.equal(readlinkSync(join(root, 'copy', 'link')), '/etc/hosts')
  assert.equal(seen.at(-1), 3000)
})

test('a stopped transfer leaves nothing behind, and nothing is ever overwritten', async () => {
  const root = fixture()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(copyTree(join(root, 'project'), join(root, 'copy'), { total: 3000, signal: controller.signal }), /stopped/)
  assert.equal(existsSync(join(root, 'copy')), false)
  mkdirSync(join(root, 'taken'))
  await assert.rejects(copyTree(join(root, 'project'), join(root, 'taken'), { total: 3000 }), /EEXIST/)
  writeFileSync(join(root, 'file-there.txt'), 'keep')
  await assert.rejects(copyTree(join(root, 'project', 'a.txt'), join(root, 'file-there.txt'), { total: 1000 }), /EEXIST/)
  assert.equal(readFileSync(join(root, 'file-there.txt'), 'utf8'), 'keep')
})

test('credential stores are never sent, even through a link', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eaon-transfer-cred-'))
  mkdirSync(join(root, '.ssh'))
  writeFileSync(join(root, '.ssh', 'id_rsa'), 'secret')
  assert.match((await transferRefusal(join(root, '.ssh', 'id_rsa'))) ?? '', /holds credentials/)
  assert.match((await transferRefusal(join(root, '.ssh'))) ?? '', /holds credentials/)
  symlinkSync(join(root, '.ssh'), join(root, 'innocent'))
  assert.match((await transferRefusal(join(root, 'innocent'))) ?? '', /holds credentials/)
  writeFileSync(join(root, 'notes.md'), 'fine')
  assert.equal(await transferRefusal(join(root, 'notes.md')), null)
})
