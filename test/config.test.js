'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const config = require('../src/config')

const { deepMerge, DEFAULTS } = config

test('deepMerge keeps untouched defaults', () => {
  const merged = deepMerge(DEFAULTS, { general: { position: 'bottom' } })
  assert.equal(merged.general.position, 'bottom')
  assert.equal(merged.general.hotkey, DEFAULTS.general.hotkey)
  assert.equal(merged.ai.provider, DEFAULTS.ai.provider)
})

test('deepMerge does not mutate its inputs', () => {
  const patch = { general: { position: 'bottom' } }
  const before = JSON.stringify(DEFAULTS)
  deepMerge(DEFAULTS, patch)
  assert.equal(JSON.stringify(DEFAULTS), before)
  assert.deepEqual(patch, { general: { position: 'bottom' } })
})

test('deepMerge refuses prototype pollution', () => {
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}')
  const merged = deepMerge(DEFAULTS, hostile)

  assert.equal({}.polluted, undefined)
  assert.equal(Object.prototype.polluted, undefined)
  assert.equal(Object.hasOwn(merged, '__proto__'), false)
  assert.equal(merged.polluted, undefined)
})

test('deepMerge replaces arrays instead of merging them', () => {
  const merged = deepMerge({ list: [1, 2, 3] }, { list: [9] })
  assert.deepEqual(merged.list, [9])
})

test('deepMerge ignores undefined values', () => {
  const merged = deepMerge({ a: 1 }, { a: undefined })
  assert.equal(merged.a, 1)
})

test('every documented default still exists', () => {
  for (const key of ['general', 'appearance', 'media', 'timer', 'ai', 'activities', 'widgets']) {
    assert.ok(DEFAULTS[key], `missing ${key}`)
  }
  assert.equal(DEFAULTS.activities.allowBrowser, false, 'web pages are opt-in')
})
