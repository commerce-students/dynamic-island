'use strict'

/**
 * The activity centre's memory.
 *
 * Until now a Live Activity was a 6-second card and nothing more: close the
 * panel and it was gone. This store keeps the last N activities on disk, folds
 * repeats of the same group into one row with a counter, and remembers which
 * ones the user has seen.
 *
 * It is deliberately dumb about the network: only `activities.js` decides what
 * a caller is allowed to send, and everything that arrives here is cleaned
 * again before it is stored, because the file on disk is editable too.
 */

const fs = require('fs')
const path = require('path')

const VERSION = 1
const PRIORITIES = [0, 1, 2]

function clamp01(value) {
  return Math.max(0, Math.min(1, value))
}

function text(value, max) {
  if (value == null) return ''
  return String(value).slice(0, max)
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
}

/** Turns anything into a record the rest of the app can trust. */
function clean(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const title = typeof input.title === 'string' ? input.title.slice(0, 120).trim() : ''
  if (!title) return null

  const priority = Number(input.priority)
  const at = Number(input.at)
  const count = Number(input.count)
  const progress = typeof input.progress === 'number' && Number.isFinite(input.progress)
    ? clamp01(input.progress)
    : null

  return {
    id: text(input.id, 60).trim() || `act_${now}`,
    group: text(input.group, 60).trim() || '',
    title,
    subtitle: text(input.subtitle, 160),
    icon: text(input.icon, 4) || '*',
    tone: ['info', 'success', 'warning', 'error'].includes(input.tone) ? input.tone : 'info',
    priority: PRIORITIES.includes(priority) ? priority : 1,
    progress,
    open: text(input.open, 300).trim(),
    at: Number.isFinite(at) && at > 0 ? at : now,
    read: input.read === true,
    count: Number.isFinite(count) && count > 1 ? Math.min(count, 999) : 1
  }
}

/** Newest first, but time-sensitive cards stay above passive chatter. */
function sort(items) {
  return items.slice().sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority
    return b.at - a.at
  })
}

function createStore({ file, limit = 50, now = Date.now } = {}) {
  let items = []
  let counter = 0

  function cap() {
    const wanted = typeof limit === 'function' ? limit() : limit
    const size = Math.max(5, Math.min(500, Number(wanted) || 50))
    if (items.length > size) items = sort(items).slice(0, size)
  }

  function load() {
    try {
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed) ? parsed : (parsed && parsed.items)
      if (!Array.isArray(list)) throw new Error('unexpected shape')
      items = list.map((item) => clean(item, now())).filter(Boolean)
      cap()
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        // Keep the damaged file for a human, then start clean.
        try { fs.renameSync(file, `${file}.broken`) } catch { /* best effort */ }
        console.error('[activity-store] reset after a bad file:', err.message)
      }
      items = []
    }
    return items
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const temp = `${file}.tmp`
      fs.writeFileSync(temp, JSON.stringify({ version: VERSION, items }, null, 2), 'utf8')
      fs.renameSync(temp, file)
    } catch (err) {
      console.error('[activity-store] could not save', err.message)
    }
  }

  function keyOf(record) {
    return record.group || record.id
  }

  function push(input) {
    const stamp = now()
    const record = clean(input, stamp)
    if (!record) return null

    if (!record.group) record.group = slug(record.title) || record.id
    const key = keyOf(record)
    const existing = items.find((item) => keyOf(item) === key)

    if (existing) {
      // Same group again: update in place, bump the counter, mark unread.
      const merged = { ...existing, ...record, id: existing.id, count: Math.min(existing.count + 1, 999), read: false }
      items = items.filter((item) => item !== existing)
      items.push(merged)
      cap()
      save()
      return merged
    }

    counter += 1
    record.id = record.id === `act_${stamp}` ? `act_${stamp}_${counter}` : record.id
    items.push(record)
    cap()
    save()
    return record
  }

  function dismiss(id) {
    const before = items.length
    items = items.filter((item) => item.id !== id)
    if (items.length !== before) save()
    return items.length !== before
  }

  function clear() {
    items = []
    save()
  }

  function markAllRead() {
    let changed = false
    items = items.map((item) => {
      if (!item.read) { changed = true; return { ...item, read: true } }
      return item
    })
    if (changed) save()
    return changed
  }

  function all() {
    return sort(items)
  }

  function unread() {
    return items.reduce((total, item) => total + (item.read ? 0 : 1), 0)
  }

  return { load, save, push, dismiss, clear, markAllRead, all, unread, size: () => items.length }
}

module.exports = { createStore, clean, sort, slug, VERSION }
