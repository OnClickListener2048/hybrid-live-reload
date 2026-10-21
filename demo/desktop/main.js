'use strict';

const path = require('path');
const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  shell,
} = require('electron');
const QRCode = require('qrcode');
const orchestrator = require('../core/orchestrator');
const { ports } = require('../core/config');

const PHONE_PARTITION = 'persist:hybrid-demo-phone';
const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 HybridDemoPhone/0.1';

let controlWindow = null;
let phoneWindow = null;
let proxyEnabled = true;
let busy = false;
let quitting = false;

function currentStatus() {
  return {
    ...orchestrator.status(),
    proxyEnabled,
    phoneOpen: Boolean(phoneWindow && !phoneWindow.isDestroyed()),
  };
}

function sendToControl(channel, payload) {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send(channel, payload);
  }
}

function broadcastStatus() {
  sendToControl('demo:status', currentStatus());
}

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 680,
    title: 'Hybrid Live Reload · Demo Console',
    backgroundColor: '#0b0f19',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  controlWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  controlWindow.once('ready-to-show', () => controlWindow.show());
  controlWindow.on('closed', () => {
    controlWindow = null;
    app.quit();
  });
}

function phoneSession() {
  return session.fromPartition(PHONE_PARTITION);
}

async function applyPhoneProxy() {
  const phone = phoneSession();
  const proxyRules = proxyEnabled
    ? `http://127.0.0.1:${ports.proxy}`
    : 'direct://';
  await phone.setProxy({ proxyRules });
}

function updatePhoneTitle() {
  if (!phoneWindow || phoneWindow.isDestroyed()) return;
  phoneWindow.setTitle(
    proxyEnabled
      ? 'Hybrid Demo · 手机窗口（代理开 · 本地代码）'
      : 'Hybrid Demo · 手机窗口（代理关 · 生产代码）'
  );
}

function ensurePhoneWindow() {
  if (phoneWindow && !phoneWindow.isDestroyed()) {
    phoneWindow.show();
    phoneWindow.focus();
    return phoneWindow;
  }

  phoneWindow = new BrowserWindow({
    width: 430,
    height: 900,
    minWidth: 360,
    minHeight: 560,
    backgroundColor: '#08130f',
    title: 'Hybrid Demo · 手机窗口',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      partition: PHONE_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  phoneWindow.webContents.setUserAgent(PHONE_UA);

  phoneWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  phoneWindow.once('ready-to-show', () => phoneWindow.show());
  phoneWindow.on('closed', () => {
    phoneWindow = null;
    broadcastStatus();
  });

  updatePhoneTitle();
  return phoneWindow;
}

async function loadPhone(url) {
  const win = ensurePhoneWindow();
  await applyPhoneProxy();
  updatePhoneTitle();
  try {
    await win.loadURL(url);
  } catch (err) {
    // A failed load still leaves the window usable; surface the reason.
    orchestrator.log(`[phone] load failed: ${err.message}`);
  }
}

function openExternal(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
  shell.openExternal(url);
}

function registerIpc() {
  ipcMain.handle('demo:status', () => currentStatus());

  ipcMain.handle('demo:qr', async (_event, text) => {
    if (typeof text !== 'string' || !/^https?:\/\//i.test(text)) return null;
    return QRCode.toDataURL(text, {
      width: 220,
      margin: 1,
      color: { dark: '#0b1220', light: '#ffffff' },
    });
  });

  ipcMain.handle('demo:start', async () => {
    if (!orchestrator.running && !busy) {
      busy = true;
      try {
        await orchestrator.start();
      } finally {
        busy = false;
      }
    }
    broadcastStatus();
    return currentStatus();
  });

  ipcMain.handle('demo:restart', async () => {
    if (busy) return currentStatus();
    busy = true;
    try {
      await orchestrator.stop();
      await orchestrator.start();
      if (phoneWindow && !phoneWindow.isDestroyed()) {
        await loadPhone(orchestrator.status().phoneUrl);
      }
    } catch (err) {
      orchestrator.log(`[orchestrator] restart failed: ${err.message}`);
    } finally {
      busy = false;
    }
    broadcastStatus();
    return currentStatus();
  });

  ipcMain.handle('demo:open-phone', async () => {
    if (!orchestrator.running) {
      return currentStatus();
    }
    await loadPhone(orchestrator.status().phoneUrl);
    broadcastStatus();
    return currentStatus();
  });

  ipcMain.handle('demo:set-proxy', async (_event, enabled) => {
    proxyEnabled = Boolean(enabled);
    await applyPhoneProxy();
    updatePhoneTitle();
    if (phoneWindow && !phoneWindow.isDestroyed()) {
      await loadPhone(orchestrator.status().phoneUrl);
    }
    broadcastStatus();
    return currentStatus();
  });

  ipcMain.handle('demo:clear-session', async () => {
    const phone = phoneSession();
    await phone.clearStorageData({
      storages: [
        'cookies',
        'localstorage',
        'indexdb',
        'serviceworkers',
        'cachestorage',
        'websql',
      ],
    });
    await phone.clearCache();
    orchestrator.clearSession();
    if (phoneWindow && !phoneWindow.isDestroyed()) {
      await loadPhone(orchestrator.status().phoneUrl);
    }
    broadcastStatus();
    return currentStatus();
  });

  ipcMain.handle('demo:open-url', (_event, url) => {
    openExternal(url);
  });
}

app.whenReady().then(async () => {
  registerIpc();

  orchestrator.on('log', (entry) => sendToControl('demo:log', entry));
  orchestrator.on('status', () => broadcastStatus());

  createControlWindow();

  try {
    await orchestrator.start();
  } catch (err) {
    orchestrator.log(`[orchestrator] start failed: ${err.message}`);
  }
  broadcastStatus();

  app.on('activate', () => {
    if (!controlWindow) createControlWindow();
  });
});

app.on('before-quit', async (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  if (phoneWindow && !phoneWindow.isDestroyed()) phoneWindow.destroy();
  try {
    await orchestrator.stop();
  } catch (err) {
    // Process is exiting; nothing else to do.
  }
  app.quit();
});

app.on('window-all-closed', () => {
  app.quit();
});
