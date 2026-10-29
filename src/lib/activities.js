'use strict'

/**
 * Live Activities - a tiny local HTTP endpoint so anything on the machine can
 * push a card into the island: a build finishing, a download, a script, a
 * browser bookmarklet, a phone shortcut. This is the honest alternative to
 * intercepting Windows toasts, which is reserved for packaged Store apps.
 *
 *   curl -X POST http://127.0.0.1:39321/push -H "Content-Type: application/json" \
 *        -d "{\"title\":\"Build finished\",\"subtitle\":\"in 42s\",\"icon\":\"*\"}"
 *
 * Security model
 * --------------
 * The port is reachable by every process on the machine and by any web page
 * the user has open. Two cheap rules keep browsers out of it:
 *
 *   1. POST must carry `Content-Type: application/json`. A cross-origin page
 *      cannot send that header without a CORS preflight, which we refuse.
 *   2. A request that arrives with an `Origin` header is rejected outright
 *      unless the user explicitly turned browser access on.
 *
 * Local processes (curl, scripts, CI hooks) send neither, so they just work.
 */

const http = require('http')

const MAX_BODY = 16 * 1024
const RATE_WINDOW_MS = 60 * 1000
const RATE_LIMIT = 30

class BodyTooLarge extends Error {}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    let data = ''
    let tooLarge = false
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (tooLarge) return
      size += chunk.length
      if (size > MAX_BODY) {
        tooLarge = true
        // Keep draining instead of destroying the socket, so the client can
        // still read the 413 we are about to send.
        req.resume()
        reject(new BodyTooLarge('body too large'))
        return
      }
      data += chunk
    })
    req.on('end', () => { if (!tooLarge) resolve(data) })
    req.on('error', reject)
  })
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value))
}

function text(value, max) {
  return value == null ? '' : String(value).slice(0, max)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * One region of a Live Activity card.
 *
 * Apple's ActivityKit gives every Live Activity a handful of regions
 * (compactLeading, compactTrailing, minimal, expanded.leading, ...). We accept
 * the same shape, and fall back to the flat fields for simple callers.
 *
 * Only known keys are copied, so a payload cannot smuggle extra properties
 * (or __proto__) into the renderer.
 */
function region(value, maxText = 64) {
  if (value == null) return null
  if (typeof value === 'string') return { text: text(value, maxText) }
  if (!isPlainObject(value)) return null
  const out = {}
  if (value.icon != null) out.icon = text(value.icon, 4)
  if (value.title != null) out.title = text(value.title, 120)
  if (value.subtitle != null) out.subtitle = text(value.subtitle, 160)
  if (value.text != null) out.text = text(value.text, maxText)
  if (typeof value.progress === 'number' && Number.isFinite(value.progress)) {
    out.progress = clamp01(value.progress)
  }
  return Object.keys(out).length ? out : null
}

/**
 * Turns whatever a caller posted into the card the island understands.
 * Returns null when there is nothing usable, so the caller can answer 400.
 */
function normalise(payload) {
  if (!isPlainObject(payload)) return null
  const title = typeof payload.title === 'string' ? payload.title.slice(0, 120).trim() : ''
  if (!title) return null

  const progress = typeof payload.progress === 'number' && Number.isFinite(payload.progress)
    ? clamp01(payload.progress)
    : null
  const icon = text(payload.icon, 4) || '*'
  const subtitle = text(payload.subtitle, 160)
  const layout = isPlainObject(payload.layout) ? payload.layout : {}
  const expanded = isPlainObject(layout.expanded) ? layout.expanded : {}
  const percent = progress == null ? null : `${Math.round(progress * 100)}%`
  const duration = Number(payload.durationMs)

  return {
    id: text(payload.id, 40).trim() || null,
    group: text(payload.group, 60).trim() || null,
    title,
    subtitle,
    icon,
    progress,
    tone: ['info', 'success', 'warning', 'error'].includes(payload.tone) ? payload.tone : 'info',
    priority: [0, 1, 2].includes(payload.priority) ? payload.priority : 1,
    durationMs: Number.isFinite(duration) ? Math.max(1200, Math.min(60000, duration)) : 6000,
    open: text(payload.open, 300).trim() || null,

    compact: {
      leading: region(layout.compactLeading) || { icon },
      trailing: region(layout.compactTrailing) || (percent ? { text: percent } : null),
      minimal: region(layout.minimal) || { icon }
    },
    expanded: {
      leading: region(expanded.leading) || { icon },
      trailing: region(expanded.trailing) || (percent ? { text: percent } : null),
      center: region(expanded.center) || { title, subtitle },
      bottom: region(expanded.bottom) || (subtitle ? { text: subtitle } : null)
    }
  }
}

const HELP = `Dynamic Island - Live Activities

POST /push   {"title":"Build finished","subtitle":"in 42s","icon":"*","progress":0.4,"tone":"success","durationMs":6000}
             optional: "id" (replace a card with the same id), "open" (URL or window title to open on tap),
             "layout": { "compactLeading": {...}, "compactTrailing": {...}, "minimal": {...},
                         "expanded": { "leading": {...}, "trailing": {...}, "center": {...}, "bottom": {...} } }
POST /clear
GET  /activities   recent history, newest first (grouped repeats carry a count)
GET  /health

Requires Content-Type: application/json. Browser-origin requests are refused
unless "Allow web pages" is switched on in Settings -> Live Activities.
`

function normalisePort(value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return 39321
  return port
}

/**
 * Builds the server without listening, so tests can drive it directly.
 */
function createServer({ onActivity = () => {}, onClear = () => {}, onList = null, allowBrowser = false, now = Date.now } = {}) {
  const hits = []

  function rateLimited() {
    const stamp = now()
    while (hits.length && stamp - hits[0] > RATE_WINDOW_MS) hits.shift()
    if (hits.length >= RATE_LIMIT) return true
    hits.push(stamp)
    return false
  }

  function json(res, status, payload) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    })
    res.end(JSON.stringify(payload))
  }

  function isJson(req) {
    const type = String(req.headers['content-type'] || '').toLowerCase()
    return type.startsWith('application/json')
  }

  return http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0]
    const origin = req.headers.origin

    // A browser page that is not explicitly allowed never gets through, not
    // even the CORS preflight, so it cannot read anything back either.
    if (origin && !allowBrowser) {
      json(res, 403, { ok: false, error: 'browser origins are not allowed' })
      return
    }

    if (origin && allowBrowser) {
      res.setHeader('Access-Control-Allow-Origin', String(origin))
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(allowBrowser ? 204 : 403).end()
      return
    }

    if (req.method === 'POST' && (url === '/push' || url === '/clear')) {
      if (!isJson(req)) {
        json(res, 415, { ok: false, error: 'Content-Type must be application/json' })
        return
      }
      if (rateLimited()) {
        json(res, 429, { ok: false, error: 'too many activities, slow down' })
        return
      }
    }

    try {
      if (req.method === 'POST' && url === '/push') {
        const body = await readBody(req)
        let parsed
        try {
          parsed = JSON.parse((body || '{}').replace(/^\uFEFF/, ''))
        } catch {
          json(res, 400, { ok: false, error: 'body must be valid JSON' })
          return
        }
        const activity = normalise(parsed)
        if (!activity) {
          json(res, 400, { ok: false, error: 'title is required' })
          return
        }
        onActivity(activity)
        json(res, 200, { ok: true, id: activity.id })
        return
      }

      if (req.method === 'POST' && url === '/clear') {
        onClear()
        json(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url === '/activities') {
        const state = onList ? onList() : { items: [], unread: 0 }
        json(res, 200, { ok: true, ...state })
        return
      }

      if (req.method === 'GET' && url === '/health') {
        json(res, 200, { ok: true, app: 'dynamic-island' })
        return
      }

      if (req.method === 'GET' && (url === '/' || url === '/help')) {
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Content-Type-Options': 'nosniff'
        })
        res.end(HELP)
        return
      }

      json(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      if (err instanceof BodyTooLarge) {
        json(res, 413, { ok: false, error: 'body too large' })
        return
      }
      json(res, 400, { ok: false, error: 'could not read the request' })
    }
  })
}

function start({ port = 39321, onActivity, onClear, onList, allowBrowser = false } = {}) {
  const wanted = normalisePort(port)
  const server = createServer({ onActivity, onClear, onList, allowBrowser })

  server.on('error', (err) => {
    console.error('[activities]', err.message)
  })

  try {
    server.listen(wanted, '127.0.0.1')
  } catch (err) {
    console.error('[activities]', err.message)
  }

  return {
    port: wanted,
    server,
    close: () => { try { server.close() } catch { /* already closed */ } }
  }
}

module.exports = { start, createServer, normalise, HELP, MAX_BODY, RATE_LIMIT }
