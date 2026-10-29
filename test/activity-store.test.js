'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createStore, clean } = require('../src/lib/activity-store')

function tempFile(name = 'activities.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'di-store-'))
  return path.join(dir, name)
}

function makeStore(options = {}) {
  return createStore({ file: tempFile(), limit: 50, ...options })
}

/* ------------------------------------------------------------------ *
 * cleaning
 * ------------------------------------------------------------------ */

test('clean drops records without a title', () => {
  assert.equal(clean({}, 1), null)
  assert.equal(clean({ title: '  ' }, 1), null)
  assert.equal(clean(null, 1), null)
  assert.equal(clean('nope', 1), null)
})

test('clean clamps and whitelists', () => {
  const record = clean({
    title: 'Build',
    priority: 9,
    progress: 2,
    tone: 'shouty',
    count: 0,
    at: -5,
    evil: true,
    __proto__: { polluted: true }
  }, 1000)

  assert.equal(record.priority, 1)
  assert.equal(record.progress, 1)
  assert.equal(record.tone, 'info')
  assert.equal(record.count, 1)
  assert.equal(record.at, 1000)
  assert.equal(record.evil, undefined)
  assert.equal({}.polluted, undefined)
})

/* ------------------------------------------------------------------ *
 * behaviour
 * ------------------------------------------------------------------ */

test('push stores a record and marks it unread', () => {
  const store = makeStore()
  const record = store.push({ title: 'Build finished', tone: 'success' })

  assert.equal(record.title, 'Build finished')
  assert.equal(store.size(), 1)
  assert.equal(store.unread(), 1)
  assert.equal(store.all()[0].read, false)
})

test('the same group updates in place and counts repeats', () => {
  const store = makeStore()
  store.push({ group: 'build', title: 'Build 1' })
  const second = store.push({ group: 'build', title: 'Build 2' })

  assert.equal(store.size(), 1, 'grouped, not duplicated')
  assert.equal(second.count, 2)
  assert.equal(second.title, 'Build 2')
})

test('a record without a group falls back to a slug of the title', () => {
  const store = makeStore()
  store.push({ title: 'Disk almost full' })
  const again = store.push({ title: 'Disk almost full' })

  assert.equal(store.size(), 1)
  assert.equal(again.count, 2)
})

test('priority keeps time-sensitive cards above chatter', () => {
  const store = makeStore()
  store.push({ title: 'low', priority: 0 })
  store.push({ title: 'urgent', priority: 2 })
  store.push({ title: 'normal', priority: 1 })

  assert.deepEqual(store.all().map((item) => item.title), ['urgent', 'normal', 'low'])
})

test('the limit trims the oldest passive cards first', () => {
  const store = createStore({ file: tempFile(), limit: 5 })
  for (let i = 0; i < 10; i += 1) store.push({ title: `tick ${i}`, group: `tick-${i}` })
  assert.equal(store.size(), 5)
})

test('dismiss and clear', () => {
  const store = makeStore()
  const first = store.push({ title: 'one' })
  store.push({ title: 'two' })

  assert.equal(store.dismiss(first.id), true)
  assert.equal(store.size(), 1)
  assert.equal(store.dismiss('missing'), false)

  store.clear()
  assert.equal(store.size(), 0)
  assert.equal(store.unread(), 0)
})

test('markAllRead clears the badge', () => {
  const store = makeStore()
  store.push({ title: 'one' })
  store.push({ title: 'two' })
  assert.equal(store.unread(), 2)

  assert.equal(store.markAllRead(), true)
  assert.equal(store.unread(), 0)
  assert.equal(store.all().every((item) => item.read), true)
})

/* ------------------------------------------------------------------ *
 * disk
 * ------------------------------------------------------------------ */

test('records survive a restart', () => {
  const file = tempFile()
  const first = createStore({ file })
  first.push({ title: 'persisted', group: 'p' })

  const second = createStore({ file })
  second.load()
  assert.equal(second.size(), 1)
  assert.equal(second.all()[0].title, 'persisted')
})

test('a corrupt file is set aside instead of crashing the app', () => {
  const file = tempFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{not json', 'utf8')

  const store = createStore({ file })
  store.load()
  assert.equal(store.size(), 0)
  assert.equal(fs.existsSync(`${file}.broken`), true)
})

test('a missing file is simply empty', () => {
  const store = createStore({ file: tempFile('nope.json') })
  assert.deepEqual(store.load(), [])
  assert.equal(store.size(), 0)
})

test('a hostile stored file cannot smuggle prototype keys in', () => {
  const file = tempFile()
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    items: [{ title: 'x', __proto__: { polluted: true }, extra: 'drop me' }]
  }), 'utf8')

  const store = createStore({ file })
  store.load()
  assert.equal(store.all()[0].extra, undefined)
  assert.equal({}.polluted, undefined)
})
