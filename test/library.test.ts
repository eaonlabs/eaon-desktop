import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shell } from 'electron'
import { libraryFeature } from '../src/main/features/library'
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
