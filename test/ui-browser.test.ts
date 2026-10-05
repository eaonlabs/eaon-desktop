import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toBrowserUrl } from '../src/renderer/src/lib/browserUrl'

test('the address bar opens addresses and searches everything else', () => {
  assert.equal(toBrowserUrl(''), null)
  assert.equal(toBrowserUrl('   '), null)
  assert.equal(toBrowserUrl('https://example.com/a?b=c'), 'https://example.com/a?b=c')
  assert.equal(toBrowserUrl('example.com'), 'https://example.com')
  assert.equal(toBrowserUrl('docs.eaon.dev/path#x'), 'https://docs.eaon.dev/path#x')
  assert.equal(toBrowserUrl('localhost:5173'), 'http://localhost:5173')
  assert.equal(toBrowserUrl('192.168.1.10:8080'), 'https://192.168.1.10:8080')
  assert.equal(toBrowserUrl('about:blank'), 'about:blank')
  assert.equal(toBrowserUrl('what is 1.5 times 2'), 'https://duckduckgo.com/?q=what%20is%201.5%20times%202')
  assert.equal(toBrowserUrl('1.5'), 'https://duckduckgo.com/?q=1.5')
  assert.equal(toBrowserUrl('cats', 'Google'), 'https://www.google.com/search?q=cats')
  assert.equal(toBrowserUrl('cats', 'Bing'), 'https://www.bing.com/search?q=cats')
  // Not a scheme the panel should run.
  assert.equal(toBrowserUrl('javascript:alert(1)'), 'https://duckduckgo.com/?q=javascript%3Aalert(1)')
})
