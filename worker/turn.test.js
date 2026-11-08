import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { turnCredentials } from './index.js'

// Matches coturn's check: base64(HMAC-SHA1(secret, username)), with the expiry an hour ahead.
const { username, credential } = await turnCredentials('test-secret', 1_700_000_000_000)
assert.equal(username, '1700003600:cardbox')
assert.equal(credential, createHmac('sha1', 'test-secret').update(username).digest('base64'))
console.log('turn tests passed')
