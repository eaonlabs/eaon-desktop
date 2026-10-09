import { test } from 'node:test'
import assert from 'node:assert/strict'
import { errorText, explainUpdateError } from '../src/renderer/src/lib/errors'

test('an IPC error loses Electron’s wrapper', () => {
  assert.equal(errorText(new Error("Error invoking remote method 'background:set': Error: Not available here.")), 'Not available here.')
  assert.equal(errorText(new Error("Error invoking remote method 'x:y': TypeError: bad")), 'bad')
  assert.equal(errorText('plain'), 'plain')
})

test('update failures read as what happened and what to do', () => {
  const offline = explainUpdateError('net::ERR_INTERNET_DISCONNECTED')
  assert.match(offline.message, /internet connection/)
  assert.equal(offline.offerDownload, false)

  // electron-updater's real wording when a release lacks this platform's feed.
  const missing = explainUpdateError(
    'Cannot find latest-mac.yml in the latest release artifacts (https://github.com/eaonlabs/eaon-desktop/releases/download/v2026.6.1/latest-mac.yml): HttpError: 404 \n"method: GET url: …"\n\nHeaders: {…}'
  )
  assert.match(missing.message, /doesn't have an update for this system yet/)
  assert.equal(missing.offerDownload, true)

  assert.match(explainUpdateError('HttpError: 403 Forbidden "API rate limit exceeded for 1.2.3.4"').message, /limiting/)
  assert.match(explainUpdateError('Cannot update while running on a read-only volume.').message, /Move it to Applications/)
  assert.match(explainUpdateError('Code signature at URL file:///… did not pass validation: code failed to satisfy specified code requirement(s)').message, /couldn't be verified/)
  assert.match(explainUpdateError('sha512 checksum mismatch, expected abc, got def').message, /damaged/)
  assert.match(explainUpdateError('ENOSPC: no space left on device, write').message, /disk space/)
  assert.match(explainUpdateError('Updates are unavailable in development builds.').message, /development build/)
  assert.match(explainUpdateError('ETIMEDOUT').message, /dropped/)
  // Anything else still says what to do, never just the raw text.
  const other = explainUpdateError('Something nobody has seen before')
  assert.match(other.message, /releases page/)
  assert.equal(other.offerDownload, true)
})
