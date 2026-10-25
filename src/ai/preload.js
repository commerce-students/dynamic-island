'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ai', {
  info: () => ipcRenderer.invoke('ai:info'),
  send: (messages) => ipcRenderer.invoke('ai:send', messages),
  close: () => ipcRenderer.send('ai:close'),
  openSettings: () => ipcRenderer.send('ai:open-settings')
})
