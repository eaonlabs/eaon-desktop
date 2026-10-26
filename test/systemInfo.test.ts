import { test } from 'node:test'
import assert from 'node:assert/strict'
import { macAvailableBytes } from '../src/main/system'

/** System Monitor's memory on a Mac: Activity Monitor's count, not only the pages nobody has touched. */

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    14000.
Pages active:                                 352547.
Pages inactive:                               361050.
Pages speculative:                               255.
Pages wired down:                             267378.
Pages purgeable:                                7196.
File-backed pages:                            237625.
Anonymous pages:                              476227.
Pages stored in compressor:                   922739.
Pages occupied by compressor:                 505308.
`

test('available memory on a Mac leaves out apps, wired and compressed memory, and counts cache as free', () => {
  const total = 25769803776
  const available = macAvailableBytes(VM_STAT, total)!
  const used = (476227 - 7196 + 267378 + 505308) * 16384
  assert.equal(available, total - used)
  // Far more than the 14000 untouched pages (0.23 GB) os.freemem() reports.
  assert.ok(available > 14000 * 16384 * 10)
  assert.equal(macAvailableBytes('nonsense', total), null)
})
