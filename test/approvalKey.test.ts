import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalKey, bareToolName, canonicalJson, sameCall } from '../src/main/agent/approvalKey'

/**
 * Approve once must mean exactly one action: the same tool and the same
 * arguments. These are the ways a provider or model can say the same call
 * differently (which must still match) and the ways a different call can
 * look almost the same (which must not).
 */

const email = { to: 'bob@example.com', subject: 'Invoice', body: 'Attached.', attachments: ['a.pdf', 'b.pdf'], cc: null }

test('the same call matches however it is written', () => {
  // Key order, at every level.
  assert.ok(sameCall({ tool: 'email_send', input: email }, { tool: 'email_send', input: { cc: null, attachments: ['a.pdf', 'b.pdf'], body: 'Attached.', subject: 'Invoice', to: 'bob@example.com' } }))
  assert.ok(sameCall({ tool: 'x', input: { a: { y: 1, x: 2 } } }, { tool: 'x', input: { a: { x: 2, y: 1 } } }))
  // A namespace the model put in front of the name, and stray whitespace around it.
  for (const name of ['functions.email_send', 'default_api.email_send', 'tools.email_send', 'functions:email_send', ' email_send ']) {
    assert.ok(sameCall({ tool: name, input: email }, { tool: 'email_send', input: email }), name)
  }
  // `1` and `1.0` are the same number once parsed, as is -0 and 0.
  assert.ok(sameCall({ tool: 'pay', input: JSON.parse('{"amount": 1.0}') }, { tool: 'pay', input: JSON.parse('{"amount": 1}') }))
  assert.ok(sameCall({ tool: 'pay', input: { amount: -0 } }, { tool: 'pay', input: { amount: 0 } }))
  // A key whose value is undefined is a key JSON never had.
  assert.ok(sameCall({ tool: 'x', input: { a: 1, b: undefined } }, { tool: 'x', input: { a: 1 } }))
})

test('a different call never matches', () => {
  const base = { tool: 'run_command', input: { command: 'rm -rf build' } }
  const other = (tool: string, input: Record<string, unknown>): boolean => sameCall(base, { tool, input })
  assert.ok(!other('run_command', { command: 'rm -rf build ' }), 'trailing whitespace')
  assert.ok(!other('run_command', { command: 'rm  -rf build' }), 'inner whitespace')
  assert.ok(!other('run_command', { command: 'rm -rf Build' }), 'case')
  assert.ok(!other('run_command', { command: 'rm -rf build', cwd: '/' }), 'an extra argument')
  assert.ok(!other('run_command', {}), 'a missing argument')
  assert.ok(!other('run_command_v2', { command: 'rm -rf build' }), 'another tool')
  assert.ok(!other('functions.run_commands', { command: 'rm -rf build' }), 'another tool behind a namespace')
  assert.ok(!sameCall({ tool: 'pay', input: { amount: 12 } }, { tool: 'pay', input: { amount: '12' } }), 'a number sent as a string')
  assert.ok(!sameCall({ tool: 'x', input: { list: [1, 2] } }, { tool: 'x', input: { list: [2, 1] } }), 'array order')
  assert.ok(!sameCall({ tool: 'x', input: { cc: null } }, { tool: 'x', input: {} }), 'null is not absent')
  assert.ok(!sameCall({ tool: 'x', input: { a: { b: 1 } } }, { tool: 'x', input: { a: '{"b":1}' } }), 'an object is not its JSON text')
})

test('a namespace is stripped only as a prefix, never from the middle of a name', () => {
  assert.equal(bareToolName('functions.email_send'), 'email_send')
  assert.equal(bareToolName('my_functions_tool'), 'my_functions_tool')
  assert.equal(bareToolName('api_call'), 'api_call')
  assert.equal(bareToolName(undefined), '')
})

test('canonical JSON is stable and parses back to the same value', () => {
  const value = { z: [3, { b: 'x', a: null }], a: true, m: 1.5 }
  const text = canonicalJson(value)
  assert.equal(text, '{"a":true,"m":1.5,"z":[3,{"a":null,"b":"x"}]}')
  assert.deepEqual(JSON.parse(text), value)
  assert.equal(canonicalJson({ n: Number.NaN }), '{"n":null}', 'NaN is null, as in JSON')
  assert.notEqual(approvalKey('a', { b: 1 }), approvalKey('a.b', { b: 1 }))
})
