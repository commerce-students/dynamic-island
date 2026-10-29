'use strict'

/**
 * Where the provider key actually lives.
 *
 * On Windows `safeStorage` is DPAPI: the ciphertext is tied to the signed-in
 * user, so copying settings.json to another account or another PC yields
 * nothing readable. The plaintext is only ever held in the main process, and
 * never written back to disk.
 *
 * The backend is injected so this file has no Electron dependency and can be
 * tested with a fake.
 */

const PREFIX = 'enc:v1:'

function looksSealed(value) {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

function createVault(backend) {
  function available() {
    try {
      return Boolean(backend && backend.available())
    } catch {
      return false
    }
  }

  return {
    available,

    /** Returns the stored form, or null when encryption is not available. */
    seal(plain) {
      const value = String(plain || '')
      if (!value) return ''
      if (!available()) return null
      try {
        return PREFIX + backend.encryptString(value).toString('base64')
      } catch {
        return null
      }
    },

    /** Accepts sealed or legacy plaintext, and never throws. */
    open(stored) {
      const value = String(stored || '')
      if (!value) return ''
      if (!looksSealed(value)) return value
      try {
        return backend.decryptString(Buffer.from(value.slice(PREFIX.length), 'base64'))
      } catch {
        return ''
      }
    }
  }
}

/**
 * One-way migration for a settings object.
 *
 * - a plaintext key is sealed and removed from `apiKey` when possible
 * - a sealed key is decrypted into memory
 * - anything unexpected is left alone
 *
 * Returns `{ ai, changed }`; `changed` means the file should be rewritten.
 */
function migrateKey(ai, vault) {
  if (!ai || typeof ai !== 'object' || Array.isArray(ai)) return { ai, changed: false }

  const out = { ...ai }
  const plain = typeof out.apiKey === 'string' ? out.apiKey.trim() : ''
  const sealed = typeof out.apiKeyEnc === 'string' ? out.apiKeyEnc : ''

  // A key the user just typed wins over an older sealed one.
  if (plain && !looksSealed(plain)) {
    const stored = vault.seal(plain)
    if (stored) {
      out.apiKeyEnc = stored
      out.apiKey = ''
      return { ai: out, changed: true }
    }
    // No DPAPI (rare): keep working in plaintext rather than losing the key.
    return { ai: { ...out, apiKey: plain }, changed: false }
  }

  if (!plain && sealed) {
    return { ai: { ...out, apiKey: vault.open(sealed) }, changed: false }
  }

  return { ai: out, changed: false }
}

module.exports = { createVault, migrateKey, looksSealed, PREFIX }
