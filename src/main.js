'use strict'

const {
  app, BrowserWindow, ipcMain, Tray, Menu, nativeImage,
  globalShortcut, screen, clipboard, shell, dialog
} = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { pathToFileURL } = require('url')
const { spawn } = require('child_process')

const settings = require('./config')
const calendar = require('./lib/calendar')
const activities = require('./lib/activities')
const { createStore } = require('./lib/activity-store')
const ai = require('./lib/ai')

const SHOT_MODE = process.argv.includes('--shot')
const SHOT_PREFS = process.argv.includes('--shot-prefs')
const WANT_SETTINGS = process.argv.includes('--settings')
const WIN_W = 680
const WIN_H = 360

// Same id the installer stamps on the Start Menu shortcut, so Windows groups
// every island window under one taskbar entry.
const APP_ID = 'com.dynamicisland.app'
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)

/** Where the portable Python + sidecar scripts live (see scripts/prepare-runtime.mjs). */
function runtimeRoot() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..')
}

function bundledPython() {
  const exe = path.join(runtimeRoot(), 'runtime', 'python', 'python.exe')
  return fs.existsSync(exe) ? exe : null
}

/**
 * Packaged builds keep bundled artwork next to the asar (resources/assets) so
 * nativeImage and the renderer can read it as a plain file.
 */
function assetPath(name) {
  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, 'assets', name)
    if (fs.existsSync(packaged)) return packaged
  }
  return path.join(__dirname, '..', 'assets', name)
}

let island = null
let prefs = null
let aiWin = null
let tray = null
let mediaBridge = null
let volumeBridge = null
let activityServer = null
let activityStore = null
let calendarTimer = null
let clipboardTimer = null
let lastClipboard = null
let isVisible = true

/* ------------------------------------------------------------------ *
 * Island window
 * ------------------------------------------------------------------ */

function islandBounds() {
  const display = screen.getPrimaryDisplay()
  const area = display.bounds
  const conf = settings.get().general
  const x = Math.round(area.x + (area.width - WIN_W) / 2)
  const y = conf.position === 'bottom'
    ? area.y + area.height - WIN_H - 6
    : area.y + 6
  return { x, y, width: WIN_W, height: WIN_H }
}

function placeIsland() {
  if (!island || SHOT_MODE) return
  island.setBounds(islandBounds())
}

/**
 * Every window loads local files only. Anything that tries to navigate away or
 * open a popup is handed to the real browser, or refused.
 */
function lockDown(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault()
  })

  // Nothing here captures a microphone, a camera or the screen, so every
  // permission prompt is a bug or an attack.
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
}

function createIsland() {
  island = new BrowserWindow({
    ...islandBounds(),
    x: SHOT_MODE ? -3200 : islandBounds().x,
    y: SHOT_MODE ? -3200 : islandBounds().y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })
  lockDown(island)

  island.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  island.once('ready-to-show', () => {
    island.setAlwaysOnTop(true, 'screen-saver')
    island.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    island.setIgnoreMouseEvents(true, { forward: true })
    island.showInactive()
  })

  island.webContents.on('did-finish-load', () => {
    sendConfigToIsland()
    sendActivityState()
  })
  island.on('closed', () => { island = null })
}

function sendConfigToIsland() {
  if (!island || island.isDestroyed()) return

  // publicConfig() strips the provider key: the island only needs ai.enabled.
  const conf = settings.publicConfig()
  const custom = conf.timer && conf.timer.customSound
  let customUrl = ''
  try {
    if (custom && fs.existsSync(custom)) customUrl = pathToFileURL(custom).href
  } catch { /* keep empty */ }

  island.webContents.send('config', {
    settings: {
      ...conf,
      timer: { ...conf.timer, customUrl }
    },
    api: activityServer ? activityServer.port : null
  })
}

ipcMain.handle('settings:pick-sound', async () => {
  const result = await dialog.showOpenDialog(prefs || undefined, {
    title: 'Choose an alarm sound',
    properties: ['openFile'],
    filters: [
      { name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'] },
      { name: 'All files', extensions: ['*'] }
    ]
  })
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths[0]
})

ipcMain.on('settings:preview-sound', () => {
  if (island && !island.isDestroyed()) island.webContents.send('data', { type: 'preview-sound' })
})

ipcMain.on('hit', (_event, inside) => {
  if (!island) return
  island.setIgnoreMouseEvents(!inside, { forward: true })
})

ipcMain.on('media', (_event, cmd) => sendToMedia(String(cmd)))

ipcMain.on('open-settings', () => openSettings())

/* ------------------------------------------------------------------ *
 * Settings window
 * ------------------------------------------------------------------ */

function openSettings() {
  if (prefs && !prefs.isDestroyed()) {
    prefs.show()
    prefs.focus()
    return
  }

  prefs = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 860,
    minHeight: 580,
    title: 'Dynamic Island Settings',
    backgroundColor: '#f5f5f7',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  lockDown(prefs)

  prefs.loadFile(path.join(__dirname, 'settings', 'index.html'))
    .then(() => {
      if (prefs && !prefs.isDestroyed()) prefs.show()
    })
    .catch((err) => console.error('[settings] could not load', err))

  // Belt and braces: some Windows compositor states swallow ready-to-show.
  setTimeout(() => {
    if (prefs && !prefs.isDestroyed() && !prefs.isVisible()) prefs.show()
  }, 1400)

  prefs.on('closed', () => { prefs = null })
}

/**
 * Only our own windows may change settings or spend the user's AI quota.
 * A compromised renderer cannot become a second caller: the check is on the
 * webContents that sent the message, not on anything in the payload.
 */
function fromOwnWindow(event) {
  const id = event && event.sender ? event.sender.id : -1
  return [island, prefs, aiWin].some((win) => win && !win.isDestroyed() && win.webContents.id === id)
}

ipcMain.handle('settings:get', (event) => {
  if (!fromOwnWindow(event)) throw new Error('untrusted sender')
  return {
    settings: settings.publicConfig(),
    info: {
      version: app.getVersion(),
      settingsFile: settings.settingsFile(),
      port: activityServer ? activityServer.port : null,
      artDir: path.join(app.getPath('temp'), 'dynamic-island-art'),
      autostart: isAutoStartEnabled()
    }
  }
})

ipcMain.handle('settings:set', (event, patch) => {
  if (!fromOwnWindow(event)) return settings.publicConfig()
  const safe = patch && typeof patch === 'object' && !Array.isArray(patch) ? { ...patch } : {}

  // The settings window never receives the key, so an empty field means
  // "leave it alone" rather than "erase it".
  if (safe.ai && typeof safe.ai === 'object' && !Array.isArray(safe.ai)) {
    const aiPatch = { ...safe.ai }
    if (!String(aiPatch.apiKey || '').trim()) delete aiPatch.apiKey
    safe.ai = aiPatch
  }

  settings.set(safe)
  applySettings(safe)
  return settings.publicConfig()
})

ipcMain.handle('settings:reset', (event) => {
  if (!fromOwnWindow(event)) return settings.publicConfig()
  const next = settings.reset()
  applySettings(next)
  return settings.publicConfig()
})

ipcMain.handle('settings:clear-api-key', (event) => {
  if (!fromOwnWindow(event)) return settings.publicConfig()
  settings.set({ ai: { apiKey: '', apiKeyEnc: '' } })
  const conf = settings.publicConfig()
  if (prefs && !prefs.isDestroyed()) prefs.webContents.send('settings:changed', conf)
  return conf
})

ipcMain.handle('settings:calendar-check', async () => {
  const conf = settings.get().calendar
  const result = await calendar.load(conf, app.getPath('userData'))
  pushCalendar(result)
  return result
})

ipcMain.handle('settings:test-activity', () => {
  pushActivity({
    title: 'Live Activity',
    subtitle: 'Pushed from settings',
    icon: '★',
    tone: 'success',
    progress: null,
    durationMs: 6000
  })
  return true
})

ipcMain.on('settings:close', () => { if (prefs) prefs.close() })
ipcMain.on('app:quit', () => quit())

/* ------------------------------------------------------------------ *
 * AI chat window
 *
 * A separate focusable window, because the island itself is
 * click-through and deliberately never steals the keyboard.
 * ------------------------------------------------------------------ */

function createAiWindow() {
  if (aiWin && !aiWin.isDestroyed()) return aiWin

  aiWin = new BrowserWindow({
    width: 400,
    height: 560,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'ai', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  lockDown(aiWin)

  aiWin.setAlwaysOnTop(true, 'floating')
  aiWin.loadFile(path.join(__dirname, 'ai', 'index.html'))
    .catch((err) => console.error('[ai] could not load', err))

  aiWin.on('blur', () => { if (aiWin && !aiWin.isDestroyed()) aiWin.hide() })
  aiWin.on('closed', () => { aiWin = null })
  return aiWin
}

function placeAiWindow(win) {
  const bounds = islandBounds()
  const display = screen.getDisplayNearestPoint({ x: bounds.x + Math.round(bounds.width / 2), y: bounds.y })
  const area = display.workArea
  const target = win.getBounds()
  const x = Math.round(bounds.x + bounds.width / 2 - target.width / 2)
  const belowIsland = bounds.y + bounds.height + 12
  const y = belowIsland + target.height < area.y + area.height
    ? belowIsland
    : Math.max(area.y + 16, bounds.y - target.height - 12)
  win.setBounds({ x, y, width: target.width, height: target.height })
}

function openAiWindow() {
  const conf = settings.get().ai || {}
  const win = createAiWindow()
  placeAiWindow(win)
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  if (!conf.enabled) {
    // Still let them see the "switched off" state and jump to settings.
  }
}

ipcMain.on('ai:open', () => openAiWindow())
ipcMain.on('ai:close', () => { if (aiWin && !aiWin.isDestroyed()) aiWin.hide() })
ipcMain.on('ai:open-settings', () => {
  if (aiWin && !aiWin.isDestroyed()) aiWin.hide()
  openSettings()
})

ipcMain.handle('ai:info', (event) => {
  if (!fromOwnWindow(event)) throw new Error('untrusted sender')
  const conf = settings.get().ai || {}
  const provider = ai.PROVIDERS[conf.provider] ? conf.provider : 'pollinations'
  const spec = ai.PROVIDERS[provider]
  const model = (conf.model || '').trim() || spec.model
  return {
    enabled: !!conf.enabled,
    provider,
    model,
    label: spec.label,
    hasKey: !spec.needsKey || !!String(conf.apiKey || '').trim()
  }
})

ipcMain.handle('ai:send', async (event, messages) => {
  if (!fromOwnWindow(event)) return { ok: false, error: 'Untrusted sender.' }
  const conf = settings.get().ai || {}
  if (!conf.enabled) return { ok: false, error: 'The assistant is switched off. Turn it on in Settings → AI.' }
  return ai.ask(conf, messages)
})

ipcMain.handle('ai:test', async (event) => {
  if (!fromOwnWindow(event)) return { ok: false, error: 'Untrusted sender.' }
  const conf = settings.get().ai || {}
  const result = await ai.test(conf)
  if (result.ok) {
    return { ok: true, text: result.text }
  }
  return { ok: false, error: result.error }
})


/**
 * Tap a card -> open whatever it points at.
 * http(s) and app URLs go through the shell, real paths open in Explorer, and
 * anything else is treated as a window title to raise (like tapping the island
 * on iOS opens the app that owns the Live Activity).
 */
function openTarget(target) {
  const value = String(target || '').trim()
  if (!value) return
  try {
    if (fs.existsSync(value)) { shell.openPath(value); return }

    // Only schemes that the browser or mail client should ever handle. A card
    // pushed by some local script must not be able to launch arbitrary
    // protocol handlers.
    if (/^(https?:\/\/|mailto:)/i.test(value)) {
      shell.openExternal(value)
      return
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return
  } catch { /* fall through to focusing */ }
  sendToMedia('focus:' + value)
}

ipcMain.on('activity:open', (_event, target) => openTarget(target))

ipcMain.handle('activity:list', (event) => {
  if (!fromOwnWindow(event)) return { items: [], unread: 0 }
  return activityState()
})

ipcMain.handle('activity:dismiss', (event, id) => {
  if (!fromOwnWindow(event)) return activityState()
  activityStoreRef().dismiss(String(id || ''))
  sendActivityState()
  return activityState()
})

ipcMain.handle('activity:read-all', (event) => {
  if (!fromOwnWindow(event)) return activityState()
  activityStoreRef().markAllRead()
  sendActivityState()
  return activityState()
})

ipcMain.handle('activity:clear', (event) => {
  if (!fromOwnWindow(event)) return activityState()
  activityStoreRef().clear()
  sendActivityState()
  return activityState()
})
ipcMain.on('app:focus', (_event, name) => sendToMedia('focus:' + String(name || '')))
ipcMain.on('app:reveal', (_event, target) => {
  const map = {
    app: app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(),
    settings: path.dirname(settings.settingsFile()),
    art: path.join(app.getPath('temp'), 'dynamic-island-art')
  }
  const target_path = map[target]
  if (target_path) shell.openPath(target_path)
})

/* ------------------------------------------------------------------ *
 * Applying settings live
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * System stats widget
 *
 * Everything here comes from Node's own os module — no native
 * dependency, no spawning a process twice a second.
 * ------------------------------------------------------------------ */

let statsTimer = null
let lastCpuTimes = null

function cpuTimes() {
  const cpus = os.cpus() || []
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    const t = cpu.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

function readStats() {
  const now = cpuTimes()
  let cpu = 0
  if (lastCpuTimes) {
    const idle = now.idle - lastCpuTimes.idle
    const total = now.total - lastCpuTimes.total
    if (total > 0) cpu = Math.max(0, Math.min(100, 100 - (idle / total) * 100))
  }
  lastCpuTimes = now

  const total = os.totalmem()
  return {
    cpu: Math.round(cpu),
    used: total - os.freemem(),
    total,
    uptime: os.uptime(),
    cores: (os.cpus() || []).length
  }
}

function startSystemWatch() {
  clearInterval(statsTimer)
  statsTimer = null
  lastCpuTimes = cpuTimes()

  const conf = settings.get().widgets || {}
  if (!conf.system) return

  const ms = Math.max(1000, Math.min(5000, Number(conf.refreshMs) || 2000))
  statsTimer = setInterval(() => {
    if (!island || island.isDestroyed()) return
    pushToIsland({ type: 'stats', ...readStats() })
  }, ms)
}

function applySettings(patch = {}) {
  const conf = settings.get()
  if (!SHOT_MODE) {
    registerHotkey()
    setAutoStart(conf.general.startWithWindows)
    placeIsland()
  }

  if (patch.activities) {
    if (activityServer) activityServer.close()
    activityServer = null
    startActivities()
  }

  if (patch.calendar) {
    refreshCalendar()
  }

  if (patch.widgets) {
    startSystemWatch()
  }

  sendConfigToIsland()

  if (prefs && !prefs.isDestroyed()) {
    prefs.webContents.send('settings:changed', settings.publicConfig())
  }
  rebuildTray()
}

/* ------------------------------------------------------------------ *
 * Hotkey + autostart
 * ------------------------------------------------------------------ */

let currentHotkey = null

function registerHotkey() {
  const hotkey = settings.get().general.hotkey
  if (currentHotkey === hotkey) return
  globalShortcut.unregisterAll()
  currentHotkey = hotkey
  if (!hotkey) return
  try { globalShortcut.register(hotkey, () => toggleVisible()) } catch { /* invalid */ }
}

function startupShortcutPath() {
  return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu',
    'Programs', 'Startup', 'Dynamic Island.lnk')
}

function isAutoStartEnabled() {
  try { return fs.existsSync(startupShortcutPath()) } catch { return false }
}

let lastAutoStart = null

function setAutoStart(enabled) {
  if (lastAutoStart === enabled) return
  lastAutoStart = enabled
  const lnk = startupShortcutPath()

  if (!enabled) {
    try { fs.unlinkSync(lnk) } catch { /* already gone */ }
    return
  }

  const target = process.execPath
  // In development Electron is the executable and the app folder is the
  // argument. A packaged build is a real .exe that needs no argument.
  const args = app.isPackaged ? '' : app.getAppPath()
  const ps = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$s = $ws.CreateShortcut('${lnk.replace(/'/g, "''")}')`,
    `$s.TargetPath = '${target.replace(/'/g, "''")}'`,
    `$s.Arguments = '${args.replace(/'/g, "''")}'`,
    `$s.WorkingDirectory = '${path.dirname(target).replace(/'/g, "''")}'`,
    '$s.WindowStyle = 7',
    '$s.Save()'
  ].join('; ')

  try {
    spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true })
  } catch { /* non fatal */ }
}

/* ------------------------------------------------------------------ *
 * Tray
 * ------------------------------------------------------------------ */

function trayImage() {
  const iconPath = assetPath('tray.png')
  if (fs.existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath)
    if (!img.isEmpty()) return img
  }
  return nativeImage.createEmpty()
}

function rebuildTray() {
  if (!tray || SHOT_MODE) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: isVisible ? 'Hide island' : 'Show island', click: () => toggleVisible() },
    { label: 'Settings…', click: () => openSettings() },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: settings.get().general.startWithWindows,
      click: (item) => {
        settings.set({ general: { startWithWindows: item.checked } })
        applySettings({ general: {} })
      }
    },
    { label: 'Reset position', click: () => { placeIsland(); nudge() } },
    { type: 'separator' },
    { label: 'Quit Dynamic Island', click: () => quit() }
  ]))
}

function createTray() {
  tray = new Tray(trayImage())
  tray.setToolTip('Dynamic Island')
  tray.on('click', () => toggleVisible())
  tray.on('double-click', () => openSettings())
  rebuildTray()
}

function toggleVisible() {
  if (!island) return
  isVisible = !isVisible
  if (isVisible) { placeIsland(); island.showInactive() } else { island.hide() }
  rebuildTray()
}

function nudge() {
  if (island) island.webContents.send('pulse')
}

function quit() {
  app.isQuitting = true
  for (const child of [mediaBridge, volumeBridge]) {
    if (child) { try { child.kill() } catch { /* gone */ } }
  }
  if (activityServer) activityServer.close()
  app.quit()
}

/* ------------------------------------------------------------------ *
 * Album tint — an average colour of the artwork, used by the "tinted"
 * theme. Computed in the main process because a file:// page cannot
 * safely read pixels back out of a canvas.
 * ------------------------------------------------------------------ */

const tintCache = new Map()

function tintOf(filePath) {
  if (!filePath) return null
  if (tintCache.has(filePath)) return tintCache.get(filePath)
  try {
    const img = nativeImage.createFromPath(filePath)
    if (img.isEmpty()) return null

    const small = img.resize({ width: 16, height: 16, quality: 'good' })
    const bmp = small.toBitmap() // BGRA on Windows

    let r = 0, g = 0, b = 0, n = 0
    let vivid = null
    let vividScore = 0

    for (let i = 0; i + 3 < bmp.length; i += 4) {
      const blue = bmp[i]
      const green = bmp[i + 1]
      const red = bmp[i + 2]

      r += red
      g += green
      b += blue
      n += 1

      const max = Math.max(red, green, blue)
      const min = Math.min(red, green, blue)
      if (max < 24) continue // skip the near-black background of most artwork
      const saturation = (max - min) / max
      const score = saturation * (max / 255)
      if (score > vividScore) {
        vividScore = score
        vivid = [red, green, blue]
      }
    }

    if (!n) return null

    const average = [r / n, g / n, b / n]
    // The most colourful pixel reads as "the colour of this album"; the
    // average alone is usually a muddy grey.
    const base = vivid && vividScore > 0.12
      ? average.map((value, i) => value * 0.35 + vivid[i] * 0.65)
      : average

    let luma = (0.2126 * base[0] + 0.7152 * base[1] + 0.0722 * base[2]) / 255
    let lift = 1
    if (luma > 0.01 && luma < 0.34) lift = Math.min(2.4, 0.34 / luma)

    const color = `rgb(${base.map((value) => Math.round(Math.min(255, value * lift))).join(', ')})`
    tintCache.set(filePath, color)
    return color
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Python bridges
 * ------------------------------------------------------------------ */

function resolveBridge(name) {
  const candidates = [
    path.join(runtimeRoot(), 'runtime', name),
    path.join(__dirname, name)
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) || null
}

function spawnBridge(name, onMessage, tag) {
  const script = resolveBridge(name)
  if (!script) return null

  // Bundled runtime first (works on machines without Python), then whatever
  // happens to be installed for development.
  const python = bundledPython()
  const attempts = python
    ? [{ cmd: python, args: ['-u', script] }]
    : (process.platform === 'win32'
        ? [{ cmd: 'python', args: ['-u', script] }, { cmd: 'py', args: ['-3', '-u', script] }]
        : [{ cmd: 'python3', args: ['-u', script] }, { cmd: 'python', args: ['-u', script] }])
  let index = 0

  const attempt = () => {
    if (index >= attempts.length) return
    const { cmd, args } = attempts[index]

    let child
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      index += 1
      attempt()
      return
    }

    let buffer = ''
    let alive = false

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      alive = true
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.type === 'media' && msg.thumb) {
            msg.thumbPath = path.join(app.getPath('temp'), 'dynamic-island-art', msg.thumb)
            msg.tint = tintOf(msg.thumbPath)
          }
          onMessage(msg)
        } catch { /* skip malformed */ }
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (data) => {
      if (process.env.ISLAND_DEBUG) console.error(`[${tag}]`, data.toString().trim())
    })

    child.on('error', () => {
      if (!alive) { index += 1; attempt() }
    })

    child.on('exit', () => {
      if (!alive) { index += 1; attempt(); return }
      if (!app.isQuitting) setTimeout(() => {
        const next = spawnBridge(name, onMessage, tag)
        if (tag === 'media') mediaBridge = next
        else volumeBridge = next
      }, 2500)
    })

    if (tag === 'media') mediaBridge = child
    else volumeBridge = child
  }

  attempt()
  return null
}

function sendToMedia(cmd) {
  if (mediaBridge && mediaBridge.stdin.writable) {
    try { mediaBridge.stdin.write(cmd + '\n') } catch { /* went away */ }
  }
}

/* ------------------------------------------------------------------ *
 * Data sources
 * ------------------------------------------------------------------ */

function pushToIsland(message) {
  if (island && !island.isDestroyed()) island.webContents.send('data', message)
}

function pushCalendar(result) {
  pushToIsland({ type: 'calendar', ...result })
}

async function refreshCalendar() {
  const conf = settings.get().calendar
  if (!conf.enabled || !conf.icsUrl) {
    pushCalendar({ ok: false, reason: 'disabled', events: [] })
    return
  }
  pushCalendar(await calendar.load(conf, app.getPath('userData')))
}

function startCalendarLoop() {
  refreshCalendar()
  clearInterval(calendarTimer)
  calendarTimer = setInterval(refreshCalendar, 10 * 60 * 1000)
}

function activityStoreRef() {
  if (!activityStore) {
    activityStore = createStore({
      file: path.join(app.getPath('userData'), 'activities.json'),
      limit: () => (settings.get().activities || {}).keep
    })
    activityStore.load()
  }
  return activityStore
}

function activityState() {
  const store = activityStoreRef()
  return { items: store.all(), unread: store.unread() }
}

function sendActivityState() {
  pushToIsland({ type: 'activity-state', ...activityState() })
}

function pushActivity(activity) {
  const store = activityStoreRef()
  const record = store.push(activity)
  if (!record) return

  const conf = settings.get().activities || {}
  if (conf.showOnPush !== false) {
    pushToIsland({ type: 'activity', ...record, at: Date.now() })
  }
  sendActivityState()
  if (prefs && !prefs.isDestroyed()) prefs.webContents.send('activity:fired', record)
}

function startActivities() {
  const conf = settings.get().activities
  activityStoreRef()

  if (!conf.enabled) {
    sendConfigToIsland()
    return
  }
  activityServer = activities.start({
    port: conf.port,
    allowBrowser: !!conf.allowBrowser,
    onActivity: (activity) => pushActivity(activity),
    onClear: () => {
      activityStoreRef().clear()
      pushToIsland({ type: 'activity', clear: true })
      sendActivityState()
    },
    onList: () => activityState()
  })
  sendConfigToIsland()
  sendActivityState()
}

function clipboardFingerprint(buffer) {
  if (!buffer || !buffer.length) return '0'
  const step = Math.max(1, Math.floor(buffer.length / 64))
  let sum = buffer.length
  for (let i = 0; i < buffer.length; i += step) sum = (sum * 31 + buffer[i]) >>> 0
  return String(sum)
}

/**
 * Electron 45 replaced the clipboard module with the W3C-style async API, so
 * these are promises now. Worth knowing before blaming the code.
 */
async function clipboardSnapshot() {
  const text = await clipboard.readText()
  if (text) {
    return {
      kind: 'text',
      key: 't:' + clipboardFingerprint(Buffer.from(text.slice(0, 4096))),
      text
    }
  }

  const items = await clipboard.read()
  for (const item of items) {
    const type = item.types.find((entry) => entry.startsWith('image/'))
    if (!type) continue
    const blob = await item.getType(type)
    const buffer = Buffer.from(await blob.arrayBuffer())
    return { kind: 'image', key: 'i:' + clipboardFingerprint(buffer), buffer }
  }

  return { kind: 'none', key: '' }
}

function startClipboardWatch() {
  clearInterval(clipboardTimer)
  let primed = false
  let busy = false

  const poll = async () => {
    if (busy) return
    const conf = settings.get().clipboard
    if (!conf.enabled) {
      primed = false
      return
    }

    busy = true
    try {
      const snapshot = await clipboardSnapshot()

      // The first poll only records what is already there, so launching the
      // app never pops a card for something you copied an hour ago.
      if (!primed) {
        primed = true
        lastClipboard = snapshot.key
        return
      }
      if (!snapshot.key || snapshot.key === lastClipboard) return
      lastClipboard = snapshot.key

      if (snapshot.kind === 'text') {
        pushToIsland({
          type: 'clipboard',
          kind: 'text',
          preview: snapshot.text.replace(/\s+/g, ' ').trim().slice(0, conf.maxChars),
          length: snapshot.text.length
        })
        return
      }

      if (snapshot.kind === 'image' && conf.showImages) {
        let label = 'Image copied'
        try {
          const size = nativeImage.createFromBuffer(snapshot.buffer).getSize()
          if (size.width) label = `Image ${size.width}×${size.height}`
        } catch { /* the size is a nicety, not a requirement */ }
        pushToIsland({ type: 'clipboard', kind: 'image', preview: label, length: 0 })
      }
    } catch {
      /* clipboard busy, or a format we cannot read */
    } finally {
      busy = false
    }
  }

  clipboardTimer = setInterval(poll, 800)
}

/* ------------------------------------------------------------------ *
 * Screenshot mode — render states to PNG for design review
 * ------------------------------------------------------------------ */

async function screenshotStates() {
  const dir = path.join(app.getAppPath(), 'shots')
  fs.mkdirSync(dir, { recursive: true })
  const art = assetPath('sample-art.png')

  const song = {
    active: true, title: 'Weightless', artist: 'Marconi Union',
    album: 'Ambient Transmissions', status: 'playing',
    position: 63, duration: 214, app: 'Spotify', thumbPath: art,
    tint: tintOf(art)
  }


  const soon = new Date(Date.now() + 12 * 60000)
  const later = new Date(Date.now() + 90 * 60000)

  const event = {
    summary: 'Design review',
    start: soon.toISOString(),
    end: later.toISOString(),
    allDay: false,
    location: 'Meet'
  }

  const states = [
    ['01-idle', []],    ['02-compact', [{ media: song }]],
    ['03-music', [{ media: song, expanded: true }]],
    ['04-panel', [{ panel: true, events: [event] }]],
    ['05-timer', [{ timer: 272 }]],
    ['06-volume', [{ transient: { kind: 'vol', text: 'Volume 62%', bar: 62 } }]],
    ['07-mic-dot', [{ devices: { mic: ['Chrome'], camera: [] } }]],
    ['08-mic', [{ devices: { mic: ['Chrome'], camera: [] } }, { transient: { kind: 'mic', text: 'Microphone on · Chrome' } }]],
    ['09-calendar', [{ transient: { kind: 'cal', text: 'Design review · in 12m' } }]],
    ['10-activity', [{ activity: { title: 'Build finished', subtitle: 'in 42s', icon: '★', tone: 'success', progress: 0.72 } }]],
    ['11-clipboard', [{ transient: { kind: 'clip', text: 'Design tokens v2 final' } }]],
    ['12-timer-presets', [{ panel: true, panelMode: 'timer' }]],
    ['13-confetti', [{ timer: 272 }, { confetti: true }], 550]
  ]

  for (const [name, messages, delay] of states) {    await new Promise((r) => setTimeout(r, 300))
    for (const msg of messages) {
      island.webContents.send('debug', msg)
    }
    await new Promise((r) => setTimeout(r, delay || 1400))
    const image = await island.webContents.capturePage()
    fs.writeFileSync(path.join(dir, `${name}.png`), image.toPNG())
    island.webContents.send('debug', { reset: true })
  }

  app.isQuitting = true
  app.quit()
}

/* ------------------------------------------------------------------ *
 * Screenshot mode for the settings window
 * ------------------------------------------------------------------ */

async function screenshotPrefs() {
  const dir = path.join(app.getAppPath(), 'shots')
  fs.mkdirSync(dir, { recursive: true })

  openSettings()
  prefs.webContents.on('console-message', (event, level, message) => {
    console.log('[prefs]', message || (event && event.message))
  })
  await new Promise((r) => setTimeout(r, 1600))

  const panes = ['general', 'appearance', 'media', 'calls', 'clipboard', 'calendar', 'activities', 'about']

  for (let i = 0; i < panes.length; i += 1) {
    try {
      await prefs.webContents.executeJavaScript(
        `document.querySelectorAll('.nav-item')[${i}].click()`
      )
    } catch { /* window went away */ }
    await new Promise((r) => setTimeout(r, 450))
    const image = await prefs.webContents.capturePage()
    fs.writeFileSync(
      path.join(dir, `prefs-${String(i + 1).padStart(2, '0')}-${panes[i]}.png`),
      image.toPNG()
    )
  }

  app.isQuitting = true
  app.quit()
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (island) { placeIsland(); island.showInactive() }
    openSettings()
  })

  app.whenReady().then(() => {
    const firstRun = !fs.existsSync(settings.settingsFile())
    settings.load()
    createIsland()
    startActivities()
    spawnBridge('bridge.py', (msg) => pushToIsland(msg), 'media')
    spawnBridge('volume.py', (msg) => pushToIsland(msg), 'volume')
    startCalendarLoop()
    startClipboardWatch()
    startSystemWatch()

    if (SHOT_MODE) {
      island.webContents.once('did-finish-load', () => setTimeout(screenshotStates, 900))
      return
    }

    if (SHOT_PREFS) {
      setTimeout(screenshotPrefs, 600)
      return
    }

    createTray()
    registerHotkey()
    setAutoStart(settings.get().general.startWithWindows)
    screen.on('display-metrics-changed', placeIsland)
    screen.on('display-added', placeIsland)
    screen.on('display-removed', placeIsland)

    if (WANT_SETTINGS || settings.get().general.openSettingsOnLaunch || firstRun) openSettings()
  })

  app.on('window-all-closed', () => {
    if (app.isQuitting) app.quit()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    clearInterval(calendarTimer)
    clearInterval(clipboardTimer)
    if (activityServer) activityServer.close()
  })
}
