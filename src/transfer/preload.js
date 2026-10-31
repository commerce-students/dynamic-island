'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('islandTransfer', {
  answer: (accept, fileIds) => ipcRenderer.invoke('transfer:answer', { accept: Boolean(accept), fileIds }),
  onRequest: (cb) => ipcRenderer.on('transfer:request', (_event, request) => cb(request))
})
