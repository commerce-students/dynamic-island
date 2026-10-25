'use strict'

/**
 * Live Activities — a tiny local HTTP endpoint so anything on the machine can
 * push a card into the island: a build finishing, a download, a script, a
 * browser bookmarklet, a phone shortcut. This is the honest alternative to
 * intercepting Windows toasts, which is reserved for packaged Store apps.
 *
 *   curl -X POST http://127.0.0.1:39321/push -H "Content-Type: application/json" \
 *        -d "{\"title\":\"Build finished\",\"subtitle\":\"in 42s\",\"icon\":\"*\"}"
 */

const http = require('http')

const MAX_BODY = 16 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      data += chunk
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value))
}

function text(value, max) {
  return value == null ? '' : String(value).slice(0, max)
}

/**
 * One region of a Live Activity card.
 *
 * Apple's ActivityKit gives every Live Activity a handful of regions
 * (compactLeading, compactTrailing, minimal, expanded.leading, ...). We accept
 * the same shape, and fall back to the flat fields for simple callers.
 */
function region(value, maxText = 64) {
  if (value == null) return null
  if (typeof value === 'string') return { text: text(value, maxText) }
  if (typeof value !== 'object') return null
  const out = {}
  if (value.icon != null) out.icon = text(value.icon, 4)
  if (value.title != null) out.title = text(value.title, 120)
  if (value.subtitle != null) out.subtitle = text(value.subtitle, 160)
  if (value.text != null) out.text = text(value.text, maxText)
  if (typeof value.progress === 'number') out.progress = clamp01(value.progress)
  return Object.keys(out).length ? out : null
}

function normalise(payload) {
  if (!payload || typeof payload !== 'object') return null
  const title = text(payload.title, 120)
  if (!title) return null

  const progress = typeof payload.progress === 'number' ? clamp01(payload.progress) : null
  const icon = text(payload.icon, 4) || '*'
  const subtitle = text(payload.subtitle, 160)
  const layout = payload.layout && typeof payload.layout === 'object' ? payload.layout : {}
  const expanded = layout.expanded && typeof layout.expanded === 'object' ? layout.expanded : {}
  const percent = progress == null ? null : `${Math.round(progress * 100)}%`

  return {
    id: text(payload.id, 40) || null,
    title,
    subtitle,
    icon,
    progress,
    tone: ['info', 'success', 'warning', 'error'].includes(payload.tone) ? payload.tone : 'info',
    durationMs: Math.max(1200, Math.min(60000, Number(payload.durationMs) || 6000)),
    open: text(payload.open, 300) || null,

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
GET  /health
`

function start({ port = 39321, onActivity, onClear } = {}) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }

    const url = (req.url || '/').split('?')[0]

    try {
      if (req.method === 'POST' && url === '/push') {
        const body = await readBody(req)
        const activity = normalise(JSON.parse(body || '{}'))
        if (!activity) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'title is required' }))
          return
        }
        onActivity(activity)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, id: activity.id }))
        return
      }

      if (req.method === 'POST' && url === '/clear') {
        onClear()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      if (url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, app: 'dynamic-island' }))
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(HELP)
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: String(err.message || err) }))
    }
  })

  server.on('error', (err) => {
    console.error('[activities]', err.message)
  })

  try {
    server.listen(port, '127.0.0.1')
  } catch (err) {
    console.error('[activities]', err.message)
  }

  return {
    port,
    close: () => { try { server.close() } catch { /* already closed */ } }
  }
}

module.exports = { start }
