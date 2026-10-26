'use strict'

const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const { EventEmitter } = require('events')

const DEFAULTS = {
  general: {
    hotkey: 'Control+Alt+D',
    position: 'top',
    display: 'primary',
    autoCollapseMs: 8000,
    startWithWindows: true,
    openSettingsOnLaunch: false
  },
  appearance: {
    theme: 'black',
    accent: '#34c759',
    opacity: 1,
    scale: 1,
    liquid: true,
    sounds: true,
    bounce: true,
    confetti: true,
    glow: true
  },
  media: {
    enabled: true,
    showArt: true,
    autoExpand: true,
    seek: true,
    hideWhenPaused: false,
    reactiveBars: true
  },
  calls: {
    enabled: true,
    mic: true,
    camera: true,
    notifyOnStart: true,
    banner: true
  },
  indicators: {
    focus: true,
    sharing: true,
    longPress: true
  },
  clipboard: {
    enabled: true,
    maxChars: 70,
    showImages: true
  },
  calendar: {
    enabled: false,
    icsUrl: '',
    leadMinutes: 10,
    days: 14
  },
  activities: {
    enabled: true,
    port: 39321,
    // Off by default: a web page must not be able to draw in the island.
    allowBrowser: false
  },
  volume: {
    enabled: true
  },
  widgets: {
    system: true,
    refreshMs: 2000
  },
  timer: {
    sound: 'chime',
    customSound: '',
    volume: 0.8,
    repeat: true
  },
  ai: {
    enabled: true,
    provider: 'pollinations',
    model: 'openai',
    apiKey: '',
    maxTokens: 600
  }
}

const emitter = new EventEmitter()
let current = null

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Never let a stored or patched object reach Object.prototype.
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base }
  if (!isPlainObject(patch)) return out
  for (const [key, value] of Object.entries(patch)) {
    if (BLOCKED_KEYS.has(key)) continue
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8').replace(/^\uFEFF/, ''))
    current = deepMerge(DEFAULTS, raw)
  } catch {
    current = deepMerge(DEFAULTS, {})
  }
  return current
}

function get() {
  if (!current) load()
  return current
}

function save() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
    fs.writeFileSync(settingsFile(), JSON.stringify(current, null, 2), 'utf8')
  } catch (err) {
    console.error('[settings] could not save', err)
  }
}

function set(patch) {
  current = deepMerge(get(), patch)
  save()
  emitter.emit('change', current, patch)
  return current
}

function reset() {
  current = deepMerge(DEFAULTS, {})
  save()
  emitter.emit('change', current, current)
  return current
}

/**
 * The settings a renderer is allowed to see.
 *
 * The API key is replaced by a boolean. No window needs the secret itself -
 * only the main process does, and it is the only thing that calls a provider.
 */
function publicConfig() {
  const conf = get()
  const apiKey = String((conf.ai && conf.ai.apiKey) || '')
  return {
    ...conf,
    ai: { ...conf.ai, apiKey: '', hasApiKey: Boolean(apiKey.trim()) }
  }
}

module.exports = {
  DEFAULTS,
  deepMerge,
  settingsFile,
  load,
  get,
  publicConfig,
  set,
  reset,
  onChange: (fn) => emitter.on('change', fn)
}
