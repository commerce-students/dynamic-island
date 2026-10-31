'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createReceiver, sanitiseName, uniqueName, readPrepare } = require('../src/lib/localsend')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'di-localsend-'))
}

async function withReceiver(options, fn) {
  const dir = tempDir()
  const saved = []
  const receiver = createReceiver({
    port: 0,
    discover: false,
    saveDir: dir,
    deviceName: 'Test Island',
    onRequest: () => ({ accepted: true }),
    onFile: (file) => saved.push(file),
    ...options
  })
  await receiver.start()
  try {
    await fn({ receiver, dir, saved, base: `http://127.0.0.1:${receiver.port}` })
  } finally {
    receiver.stop()
  }
}

const prepareBody = (files, alias = 'Phone') => ({
  info: { alias, version: '2.1', deviceModel: 'iPhone', deviceType: 'mobile', fingerprint: 'abc', port: 1 },
  files: Object.fromEntries(files.map((file, index) => [String(index), file]))
})

/* ------------------------------------------------------------------ *
 * names
 * ------------------------------------------------------------------ */

test('sanitiseName keeps a normal name and strips a path', () => {
  assert.equal(sanitiseName('holiday.jpg'), 'holiday.jpg')
  assert.equal(sanitiseName('../../etc/passwd'), 'passwd')
  assert.equal(sanitiseName('C:\\Windows\\evil.dll'), 'evil.dll')
})

test('sanitiseName removes characters Windows refuses', () => {
  assert.equal(sanitiseName('a<b>c:d"e|f?g*h'), 'a_b_c_d_e_f_g_h')
})

test('sanitiseName handles reserved names, dots and control characters', () => {
  assert.equal(sanitiseName('CON.txt'), '_CON.txt')
  assert.equal(sanitiseName('...hidden'), 'hidden')
  assert.equal(sanitiseName('trailing... '), 'trailing')
  assert.equal(sanitiseName('bad\u0000name.txt'), 'badname.txt')
})

test('sanitiseName never returns an empty name', () => {
  assert.equal(sanitiseName(''), 'file')
  assert.equal(sanitiseName('   '), 'file')
  assert.equal(sanitiseName('..'), 'file')
  assert.equal(sanitiseName(null), 'file')
})

test('sanitiseName caps the length but keeps the extension', () => {
  const long = sanitiseName('a'.repeat(400) + '.mp4')
  assert.ok(long.length <= 140)
  assert.ok(long.endsWith('.mp4'))
})

test('uniqueName numbers a collision instead of overwriting', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'photo.jpg'), 'x')
  assert.equal(uniqueName(dir, 'photo.jpg'), 'photo (1).jpg')

  fs.writeFileSync(path.join(dir, 'photo (1).jpg'), 'x')
  assert.equal(uniqueName(dir, 'photo.jpg'), 'photo (2).jpg')
})

/* ------------------------------------------------------------------ *
 * request cleaning
 * ------------------------------------------------------------------ */

test('readPrepare rejects junk and explains why', () => {
  assert.equal(readPrepare(null).status, 400)
  assert.equal(readPrepare([]).status, 400)
  assert.equal(readPrepare({ info: {} }).status, 400)
  assert.equal(readPrepare({ files: {} }).status, 400)
  assert.equal(readPrepare({ files: { a: { id: 'a', size: 'big' } } }).status, 400)
  assert.equal(readPrepare({ files: { a: { id: 'a', size: -1 } } }).status, 400)
})

test('readPrepare normalises what it accepts', () => {
  const result = readPrepare(prepareBody([
    { id: 'a', fileName: 'C:\\x\\photo.jpg', size: 10, fileType: 'image/jpeg' }
  ]))
  assert.equal(result.ok, true)
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].name, 'photo.jpg')
  assert.equal(result.total, 10)
  assert.equal(result.sender.alias, 'Phone')
})

test('readPrepare refuses an absurd number of files', () => {
  const files = {}
  for (let i = 0; i < 501; i += 1) files[i] = { id: String(i), fileName: `f${i}.txt`, size: 1 }
  assert.equal(readPrepare({ files }).status, 413)
})

/* ------------------------------------------------------------------ *
 * the real thing
 * ------------------------------------------------------------------ */

test('info announces a plain-HTTP receiver', async () => {
  await withReceiver({}, async ({ base }) => {
    const info = await fetch(`${base}/api/localsend/v2/info`).then((r) => r.json())
    assert.equal(info.alias, 'Test Island')
    assert.equal(info.protocol, 'http')
    assert.equal(info.deviceType, 'desktop')
    assert.ok(info.fingerprint)
  })
})

test('a full transfer lands on disk and is reported', async () => {
  await withReceiver({}, async ({ base, dir, saved }) => {
    const payload = Buffer.from('hello from the phone')
    const prepare = await fetch(`${base}/api/localsend/v2/prepare-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prepareBody([
        { id: 'f1', fileName: 'note.txt', size: payload.length, fileType: 'text/plain' }
      ]))
    }).then((r) => r.json())

    assert.ok(prepare.sessionId)
    assert.ok(prepare.files.f1)

    const upload = await fetch(
      `${base}/api/localsend/v2/upload?sessionId=${prepare.sessionId}&fileId=f1&token=${prepare.files.f1}`,
      { method: 'POST', body: payload }
    )
    assert.equal(upload.status, 200)

    const written = fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')
    assert.equal(written, 'hello from the phone')
    assert.equal(saved.length, 1)
    assert.equal(saved[0].name, 'note.txt')
    assert.equal(saved[0].sender, 'Phone')
    assert.equal(fs.existsSync(path.join(dir, '.di-' + prepare.files.f1.slice(0, 8) + '.part')), false)
  })
})

test('a decline is a 403 and creates nothing', async () => {
  await withReceiver({ onRequest: () => ({ accepted: false }) }, async ({ base, dir }) => {
    const response = await fetch(`${base}/api/localsend/v2/prepare-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prepareBody([{ id: 'a', fileName: 'x.txt', size: 3 }]))
    })
    assert.equal(response.status, 403)
    assert.deepEqual(fs.readdirSync(dir), [])
  })
})

test('an onRequest that throws is a decline, not a crash', async () => {
  await withReceiver({ onRequest: () => { throw new Error('user closed the window') } }, async ({ base }) => {
    const response = await fetch(`${base}/api/localsend/v2/prepare-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prepareBody([{ id: 'a', fileName: 'x.txt', size: 3 }]))
    })
    assert.equal(response.status, 403)
  })
})

test('a wrong token cannot write a file', async () => {
  await withReceiver({}, async ({ base, dir }) => {
    const prepare = await fetch(`${base}/api/localsend/v2/prepare-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prepareBody([{ id: 'a', fileName: 'x.txt', size: 3 }]))
    }).then((r) => r.json())

    const denied = await fetch(
      `${base}/api/localsend/v2/upload?sessionId=${prepare.sessionId}&fileId=a&token=deadbeef`,
      { method: 'POST', body: Buffer.from('abc') }
    )
    assert.equal(denied.status, 403)
    assert.deepEqual(fs.readdirSync(dir), [])
  })
})

test('an unknown session cannot write a file', async () => {
  await withReceiver({}, async ({ base }) => {
    const response = await fetch(
      `${base}/api/localsend/v2/upload?sessionId=nope&fileId=a&token=t`,
      { method: 'POST', body: Buffer.from('abc') }
    )
    assert.equal(response.status, 403)
  })
})

test('a file that arrives with the wrong size is thrown away', async () => {
  await withReceiver({}, async ({ base, dir, saved }) => {
    const prepare = await fetch(`${base}/api/localsend/v2/prepare-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prepareBody([{ id: 'a', fileName: 'short.txt', size: 99 }]))
    }).then((r) => r.json())

    const response = await fetch(
      `${base}/api/localsend/v2/upload?sessionId=${prepare.sessionId}&fileId=a&token=${prepare.files.a}`,
      { method: 'POST', body: Buffer.from('too small') }
    )
    assert.equal(response.status, 400)
    assert.deepEqual(fs.readdirSync(dir), [])
    assert.equal(saved.length, 0)
  })
})

test('a hostile file name cannot escape the save folder', async () => {
  await withReceiver({}, async ({ base, dir }) => {
    const payload = Buffer.from('nope')
    const prepare = await fetch(`${base}/api/localsend/v2/prepare-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prepareBody([
        { id: 'a', fileName: '../../escaped.txt', size: payload.length }
      ]))
    }).then((r) => r.json())

    await fetch(
      `${base}/api/localsend/v2/upload?sessionId=${prepare.sessionId}&fileId=a&token=${prepare.files.a}`,
      { method: 'POST', body: payload }
    )

    assert.equal(fs.existsSync(path.join(dir, 'escaped.txt')), true)
    assert.equal(fs.existsSync(path.join(dir, '..', '..', 'escaped.txt')), false)
  })
})

test('a second sender is refused while one transfer is open', async () => {
  await withReceiver({}, async ({ base }) => {
    await fetch(`${base}/api/localsend/v2/prepare-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prepareBody([{ id: 'a', fileName: 'x.txt', size: 3 }]))
    })

    const second = await fetch(`${base}/api/localsend/v2/prepare-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prepareBody([{ id: 'b', fileName: 'y.txt', size: 3 }], 'Other'))
    })
    assert.equal(second.status, 409)
  })
})

test('cancel frees the session for the next sender', async () => {
  await withReceiver({}, async ({ base }) => {
    const prepare = await fetch(`${base}/api/localsend/v2/prepare-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prepareBody([{ id: 'a', fileName: 'x.txt', size: 3 }]))
    }).then((r) => r.json())

    await fetch(`${base}/api/localsend/v2/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: prepare.sessionId })
    })

    const again = await fetch(`${base}/api/localsend/v2/prepare-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prepareBody([{ id: 'b', fileName: 'y.txt', size: 3 }]))
    })
    assert.equal(again.status, 200)
  })
})

test('an accepted subset only writes the chosen files', async () => {
  await withReceiver({
    onRequest: () => ({ accepted: true, fileIds: ['keep'] })
  }, async ({ base, dir }) => {
    const prepare = await fetch(`${base}/api/localsend/v2/prepare-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prepareBody([
        { id: 'keep', fileName: 'keep.txt', size: 2 },
        { id: 'drop', fileName: 'drop.txt', size: 2 }
      ]))
    }).then((r) => r.json())

    assert.deepEqual(Object.keys(prepare.files), ['keep'])
    assert.equal(fs.existsSync(path.join(dir, 'drop.txt')), false)
  })
})

test('a file name already in the folder is not overwritten', async () => {
  await withReceiver({}, async ({ base, dir }) => {
    fs.writeFileSync(path.join(dir, 'note.txt'), 'original')
    const payload = Buffer.from('new')

    const prepare = await fetch(`${base}/api/localsend/v2/prepare-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prepareBody([{ id: 'a', fileName: 'note.txt', size: payload.length }]))
    }).then((r) => r.json())

    await fetch(
      `${base}/api/localsend/v2/upload?sessionId=${prepare.sessionId}&fileId=a&token=${prepare.files.a}`,
      { method: 'POST', body: payload }
    )

    assert.equal(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8'), 'original')
    assert.equal(fs.readFileSync(path.join(dir, 'note (1).txt'), 'utf8'), 'new')
  })
})

test('a bad JSON body is a 400, not a crash', async () => {
  await withReceiver({}, async ({ base }) => {
    const response = await fetch(`${base}/api/localsend/v2/prepare-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json'
    })
    assert.equal(response.status, 400)
  })
})
