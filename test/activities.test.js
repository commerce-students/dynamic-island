'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const activities = require('../src/lib/activities')

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`)
    })
  })
}

async function withServer(options, fn) {
  const server = activities.createServer(options)
  const base = await listen(server)
  try {
    await fn(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function push(base, body, headers = {}) {
  return fetch(`${base}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}

/* ------------------------------------------------------------------ *
 * normalise - the boundary between the network and the renderer
 * ------------------------------------------------------------------ */

test('normalise rejects anything without a usable title', () => {
  assert.equal(activities.normalise(null), null)
  assert.equal(activities.normalise({}), null)
  assert.equal(activities.normalise({ title: '   ' }), null)
  assert.equal(activities.normalise({ title: 42 }), null, 'numbers are not titles')
})

test('normalise keeps only known fields', () => {
  const activity = activities.normalise({
    title: 'Build finished',
    subtitle: 'in 42s',
    tone: 'success',
    progress: 0.5,
    evil: 'ignored',
    __proto__: { polluted: true },
    constructor: 'ignored'
  })

  assert.equal(activity.title, 'Build finished')
  assert.equal(activity.subtitle, 'in 42s')
  assert.equal(activity.tone, 'success')
  assert.equal(activity.progress, 0.5)
  assert.equal(activity.evil, undefined)
  assert.equal(activity.polluted, undefined)
  assert.equal({}.polluted, undefined)
})

test('normalise clamps progress and falls back on unknown tones', () => {
  assert.equal(activities.normalise({ title: 'x', progress: 4 }).progress, 1)
  assert.equal(activities.normalise({ title: 'x', progress: -2 }).progress, 0)
  assert.equal(activities.normalise({ title: 'x', progress: 'half' }).progress, null)
  assert.equal(activities.normalise({ title: 'x', tone: 'nope' }).tone, 'info')
})

test('normalise clamps durationMs into a readable window', () => {
  assert.equal(activities.normalise({ title: 'x', durationMs: 1 }).durationMs, 1200)
  assert.equal(activities.normalise({ title: 'x', durationMs: 10_000_000 }).durationMs, 60000)
  assert.equal(activities.normalise({ title: 'x' }).durationMs, 6000)
  assert.equal(activities.normalise({ title: 'x', durationMs: 'soon' }).durationMs, 6000)
})

test('normalise truncates long strings', () => {
  const activity = activities.normalise({ title: 'a'.repeat(500), subtitle: 'b'.repeat(500) })
  assert.equal(activity.title.length, 120)
  assert.equal(activity.subtitle.length, 160)
})

test('normalise builds compact and expanded regions', () => {
  const activity = activities.normalise({ title: 'Sync', subtitle: '3 files', progress: 0.25 })
  assert.deepEqual(activity.compact.leading, { icon: '*' })
  assert.deepEqual(activity.compact.trailing, { text: '25%' })
  assert.deepEqual(activity.expanded.center, { title: 'Sync', subtitle: '3 files' })
})

test('normalise refuses to let a region smuggle keys through', () => {
  const activity = activities.normalise({
    title: 'Sync',
    layout: { compactLeading: { text: 'ok', evil: 1, __proto__: { polluted: true } } }
  })
  assert.deepEqual(activity.compact.leading, { text: 'ok' })
  assert.equal({}.polluted, undefined)
})

/* ------------------------------------------------------------------ *
 * HTTP surface
 * ------------------------------------------------------------------ */

test('POST /push accepts a local JSON caller', async () => {
  const seen = []
  await withServer({ onActivity: (a) => seen.push(a) }, async (base) => {
    const res = await push(base, { title: 'Build finished', subtitle: 'in 42s' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].title, 'Build finished')
  })
})

test('POST /push requires application/json', async () => {
  const seen = []
  await withServer({ onActivity: (a) => seen.push(a) }, async (base) => {
    const res = await push(base, { title: 'nope' }, { 'Content-Type': 'text/plain' })
    assert.equal(res.status, 415)
    assert.equal(seen.length, 0)
  })
})

test('POST /push refuses browser origins by default', async () => {
  const seen = []
  await withServer({ onActivity: (a) => seen.push(a) }, async (base) => {
    const res = await push(base, { title: 'from a web page' }, { Origin: 'https://evil.example' })
    assert.equal(res.status, 403)
    assert.equal(seen.length, 0)
  })
})

test('POST /push allows a browser origin only when switched on', async () => {
  const seen = []
  await withServer({ onActivity: (a) => seen.push(a), allowBrowser: true }, async (base) => {
    const res = await push(base, { title: 'from a bookmarklet' }, { Origin: 'https://example.com' })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://example.com')
    assert.equal(seen.length, 1)
  })
})

test('OPTIONS is refused unless browser access is on', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/push`, { method: 'OPTIONS', headers: { Origin: 'https://example.com' } })
    assert.equal(res.status, 403)
  })
})

test('POST /push rejects broken JSON with 400', async () => {
  await withServer({}, async (base) => {
    const res = await push(base, '{not json')
    assert.equal(res.status, 400)
  })
})

test('POST /push rejects an oversized body with 413', async () => {
  await withServer({}, async (base) => {
    const res = await push(base, { title: 'x', padding: 'y'.repeat(40 * 1024) })
    assert.equal(res.status, 413)
  })
})

test('POST /push needs a title', async () => {
  await withServer({}, async (base) => {
    const res = await push(base, { subtitle: 'no title' })
    assert.equal(res.status, 400)
  })
})

test('POST /clear calls the clear handler', async () => {
  let cleared = 0
  await withServer({ onClear: () => { cleared += 1 } }, async (base) => {
    const res = await fetch(`${base}/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
    assert.equal(res.status, 200)
    assert.equal(cleared, 1)
  })
})

test('the rate limit answers 429 instead of dropping the card silently', async () => {
  await withServer({}, async (base) => {
    let last = 0
    for (let i = 0; i <= activities.RATE_LIMIT; i += 1) {
      const res = await push(base, { title: `tick ${i}` })
      last = res.status
    }
    assert.equal(last, 429)
  })
})

test('GET /health works and unknown paths are 404', async () => {
  await withServer({}, async (base) => {
    const health = await fetch(`${base}/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true, app: 'dynamic-island' })

    const missing = await fetch(`${base}/nope`)
    assert.equal(missing.status, 404)
  })
})
