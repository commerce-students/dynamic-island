'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('islandSearch', {
  query: (text) => ipcRenderer.invoke('search:query', text),
  stats: () => ipcRenderer.invoke('search:stats'),
  open: (id) => ipcRenderer.invoke('search:open', id),
  reveal: (id) => ipcRenderer.invoke('search:reveal', id),
  ask: (text) => ipcRenderer.send('search:ask', text),
  close: () => ipcRenderer.send('search:close'),
  onShow: (cb) => ipcRenderer.on('search:show', () => cb())
})
