import { test } from 'node:test'
import assert from 'node:assert/strict'
import { portProblem } from '../src/renderer/src/lib/port'

/** Settings → Local API Server → Port says why a port isn't kept (lib/port.ts). */

test('a whole number from 1024 to 65535 is a port', () => {
  for (const port of ['1024', '1337', ' 8080 ', '65535']) assert.equal(portProblem(port), null, port)
})

test('anything else says why', () => {
  assert.match(portProblem('')!, /Enter a port/)
  assert.match(portProblem('abc')!, /isn’t a port/)
  assert.match(portProblem('4242.6')!, /whole number/)
  assert.match(portProblem('80')!, /below 1024/)
  assert.match(portProblem('70000')!, /up to 65535/)
})
