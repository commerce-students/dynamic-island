'use strict'

/**
 * Watches the folder LocalSend saves into.
 *
 * `fs.watch` is unreliable on Windows for network/OneDrive folders and fires
 * several times per file, so this polls instead: a directory listing every
 * 1.5 s is nothing, and it means a partially written file is never announced
 * mid-copy. A file is reported once its size has stopped changing and it has
 * been quiet for `settleMs`.
 */

const fs = require('fs')
const path = require('path')

/** Half-written files, Office lock files, and OS noise. */
const JUNK = /(^~\$|^\.|\.(part|partial|crdownload|download|tmp|temp|filepart)$|desktop\.ini$|thumbs\.db$)/i

function isJunk(name) {
  return JUNK.test(String(name || ''))
}

function createWatcher({
  dir,
  intervalMs = 1500,
  settleMs = 1200,
  onChange = () => {},
  now = Date.now,
  list = null
} = {}) {
  let timer = null
  let primed = false
  let known = new Map()      // name -> size, at the last accepted state
  let pending = new Map()    // name -> { size, since }

  function readDir() {
    if (list) return list()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const out = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (isJunk(entry.name)) continue
      let stat
      try { stat = fs.statSync(path.join(dir, entry.name)) } catch { continue }
      if (!stat.isFile()) continue
      out.push({ name: entry.name, size: stat.size, mtime: stat.mtimeMs })
    }
    return out
  }

  function tick() {
    const entries = readDir()
    const seen = new Set()
    const fresh = []
    const stamp = now()

    for (const entry of entries) {
      seen.add(entry.name)
      const last = known.get(entry.name)

      // Already reported and unchanged: nothing to do.
      if (last === entry.size) {
        pending.delete(entry.name)
        continue
      }

      const waiting = pending.get(entry.name)
      if (!waiting) {
        pending.set(entry.name, { size: entry.size, since: stamp, mtime: entry.mtime })
        continue
      }

      // Still growing: restart the clock.
      if (waiting.size !== entry.size) {
        pending.set(entry.name, { size: entry.size, since: stamp, mtime: entry.mtime })
        continue
      }

      // Quiet means: the size has not moved for a while, and the file's own
      // timestamp is not from the last moment. The timestamp check is skipped
      // when the clock and the filesystem disagree wildly (injected clocks).
      const mtimeUsable = Number.isFinite(entry.mtime) && Math.abs(stamp - entry.mtime) < 6 * 60 * 60 * 1000
      const quiet = !mtimeUsable || stamp - entry.mtime >= settleMs

      if (stamp - waiting.since >= settleMs && quiet) {
        pending.delete(entry.name)
        known.set(entry.name, entry.size)
        if (primed && entry.size > 0) {
          fresh.push({
            name: entry.name,
            path: path.join(dir, entry.name),
            size: entry.size,
            at: stamp
          })
        }
      }
    }

    // Forget files that are no longer there, so a re-drop is announced again.
    for (const name of [...pending.keys()]) {
      if (!seen.has(name)) pending.delete(name)
    }
    for (const name of [...known.keys()]) {
      if (!seen.has(name)) known.delete(name)
    }

    // The first pass only records what was already in the folder.
    if (!primed) {
      primed = true
      pending.clear()
      known = new Map(entries.map((entry) => [entry.name, entry.size]))
      return []
    }

    for (const item of fresh) {
      try { onChange(item) } catch { /* a listener must not kill the watcher */ }
    }
    return fresh
  }

  function start() {
    if (timer) return
    tick() // baseline
    timer = setInterval(tick, Math.max(400, intervalMs))
    if (timer.unref) timer.unref()
  }

  function stop() {
    clearInterval(timer)
    timer = null
    primed = false
    known = new Map()
    pending = new Map()
  }

  /** Re-baseline, e.g. after the folder changes in Settings. */
  function reset() {
    known = new Map()
    pending = new Map()
    primed = false
    if (timer) tick()
  }

  return { start, stop, reset, tick, isRunning: () => Boolean(timer) }
}

function describeSize(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

module.exports = { createWatcher, describeSize, isJunk, JUNK }
