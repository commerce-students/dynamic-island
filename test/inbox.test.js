'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createWatcher, describeSize, isJunk } = require('../src/lib/inbox')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'di-inbox-'))
}

/**
 * A watcher with a clock we control, so no test ever sleeps.
 *
 * The real watcher reports a file on the first tick where it has been quiet
 * for `settleMs` - so a test that wants an announcement writes the file, takes
 * one "sighting" tick, advances the clock, then ticks again.
 */
function harness(overrides = {}) {
  const dir = tempDir()
  let clock = 1_000_000
  const seen = []
  const watcher = createWatcher({
    dir,
    settleMs: 1000,
    now: () => clock,
    onChange: (item) => seen.push(item),
    ...overrides
  })
  return {
    dir,
    seen,
    watcher,
    advance: (ms) => { clock += ms },
    write: (name, content = 'hello') => fs.writeFileSync(path.join(dir, name), content),
    remove: (name) => fs.unlinkSync(path.join(dir, name)),
    /// Tick, wait for the settle window, tick again.
    settle: () => { clock += 1200; return watcher.tick() }
  }
}

test('files already in the folder are never announced', () => {
  const h = harness()
  h.write('old.zip', 'existing')
  h.watcher.tick()               // baseline
  h.advance(5000)
  assert.equal(h.watcher.tick().length, 0)
  h.advance(5000)
  assert.equal(h.watcher.tick().length, 0)
  assert.equal(h.seen.length, 0)
})

test('a new file is announced once it has settled', () => {
  const h = harness()
  h.watcher.tick()
  h.write('photo.jpg')

  assert.equal(h.watcher.tick().length, 0, 'first sighting waits')
  const fresh = h.settle()

  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].name, 'photo.jpg')
  assert.equal(fresh[0].size, 5)
  assert.equal(h.seen.length, 1)
})

test('a file still being written is not announced mid-copy', () => {
  const h = harness()
  h.watcher.tick()

  h.write('big.iso', '12345')
  h.watcher.tick()
  h.advance(900)

  fs.appendFileSync(path.join(h.dir, 'big.iso'), '67890')
  h.watcher.tick()          // the size moved: the clock restarts
  h.advance(500)
  assert.equal(h.watcher.tick().length, 0, 'still growing')

  h.advance(1200)
  const fresh = h.watcher.tick()
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].size, 10, 'the finished size, not the first chunk')
})

test('a file is announced only once', () => {
  const h = harness()
  h.watcher.tick()
  h.write('once.txt')
  h.watcher.tick()
  h.settle()

  h.advance(5000)
  assert.equal(h.watcher.tick().length, 0)
  assert.equal(h.seen.length, 1)
})

test('junk and half-written files are ignored', () => {
  const h = harness()
  h.watcher.tick()
  for (const name of ['x.part', 'x.crdownload', '~$report.docx', '.hidden', 'Thumbs.db', 'setup.tmp']) {
    h.write(name)
  }
  h.watcher.tick()
  h.settle()
  assert.equal(h.seen.length, 0)
})

test('a file that disappears while waiting is forgotten', () => {
  const h = harness()
  h.watcher.tick()
  h.write('gone.bin')
  h.watcher.tick()
  h.remove('gone.bin')
  h.advance(5000)

  assert.equal(h.watcher.tick().length, 0)
  assert.equal(h.seen.length, 0)

  // Dropping the same name again is a new transfer.
  h.write('gone.bin')
  h.watcher.tick()
  assert.equal(h.settle().length, 1)
})

test('a re-downloaded file with a newer timestamp is reported again', () => {
  const h = harness()
  h.watcher.tick()
  h.write('setup.exe', 'v1')
  h.watcher.tick()
  h.settle()

  fs.unlinkSync(path.join(h.dir, 'setup.exe'))
  h.watcher.tick()
  h.write('setup.exe', 'version two')
  h.watcher.tick()
  h.advance(1200)

  const fresh = h.watcher.tick()
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].size, 11)
})

test('a missing folder is not fatal', () => {
  const watcher = createWatcher({ dir: path.join(tempDir(), 'nope') })
  assert.deepEqual(watcher.tick(), [])
})

test('a listener that throws cannot stop the watcher', () => {
  const dir = tempDir()
  let clock = 1000
  const watcher = createWatcher({
    dir,
    settleMs: 500,
    now: () => clock,
    onChange: () => { throw new Error('boom') }
  })
  watcher.tick()
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x')
  watcher.tick()
  clock += 1000
  assert.doesNotThrow(() => watcher.tick())
})

test('stop clears state so the next start re-baselines', () => {
  const h = harness()
  h.watcher.tick()
  h.write('before-stop.txt')
  h.watcher.tick()
  h.settle()

  h.watcher.stop()
  h.write('after-stop.txt')
  h.watcher.tick() // baseline: neither file counts as new
  h.advance(5000)
  assert.equal(h.watcher.tick().length, 0)
  assert.equal(h.seen.length, 1, 'only the first file was ever announced')
})

test('sizes are human', () => {
  assert.equal(describeSize(0), '0 B')
  assert.equal(describeSize(512), '512 B')
  assert.equal(describeSize(2048), '2.0 KB')
  assert.equal(describeSize(5 * 1024 * 1024), '5.0 MB')
  assert.equal(describeSize(3 * 1024 * 1024 * 1024), '3.00 GB')
})

test('the junk pattern is what we think it is', () => {
  assert.equal(isJunk('a.part'), true)
  assert.equal(isJunk('holiday.jpg'), false)
  assert.equal(isJunk('~$budget.xlsx'), true)
})
