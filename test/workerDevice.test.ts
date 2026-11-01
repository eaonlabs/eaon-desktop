import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createShortcuts } from '../src/main/features/workers/shortcuts'
import { findPasswordsExport, waitForPasswordsExport } from '../src/main/features/workers/passwordsExport'
import { cameraRequest } from '../src/main/features/workers/cameraView'
import type { Connectors } from '../src/main/features/workers/connectors'
import { normalizeCard } from '@shared/workerCards'

/**
 * What reaches past the browser to the user's own Mac (labs): their
 * Shortcuts, their Passwords app's export, and a Home Assistant camera's
 * picture and live view on a card.
 */

const g = globalThis as { __EAON_LABS__?: boolean }
beforeEach(() => {
  g.__EAON_LABS__ = true
})
afterEach(() => {
  delete g.__EAON_LABS__
})

test('Shortcuts: a shortcut is found by its name, run with text input, and its output returned', async () => {
  const calls: string[][] = []
  const shortcuts = createShortcuts(async (args) => {
    calls.push(args)
    if (args[0] === 'list') return 'Good night\nSend ETA\n'
    const out = args[args.indexOf('--output-path') + 1]
    writeFileSync(out, 'Message sent to Sam')
    return ''
  })
  assert.deepEqual(await shortcuts.list(), ['Good night', 'Send ETA'])
  assert.equal(await shortcuts.run('send eta', 'Home by 7'), 'Message sent to Sam', 'its name in any case')
  const run = calls.find((c) => c[0] === 'run')!
  assert.equal(run[1], 'Send ETA', 'run by its exact name')
  assert.ok(run.includes('--input-path'), 'with its input')
  await assert.rejects(() => shortcuts.run('Make coffee'), /no shortcut called “Make coffee”. The user has: Good night, Send ETA/)
  const none = createShortcuts(async () => '')
  await assert.rejects(() => none.run('anything'), /no shortcuts yet/)
})

test('Passwords: its export is found where it was saved, only when new and whole, and handed over once', async () => {
  const downloads = mkdtempSync(join(tmpdir(), 'eaon-passwords-'))
  const desktop = mkdtempSync(join(tmpdir(), 'eaon-passwords-'))
  const since = Date.now() - 60_000
  const old = join(downloads, 'Passwords old.csv')
  writeFileSync(old, 'Title,URL,Username,Password,Notes,OTPAuth\nOld,https://old.example,me,pw,,\n')
  utimesSync(old, new Date(since - 3600_000), new Date(since - 3600_000))
  writeFileSync(join(downloads, 'budget.csv'), 'Month,Spent\nOct,120\n')
  assert.equal(await findPasswordsExport([downloads, desktop], since), null, 'an older export and some other CSV aren’t it')

  const fresh = join(desktop, 'Passwords.csv')
  writeFileSync(fresh, '﻿Title,URL,Username,Password,Notes,OTPAuth\nGitHub,https://github.com,me,s3cret,,\n')
  utimesSync(fresh, new Date(Date.now() - 2000), new Date(Date.now() - 2000))
  const hit = await findPasswordsExport([downloads, desktop], since)
  assert.equal(hit?.file, fresh)
  assert.match(hit!.text, /GitHub,https:\/\/github\.com/)

  const found: string[] = []
  const wait = waitForPasswordsExport((file) => found.push(file), { folders: [downloads, desktop], since })
  for (let i = 0; i < 50 && found.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
  wait.stop()
  assert.deepEqual(found, [fresh])
})

test('a camera card’s picture and live view come from Home Assistant with its token, and nothing else is served', async () => {
  const asked: { url: string; auth: string | undefined }[] = []
  const http = (async (url: string, init: RequestInit) => {
    asked.push({ url, auth: (init.headers as Record<string, string>).Authorization })
    return new Response('frame', { status: 200, headers: { 'content-type': url.includes('stream') ? 'multipart/x-mixed-replace; boundary=frame' : 'image/jpeg' } })
  }) as unknown as typeof fetch
  const connectors = {
    connected: (id: string) => id === 'home-assistant',
    ha: { base: () => ({ url: 'http://ha.local:8123', headers: { Authorization: 'Bearer t' } }) }
  } as unknown as Connectors
  const live = await cameraRequest(connectors, 'eaon-camera://live/camera.front_door?t=1', undefined, http)
  assert.equal(live.status, 200)
  assert.match(live.headers.get('content-type') ?? '', /multipart/)
  const still = await cameraRequest(connectors, 'eaon-camera://still/camera.front_door', undefined, http)
  assert.equal(await still.text(), 'frame')
  assert.deepEqual(asked, [
    { url: 'http://ha.local:8123/api/camera_proxy_stream/camera.front_door', auth: 'Bearer t' },
    { url: 'http://ha.local:8123/api/camera_proxy/camera.front_door', auth: 'Bearer t' }
  ])
  for (const bad of ['eaon-camera://live/light.porch', 'eaon-camera://live/camera.x%2F..%2Fstates', 'eaon-camera://admin/camera.front_door']) {
    assert.equal((await cameraRequest(connectors, bad, undefined, http)).status, 404, bad)
  }
  const elsewhere = { connected: () => false } as unknown as Connectors
  assert.equal((await cameraRequest(elsewhere, 'eaon-camera://live/camera.front_door', undefined, http)).status, 409, 'not connected here')

  const card = normalizeCard({ kind: 'camera', app: 'ring', title: 'Front door', entity: 'camera.front_door' })
  assert.ok('card' in card && card.card.kind === 'camera' && card.card.entity === 'camera.front_door')
  const notACamera = normalizeCard({ kind: 'camera', title: 'Front door', entity: 'lock.front_door' })
  assert.ok('card' in notACamera && notACamera.card.kind === 'camera' && notACamera.card.entity === undefined)
})
