import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { redactSecrets } from '../src/main/redact'
import { crashLogPath, logCrash } from '../src/main/crashGuard'

/** Keys, tokens and card numbers never reach a log file or a details panel. */

const SECRETS = {
  anthropic: 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  openai: 'sk-proj-ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210',
  gateway: 'eaon-Qm9vLmJhci5iYXoucXV4LmZvbzEyMzQ1',
  github: 'ghp_1234567890abcdefghijABCDEFGHIJ123456',
  telegram: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  card: '4242 4242 4242 4242'
}

test('keys in every shape they reach a log are blanked', () => {
  const samples = [
    `Authorization: Bearer ${SECRETS.openai}`,
    `{"headers":{"x-api-key":"${SECRETS.anthropic}"}}`,
    `fetch https://api.example.com/v1/models?key=${SECRETS.gateway}&page=2 failed`,
    `https://user:hunter2-very-secret@example.com/repo.git`,
    `GET https://api.telegram.org/bot${SECRETS.telegram}/getUpdates`,
    `token=${SECRETS.github}`,
    `id_token: ${SECRETS.jwt}`,
    `paid with ${SECRETS.card}`,
    `OPENAI_API_KEY=${SECRETS.openai}`,
    '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n-----END OPENSSH PRIVATE KEY-----'
  ]
  for (const sample of samples) {
    const out = redactSecrets(sample)
    for (const secret of [...Object.values(SECRETS), 'hunter2-very-secret', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU']) {
      assert.ok(!out.includes(secret), `${secret} left in: ${out}`)
    }
  }
  assert.match(redactSecrets(`Bearer ${SECRETS.openai}`), /Bearer sk-p…\[redacted\]|Bearer sk-proj…\[redacted\]/)
  assert.match(redactSecrets(SECRETS.anthropic), /^sk-ant-…\[redacted\]$/, 'enough is kept to say which key it was')
})

test('ordinary log text is left as it was', () => {
  for (const text of [
    'Order 1182 confirmed at 2026-10-04T10:00:00.000Z',
    'request 1234567890123 took 412 ms', // 13 digits that fail Luhn
    'token limit of 200,000 reached',
    'GET https://example.com/search?q=sk-learn&page=2',
    '[workers] failed to record a turn: ENOENT'
  ]) {
    assert.equal(redactSecrets(text), text, text)
  }
})

test('crashes.log never holds a key', () => {
  ;(app as unknown as { setPath?: (name: string, path: string) => void }).setPath?.('userData', mkdtempSync(join(tmpdir(), 'eaon-crash-')))
  const error = new Error(`401 from https://api.example.com/v1?key=${SECRETS.gateway}: Bearer ${SECRETS.openai}`)
  logCrash('main: unhandled rejection', error)
  logCrash('renderer gone (webview)', `crashed, https://accounts.example.com/callback?code=4/0AbCdEfGh1234567890&state=x`)
  const log = readFileSync(crashLogPath(), 'utf8')
  for (const secret of [SECRETS.gateway, SECRETS.openai, '4/0AbCdEfGh1234567890']) assert.ok(!log.includes(secret), secret)
  assert.match(log, /unhandled rejection/)
})
