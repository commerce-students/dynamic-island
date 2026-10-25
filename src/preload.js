'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('island', {
  hit: (inside) => ipcRenderer.send('hit', inside),
  media: (cmd) => ipcRenderer.send('media', cmd),
  open: (target) => ipcRenderer.send('activity:open', target),
  focusApp: (name) => ipcRenderer.send('app:focus', name),
  openSettings: () => ipcRenderer.send('open-settings'),
  openAi: () => ipcRenderer.send('ai:open'),
  onConfig: (cb) => ipcRenderer.on('config', (_e, payload) => cb(payload)),
  onData: (cb) => ipcRenderer.on('data', (_e, msg) => cb(msg)),
  onDebug: (cb) => ipcRenderer.on('debug', (_e, msg) => cb(msg)),
  onPulse: (cb) => ipcRenderer.on('pulse', () => cb())
})
