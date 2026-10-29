'use strict'

/* ============================================================
   Dynamic Island — renderer

   One morphing capsule, driven by a small state machine. Width,
   height and squash are animated by a real spring integrator, so
   the motion has mass instead of being a scripted curve.
   ============================================================ */

const $ = (sel) => document.querySelector(sel)
const pill = $('#pill')
const wrap = $('#pill-wrap')

const SIZES = {
  idle: { w: 132, h: 36 },
  compact: { w: 150, h: 36 },
  music: { w: 396, h: 142 },
  panel: { w: 372, h: 152 },
  activityPanel: { w: 372, h: 316 },
  timer: { w: 310, h: 136 },
  timerMini: { w: 150, h: 36 },
  transient: { w: 268, h: 36 },
  activity: { w: 330, h: 64 },
  activity2: { w: 456, h: 64 },
  call: { w: 330, h: 68 }
}

const DEFAULTS = {
  general: { position: 'top', autoCollapseMs: 8000 },
  appearance: { theme: 'black', accent: '#34c759', opacity: 1, liquid: true, sounds: true, bounce: true, confetti: true },
  media: { enabled: true, showArt: true, autoExpand: true, seek: true, hideWhenPaused: false, reactiveBars: true },
  calls: { enabled: true, mic: true, camera: true, notifyOnStart: true, banner: true },
  indicators: { focus: true, sharing: true, longPress: true },
  clipboard: { enabled: true },
  calendar: { enabled: false, leadMinutes: 10 },
  volume: { enabled: true }
}

const CALL_APPS = ['Teams', 'Zoom', 'Discord', 'Slack', 'Skype', 'WhatsApp', 'Telegram', 'Webex']

const state = {
  config: DEFAULTS,
  media: null,
  tint: null,
  devices: { mic: [], camera: [] },
  peak: 0,
  lastPeak: 0,
  volume: { level: 0, muted: false, seen: false },
  events: [],
  announced: new Set(),
  activities: [],
  activityHistory: [],
  activityUnread: 0,
  call: null,
  system: { focus: false, sharing: null },
  expanded: false,
  panelOpen: false,
  panelMode: 'home',
  stats: null,
  timer: { running: false, endsAt: 0, total: 0, expanded: false, done: false },
  transient: null,
  hover: false
}

let preview = null

/* ---------------------------- spring ---------------------------- */

function spring(value) {
  return { value, target: value, velocity: 0 }
}

const sw = spring(SIZES.idle.w)
const sh = spring(SIZES.idle.h)
let squash = 0

function stepSpring(s, dt) {
  const stiffness = 320
  const damping = 30
  const force = -stiffness * (s.value - s.target) - damping * s.velocity
  s.velocity += force * dt
  s.value += s.velocity * dt
  if (Math.abs(s.value - s.target) < 0.02 && Math.abs(s.velocity) < 0.02) {
    s.value = s.target
    s.velocity = 0
  }
}

let lastFrame = performance.now()

function tick(now) {
  const dt = Math.min((now - lastFrame) / 1000, 1 / 60)
  lastFrame = now

  stepSpring(sw, dt)
  stepSpring(sh, dt)

  const w = Math.max(24, sw.value)
  const h = Math.max(24, sh.value)
  pill.style.width = w.toFixed(2) + 'px'
  pill.style.height = h.toFixed(2) + 'px'
  pill.style.borderRadius = Math.min(h / 2, 30).toFixed(2) + 'px'

  // Liquid morph: velocity squashes the capsule as it grows, like a soft body.
  if (state.config.appearance.liquid) {
    const speed = (Math.abs(sw.velocity) + Math.abs(sh.velocity) * 0.7) / 2600
    squash += (Math.min(0.075, speed) - squash) * 0.25
  } else {
    squash *= 0.85
  }
  wrap.style.transform = `scale(${(1 + squash).toFixed(4)}, ${(1 - squash * 0.55).toFixed(4)})`

  updateProgress()
  applyPeak()
  requestAnimationFrame(tick)
}

/* ---------------------------- view ---------------------------- */

function resolveView() {
  if (preview) return preview

  if (state.transient) return { view: 'transient', size: SIZES.transient, mini: false }
  if (state.call) return { view: 'call', size: SIZES.call, mini: false }
  if (state.activities.length) {
    return {
      view: 'activity',
      size: state.activities.length > 1 ? SIZES.activity2 : SIZES.activity,
      mini: false
    }
  }

  if (state.timer.running) {
    return state.timer.expanded
      ? { view: 'timer', size: SIZES.timer, mini: false }
      : { view: 'timer', size: SIZES.timerMini, mini: true }
  }

  if (mediaVisible()) {
    return state.expanded
      ? { view: 'music', size: SIZES.music, mini: false }
      : { view: 'compact', size: SIZES.compact, mini: false }
  }

  if (state.panelOpen) {
    if (state.panelMode === 'activity') {
      const rows = state.activityHistory.length
      const wanted = rows ? 48 + rows * 46.5 : 160
      return {
        view: 'panel',
        size: { w: SIZES.activityPanel.w, h: Math.max(120, Math.min(SIZES.activityPanel.h, Math.round(wanted))) },
        mini: false
      }
    }
    return { view: 'panel', size: SIZES.panel, mini: false }
  }
  return { view: 'idle', size: SIZES.idle, mini: false }
}

function mediaVisible() {
  const m = state.media
  if (!m || !m.active || !state.config.media.enabled) return false
  if (state.config.media.hideWhenPaused && m.status !== 'playing') return false
  return true
}

let lastView = ''

function render() {
  const { view, size, mini } = resolveView()
  sw.target = size.w
  sh.target = size.h

  // Size setting: CSS zoom scales the capsule and everything inside it while
  // the spring keeps animating the unscaled width, so motion stays smooth.
  const scale = state.config.appearance.scale || 1
  pill.style.zoom = scale === 1 ? '' : String(scale)

  if (view !== lastView) {
    pill.dataset.view = view
    lastView = view
  }
  pill.classList.toggle('timer-mini', !!mini)

  if (view === 'panel') renderPanel()
  if (view === 'music' || view === 'compact') renderMedia()
  if (view === 'idle') renderIdle()
  if (view === 'timer') renderTimer()
  if (view === 'activity') renderActivityStack()
}

/* ---------------------------- clock ---------------------------- */

const pad = (n) => String(n).padStart(2, '0')
const clockText = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

function renderIdle() {
  $('#idle-time').textContent = clockText()
  const dot = $('#live-dot')
  dot.className = 'live-dot'
  const conf = state.config.calls
  const sharing = state.config.indicators.sharing && state.system.sharing
  if (sharing) dot.classList.add('sharing')
  else if (conf.enabled && conf.mic && state.devices.mic.length) dot.classList.add('mic')
  else if (conf.enabled && conf.camera && state.devices.camera.length) dot.classList.add('camera')
  else if (state.media && state.media.active && state.media.status === 'playing') dot.classList.add('playing')

  $('#flag-moon').classList.toggle('on', !!(state.config.indicators.focus && state.system.focus))
}

setInterval(() => {
  renderIdle()
  const view = pill.dataset.view
  if (view === 'panel' && state.panelMode === 'home') renderPanel()
  tickCalendar()
}, 1000)

/* ---------------------------- panel ---------------------------- */

const fmtBytes = (n) => (n >= 1073741824
  ? (n / 1073741824).toFixed(1) + ' GB'
  : Math.round(n / 1048576) + ' MB')

const fmtUptime = (seconds) => {
  const total = Math.max(0, Math.floor(seconds || 0))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const mins = Math.floor((total % 3600) / 60)
  if (days) return `${days}d ${hours}h`
  return hours ? `${hours}h ${mins}m` : `${mins}m`
}

function paintStats() {
  const stats = state.stats
  if (!stats) return

  const cpu = Math.max(0, Math.min(100, Math.round(stats.cpu || 0)))
  const memory = stats.total ? Math.round((stats.used / stats.total) * 100) : 0

  const cpuBar = $('#stats-cpu-bar')
  const memBar = $('#stats-mem-bar')
  cpuBar.style.width = cpu + '%'
  cpuBar.classList.toggle('hot', cpu >= 80)
  memBar.style.width = memory + '%'
  memBar.classList.toggle('hot', memory >= 90)

  $('#stats-cpu').textContent = cpu + '%'
  $('#stats-mem').textContent = memory + '%'
  $('#stats-foot').textContent =
    `${fmtBytes(stats.used)} of ${fmtBytes(stats.total)} · ${stats.cores || '?'} cores · up ${fmtUptime(stats.uptime)}`
}

function renderPanel() {
  const now = new Date()
  $('#clock-big').textContent = clockText(now)
  $('#clock-date').textContent = now.toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long'
  })
  const inner = $('#panel-home').parentElement
  inner.classList.toggle('mode-timer', state.panelMode === 'timer')
  inner.classList.toggle('mode-stats', state.panelMode === 'stats')
  inner.classList.toggle('mode-activity', state.panelMode === 'activity')
  if (state.panelMode === 'stats') paintStats()
  if (state.panelMode === 'activity') renderActivityCentre()
  paintActivityBadge()
  renderNextEvent()
}

/* ---------------------------- activity centre ---------------------------- */

function timeAgo(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function paintActivityBadge() {
  const badge = $('#activity-badge')
  if (!badge) return
  const unread = state.activityUnread
  badge.hidden = !unread
  badge.textContent = unread > 9 ? '9+' : String(unread)
}

function renderActivityCentre() {
  const list = $('#activity-list')
  const empty = $('#activity-empty')
  const clear = $('#activity-clear')
  if (!list) return

  list.textContent = ''
  const items = state.activityHistory
  empty.hidden = items.length > 0
  list.hidden = items.length === 0
  clear.disabled = items.length === 0

  for (const item of items) {
    const row = document.createElement('div')
    row.className = 'act-row' + (item.read ? '' : ' unread')
    row.tabIndex = 0

    const icon = document.createElement('div')
    icon.className = 'act-icon' + (item.tone && item.tone !== 'info' ? ` tone-${item.tone}` : '')
    icon.textContent = item.icon || '*'

    const body = document.createElement('div')
    body.className = 'act-body'
    const title = document.createElement('div')
    title.className = 'act-title'
    title.textContent = item.title
    body.append(title)

    const meta = document.createElement('div')
    meta.className = 'act-meta'
    const bits = [timeAgo(item.at)]
    if (item.subtitle) bits.push(item.subtitle)
    if (item.count > 1) bits.push(`×${item.count}`)
    if (item.priority === 2) bits.push('time-sensitive')
    meta.textContent = bits.join(' · ')
    body.append(meta)

    const kill = document.createElement('button')
    kill.className = 'act-kill'
    kill.textContent = '×'
    kill.title = 'Dismiss'
    kill.addEventListener('click', async (event) => {
      event.stopPropagation()
      const next = await window.island.activityDismiss(item.id)
      if (next) applyActivityState(next)
      cue('tap')
    })

    const open = () => {
      if (item.open) window.island.open(item.open)
      cue('tap')
    }
    row.addEventListener('click', open)
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        open()
      }
    })

    row.append(icon, body, kill)
    list.append(row)
  }
}

function applyActivityState(payload) {
  if (!payload) return
  if (Array.isArray(payload.items)) state.activityHistory = payload.items
  if (typeof payload.unread === 'number') state.activityUnread = payload.unread
  paintActivityBadge()
  if (pill.dataset.view === 'panel' && state.panelMode === 'activity') renderActivityCentre()
}

function nextEvent() {
  const now = Date.now()
  return state.events.find((e) => new Date(e.end || e.start).getTime() > now) || null
}

function renderNextEvent() {
  const row = $('#panel-event')
  const event = nextEvent()
  if (!event) {
    row.classList.remove('show')
    return
  }
  row.classList.add('show')
  $('#ev-text').textContent = event.summary
  $('#ev-time').textContent = eventTimeLabel(event)
}

function eventTimeLabel(event) {
  const start = new Date(event.start).getTime()
  const now = Date.now()
  const minutes = Math.round((start - now) / 60000)
  if (event.allDay) return 'all day'
  if (minutes < -1) return 'now'
  if (minutes <= 0) return 'now'
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`
}

/** Fire a card when the next meeting is about to start. */
function tickCalendar() {
  const conf = state.config.calendar
  if (!conf.enabled || !state.events.length) return
  const event = nextEvent()
  if (!event) return

  const start = new Date(event.start).getTime()
  const now = Date.now()
  const minutes = Math.round((start - now) / 60000)
  const key = `${event.start}|${event.summary}`

  if (minutes <= (conf.leadMinutes || 10) && minutes >= 0 && !state.announced.has(key)) {
    state.announced.add(key)
    showTransient('cal', `${event.summary} · ${minutes <= 0 ? 'now' : `in ${minutes}m`}`, 6500)
    cue('chime')
  }

  if (state.announced.size > 60) state.announced.clear()
}

/* ---------------------------- media ---------------------------- */

let progressBase = { position: 0, at: 0, duration: 0, playing: false }

function fmt(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0
  return `${Math.floor(seconds / 60)}:${pad(Math.floor(seconds % 60))}`
}

function setArt(box, img, thumbPath) {
  if (!box || !img) return
  if (thumbPath && state.config.media.showArt) {
    const src = 'file:///' + thumbPath.replace(/\\/g, '/')
    if (img.getAttribute('src') !== src) img.src = src
    box.classList.remove('empty')
  } else {
    img.removeAttribute('src')
    box.classList.add('empty')
  }
}

function renderMedia() {
  const m = state.media
  if (!m) return

  const playing = m.status === 'playing'
  $('#song-title').textContent = m.title || 'Unknown track'
  $('#song-artist').textContent = [m.artist, m.album].filter(Boolean).join(' · ') || m.app || ''

  setArt($('#song-art-box'), $('#song-art'), m.thumbPath)
  setArt($('#compact-art-box'), $('#compact-art'), m.thumbPath)

  const bars = $('#music-bars')
  const compactBars = $('#compact-bars')
  bars.classList.toggle('paused', !playing)
  compactBars.classList.toggle('paused', !playing)
  bars.classList.toggle('reactive', !!state.config.media.reactiveBars)
  compactBars.classList.toggle('reactive', !!state.config.media.reactiveBars)

  $('#play-icon').innerHTML = playing
    ? '<path d="M7 4.5h3.2v15H7zM13.8 4.5H17v15h-3.2z"/>'
    : '<path d="M8 5.2v13.6c0 .8.9 1.3 1.6.9l10.4-6.8a1 1 0 0 0 0-1.7L9.6 4.3A1.1 1.1 0 0 0 8 5.2z"/>'

  progressBase = { position: m.position || 0, at: performance.now(), duration: m.duration || 0, playing }
  updateProgress()
}

function currentPosition() {
  const { position, at, duration, playing } = progressBase
  let pos = position
  if (playing) pos += (performance.now() - at) / 1000
  if (duration > 0) pos = Math.min(pos, duration)
  return pos
}

function updateProgress() {
  if (pill.dataset.view !== 'music') return
  const duration = progressBase.duration
  if (!duration) {
    $('#progress-fill').style.width = '0%'
    return
  }
  const pct = Math.max(0, Math.min(100, (currentPosition() / duration) * 100))
  $('#progress-fill').style.width = pct + '%'
  $('#progress-knob').style.left = pct + '%'
  $('#time-now').textContent = fmt(currentPosition())
  $('#time-end').textContent = fmt(duration)
}

/* ---------------------------- reactive bars ---------------------------- */

const peakHistory = new Array(64).fill(0)
setInterval(() => {
  peakHistory.push(state.peak)
  peakHistory.shift()
}, 55)

function applyPeak() {
  if (!state.config.media.reactiveBars) return
  const view = pill.dataset.view
  if (view !== 'music' && view !== 'compact') return
  if (!state.media || state.media.status !== 'playing') return

  const bars = [...document.querySelectorAll('.bars.reactive i')]
  if (!bars.length) return

  const stepped = Math.min(0.55, state.peak * 1.9)
  const wobble = 0.8 + Math.abs(Math.sin(performance.now() / 260)) * 0.3

  bars.forEach((el, index) => {
    const lag = 1 + index * 6
    const sample = peakHistory[peakHistory.length - lag] || 0
    const value = Math.max(sample, stepped * 0.55) * wobble
    const pct = Math.max(14, Math.min(100, 12 + value * 128))
    el.style.height = pct.toFixed(1) + '%'
  })
}

/* ---------------------------- transient ---------------------------- */

const ICONS = {
  vol: '🔊',
  mute: '🔇',
  mic: '🎙',
  cam: '📷',
  clip: '📋',
  cal: '📅',
  timer: '⏱',
  charged: '⚡',
  low: '🪫',
  info: '•'
}

function showTransient(kind, text, ms = 2600, bar = null) {
  const previous = state.transient && state.transient.kind
  state.transient = { kind, text, bar }
  $('#t-icon').textContent = ICONS[kind] || ICONS.info
  $('#t-text').textContent = text
  const barEl = $('#t-bar')
  barEl.classList.toggle('on', bar != null)
  if (bar != null) $('#t-bar-fill').style.width = Math.max(2, Math.min(100, bar)) + '%'
  render()

  if (previous !== kind) {
    pill.classList.remove('nudge')
    void pill.offsetWidth
    if (state.config.appearance.bounce) pill.classList.add('nudge')
  }

  clearTimeout(showTransient._t)
  showTransient._t = setTimeout(() => {
    state.transient = null
    render()
  }, ms)
}

function clearTransient() {
  clearTimeout(showTransient._t)
  stopAlarm()
  if (state.transient) {
    state.transient = null
    render()
  }
}

/* ---------------------------- live activities ---------------------------- */

const activityTimers = new Map()
const activityKey = (activity) => activity.id || activity.title

function textNode(className, value) {
  const node = document.createElement('div')
  node.className = className
  node.textContent = value
  return node
}

/**
 * One card, drawn from the Apple-shaped layout regions. `minimal` is what the
 * card collapses to when two activities are on screen at once.
 */
function paintActivityCard(activity, card, minimal) {
  const regions = activity.expanded || {}
  const leading = (activity.compact && activity.compact.leading) || regions.leading || {}
  const center = regions.center || {}

  const icon = textNode('activity-icon', leading.icon || activity.icon)
  if (activity.tone && activity.tone !== 'info') icon.classList.add(`tone-${activity.tone}`)
  card.append(icon)

  const text = document.createElement('div')
  text.className = 'activity-text'
  text.append(textNode('activity-title', center.title || activity.title))
  const sub = center.subtitle || activity.subtitle
  if (sub && !minimal) text.append(textNode('activity-sub', sub))
  card.append(text)

  const trailing = regions.trailing
  const value = trailing && trailing.text ? trailing.text : ''
  const progress = typeof activity.progress === 'number'
    ? activity.progress
    : (trailing && typeof trailing.progress === 'number' ? trailing.progress : null)

  if (progress != null && !minimal) {
    const bar = document.createElement('div')
    bar.className = 'activity-bar'
    const fill = document.createElement('i')
    fill.style.width = (progress * 100).toFixed(1) + '%'
    bar.append(fill)
    card.append(bar)
  } else if (value) {
    card.append(textNode('activity-value', value))
  }
}

function renderActivityStack() {
  const host = $('#activity-stack')
  const list = state.activities
  const minimal = list.length > 1
  host.classList.toggle('two', minimal)
  host.textContent = ''

  for (const activity of list) {
    const card = document.createElement('div')
    card.className = 'activity-card'
    paintActivityCard(activity, card, minimal)
    card.addEventListener('click', (e) => {
      e.stopPropagation()
      if (activity.open) window.island.open(activity.open)
      cue('tap')
    })
    host.append(card)
  }
}

function showActivity(activity) {
  const key = activityKey(activity)
  const existing = state.activities.findIndex((item) => activityKey(item) === key)
  if (existing >= 0) state.activities.splice(existing, 1)
  state.activities.unshift(activity)
  if (state.activities.length > 2) state.activities.length = 2

  clearTimeout(activityTimers.get(key))
  activityTimers.set(key, setTimeout(() => {
    activityTimers.delete(key)
    state.activities = state.activities.filter((item) => activityKey(item) !== key)
    render()
  }, activity.durationMs || 6000))

  render()
  pill.classList.remove('nudge')
  void pill.offsetWidth
  if (state.config.appearance.bounce) pill.classList.add('nudge')
}

function clearActivities() {
  for (const timer of activityTimers.values()) clearTimeout(timer)
  activityTimers.clear()
  state.activities = []
  render()
}

/* ---------------------------- call banner ---------------------------- */

let callDismissed = false

function showCall(appName) {
  state.call = { app: appName || 'Call' }
  $('#call-app').textContent = appName || 'Call'
  $('#call-sub').textContent = 'Microphone is live'
  render()
}

function hideCall() {
  if (!state.call) return
  state.call = null
  render()
}

$('#call-open').addEventListener('click', () => {
  if (state.call) window.island.focusApp(state.call.app)
})
$('#call-close').addEventListener('click', () => {
  callDismissed = true
  hideCall()
})

/* ---------------------------- timer ---------------------------- */

const RING = 2 * Math.PI * 19

function startTimer(minutes) {
  state.timer = {
    running: true,
    endsAt: Date.now() + minutes * 60000,
    total: minutes * 60000,
    expanded: true,
    done: false
  }
  state.panelOpen = false
  state.panelMode = 'home'
  render()
  cue('expand')
  clearTimeout(startTimer._collapse)
  startTimer._collapse = setTimeout(() => {
    if (state.timer.running && !state.hover) {
      state.timer.expanded = false
      render()
    }
  }, 4200)
}

function cancelTimer() {
  stopAlarm()
  state.timer.running = false
  state.timer.expanded = false
  clearTimeout(startTimer._collapse)
  render()
}

function renderTimer() {
  const left = Math.max(0, state.timer.endsAt - Date.now())
  const frac = state.timer.total ? left / state.timer.total : 0
  const ring = $('#ring-fill')
  ring.style.strokeDasharray = RING
  ring.style.strokeDashoffset = (RING * (1 - frac)).toFixed(2)
  $('#timer-count').textContent = fmt(left / 1000)
  $('#timer-sub').textContent = state.timer.done ? 'done' : 'remaining'
}

function tickTimer() {
  if (!state.timer.running) return
  const left = Math.max(0, state.timer.endsAt - Date.now())

  if (left <= 0 && !state.timer.done) {
    state.timer.done = true
    state.timer.running = false
    state.timer.expanded = false
    state.panelOpen = false
    startAlarm()
    if (state.config.appearance.confetti) burstConfetti()
    showTransient('timer', "Time's up", 5000)
    render()
    return
  }

  if (pill.dataset.view === 'timer') {
    const frac = state.timer.total ? left / state.timer.total : 0
    const ring = $('#ring-fill')
    ring.style.strokeDasharray = RING
    ring.style.strokeDashoffset = (RING * (1 - frac)).toFixed(2)
    $('#timer-count').textContent = fmt(left / 1000)
  }
}

setInterval(tickTimer, 250)

/* ---------------------------- sound ---------------------------- */

let audioCtx = null

function ensureAudio() {
  if (!audioCtx) {
    try { audioCtx = new AudioContext() } catch { return null }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
  return audioCtx
}

function blip(freq, duration, gainValue, type = 'sine', delay = 0) {
  const ctx = ensureAudio()
  if (!ctx) return
  const now = ctx.currentTime + delay
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, now)
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(gainValue, now + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)
  osc.connect(gain).connect(ctx.destination)
  osc.start(now)
  osc.stop(now + duration + 0.02)
}

function cue(kind) {
  if (!state.config.appearance.sounds) return
  if (kind === 'expand') blip(1320, 0.09, 0.035, 'sine')
  if (kind === 'collapse') blip(760, 0.1, 0.03, 'sine')
  if (kind === 'tap') blip(1040, 0.06, 0.026, 'sine')
  if (kind === 'chime') {
    blip(880, 0.5, 0.09, 'sine', 0)
    blip(1106, 0.5, 0.07, 'sine', 0.16)
    blip(1318, 0.6, 0.06, 'sine', 0.32)
  }
}

/* ---------------------------- timer alarm ---------------------------- */

const ALARMS = {
  chime: { notes: [880, 1108.7, 1318.5], dur: 0.55, gap: 0.06, type: 'sine', gain: 0.22 },
  bell: { notes: [1568, 1046.5, 1568], dur: 0.85, gap: 0.02, type: 'sine', gain: 0.18 },
  marimba: { notes: [523.3, 659.3, 784, 1046.5], dur: 0.24, gap: 0.11, type: 'triangle', gain: 0.26 },
  arcade: { notes: [660, 880, 660, 880, 1320], dur: 0.11, gap: 0.09, type: 'square', gain: 0.09 },
  digital: { notes: [1046.5, 1046.5, 1046.5], dur: 0.16, gap: 0.3, type: 'square', gain: 0.1 },
  soft: { notes: [659.3, 880], dur: 0.8, gap: 0.22, type: 'sine', gain: 0.16 }
}

const ALARM_LOOP_MS = 2600
const ALARM_MAX_MS = 45000

let alarmLoop = null
let alarmEndsAt = 0
let alarmAudio = null

function tone(freq, duration, gainValue, type, delay) {
  const ctx = ensureAudio()
  if (!ctx) return
  const now = ctx.currentTime + delay
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, now)
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(Math.max(0.001, gainValue), now + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)
  osc.connect(gain).connect(ctx.destination)
  osc.start(now)
  osc.stop(now + duration + 0.05)
}

function alarmSpec() {
  const conf = state.config.timer || {}
  return {
    volume: typeof conf.volume === 'number' ? conf.volume : 0.8,
    customUrl: conf.customUrl || '',
    name: ALARMS[conf.sound] ? conf.sound : 'chime'
  }
}

/** One pass of the alarm - the custom file if there is one, otherwise a synth. */
function ringOnce() {
  const spec = alarmSpec()

  if (spec.customUrl) {
    try {
      if (!alarmAudio) alarmAudio = new Audio()
      if (alarmAudio.src !== spec.customUrl) alarmAudio.src = spec.customUrl
      alarmAudio.volume = Math.max(0, Math.min(1, spec.volume))
      alarmAudio.currentTime = 0
      const played = alarmAudio.play()
      if (played && played.catch) played.catch(() => synthAlarm(spec))
      return
    } catch { /* fall through to the synth */ }
  }

  synthAlarm(spec)
}

function synthAlarm(spec) {
  const voice = ALARMS[spec.name]
  voice.notes.forEach((freq, index) => {
    tone(freq, voice.dur, voice.gain * spec.volume, voice.type, index * (voice.dur + voice.gap))
  })
}

function startAlarm() {
  stopAlarm()
  alarmEndsAt = Date.now() + ALARM_MAX_MS
  ringOnce()
  if (state.config.timer && state.config.timer.repeat === false) return
  alarmLoop = setInterval(() => {
    if (Date.now() > alarmEndsAt) { stopAlarm(); return }
    ringOnce()
  }, ALARM_LOOP_MS)
}

function stopAlarm() {
  clearInterval(alarmLoop)
  alarmLoop = null
  if (alarmAudio) {
    try { alarmAudio.pause() } catch { /* nothing playing */ }
  }
}

/* ---------------------------- confetti ---------------------------- */

const canvas = $('#confetti')
const ctx2d = canvas.getContext('2d')
let particles = []
let confettiFrame = null

function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1
  canvas.width = canvas.clientWidth * dpr
  canvas.height = canvas.clientHeight * dpr
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
}

window.addEventListener('resize', sizeCanvas)
sizeCanvas()

const CONFETTI_COLORS = ['#ff375f', '#ff9f0a', '#ffd60a', '#34c759', '#0a84ff', '#bf5af2', '#ffffff']

function burstConfetti() {
  const rect = pill.getBoundingClientRect()
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2

  for (let i = 0; i < 80; i += 1) {
    const angle = Math.random() * Math.PI * 2
    const speed = 2 + Math.random() * 6
    particles.push({
      x: cx + (Math.random() - 0.5) * rect.width * 0.5,
      y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 3,
      size: 3 + Math.random() * 5,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.35,
      color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
      life: 1
    })
  }

  if (!confettiFrame) confettiFrame = requestAnimationFrame(drawConfetti)
}

function drawConfetti() {
  ctx2d.clearRect(0, 0, canvas.width, canvas.height)

  particles = particles.filter((p) => p.life > 0 && p.y < canvas.clientHeight + 40)
  for (const p of particles) {
    p.vy += 0.16
    p.vx *= 0.994
    p.x += p.vx
    p.y += p.vy
    p.rot += p.vr
    p.life -= 0.005

    ctx2d.save()
    ctx2d.translate(p.x, p.y)
    ctx2d.rotate(p.rot)
    ctx2d.globalAlpha = Math.max(0, Math.min(1, p.life))
    ctx2d.fillStyle = p.color
    ctx2d.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2)
    ctx2d.restore()
  }

  if (particles.length) {
    confettiFrame = requestAnimationFrame(drawConfetti)
  } else {
    confettiFrame = null
    ctx2d.clearRect(0, 0, canvas.width, canvas.height)
  }
}

/* ---------------------------- battery ---------------------------- */

function paintBattery(level, charging) {
  const fill = $('#battery-fill')
  if (!fill) return
  const pct = Math.round(level * 100)
  fill.style.width = Math.max(4, pct) + '%'
  fill.classList.toggle('low', !charging && pct <= 20)
  fill.classList.toggle('charging', charging)
  $('#battery-text').textContent = pct + '%'
}

if (navigator.getBattery) {
  navigator.getBattery().then((b) => {
    paintBattery(b.level, b.charging)
    b.addEventListener('chargingchange', () => {
      paintBattery(b.level, b.charging)
      showTransient(b.charging ? 'charged' : 'low',
        `${b.charging ? 'Charging' : 'On battery'} · ${Math.round(b.level * 100)}%`,
        2400, Math.round(b.level * 100))
    })
    b.addEventListener('levelchange', () => paintBattery(b.level, b.charging))
  }).catch(() => {})
}

/* ---------------------------- input ---------------------------- */

function insidePill(x, y) {
  const r = pill.getBoundingClientRect()
  const pad = 6
  return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad
}

let lastInside = null

document.addEventListener('mousemove', (e) => {
  const inside = insidePill(e.clientX, e.clientY)
  if (inside !== lastInside) {
    lastInside = inside
    window.island.hit(inside)
  }
  if (inside !== state.hover) {
    state.hover = inside
    if (inside) scheduleCollapse()
  }
  if (!inside && (state.panelOpen || state.expanded || state.timer.expanded)) scheduleClose()
})

document.addEventListener('mouseleave', () => {
  if (lastInside !== false) {
    lastInside = false
    window.island.hit(false)
  }
})

let closeTimer = null

function scheduleCollapse() {
  clearTimeout(closeTimer)
}

function scheduleClose() {
  clearTimeout(closeTimer)
  closeTimer = setTimeout(() => {
    if (state.hover) return
    closeAll()
  }, 650)
}

function closeAll() {
  let changed = false
  if (state.expanded) { state.expanded = false; changed = true }
  if (state.panelOpen) { state.panelOpen = false; changed = true }
  if (state.timer.expanded) { state.timer.expanded = false; changed = true }
  if (state.panelMode !== 'home') { state.panelMode = 'home'; changed = true }
  if (!changed) return
  cue('collapse')
  render()
}

/* Long press: Apple's gesture for opening the full card. */
let pressTimer = null
let longPressed = false

function cancelPress() {
  clearTimeout(pressTimer)
  pressTimer = null
}

pill.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) return
  longPressed = false
  cancelPress()
  if (!state.config.indicators.longPress) return
  pressTimer = setTimeout(() => {
    longPressed = true
    openFully()
  }, 380)
})
pill.addEventListener('pointerup', cancelPress)
pill.addEventListener('pointerleave', cancelPress)
pill.addEventListener('pointercancel', cancelPress)

function openFully() {
  if (state.call) return
  if (state.timer.running) state.timer.expanded = true
  else if (mediaVisible()) state.expanded = true
  else if (!state.activities.length) { state.panelOpen = true; state.panelMode = 'home' }
  cue('expand')
  render()
}

pill.addEventListener('click', (e) => {
  if (longPressed) { longPressed = false; return }
  if (e.target.closest('button') || e.target.closest('.progress') || e.target.closest('.activity-card')) return

  if (state.transient) { clearTransient(); return }

  if (state.timer.running) {
    state.timer.expanded = !state.timer.expanded
    cue('expand')
    render()
    return
  }
  if (mediaVisible()) {
    state.expanded = !state.expanded
    cue('expand')
    render()
    return
  }
  state.panelOpen = !state.panelOpen
  state.panelMode = 'home'
  cue('expand')
  render()
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAll()
})

$('#btn-play').addEventListener('click', () => window.island.media('toggle'))
$('#btn-next').addEventListener('click', () => window.island.media('next'))
$('#btn-prev').addEventListener('click', () => window.island.media('prev'))

// Tapping the artwork raises the player, like tapping the island opens Music.
$('#song-art-box').addEventListener('click', (e) => {
  e.stopPropagation()
  if (state.media && state.media.app) window.island.focusApp(state.media.app)
})

$('#progress').addEventListener('click', (e) => {
  if (!state.config.media.seek) return
  const r = e.currentTarget.getBoundingClientRect()
  const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
  progressBase.position = progressBase.duration * frac
  progressBase.at = performance.now()
  window.island.media('seek:' + frac.toFixed(4))
  updateProgress()
})

$('#open-timer').addEventListener('click', () => {
  state.panelMode = 'timer'
  render()
})

document.querySelectorAll('.preset').forEach((btn) => {
  btn.addEventListener('click', () => startTimer(Number(btn.dataset.min)))
})

$('#timer-cancel').addEventListener('click', () => cancelTimer())
$('#open-settings').addEventListener('click', () => window.island.openSettings())

const aiChip = $('#open-ai')
aiChip.addEventListener('click', (event) => {
  event.stopPropagation()
  state.panelOpen = false
  render()
  window.island.openAi()
  cue('tap')
})

const statsChip = $('#open-stats')
statsChip.addEventListener('click', (event) => {
  event.stopPropagation()
  state.panelMode = state.panelMode === 'stats' ? 'home' : 'stats'
  render()
  cue('tap')
})

const bellChip = $('#open-activity')
bellChip.addEventListener('click', (event) => {
  event.stopPropagation()
  const opening = state.panelMode !== 'activity'
  state.panelMode = opening ? 'activity' : 'home'
  render()
  if (opening) {
    // Opening the centre counts as seeing everything in it.
    window.island.activityRead().then((next) => { if (next) applyActivityState(next) })
    window.island.activityList().then((next) => { if (next) applyActivityState(next) })
  }
  cue('tap')
})

$('#activity-clear').addEventListener('click', async (event) => {
  event.stopPropagation()
  const next = await window.island.activityClear()
  if (next) applyActivityState(next)
  cue('tap')
})

/* ---------------------------- config ---------------------------- */

function applyPillBackground() {
  const appearance = state.config.appearance || {}
  const theme = appearance.theme || 'black'
  let background = '#000'
  if (theme === 'glass') background = 'rgb(16, 16, 18)'
  if (theme === 'tinted' && state.tint) background = state.tint
  document.documentElement.style.setProperty('--pill-bg', background)
}

function applyConfig(settings) {
  state.config = settings
  const appearance = settings.appearance || {}

  pill.dataset.theme = appearance.theme || 'black'
  document.documentElement.style.setProperty('--pill-opacity', appearance.opacity ?? 1)
  document.documentElement.style.setProperty('--accent', appearance.accent || '#34c759')
  document.body.classList.toggle('pos-bottom', settings.general?.position === 'bottom')
  aiChip.hidden = !(settings.ai && settings.ai.enabled)
  statsChip.hidden = !(settings.widgets && settings.widgets.system)
  bellChip.hidden = !(settings.activities && settings.activities.enabled !== false)
  applyPillBackground()

  render()
}

window.island.onConfig((payload) => {
  if (payload && payload.settings) applyConfig(payload.settings)
})

/* ---------------------------- data ---------------------------- */

window.island.onData((msg) => {
  if (!msg || !msg.type) return
  window.__lastMsg = msg

  if (msg.type === 'preview-sound') {
    ringOnce()
    return
  }

  if (msg.type === 'stats') {
    state.stats = msg
    if (pill.dataset.view === 'panel' && state.panelMode === 'stats') paintStats()
    return
  }

  if (msg.type === 'media') {
    if (!msg.active) {
      state.media = null
      render()
      return
    }
    const previous = state.media && state.media.title
    const wasActive = !!(state.media && state.media.active)
    state.media = msg
    if (msg.tint) {
      state.tint = msg.tint
      applyPillBackground()
    }

    if (msg.title !== previous && msg.status === 'playing') {
      if (state.config.appearance.bounce) {
        pill.classList.remove('nudge')
        void pill.offsetWidth
        pill.classList.add('nudge')
      }
      if (state.config.media.autoExpand && wasActive) {
        state.expanded = true
        clearTimeout(applyConfig._autoCollapse)
        applyConfig._autoCollapse = setTimeout(() => {
          if (!state.hover) { state.expanded = false; render() }
        }, state.config.general.autoCollapseMs || 8000)
      }
    }

    if (state.config.appearance.theme === 'tinted' && state.tint) {
      document.documentElement.style.setProperty('--pill-bg', state.tint)
    }
    render()
    return
  }

  if (msg.type === 'call') {
    const before = state.devices
    state.devices = { mic: msg.mic || [], camera: msg.camera || [] }

    if (state.config.calls.notifyOnStart && state.config.calls.enabled) {
      if (msg.mic?.length && !before.mic?.length) {
        showTransient('mic', `Microphone on · ${msg.mic[0]}`, 3600)
      } else if (msg.camera?.length && !before.camera?.length) {
        showTransient('cam', `Camera on · ${msg.camera[0]}`, 3600)
      }
    }

    // Call banner: appears when a call takes the mic, leaves when it lets go.
    const mic = state.devices.mic
    if (!mic.length) {
      callDismissed = false
      hideCall()
    } else if (!callDismissed && !state.call && state.config.calls.banner && state.config.calls.enabled) {
      showCall(mic.find((name) => CALL_APPS.includes(name)) || mic[0])
    }

    if (pill.dataset.view === 'idle') renderIdle()
    return
  }

  if (msg.type === 'system') {
    state.system = { focus: !!msg.focus, sharing: msg.sharing || null }
    if (pill.dataset.view === 'idle') renderIdle()
    return
  }

  if (msg.type === 'volume') {
    if (!state.config.volume.enabled) return
    const first = !state.volume.seen
    const changed = Math.abs(msg.level - state.volume.level) > 0.004 || msg.muted !== state.volume.muted
    state.volume = { ...msg, seen: true }
    if (first || !changed) return

    const pct = Math.round(msg.level * 100)
    showTransient(msg.muted ? 'mute' : 'vol', msg.muted ? 'Muted' : `Volume ${pct}%`, 1700, msg.muted ? 0 : pct)
    return
  }

  if (msg.type === 'peak') {
    state.peak = msg.level || 0
    return
  }

  if (msg.type === 'clipboard') {
    if (!state.config.clipboard.enabled) return
    if (msg.kind === 'image' && !state.config.clipboard.showImages) return
    showTransient('clip', msg.preview || 'Copied', 2000)
    return
  }

  if (msg.type === 'calendar') {
    state.events = msg.events || []
    if (pill.dataset.view === 'panel') renderNextEvent()
    tickCalendar()
    return
  }

  if (msg.type === 'activity') {
    if (msg.clear) {
      clearActivities()
      return
    }
    showActivity(msg)
    return
  }

  if (msg.type === 'activity-state') {
    applyActivityState(msg)
    return
  }
})

/* ---------------------------- shot mode ---------------------------- */

window.island.onDebug((payload) => {
  if (!payload) return

  if (payload.reset) {
    preview = null
    clearTimeout(showTransient._t)
    clearActivities()
    hideCall()
    state.media = null
    state.expanded = false
    state.panelOpen = false
    state.transient = null
    state.system = { focus: false, sharing: null }
    state.timer = { running: false, endsAt: 0, total: 0, expanded: false, done: false }
    state.devices = { mic: [], camera: [] }
    state.events = []
    render()
    return
  }

  if (payload.media) {
    state.media = { ...payload.media }
    if (payload.media.tint) {
      state.tint = payload.media.tint
      applyPillBackground()
    }
    state.expanded = !!payload.expanded
    render()
  }
  if (payload.panel) { state.panelOpen = true; state.events = payload.events || []; render() }
  if (payload.panelMode) { state.panelMode = payload.panelMode; render() }
  if (payload.timer) {
    state.timer = { running: true, endsAt: Date.now() + payload.timer * 1000, total: payload.timer * 1000, expanded: true }
    render(); tickTimer()
  }
  if (payload.devices) { state.devices = payload.devices; renderIdle(); render() }
  if (payload.volume != null) showTransient('vol', `Volume ${Math.round(payload.volume * 100)}%`, 60000, payload.volume * 100)
  if (payload.activity) showActivity({ ...payload.activity, durationMs: 60000 })
  if (payload.clipboard) showTransient('clip', payload.clipboard, 60000)
  if (payload.transient) {
    showTransient(payload.transient.kind, payload.transient.text, 60000, payload.transient.bar)
  }
  if (payload.confetti) burstConfetti()
  if (payload.peak != null) state.peak = payload.peak
})

window.island.onPulse(() => {
  pill.classList.remove('nudge')
  void pill.offsetWidth
  pill.classList.add('nudge')
})

/* ---------------------------- boot ---------------------------- */

render()
requestAnimationFrame(tick)
