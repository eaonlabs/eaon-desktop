import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAuthError } from '../src/main/providers/credentials'
import { ProviderHttpError } from '../src/main/providers/adapters/types'

test('a key with no credit left moves on to the next saved key', () => {
  // Settings promises the next key is tried "if a key fails"; a key whose
  // account is out of credit is the usual reason to have a second one, but
  // only 401/403 used to count.
  assert.equal(isAuthError(new ProviderHttpError(429, '429: You exceeded your current quota, please check your plan and billing details.')), true)
  assert.equal(isAuthError(new ProviderHttpError(400, '400: Your credit balance is too low to access the Anthropic API.')), true)
  assert.equal(isAuthError(new ProviderHttpError(402, '402: Insufficient credits')), true)
  assert.equal(isAuthError(new ProviderHttpError(402, '402: Insufficient Balance')), true)
  assert.equal(isAuthError(new ProviderHttpError(401, '401: invalid x-api-key')), true)
})

test('overloads, rate limits and bad requests are not blamed on the key', () => {
  assert.equal(isAuthError(new ProviderHttpError(429, '429: Rate limit reached for requests')), false)
  assert.equal(isAuthError(new ProviderHttpError(529, '529: Overloaded')), false)
  assert.equal(isAuthError(new ProviderHttpError(400, '400: prompt is too long: 250000 tokens > 200000 maximum')), false)
})
