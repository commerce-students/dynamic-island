'use strict'

/**
 * A LocalSend receiver.
 *
 * LocalSend talks a small REST protocol over the LAN: a sender asks
 * `POST /api/localsend/v2/prepare-upload` with metadata, gets a session id and
 * one token per file, then streams each file to `POST /api/localsend/v2/upload`
 * with that token. Discovery is a UDP multicast to 224.0.0.167:53317.
 *
 * Two deliberate choices:
 *
 *  - **Plain HTTP.** The receiver announces `protocol: "http"`, which the
 *    protocol allows; senders follow whatever the receiver announces. That
 *    avoids shipping a self-signed certificate, which would only teach people
 *    to click through a security warning.
 *  - **Nothing is accepted by itself.** `onRequest` must answer with an object
 *    (or a promise of one). If it throws, times out, or the app is closing,
 *    the sender is declined with 403.
 *
 * The receiver runs on its own port (53318 by default) so it can coexist with
 * the real LocalSend app, which owns 53317.
 */

const http = require('http')
const dgram = require('dgram')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const PROTOCOL_VERSION = '2.1'
const MULTICAST_ADDRESS = '224.0.0.167'
const DEFAULT_DISCOVERY_PORT = 53317
const MAX_FILES = 500
const MAX_FILE_BYTES = 40 * 1024 * 1024 * 1024
const MAX_TOTAL_BYTES = 100 * 1024 * 1024 * 1024
const MAX_JSON_BYTES = 1024 * 1024
const SESSION_TTL_MS = 5 * 60 * 1000

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** A file name that is safe to create inside the save folder. */
function sanitiseName(input) {
  // Take the last path segment first: stripping separators before this would
  // turn "C:\\x\\photo.jpg" into "C__x_photo.jpg" instead of "photo.jpg".
  let name = String(input == null ? '' : input)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .split(/[\\/]/)
    .pop()
    .replace(/[:*?"<>|]/g, '_')
    .trim()

  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '')
  name = path.basename(name)
  if (!name) name = 'file'
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`
  if (name.length > 140) {
    const ext = path.extname(name).slice(0, 16)
    name = name.slice(0, 140 - ext.length) + ext
  }
  return name
}

/** `photo.jpg` -> `photo (1).jpg` when it is already there. */
function uniqueName(dir, name) {
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = name
  let index = 1
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem} (${index})${ext}`
    index += 1
    if (index > 999) { candidate = `${stem} (${Date.now()})${ext}`; break }
  }
  return candidate
}

function token() {
  return crypto.randomBytes(24).toString('hex')
}

function sessionId() {
  return crypto.randomBytes(16).toString('hex')
}

/**
 * Turns a prepare-upload body into something we are willing to act on, or
 * explains why not. Never throws on hostile input.
 */
function readPrepare(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Body must be a JSON object.' }
  }

  const info = body.info && typeof body.info === 'object' ? body.info : {}
  const sender = {
    alias: String(info.alias || 'Unknown device').slice(0, 60),
    deviceModel: String(info.deviceModel || '').slice(0, 60),
    deviceType: String(info.deviceType || '').slice(0, 20),
    fingerprint: String(info.fingerprint || '').slice(0, 120)
  }

  const raw = body.files && typeof body.files === 'object' ? body.files : null
  if (!raw) return { ok: false, status: 400, error: 'No files.' }

  const entries = Object.entries(raw)
  if (!entries.length) return { ok: false, status: 400, error: 'No files.' }
  if (entries.length > MAX_FILES) {
    return { ok: false, status: 413, error: `More than ${MAX_FILES} files.` }
  }

  const files = []
  let total = 0

  for (const [key, value] of entries) {
    if (!value || typeof value !== 'object') continue
    const id = String(value.id || key).slice(0, 64)
    if (!id) continue
    const size = Number(value.size)

    if (!Number.isFinite(size) || size < 0) {
      return { ok: false, status: 400, error: 'A file has no valid size.' }
    }
    if (size > MAX_FILE_BYTES) {
      return { ok: false, status: 413, error: 'A file is too large.' }
    }

    total += size
    if (total > MAX_TOTAL_BYTES) {
      return { ok: false, status: 413, error: 'The transfer is too large.' }
    }

    files.push({
      id,
      name: sanitiseName(value.fileName || 'file'),
      size,
      type: String(value.fileType || 'application/octet-stream').slice(0, 120),
      sha256: typeof value.sha256 === 'string' ? value.sha256.slice(0, 64) : ''
    })
  }

  if (!files.length) return { ok: false, status: 400, error: 'No usable files.' }
  return { ok: true, sender, files, total }
}

function createReceiver({
  port = 53318,
  discoveryPort = DEFAULT_DISCOVERY_PORT,
  discover = true,
  deviceName = 'Dynamic Island',
  saveDir,
  fingerprint = null,
  onRequest = null,
  onFile = () => {},
  onLog = () => {},
  now = Date.now
} = {}) {
  const id = fingerprint || crypto.randomBytes(8).toString('hex')
  let server = null
  let socket = null
  let announceTimer = null
  let session = null
  let boundPort = 0
  let startedAt = 0

  function info() {
    return {
      alias: deviceName,
      version: PROTOCOL_VERSION,
      deviceModel: 'Windows PC',
      deviceType: 'desktop',
      fingerprint: id,
      port: boundPort || port,
      protocol: 'http',
      download: false
    }
  }

  function log(message, level = 'info') {
    try { onLog({ level, message, at: now() }) } catch { /* ignore */ }
  }

  function json(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': '',
      'X-Content-Type-Options': 'nosniff'
    })
    res.end(body)
  }

  function readJson(req) {
    return new Promise((resolve) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_JSON_BYTES) {
          resolve({ ok: false, status: 413, error: 'Body too large.' })
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (size > MAX_JSON_BYTES) return
        let parsed
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''))
        } catch {
          resolve({ ok: false, status: 400, error: 'Invalid JSON.' })
          return
        }
        resolve({ ok: true, body: parsed })
      })
      req.on('error', () => resolve({ ok: false, status: 400, error: 'Bad request.' }))
    })
  }

  function closeSession(reason) {
    if (!session) return
    try { clearTimeout(session.timer) } catch { /* gone */ }
    session = null
    if (reason) log(`Session closed: ${reason}`)
  }

  async function handlePrepare(req, res) {
    if (session) {
      json(res, 409, { error: 'Another transfer is already in progress.' })
      return
    }

    const parsed = await readJson(req)
    if (!parsed.ok) { json(res, parsed.status, { error: parsed.error }); return }

    const request = readPrepare(parsed.body)
    if (!request.ok) { json(res, request.status, { error: request.error }); return }

    if (!saveDir) { json(res, 500, { error: 'No save folder.' }); return }
    try {
      fs.mkdirSync(saveDir, { recursive: true })
    } catch (err) {
      log(`Cannot create the save folder: ${err.message}`, 'error')
      json(res, 500, { error: 'Could not create the save folder.' })
      return
    }

    const snapshot = {
      id: sessionId(),
      sender: request.sender,
      files: new Map(request.files.map((file) => [file.id, { ...file, token: token(), received: 0, written: false }])),
      total: request.total,
      createdAt: now()
    }

    let decision = { accepted: false }
    try {
      if (typeof onRequest === 'function') {
        decision = await onRequest({
          id: snapshot.id,
          sender: snapshot.sender,
          files: request.files.map(({ id: fileId, name, size, type }) => ({ id: fileId, name, size, type })),
          total: request.total
        }) || { accepted: false }
      }
    } catch (err) {
      log(`Declined after an error: ${err.message}`, 'error')
      decision = { accepted: false }
    }

    if (!decision.accepted) {
      json(res, 403, { error: 'Declined.' })
      return
    }

    // A decision can accept a subset of the files.
    const wanted = Array.isArray(decision.fileIds) ? new Set(decision.fileIds.map(String)) : null
    if (wanted) {
      for (const key of [...snapshot.files.keys()]) {
        if (!wanted.has(key)) snapshot.files.delete(key)
      }
      if (!snapshot.files.size) { json(res, 403, { error: 'Declined.' }); return }
    }

    session = snapshot
    session.timer = setTimeout(() => closeSession('timed out'), SESSION_TTL_MS)
    if (session.timer.unref) session.timer.unref()

    log(`Accepted ${snapshot.files.size} file(s) from ${snapshot.sender.alias}`)

    const files = {}
    for (const [fileId, entry] of session.files) files[fileId] = entry.token
    json(res, 200, { sessionId: snapshot.id, files })
  }

  function handleUpload(req, res, url) {
    const sid = url.searchParams.get('sessionId') || ''
    const fileId = url.searchParams.get('fileId') || ''
    const sentToken = url.searchParams.get('token') || ''

    if (!session || session.id !== sid) {
      json(res, 403, { error: 'Unknown session.' })
      return
    }

    const entry = session.files.get(fileId)
    if (!entry || entry.token !== sentToken) {
      json(res, 403, { error: 'Unknown file.' })
      return
    }
    if (entry.written) {
      json(res, 409, { error: 'That file was already uploaded.' })
      return
    }

    const target = uniqueName(saveDir, entry.name)
    const temp = path.join(saveDir, `.di-${entry.token.slice(0, 8)}.part`)
    const stream = fs.createWriteStream(temp)
    let received = 0
    let failed = false

    const abort = (status, message) => {
      if (failed) return
      failed = true
      try { stream.destroy() } catch { /* gone */ }
      try { fs.unlinkSync(temp) } catch { /* gone */ }
      if (!res.headersSent) json(res, status, { error: message })
    }

    req.on('data', (chunk) => {
      received += chunk.length
      if (received > entry.size + 1) abort(413, 'More data than declared.')
    })
    req.on('aborted', () => abort(400, 'Upload aborted.'))
    req.on('error', () => abort(400, 'Upload failed.'))
    stream.on('error', (err) => abort(500, `Could not write the file: ${err.message}`))

    stream.on('finish', () => {
      if (failed) return
      if (received !== entry.size) {
        try { fs.unlinkSync(temp) } catch { /* gone */ }
        json(res, 400, { error: 'Size did not match what was declared.' })
        return
      }
      const finalPath = path.join(saveDir, target)
      try {
        fs.renameSync(temp, finalPath)
      } catch (err) {
        try { fs.unlinkSync(temp) } catch { /* gone */ }
        json(res, 500, { error: `Could not save the file: ${err.message}` })
        return
      }

      entry.written = true
      entry.path = finalPath
      json(res, 200, { ok: true })

      try {
        onFile({
          name: target,
          path: finalPath,
          size: received,
          type: entry.type,
          sender: session ? session.sender.alias : ''
        })
      } catch (err) {
        log(`File callback failed: ${err.message}`, 'error')
      }

      const remaining = [...(session ? session.files.values() : [])].filter((file) => !file.written)
      if (session && remaining.length === 0) closeSession('complete')
    })

    req.pipe(stream)
  }

  function handleRequest(req, res) {
    let url
    try {
      url = new URL(req.url, 'http://localhost')
    } catch {
      json(res, 400, { error: 'Bad URL.' })
      return
    }
    const pathname = url.pathname

    if (req.method === 'GET' && (pathname === '/api/localsend/v2/info' || pathname === '/api/localsend/v1/info')) {
      json(res, 200, info())
      return
    }

    if (req.method === 'POST' && pathname === '/api/localsend/v2/register') {
      // A sender introducing itself: answer with who we are.
      readJson(req).then((parsed) => {
        if (parsed.ok && parsed.body && parsed.body.fingerprint === id) return
        json(res, 200, info())
      })
      return
    }

    if (req.method === 'POST' && pathname === '/api/localsend/v2/prepare-upload') {
      handlePrepare(req, res).catch((err) => {
        log(`prepare-upload failed: ${err.message}`, 'error')
        if (!res.headersSent) json(res, 500, { error: 'Internal error.' })
      })
      return
    }

    if (req.method === 'POST' && pathname === '/api/localsend/v2/upload') {
      handleUpload(req, res, url)
      return
    }

    if (req.method === 'POST' && pathname === '/api/localsend/v2/cancel') {
      readJson(req).then((parsed) => {
        const wanted = parsed.ok && parsed.body ? String(parsed.body.sessionId || '') : ''
        if (session && (!wanted || session.id === wanted)) closeSession('cancelled by the sender')
        json(res, 200, { ok: true })
      })
      return
    }

    json(res, 404, { error: 'Not found.' })
  }

  function startDiscovery() {
    if (!discover) return
    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

      socket.on('message', (buffer, remote) => {
        let message
        try { message = JSON.parse(buffer.toString('utf8')) } catch { return }
        if (!message || message.fingerprint === id) return
        if (!message.announce) return

        // Answer the broadcaster directly so it lists us immediately.
        const reply = Buffer.from(JSON.stringify({ ...info(), announce: true }))
        try { socket.send(reply, remote.port, remote.address) } catch { /* transient */ }
      })

      socket.on('error', (err) => {
        log(`Discovery is off: ${err.message}`, 'warning')
        try { socket.close() } catch { /* gone */ }
        socket = null
      })

      socket.bind(discoveryPort, () => {
        try {
          socket.setMulticastTTL(2)
          socket.addMembership(MULTICAST_ADDRESS)
        } catch (err) {
          log(`Discovery is limited: ${err.message}`, 'warning')
        }
        announce()
      })

      announceTimer = setInterval(announce, 60 * 1000)
      if (announceTimer.unref) announceTimer.unref()
    } catch (err) {
      log(`Discovery could not start: ${err.message}`, 'warning')
      socket = null
    }
  }

  function announce() {
    if (!socket) return
    const payload = Buffer.from(JSON.stringify({ ...info(), announce: true }))
    try { socket.send(payload, discoveryPort, MULTICAST_ADDRESS) } catch { /* no network */ }
  }

  async function start() {
    if (server) return boundPort
    startedAt = now()

    server = http.createServer((req, res) => {
      try {
        handleRequest(req, res)
      } catch (err) {
        log(`Request failed: ${err.message}`, 'error')
        if (!res.headersSent) json(res, 500, { error: 'Internal error.' })
      }
    })

    server.headersTimeout = 20000
    server.requestTimeout = 0 // large uploads legitimately take a while

    await new Promise((resolve, reject) => {
      const fail = (err) => {
        server.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = () => resolve()
      server.once('error', fail)
      server.once('listening', onListening)
      server.listen(port, '0.0.0.0')
    })

    boundPort = server.address().port
    log(`Listening on 0.0.0.0:${boundPort} as "${deviceName}"`)
    startDiscovery()
    return boundPort
  }

  function stop() {
    closeSession()
    clearInterval(announceTimer)
    announceTimer = null
    if (socket) {
      try { socket.close() } catch { /* gone */ }
      socket = null
    }
    if (server) {
      const closing = server
      server = null
      try { closing.close() } catch { /* gone */ }
    }
    boundPort = 0
  }

  return {
    id,
    start,
    stop,
    announce,
    info,
    get port() { return boundPort || port },
    get running() { return Boolean(server) },
    get startedAt() { return startedAt },
    get activeSession() {
      return session ? { id: session.id, sender: session.sender, total: session.total } : null
    }
  }
}

module.exports = {
  createReceiver,
  sanitiseName,
  uniqueName,
  readPrepare,
  PROTOCOL_VERSION,
  MULTICAST_ADDRESS,
  MAX_FILES
}
