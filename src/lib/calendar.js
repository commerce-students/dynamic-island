'use strict'

/**
 * Calendar: reads a Google Calendar "secret iCal address" (or any .ics URL),
 * expands simple recurrences and hands back the next events.
 *
 * No OAuth, no API key, no dependency — just a text file over HTTPS.
 */

const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')

const FETCH_TIMEOUT = 15000
const MAX_EVENTS = 60

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'))
    const client = url.startsWith('https:') ? https : http
    const req = client.get(url, { timeout: FETCH_TIMEOUT }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return resolve(fetchText(new URL(res.headers.location, url).toString(), redirects + 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`calendar returned HTTP ${res.statusCode}`))
      }
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve(data))
    })
    req.on('timeout', () => req.destroy(new Error('calendar request timed out')))
    req.on('error', reject)
  })
}

/** ICS folds long lines with a leading space or tab. */
function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '')
}

function parseProperty(line) {
  const colon = line.indexOf(':')
  if (colon < 0) return null
  const head = line.slice(0, colon)
  const value = line.slice(colon + 1)
  const parts = head.split(';')
  const name = parts[0].toUpperCase()
  const params = {}
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=')
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1)
  }
  return { name, params, value }
}

function parseDate(value, params) {
  const raw = value.trim()
  const isDateOnly = params.VALUE === 'DATE' || /^\d{8}$/.test(raw)

  if (isDateOnly) {
    const y = Number(raw.slice(0, 4))
    const m = Number(raw.slice(4, 6)) - 1
    const d = Number(raw.slice(6, 8))
    return { date: new Date(y, m, d), allDay: true }
  }

  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/)
  if (!match) return null
  const [, y, mo, d, h, mi, s, utc] = match
  if (utc) {
    return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), allDay: false }
  }
  // TZID timestamps are treated as local time, which is what a personal
  // calendar almost always means on the machine it is being read on.
  return { date: new Date(+y, +mo - 1, +d, +h, +mi, +s), allDay: false }
}

function expandRule(rrule) {
  const rule = {}
  for (const bit of rrule.split(';')) {
    const [k, v] = bit.split('=')
    if (k && v) rule[k.toUpperCase()] = v.toUpperCase()
  }
  return rule
}

function parseEvents(ics) {
  const lines = unfold(ics).split('\n')
  const events = []
  let inEvent = false
  let current = null

  for (const line of lines) {
    if (line.startsWith('BEGIN:VEVENT')) {
      inEvent = true
      current = {}
      continue
    }
    if (line.startsWith('END:VEVENT')) {
      inEvent = false
      if (current && current.start) events.push(current)
      current = null
      continue
    }
    if (!inEvent || !current) continue

    const prop = parseProperty(line)
    if (!prop) continue

    switch (prop.name) {
      case 'SUMMARY':
        current.summary = prop.value.replace(/\\,/g, ',').replace(/\\n/gi, ' ').trim()
        break
      case 'LOCATION':
        current.location = prop.value.replace(/\\,/g, ',').trim()
        break
      case 'DTSTART': {
        const parsed = parseDate(prop.value, prop.params)
        if (parsed) {
          current.start = parsed.date
          current.allDay = parsed.allDay
        }
        break
      }
      case 'DTEND': {
        const parsed = parseDate(prop.value, prop.params)
        if (parsed) current.end = parsed.date
        break
      }
      case 'RRULE':
        current.rrule = expandRule(prop.value)
        break
      case 'STATUS':
        current.status = prop.value.toUpperCase()
        break
      default:
        break
    }
  }

  return events
}

/** Expand daily/weekly recurrences across the visible window. */
function withRecurrence(event, windowEnd) {
  const out = [{ ...event }]
  const rule = event.rrule
  if (!rule || !rule.FREQ) return out

  const freq = rule.FREQ
  if (freq !== 'DAILY' && freq !== 'WEEKLY') return out

  const until = rule.UNTIL ? (parseDate(rule.UNTIL, {}) || {}).date : null
  const count = rule.COUNT ? Number(rule.COUNT) : 180
  const hardStop = until && until < windowEnd ? until : windowEnd

  let cursor = new Date(event.start)
  let made = 1
  while (made < count) {
    cursor = new Date(cursor)
    cursor.setDate(cursor.getDate() + (freq === 'DAILY' ? 1 : 7))
    if (cursor > hardStop) break
    const length = event.end ? event.end - event.start : 60 * 60 * 1000
    out.push({
      ...event,
      start: new Date(cursor),
      end: new Date(cursor.getTime() + length)
    })
    made += 1
  }
  return out
}

function upcoming(events, { from = new Date(), days = 14, limit = 12 } = {}) {
  const windowEnd = new Date(from.getTime() + days * 24 * 60 * 60 * 1000)
  const expanded = []
  for (const event of events) {
    if (event.status === 'CANCELLED') continue
    expanded.push(...withRecurrence(event, windowEnd))
  }

  return expanded
    .filter((event) => {
      const end = event.end || new Date(event.start.getTime() + 60 * 60 * 1000)
      return end >= from && event.start <= windowEnd
    })
    .sort((a, b) => a.start - b.start)
    .slice(0, limit)
    .map((event) => ({
      summary: event.summary || 'Untitled event',
      location: event.location || '',
      allDay: !!event.allDay,
      start: event.start.toISOString(),
      end: (event.end || new Date(event.start.getTime() + 60 * 60 * 1000)).toISOString()
    }))
}

async function load(config, userDataDir) {
  const cachePath = path.join(userDataDir, 'calendar-cache.ics')
  const url = (config.icsUrl || '').trim()

  if (!url) {
    return { ok: false, reason: 'no-url', events: [] }
  }

  try {
    const ics = await fetchText(url)
    if (!/BEGIN:VCALENDAR/i.test(ics)) throw new Error('that URL did not return a calendar')
    try { fs.writeFileSync(cachePath, ics, 'utf8') } catch { /* cache is best effort */ }
    return {
      ok: true,
      events: upcoming(parseEvents(ics), { days: config.days || 14 })
    }
  } catch (err) {
    // Fall back to the last good copy so a flaky network does not blank the island.
    try {
      const cached = fs.readFileSync(cachePath, 'utf8')
      return {
        ok: true,
        stale: true,
        events: upcoming(parseEvents(cached), { days: config.days || 14 })
      }
    } catch {
      return { ok: false, reason: err.message, events: [] }
    }
  }
}

module.exports = { load, parseEvents, upcoming, fetchText }
