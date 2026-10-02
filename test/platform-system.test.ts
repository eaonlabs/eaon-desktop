import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getSystemInfo } from '../src/main/system'

test('system info resolves without a synchronous spawn and reads the marketing OS version on macOS', async () => {
  const pending = getSystemInfo()
  assert.ok(pending instanceof Promise, 'sw_vers is asked asynchronously')
  const info = await pending
  if (process.platform === 'darwin') assert.match(info.os.version, /^macOS \d+(\.\d+)*$/)
  else assert.ok(info.os.version.length > 0)
  assert.ok(info.cpu.cores > 0)
  assert.ok(info.cpu.usagePercent >= 0 && info.cpu.usagePercent <= 100)
  assert.ok(info.memory.totalBytes > 0)

  // The OS version is looked up once; later polls reuse it.
  const again = await getSystemInfo()
  assert.equal(again.os.version, info.os.version)
})
