'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const QRCode = require('qrcode');
const orchestrator = require('../core/bundle-orchestrator');

// `npm run bundle:demo:react` passes --source web-react/dist through Electron.
function parseSourceArg(argv) {
  const index = argv.indexOf('--source');
  if (index === -1) return null;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

const sourceArg = parseSourceArg(process.argv);
if (sourceArg) {
  orchestrator.setSourceDir(path.resolve(path.join(__dirname, '..'), sourceArg));
}

let window = null;
let quitting = false;

function currentStatus() {
  return orchestrator.status();
}

function send(channel, payload) {
  if (window && !window.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}

function broadcastStatus() {
  send('bundle:status', currentStatus());
}

// Dev/CI helper: capture the console to a PNG and exit.
// BUNDLE_DEMO_SCREENSHOT=/tmp/console.png npm run bundle:demo
async function maybeCaptureScreenshot() {
  const target = process.env.BUNDLE_DEMO_SCREENSHOT;
  if (!target || !window) return;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const image = await window.webContents.capturePage();
  fs.writeFileSync(target, image.toPNG());
  orchestrator.log(`[screenshot] saved ${target}`);
  app.quit();
}

function createWindow() {
  window = new BrowserWindow({
    width: 1080,
    height: 820,
    minWidth: 900,
    minHeight: 680,
    title: 'Hybrid DevShell · Bundle Sync',
    backgroundColor: '#07111d',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    window = null;
    app.quit();
  });
}

function registerIpc() {
  ipcMain.handle('bundle:status', () => currentStatus());

  ipcMain.handle('bundle:qr', async (_event, text) => {
    if (typeof text !== 'string' || text.length === 0) return null;
    return QRCode.toDataURL(text, {
      width: 260,
      margin: 1,
      color: { dark: '#07111d', light: '#ffffff' },
    });
  });

  ipcMain.handle('bundle:build', async () => {
    try {
      await orchestrator.buildNewBundle();
    } catch (err) {
      orchestrator.log(`[build] failed: ${err.message}`);
    }
    broadcastStatus();
    return currentStatus();
  });

  ipcMain.handle('bundle:restart', async () => {
    await orchestrator.stop();
    try {
      await orchestrator.start();
    } catch (err) {
      orchestrator.log(`[restart] failed: ${err.message}`);
    }
    broadcastStatus();
    return currentStatus();
  });

  ipcMain.handle('bundle:open-url', (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
  });
}

app.whenReady().then(async () => {
  registerIpc();
  orchestrator.on('log', (entry) => send('bundle:log', entry));
  orchestrator.on('status', () => broadcastStatus());

  createWindow();

  try {
    await orchestrator.start();
  } catch (err) {
    orchestrator.log(`[orchestrator] start failed: ${err.message}`);
  }
  broadcastStatus();
  maybeCaptureScreenshot().catch((err) => {
    orchestrator.log(`[screenshot] failed: ${err.message}`);
  });

  app.on('activate', () => {
    if (!window) createWindow();
  });
});

app.on('before-quit', async (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  try {
    await orchestrator.stop();
  } catch {
    // Exiting anyway.
  }
  app.quit();
});

app.on('window-all-closed', () => app.quit());
