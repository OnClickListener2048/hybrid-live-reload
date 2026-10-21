'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('bundleDemo', {
  getStatus: () => ipcRenderer.invoke('bundle:status'),
  getQr: (text) => ipcRenderer.invoke('bundle:qr', text),
  build: () => ipcRenderer.invoke('bundle:build'),
  restart: () => ipcRenderer.invoke('bundle:restart'),
  openUrl: (url) => ipcRenderer.invoke('bundle:open-url', url),
  onStatus: (callback) => subscribe('bundle:status', callback),
  onLog: (callback) => subscribe('bundle:log', callback),
});
