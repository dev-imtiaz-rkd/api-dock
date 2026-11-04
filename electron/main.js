// ApiDock desktop shell: runs the local server in-process and shows it in a window.
const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Installed app files are read-only, so data lives in the per-user folder:
// %APPDATA%\ApiDock\data on Windows.
process.env.APIDOCK_DATA = process.env.APIDOCK_DATA || path.join(app.getPath('userData'), 'data');
process.env.APIDOCK_ROOT = process.env.APIDOCK_ROOT || os.homedir();
fs.mkdirSync(process.env.APIDOCK_DATA, { recursive: true });

const server = require('../server');
const updater = require('./updater');

let win = null;
let port = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(boot);
}

async function boot() {
  Menu.setApplicationMenu(null);
  try {
    port = await server.start(0);
    console.log(`ApiDock server on http://127.0.0.1:${port}`);
  } catch (err) {
    dialog.showErrorBox('ApiDock could not start', String(err && err.message ? err.message : err));
    app.quit();
    return;
  }
  createWindow();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    title: 'ApiDock',
    backgroundColor: '#121211',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  const home = `http://127.0.0.1:${port}/`;
  win.loadURL(home);
  win.once('ready-to-show', () => win.show());
  updater.init(win);

  // Links that leave ApiDock open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(home)) {
      // Export links are file downloads served by the local server — let them through.
      if (url.includes('/export')) return;
      return;
    }
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  // Exports (collections, variable sets, responses) ask where to save.
  win.webContents.session.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
  });

  // Keyboard shortcuts that the app does not handle itself.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r' && !input.shift)) {
      win.webContents.reload();
      e.preventDefault();
    } else if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      win.webContents.toggleDevTools();
      e.preventDefault();
    } else if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      e.preventDefault();
    }
  });

  win.on('closed', () => (win = null));
}

app.on('window-all-closed', () => app.quit());

// Stop any `php artisan serve` processes ApiDock started.
let stopping = false;
app.on('before-quit', async (e) => {
  if (stopping) return;
  stopping = true;
  e.preventDefault();
  try {
    await server.stop();
  } catch {}
  app.exit(0);
});
