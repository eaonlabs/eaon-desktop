import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { resolveWorkPath } from '../src/main/localTools'

// Under the home folder, where the agent may otherwise work.
const work = mkdtempSync(join(homedir(), '.eaon-guard-test-'))
const made = [work]
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

test('a symlink inside the work folder cannot lead to credentials', (t) => {
  const link = join(work, 'docs')
  try {
    symlinkSync(join(homedir(), '.ssh'), link)
  } catch {
    t.skip('symlinks are not available here')
    return
  }
  assert.throws(() => resolveWorkPath(work, 'docs/id_ed25519'), /credentials/)
  assert.throws(() => resolveWorkPath(work, 'docs/new-file'), /credentials/, 'a file that does not exist yet, through the link')
})

test('a symlink to a folder outside the work folder is not "inside"', (t) => {
  const outside = mkdtempSync(join(homedir(), '.eaon-guard-outside-'))
  made.push(outside)
  writeFileSync(join(outside, 'notes.md'), 'x')
  try {
    symlinkSync(outside, join(work, 'elsewhere'))
  } catch {
    t.skip('symlinks are not available here')
    return
  }
  assert.equal(resolveWorkPath(work, 'elsewhere/notes.md').inside, false)
  writeFileSync(join(work, 'own.md'), 'x')
  assert.equal(resolveWorkPath(work, 'own.md').inside, true)
})

test('Eaon’s own data is off limits, apart from the files the agent is handed', () => {
  const data = app.getPath('userData')
  mkdirSync(join(data, 'store'), { recursive: true })
  mkdirSync(join(data, 'attachments'), { recursive: true })
  assert.throws(() => resolveWorkPath(work, join(data, 'store', 'settings.json')), /credentials/)
  assert.throws(() => resolveWorkPath(work, join(data, 'keys.dat')), /credentials/)
  assert.doesNotThrow(() => resolveWorkPath(work, join(data, 'attachments', 'shot.png')))
})

test('other tools’ sign-ins are off limits', () => {
  for (const path of ['~/.kube/config', '~/.npmrc', '~/.codex/auth.json', '~/.claude/.credentials.json', '~/.config/gcloud/credentials.db']) {
    assert.throws(() => resolveWorkPath(work, path), /credentials/, path)
  }
  assert.doesNotThrow(() => resolveWorkPath(work, '~/.claude/settings.json'))
})
