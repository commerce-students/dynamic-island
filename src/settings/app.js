'use strict'

/* ============================================================
   Settings app — every control is declared once and bound to a
   dotted path in the stored config, so adding a feature means
   adding one line here.
   ============================================================ */

const api = window.prefs

let CONFIG = null
let INFO = null
let activePane = 'general'
const bindings = []

function buildPanes() {
  return [
  {
    id: 'general',
    title: 'General',
    icon: '⚙',
    desc: 'Where the island sits, and how it gets out of your way.',
    groups: [
      {
        title: 'Startup',
        rows: [
          { type: 'toggle', path: 'general.startWithWindows', label: 'Start with Windows', hint: 'Launch the island when you sign in.' },
          { type: 'toggle', path: 'general.openSettingsOnLaunch', label: 'Open settings on launch', hint: 'Useful while you are still tweaking it.' }
        ]
      },
      {
        title: 'Placement',
        rows: [
          {
            type: 'segmented', path: 'general.position', label: 'Position',
            options: [{ value: 'top', label: 'Top' }, { value: 'bottom', label: 'Bottom' }]
          },
          {
            type: 'slider', path: 'general.autoCollapseMs', label: 'Auto-collapse after',
            min: 2000, max: 20000, step: 1000, format: (v) => `${v / 1000}s`
          },
          {
            type: 'button', label: 'Re-centre', hint: 'Puts the island back in the middle of your screen.', buttonLabel: 'Reset position',
            onClick: () => api.set({ general: {} }).then(showToast('Island repositioned'))
          }
        ]
      },
      {
        title: 'Keyboard',
        rows: [
          {
            type: 'text', path: 'general.hotkey', label: 'Show / hide shortcut',
            hint: 'Written like Control+Alt+D. Leave empty to disable.', medium: true
          }
        ]
      },
      {
        title: 'System indicators',
        rows: [
          { type: 'toggle', path: 'indicators.focus', label: 'Focus Assist moon', hint: 'A small moon in the idle pill while Do Not Disturb is on.' },
          { type: 'toggle', path: 'indicators.sharing', label: 'Screen recording dot', hint: 'The dot turns red while an app reports it is sharing or recording the screen.' },
          { type: 'toggle', path: 'indicators.longPress', label: 'Long-press to expand', hint: 'Press and hold the pill for a moment to open the full card.' }
        ]
      }
    ]
  },
  {
    id: 'appearance',
    title: 'Appearance',
    icon: '🎨',
    desc: 'Make it yours. Changes apply to the real island instantly.',
    groups: [
      {
        title: 'Style',
        rows: [
          {
            type: 'segmented', path: 'appearance.theme', label: 'Theme',
            options: [
              { value: 'black', label: 'Black' },
              { value: 'tinted', label: 'Album tint' },
              { value: 'glass', label: 'Glass' }
            ],
            hint: 'Album tint subtly takes on the colour of the artwork.'
          },
          { type: 'color', path: 'appearance.accent', label: 'Accent', hint: 'Used for the live indicators.' },
          {
            type: 'slider', path: 'appearance.opacity', label: 'Opacity',
            min: 0.5, max: 1, step: 0.02, format: (v) => `${Math.round(v * 100)}%`
          },
          {
            type: 'slider', path: 'appearance.scale', label: 'Island size',
            min: 0.75, max: 1.4, step: 0.05, format: (v) => `${Math.round(v * 100)}%`,
            hint: 'Scales the whole capsule — text, artwork and buttons included.'
          },
          { type: 'toggle', path: 'appearance.glow', label: 'Outer glow', hint: 'A soft shadow so it reads on light wallpapers.' }
        ]
      },
      {
        title: 'Motion',
        rows: [
          { type: 'toggle', path: 'appearance.liquid', label: 'Liquid morph', hint: 'Squash and stretch while the island changes shape.' },
          { type: 'toggle', path: 'appearance.bounce', label: 'Bounce on new song', hint: 'A small spring bounce when a track starts.' },
          { type: 'toggle', path: 'appearance.confetti', label: 'Confetti on timer done', hint: 'Because a timer finishing is worth celebrating.' },
          { type: 'toggle', path: 'appearance.sounds', label: 'Sound cues', hint: 'Subtle clicks for expand, collapse and timer.' }
        ]
      }
    ]
  },
  {
    id: 'widgets',
    title: 'Widgets',
    icon: '📊',
    desc: 'Small live readouts that live in the island panel.',
    groups: [
      {
        title: 'System',
        rows: [
          { type: 'toggle', path: 'widgets.system', label: 'CPU & memory', hint: 'Adds a stats button to the panel: live CPU load, memory use, uptime and core count.' },
          {
            type: 'slider', path: 'widgets.refreshMs', label: 'Refresh every',
            min: 1000, max: 5000, step: 250, format: (v) => `${(v / 1000).toFixed(2).replace(/0$/, '')}s`,
            hint: 'Slower is lighter on the CPU. Two seconds is a good default.'
          },
          { type: 'note', html: 'Read from Windows directly — no extra process, no polling of the network, nothing sent anywhere.' }
        ]
      }
    ]
  },
  {
    id: 'media',
    title: 'Media',
    icon: '♪',
    desc: 'Anything Windows shows in its own media flyout works here — Spotify, YouTube in Chrome, Edge, VLC, Media Player.',
    groups: [
      {
        title: 'Now playing',
        rows: [
          { type: 'toggle', path: 'media.enabled', label: 'Show now playing', hint: 'Compact card with artwork and a live equaliser.' },
          { type: 'toggle', path: 'media.autoExpand', label: 'Expand on new track', hint: 'Opens the full card for a moment when a song changes.' },
          { type: 'toggle', path: 'media.showArt', label: 'Show album art', hint: 'Falls back to a placeholder tile when an app provides none.' },
          { type: 'toggle', path: 'media.seek', label: 'Click-to-seek', hint: 'Click anywhere on the progress bar to jump.' },
          { type: 'toggle', path: 'media.reactiveBars', label: 'Real audio-reactive bars', hint: 'Bars follow the actual audio level, not a fake loop.' },
          { type: 'toggle', path: 'media.hideWhenPaused', label: 'Hide when paused', hint: 'Collapse back to the clock while paused.' }
        ]
      },
      {
        title: 'Controls',
        rows: [
          { type: 'note', html: 'Play, pause, skip and seek are sent straight to the app that owns the session — Chrome tabs included. If a button does nothing, that app does not support remote control.' }
        ]
      }
    ]
  },
  {
    id: 'calls',
    title: 'Calls',
    icon: '🎙',
    desc: 'Knows when your microphone or camera is live — no permission prompts, straight from Windows.',
    groups: [
      {
        title: 'Privacy indicators',
        rows: [
          { type: 'toggle', path: 'calls.enabled', label: 'Watch devices', hint: 'Reads the same registry Windows uses for its own privacy dots.' },
          { type: 'toggle', path: 'calls.mic', label: 'Microphone', hint: 'Shows which app is using your mic.' },
          { type: 'toggle', path: 'calls.camera', label: 'Camera', hint: 'Shows when your camera is on.' },
          { type: 'toggle', path: 'calls.notifyOnStart', label: 'Announce when it starts', hint: 'A short card the moment a device goes live.' },
          { type: 'toggle', path: 'calls.banner', label: 'Call banner', hint: 'A wide card while a call holds the microphone, with a button to jump to the app. Windows offers no way to answer or hang up from here, so it does not pretend to.' },
          { type: 'note', html: 'Indicator only — this never touches or mutes your devices.' }
        ]
      }
    ]
  },
  {
    id: 'clipboard',
    title: 'Clipboard',
    icon: '📋',
    desc: 'A quiet confirmation when you copy something.',
    groups: [
      {
        title: 'Copy feedback',
        rows: [
          { type: 'toggle', path: 'clipboard.enabled', label: 'Show copied items', hint: 'Never stores history — it only shows the last thing.' },
          { type: 'toggle', path: 'clipboard.showImages', label: 'Include images', hint: 'Shows the dimensions of a copied image.' },
          {
            type: 'slider', path: 'clipboard.maxChars', label: 'Preview length',
            min: 20, max: 200, step: 10, format: (v) => `${v} chars`
          }
        ]
      }
    ]
  },
  {
    id: 'calendar',
    title: 'Calendar',
    icon: '📅',
    desc: 'A live countdown to your next meeting.',
    groups: [
      {
        title: 'Source',
        rows: [
          { type: 'toggle', path: 'calendar.enabled', label: 'Enable calendar', hint: 'Reads a private iCal address, refreshed every 10 minutes.' },
          {
            type: 'text', path: 'calendar.icsUrl', label: 'iCal address', wide: true,
            placeholder: 'https://calendar.google.com/calendar/ical/…/basic.ics',
            hint: 'Google Calendar → Settings → your calendar → "Secret address in iCal format".'
          },
          {
            type: 'button', label: 'Connection', hint: 'Fetches right now and tells you what it found.',
            buttonLabel: 'Test connection',
            onClick: async () => {
              const result = await api.checkCalendar()
              if (!result.ok) return showToast(`Failed: ${result.reason}`)
              const next = result.events[0]
              showToast(next
                ? `Found ${result.events.length} events · next: ${next.summary}`
                : `Connected, but nothing in the next ${CONFIG.calendar.days} days`)
            }
          }
        ]
      },
      {
        title: 'Behaviour',
        rows: [
          {
            type: 'slider', path: 'calendar.leadMinutes', label: 'Warn before',
            min: 1, max: 60, step: 1, format: (v) => `${v} min`
          },
          {
            type: 'slider', path: 'calendar.days', label: 'Look ahead',
            min: 1, max: 30, step: 1, format: (v) => `${v} days`
          }
        ]
      }
    ]
  },
  {
    id: 'timer',
    title: 'Timer',
    icon: '⏱',
    desc: 'The alarm that rings when your island timer reaches zero.',
    groups: [
      {
        title: 'Alarm sound',
        rows: [
          {
            type: 'select', path: 'timer.sound', label: 'Preset',
            options: [
              { value: 'chime', label: 'Chime' },
              { value: 'bell', label: 'Bell' },
              { value: 'marimba', label: 'Marimba' },
              { value: 'arcade', label: 'Arcade' },
              { value: 'digital', label: 'Digital beep' },
              { value: 'soft', label: 'Soft two-note' }
            ],
            hint: 'All six are generated live, so they work offline and take no disk space.'
          },
          {
            type: 'text', path: 'timer.customSound', label: 'Your own song', wide: true,
            placeholder: 'C:\\Users\\you\\Music\\alarm.mp3',
            hint: 'Any MP3, WAV, M4A, OGG or FLAC. While this is set it plays instead of the preset.'
          },
          {
            type: 'button', label: 'Pick a file',
            hint: 'Opens a file picker. Whatever you choose is remembered.',
            buttonLabel: 'Choose song…',
            onClick: async () => {
              const file = await api.pickSound()
              if (!file) return
              await api.set({ timer: { customSound: file } })
              showToast('Alarm sound set')
            }
          },
          {
            type: 'button', label: 'Back to preset',
            hint: 'Clears the custom file.',
            buttonLabel: 'Use preset',
            onClick: () => api.set({ timer: { customSound: '' } }).then(() => showToast('Back to the preset'))
          }
        ]
      },
      {
        title: 'Playback',
        rows: [
          {
            type: 'slider', path: 'timer.volume', label: 'Alarm volume',
            min: 0.1, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%`
          },
          { type: 'toggle', path: 'timer.repeat', label: 'Keep ringing', hint: 'Repeats until you dismiss the card, for up to 45 seconds.' },
          {
            type: 'button', label: 'Preview',
            hint: 'Plays it once, at the volume above.',
            buttonLabel: 'Play the alarm',
            onClick: () => api.previewSound().then(() => showToast('Playing'))
          }
        ]
      }
    ]
  },
  {
    id: 'ai',
    title: 'AI',
    icon: '✦',
    desc: 'An optional assistant behind the island. Off until you switch it on, and it sends nothing until you press send.',
    groups: [
      {
        title: 'Assistant',
        rows: [
          { type: 'toggle', path: 'ai.enabled', label: 'AI button', hint: 'Adds a ✦ button to the island panel that opens the chat window.' },
          {
            type: 'select', path: 'ai.provider', label: 'Provider',
            options: [
              { value: 'pollinations', label: 'Pollinations — free, no key' },
              { value: 'groq', label: 'Groq — free tier, needs key' },
              { value: 'gemini', label: 'Google Gemini — free tier, needs key' },
              { value: 'openai', label: 'OpenAI — paid, needs key' },
              { value: 'ollama', label: 'Ollama — local, no key' }
            ],
            hint: 'Pollinations works immediately with no signup. Groq and Gemini are faster and stronger once you paste a key.'
          },
          {
            type: 'text', path: 'ai.model', label: 'Model', medium: true,
            hint: 'Pollinations: openai · Groq: llama-3.3-70b-versatile · Gemini: gemini-3.5-flash · Ollama: llama3.2'
          },
          {
            type: 'text', path: 'ai.apiKey', label: 'API key', secret: true, wide: true,
            placeholder: 'paste your key here',
            hint: 'Stored in your local settings file. No window ever receives it back — an empty box means your key is kept.'
          },
          {
            type: 'button', label: 'Connection',
            hint: 'Sends one tiny test message.',
            buttonLabel: 'Test key',
            onClick: async () => {
              const result = await api.aiTest()
              showToast(result && result.ok ? 'Key works' : (result && result.error) || 'Test failed')
            }
          },
          {
            type: 'button', label: 'Stored key',
            hint: 'Forget the key on this PC.',
            buttonLabel: 'Remove key',
            onClick: async () => {
              await api.clearApiKey()
              showToast('Key removed')
            }
          }
        ]
      },
      {
        title: 'Getting a free key',
        rows: [
          { type: 'note', html: '<b>Pollinations</b> is already selected above and needs no key at all — pick it and start typing.<br><b>Groq</b> — <b>console.groq.com/keys</b> · free, no card needed.<br><b>Gemini</b> — <b>aistudio.google.com/apikey</b> · free tier.<br><b>Ollama</b> — <b>ollama.com</b> · runs on your own PC, no key, no internet.' },
          { type: 'note', html: 'A pasted key is only used by the provider you picked, and never leaves your PC except in a request to that provider.' }
        ]
      }
    ]
  },
  {
    id: 'activities',
    title: 'Live Activities',
    icon: '⚡',
    desc: 'Push any short-lived status into the island from anything on your machine.',
    groups: [
      {
        title: 'Endpoint',
        rows: [
          { type: 'toggle', path: 'activities.enabled', label: 'Accept activities', hint: 'A local HTTP server, bound to 127.0.0.1 only.' },
          { type: 'number', path: 'activities.port', label: 'Port', hint: 'Change it if something else uses the default.', narrow: true },
          { type: 'toggle', path: 'activities.allowBrowser', label: 'Allow web pages', hint: 'Off means a page in your browser cannot post into the island. Leave it off unless you use a bookmarklet.' },
          { type: 'number', path: 'activities.keep', label: 'Keep in history', hint: 'How many recent activities the bell keeps on disk. 5–500.', narrow: true },
          { type: 'toggle', path: 'activities.showOnPush', label: 'Announce new ones', hint: 'Slide a card in when something arrives. The bell still records it.' },
          {
            type: 'button', label: 'Test', hint: 'Sends one so you can see it.',
            buttonLabel: 'Send a test activity',
            onClick: () => api.testActivity().then(showToast('Pushed to the island'))
          }
        ]
      },
      {
        title: 'How to push',
        rows: [
          {
            type: 'note',
            html: '<pre class="code">curl -X POST http://127.0.0.1:' + (INFO && INFO.port ? INFO.port : 39321) + '/push ^\n  -H "Content-Type: application/json" ^\n  -d "{\\"title\\":\\"Build finished\\",\\"subtitle\\":\\"in 42s\\",\\"icon\\":\\"*\\"}"</pre>'
          },
          {
            type: 'note',
            html: 'Fields: <b>title</b> (required), subtitle, icon, progress (0–1), tone (info, success, warning, error), durationMs,<br><b>group</b> (repeat pushes update one row), <b>priority</b> (0 passive, 1 normal, 2 time-sensitive), <b>open</b>.<br>The bell keeps the last activities on disk. <b>GET /activities</b> returns them as JSON.'
          }
        ]
      }
    ]
  },
  {
    id: 'about',
    title: 'About',
    icon: 'ⓘ',
    desc: 'Everything lives locally. Nothing leaves your machine except the calendar and, if you switch it on, the assistant.',
    groups: [
      {
        title: 'Dynamic Island',
        rows: [
          { type: 'button', label: 'Version', hint: INFO ? `v${INFO.version}` : '', buttonLabel: 'Open app folder', onClick: () => api.reveal('app') },
          { type: 'button', label: 'Settings file', hint: INFO ? INFO.settingsFile : '', buttonLabel: 'Show', onClick: () => api.reveal('settings') },
          { type: 'button', label: 'Album art cache', hint: INFO ? INFO.artDir : '', buttonLabel: 'Show', onClick: () => api.reveal('art') }
        ]
      },
      {
        title: 'Danger zone',
        rows: [
          {
            type: 'button', label: 'Reset everything', hint: 'Back to defaults. Does not delete the calendar cache.',
            buttonLabel: 'Reset settings', danger: true,
            onClick: async () => {
              CONFIG = await api.reset()
              render()
              showToast('Settings reset')
            }
          },
          { type: 'button', label: 'Quit', hint: 'Stops the island completely.', buttonLabel: 'Quit Dynamic Island', danger: true, onClick: () => api.quit() }
        ]
      }
    ]
  }
  ]
}

let PANES = []

/* ---------------------------- helpers ---------------------------- */

function getPath(obj, path) {
  if (!path) return undefined
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj)
}

function patchFor(path, value) {
  const parts = path.split('.')
  const patch = {}
  let cursor = patch
  parts.forEach((part, i) => {
    if (i === parts.length - 1) cursor[part] = value
    else cursor = cursor[part] = {}
  })
  return patch
}

let toastTimer = null
function showToast(message) {
  const el = document.getElementById('toast')
  el.textContent = message
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600)
}

function debounce(fn, ms) {
  let t = null
  return (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}

async function commit(path, value) {
  CONFIG = await api.set(patchFor(path, value))
}

/* ---------------------------- render ---------------------------- */

function render() {
  bindings.length = 0

  const nav = document.getElementById('nav')
  nav.innerHTML = ''
  for (const pane of PANES) {
    const btn = document.createElement('button')
    btn.className = 'nav-item' + (pane.id === activePane ? ' on' : '')
    btn.innerHTML = `<span class="nav-icon">${pane.icon}</span><span>${pane.title}</span>`
    btn.addEventListener('click', () => {
      activePane = pane.id
      render()
    })
    nav.appendChild(btn)
  }

  const pane = PANES.find((p) => p.id === activePane) || PANES[0]
  document.getElementById('pane-title').textContent = pane.title
  document.getElementById('pane-desc').textContent = pane.desc || ''

  const body = document.getElementById('pane-body')
  body.innerHTML = ''

  for (const group of pane.groups) {
    const wrap = document.createElement('section')
    wrap.className = 'group'
    if (group.title) {
      const h = document.createElement('h2')
      h.className = 'group-title'
      h.textContent = group.title
      wrap.appendChild(h)
    }
    const card = document.createElement('div')
    card.className = 'card'
    for (const row of group.rows) {
      card.appendChild(buildRow(row))
    }
    wrap.appendChild(card)
    body.appendChild(wrap)
  }
}

function buildRow(row) {
  const el = document.createElement('div')
  el.className = 'row' + (row.type === 'note' ? ' stack' : '')

  if (row.type === 'note') {
    el.innerHTML = `<div class="note" style="border:0;padding:0;background:transparent">${row.html}</div>`
    return el
  }

  const label = document.createElement('div')
  label.className = 'row-label'
  label.innerHTML = `<b>${row.label}</b>${row.hint ? `<span>${row.hint}</span>` : ''}`
  el.appendChild(label)

  const control = document.createElement('div')
  control.style.display = 'flex'
  control.style.alignItems = 'center'
  control.style.gap = '10px'

  const value = getPath(CONFIG, row.path)

  if (row.type === 'toggle') {
    const sw = document.createElement('button')
    sw.className = 'switch' + (value ? ' on' : '')
    sw.setAttribute('aria-label', row.label)
    sw.addEventListener('click', () => {
      const next = !sw.classList.contains('on')
      sw.classList.toggle('on', next)
      commit(row.path, next)
    })
    bindings.push({ path: row.path, el: sw, apply: (v) => sw.classList.toggle('on', !!v) })
    control.appendChild(sw)
  }

  if (row.type === 'segmented') {
    const seg = document.createElement('div')
    seg.className = 'segmented'
    for (const option of row.options) {
      const btn = document.createElement('button')
      btn.textContent = option.label
      btn.className = option.value === value ? 'on' : ''
      btn.addEventListener('click', () => {
        for (const child of seg.children) child.classList.remove('on')
        btn.classList.add('on')
        commit(row.path, option.value)
      })
      seg.appendChild(btn)
    }
    bindings.push({
      path: row.path,
      el: seg,
      apply: (v) => {
        ;[...seg.children].forEach((child, i) => child.classList.toggle('on', row.options[i].value === v))
      }
    })
    control.appendChild(seg)
  }

  if (row.type === 'select') {
    const sel = document.createElement('select')
    if (row.mini) sel.className = 'mini'
    for (const option of row.options) {
      const opt = document.createElement('option')
      opt.value = option.value
      opt.textContent = option.label
      sel.appendChild(opt)
    }
    sel.value = value == null ? '' : String(value)
    sel.addEventListener('change', () => commit(row.path, sel.value))
    bindings.push({ path: row.path, el: sel, apply: (v) => { if (document.activeElement !== sel) sel.value = v == null ? '' : String(v) } })
    control.appendChild(sel)
  }

  if (row.type === 'text') {
    const input = document.createElement('input')
    input.type = row.secret ? 'password' : 'text'
    input.value = value || ''
    input.placeholder = row.placeholder || ''
    input.className = row.wide ? 'wide' : (row.medium ? 'medium' : (row.narrow ? 'narrow' : ''))
    input.addEventListener('input', debounce(() => commit(row.path, input.value), 550))
    bindings.push({ path: row.path, el: input, apply: (v) => { if (document.activeElement !== input) input.value = v || '' } })
    control.appendChild(input)
  }

  if (row.type === 'number') {
    const input = document.createElement('input')
    input.type = 'number'
    input.value = value
    input.className = 'narrow'
    input.addEventListener('change', () => commit(row.path, Number(input.value)))
    bindings.push({ path: row.path, el: input, apply: (v) => { if (document.activeElement !== input) input.value = v } })
    control.appendChild(input)
  }

  if (row.type === 'slider') {
    const tag = document.createElement('span')
    tag.className = 'value-tag'
    tag.textContent = row.format ? row.format(value) : value
    const input = document.createElement('input')
    input.type = 'range'
    input.min = row.min
    input.max = row.max
    input.step = row.step
    input.value = value
    const save = debounce((v) => commit(row.path, v), 140)
    input.addEventListener('input', () => {
      tag.textContent = row.format ? row.format(Number(input.value)) : input.value
      save(Number(input.value))
    })
    bindings.push({
      path: row.path,
      el: input,
      apply: (v) => {
        if (document.activeElement !== input) input.value = v
        tag.textContent = row.format ? row.format(v) : v
      }
    })
    control.appendChild(input)
    control.appendChild(tag)
  }

  if (row.type === 'color') {
    const input = document.createElement('input')
    input.type = 'color'
    input.value = value
    input.addEventListener('input', () => commit(row.path, input.value))
    bindings.push({ path: row.path, el: input, apply: (v) => { if (document.activeElement !== input) input.value = v } })
    control.appendChild(input)
  }

  if (row.type === 'button') {
    const btn = document.createElement('button')
    btn.className = 'btn' + (row.danger ? ' danger' : '')
    btn.textContent = row.buttonLabel
    btn.addEventListener('click', () => row.onClick())
    control.appendChild(btn)
  }

  el.appendChild(control)
  return el
}

function syncControls(conf) {
  CONFIG = conf
  for (const binding of bindings) {
    binding.apply(getPath(conf, binding.path))
  }
}

/* ---------------------------- boot ---------------------------- */

async function boot() {
  const payload = await api.load()
  CONFIG = payload.settings
  INFO = payload.info
  PANES = buildPanes()
  document.getElementById('version').textContent = `v${INFO.version}`
  render()

  api.onChanged((conf) => syncControls(conf))
}

boot()
