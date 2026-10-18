import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shell } from 'electron'
import { libraryFeature, savePastedImage } from '../src/main/features/library'
import type { FeatureContext } from '../src/main/features/types'

/** Clicking an attachment opens it, unless opening it would run it. */
test('scripts, installers and Windows Script Host files are revealed, not opened', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipcMain = { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler) }
  libraryFeature.register({ ipcMain } as unknown as FeatureContext)
  const opened: string[] = []
  const revealed: string[] = []
  const stub = shell as unknown as { openPath: (path: string) => Promise<string>; showItemInFolder: (path: string) => void }
  stub.openPath = async (path) => {
    opened.push(path)
    return ''
  }
  stub.showItemInFolder = (path) => {
    revealed.push(path)
  }
  const open = handlers.get('library:open')!
  // Real files: a missing one is reported as missing before anything else.
  const dir = mkdtempSync(join(tmpdir(), 'eaon-library-'))
  const file = (name: string): string => {
    const path = join(dir, name)
    writeFileSync(path, 'x')
    return path
  }
  for (const name of ['invoice.js', 'run.VBS', 'setup.hta', 'a.scr', 'fix.reg', 'app.msix', 'app.desktop', 'tool.py']) {
    await open(null, file(name))
  }
  const report = file('report.pdf')
  await open(null, report)
  assert.equal(revealed.length, 8)
  assert.deepEqual(opened, [report])
})

/** A pasted screenshot has no file of its own; it is saved so it can be attached like one. */
test('a pasted image is saved as a file to attach, and anything else is refused', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'eaon-pasted-'))
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  const path = await savePastedImage(bytes, 'image/png', folder)
  assert.ok(path.startsWith(folder) && path.endsWith('.png'))
  assert.deepEqual(new Uint8Array(readFileSync(path)), bytes)
  // Two pastes in the same second don't overwrite each other.
  assert.notEqual(await savePastedImage(bytes, 'image/png', folder), path)

  await assert.rejects(savePastedImage(bytes, 'text/html', folder))
  await assert.rejects(savePastedImage(bytes, 'image/svg+xml', folder))
  await assert.rejects(savePastedImage(new Uint8Array(), 'image/png', folder))
  await assert.rejects(savePastedImage('not bytes', 'image/png', folder))
})
