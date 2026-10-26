import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileResponse } from '../src/main/fileResponse'

/** eaon-file:// answers byte ranges, which a video element asks for (main/fileResponse.ts). */

const dir = mkdtempSync(join(tmpdir(), 'eaon-file-response-'))
const path = join(dir, 'clip.mp4')
writeFileSync(path, Buffer.from('0123456789'))
after(() => rmSync(dir, { recursive: true, force: true }))

test('a whole file comes with its type and says it takes ranges', async () => {
  const response = await fileResponse(path, null)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'video/mp4')
  assert.equal(response.headers.get('accept-ranges'), 'bytes')
  assert.equal(await response.text(), '0123456789')
})

test('a range comes back as just those bytes', async () => {
  const middle = await fileResponse(path, 'bytes=2-5')
  assert.equal(middle.status, 206)
  assert.equal(middle.headers.get('content-range'), 'bytes 2-5/10')
  assert.equal(await middle.text(), '2345')
  assert.equal(await (await fileResponse(path, 'bytes=7-')).text(), '789')
  assert.equal(await (await fileResponse(path, 'bytes=-3')).text(), '789', 'the last three')
  assert.equal(await (await fileResponse(path, 'bytes=8-99')).text(), '89', 'an end past the file stops at it')
})

test('a range past the end, or a file that isn’t there, says so', async () => {
  assert.equal((await fileResponse(path, 'bytes=20-30')).status, 416)
  assert.equal((await fileResponse(join(dir, 'gone.mp4'), null)).status, 404)
})
