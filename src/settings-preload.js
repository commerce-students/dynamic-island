'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('prefs', {
  load: () => ipcRenderer.invoke('settings:get'),
  set: (patch) => ipcRenderer.invoke('settings:set', patch),
  reset: () => ipcRenderer.invoke('settings:reset'),
  checkCalendar: () => ipcRenderer.invoke('settings:calendar-check'),
  testActivity: () => ipcRenderer.invoke('settings:test-activity'),
  pickSound: () => ipcRenderer.invoke('settings:pick-sound'),
  pickFolder: () => ipcRenderer.invoke('settings:pick-folder'),
  previewSound: () => { ipcRenderer.send('settings:preview-sound') },
  aiTest: () => ipcRenderer.invoke('ai:test'),
  clearApiKey: () => ipcRenderer.invoke('settings:clear-api-key'),
  close: () => ipcRenderer.send('settings:close'),
  quit: () => ipcRenderer.send('app:quit'),
  reveal: (where) => ipcRenderer.send('app:reveal', where),
  onChanged: (cb) => ipcRenderer.on('settings:changed', (_e, conf) => cb(conf)),
  onActivity: (cb) => ipcRenderer.on('activity:fired', (_e, activity) => cb(activity))
})
