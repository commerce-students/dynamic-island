'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('island', {
  hit: (inside) => ipcRenderer.send('hit', inside),
  media: (cmd) => ipcRenderer.send('media', cmd),
  open: (target) => ipcRenderer.send('activity:open', target),
  activityList: () => ipcRenderer.invoke('activity:list'),
  activityDismiss: (id) => ipcRenderer.invoke('activity:dismiss', id),
  activityClear: () => ipcRenderer.invoke('activity:clear'),
  activityRead: () => ipcRenderer.invoke('activity:read-all'),
  focusApp: (name) => ipcRenderer.send('app:focus', name),
  openSettings: () => ipcRenderer.send('open-settings'),
  openAi: () => ipcRenderer.send('ai:open'),
  openSearch: () => ipcRenderer.send('search:panel'),
  onConfig: (cb) => ipcRenderer.on('config', (_e, payload) => cb(payload)),
  onData: (cb) => ipcRenderer.on('data', (_e, msg) => cb(msg)),
  onDebug: (cb) => ipcRenderer.on('debug', (_e, msg) => cb(msg)),
  onPulse: (cb) => ipcRenderer.on('pulse', () => cb())
})
