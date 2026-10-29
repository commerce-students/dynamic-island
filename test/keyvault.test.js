'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createVault, migrateKey, looksSealed } = require('../src/lib/keyvault')

/** Stand-in for DPAPI: reversible, obviously not encryption. */
function fakeBackend({ available = true } = {}) {
  return {
    available: () => available,
    encryptString: (text) => Buffer.from(`sealed:${text}`, 'utf8'),
    // DPAPI throws on ciphertext it did not produce; mirror that.
    decryptString: (buffer) => {
      const text = buffer.toString('utf8')
      if (!text.startsWith('sealed:')) throw new Error('bad ciphertext')
      return text.slice('sealed:'.length)
    }
  }
}

test('seal then open round-trips and hides the key', () => {
  const vault = createVault(fakeBackend())
  const sealed = vault.seal('sk-secret-value')

  assert.ok(looksSealed(sealed))
  assert.equal(sealed.includes('sk-secret-value'), false, 'plaintext must not survive')
  assert.equal(vault.open(sealed), 'sk-secret-value')
})

test('seal returns null when the platform has no encryption', () => {
  const vault = createVault(fakeBackend({ available: false }))
  assert.equal(vault.available(), false)
  assert.equal(vault.seal('sk-secret'), null)
  assert.equal(vault.open('legacy-plain'), 'legacy-plain')
})

test('open survives a corrupt or foreign ciphertext', () => {
  const vault = createVault(fakeBackend())
  assert.equal(vault.open('enc:v1:not-base64!!'), '')
  const throwing = createVault({
    available: () => true,
    encryptString: () => Buffer.from('x'),
    decryptString: () => { throw new Error('wrong user') }
  })
  assert.equal(throwing.open('enc:v1:AAAA'), '')
})

test('migration seals a plaintext key and flags the file for rewrite', () => {
  const { ai, changed } = migrateKey({ provider: 'gemini', apiKey: 'sk-123' }, createVault(fakeBackend()))

  assert.equal(changed, true)
  assert.equal(ai.apiKey, '')
  assert.ok(ai.apiKeyEnc.startsWith('enc:v1:'))
  assert.equal(ai.provider, 'gemini')
})

test('migration decrypts a sealed key into memory only', () => {
  const vault = createVault(fakeBackend())
  const sealed = vault.seal('sk-abc')
  const { ai, changed } = migrateKey({ apiKey: '', apiKeyEnc: sealed }, vault)

  assert.equal(changed, false)
  assert.equal(ai.apiKey, 'sk-abc')
  assert.equal(ai.apiKeyEnc, sealed)
})

test('migration keeps a plaintext key when encryption is unavailable', () => {
  const { ai, changed } = migrateKey({ apiKey: 'sk-123' }, createVault(fakeBackend({ available: false })))
  assert.equal(changed, false)
  assert.equal(ai.apiKey, 'sk-123')
})

test('migration tolerates junk', () => {
  assert.deepEqual(migrateKey(null, createVault(fakeBackend())), { ai: null, changed: false })
  assert.deepEqual(migrateKey([], createVault(fakeBackend())), { ai: [], changed: false })
  const { ai, changed } = migrateKey({ apiKey: 42 }, createVault(fakeBackend()))
  assert.equal(changed, false)
  assert.equal(ai.apiKey, 42)
})
