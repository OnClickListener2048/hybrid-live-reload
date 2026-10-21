'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('demo', {
  getStatus: () => ipcRenderer.invoke('demo:status'),
  getQr: (text) => ipcRenderer.invoke('demo:qr', text),
  start: () => ipcRenderer.invoke('demo:start'),
  restart: () => ipcRenderer.invoke('demo:restart'),
  openPhone: () => ipcRenderer.invoke('demo:open-phone'),
  setProxy: (enabled) => ipcRenderer.invoke('demo:set-proxy', Boolean(enabled)),
  clearSession: () => ipcRenderer.invoke('demo:clear-session'),
  openUrl: (url) => ipcRenderer.invoke('demo:open-url', url),
  onStatus: (callback) => subscribe('demo:status', callback),
  onLog: (callback) => subscribe('demo:log', callback),
});
