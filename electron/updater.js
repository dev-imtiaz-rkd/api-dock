// Auto-update from the Dhaka server (https://apidock.ebareidechutionek.cfd/updates/).
// Checks shortly after start and every few hours; the page shows the result and
// one click downloads the update and restarts into it.
const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

// Kept in %APPDATA%\ApiDock\updater.log to diagnose update problems.
function log(line) {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  try {
    const file = path.join(app.getPath('userData'), 'updater.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 256 * 1024) fs.renameSync(file, `${file}.old`);
    fs.appendFileSync(file, `${text}\n`);
  } catch {}
}

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 10 * 1000;

let win = null;
let last = { state: 'idle' };
let updater = null;
let downloading = false;

function send(status) {
  last = status;
  log(`[updater] ${status.state}${status.version ? ' ' + status.version : ''}${status.percent != null ? ' ' + status.percent + '%' : ''}${status.message ? ' — ' + status.message : ''}`);
  if (win && !win.isDestroyed()) win.webContents.send('update:status', status);
}

// Installed (NSIS) builds can update themselves; the portable exe and `npm run app` cannot.
function unsupportedReason() {
  if (!app.isPackaged) return 'Updates are only available in the installed app.';
  if (process.env.PORTABLE_EXECUTABLE_DIR) return 'The portable version can’t update itself — install the regular version (ApiDock-Setup) to get automatic updates.';
  return null;
}

function init(mainWindow) {
  win = mainWindow;
  const reason = unsupportedReason();

  ipcMain.handle('update:version', () => ({ version: app.getVersion(), supported: !reason, reason }));
  ipcMain.handle('update:check', async () => {
    if (reason) return { state: 'unsupported', message: reason };
    await check(true);
    return last;
  });
  ipcMain.handle('update:install', async () => {
    if (reason || !updater) return { state: 'unsupported', message: reason };
    if (last.state === 'downloaded') return restartNow();
    if (downloading) return last;
    downloading = true;
    // When the download finishes the 'update-downloaded' handler restarts the app.
    updater.downloadUpdate().catch((err) => {
      downloading = false;
      send({ state: 'error', message: friendly(err) });
    });
    return { state: 'downloading', percent: 0 };
  });

  // The page may load after an event fired: replay the latest status.
  win.webContents.on('did-finish-load', () => send(last));

  if (reason) return;

  ({ autoUpdater: updater } = require('electron-updater'));
  updater.autoDownload = false; // the user decides when
  updater.autoInstallOnAppQuit = true; // a finished download installs on next quit anyway
  updater.allowPrerelease = false;

  updater.on('checking-for-update', () => send({ ...last, state: last.state === 'available' ? 'available' : 'checking' }));
  updater.on('update-not-available', () => send({ state: 'latest', version: app.getVersion() }));
  updater.on('update-available', (info) => send({ state: 'available', version: info.version, notes: plainNotes(info.releaseNotes), date: info.releaseDate }));
  updater.on('download-progress', (p) => send({ state: 'downloading', version: last.version, percent: Math.round(p.percent), bytesPerSecond: p.bytesPerSecond, total: p.total }));
  updater.on('update-downloaded', (info) => {
    downloading = false;
    send({ state: 'downloaded', version: info.version });
    // The user already clicked "Update & restart": give the UI a moment to show it, then restart.
    setTimeout(restartNow, 1200);
  });
  updater.on('error', (err) => {
    log(`[updater] raw error: ${String((err && err.stack) || err).split(/\r?\n/).slice(0, 6).join(' | ')}`);
    downloading = false;
    send({ state: 'error', message: friendly(err), version: last.version });
  });

  setTimeout(() => check(false), FIRST_CHECK_MS);
  setInterval(() => check(false), CHECK_EVERY_MS).unref?.();
}

async function check(manual) {
  if (!updater || downloading) return;
  try {
    await updater.checkForUpdates();
  } catch (err) {
    // Background checks fail quietly (offline etc.); manual checks report the problem.
    if (manual) send({ state: 'error', message: friendly(err) });
  }
}

function restartNow() {
  app.isUpdating = true;
  // isSilent: no installer window; isForceRunAfter: reopen ApiDock afterwards.
  setImmediate(() => updater.quitAndInstall(true, true));
  return { state: 'restarting' };
}

function friendly(err) {
  const msg = String((err && err.message) || err || '');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::|network/i.test(msg)) return 'Couldn’t reach the update server. Check your internet connection.';
  if (/404|latest\.yml/i.test(msg)) return 'No published update was found yet.';
  return msg.split('\n')[0].slice(0, 200) || 'Update failed';
}

function plainNotes(notes) {
  if (!notes) return '';
  const text = Array.isArray(notes) ? notes.map((n) => n.note || '').join('\n') : String(notes);
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim().slice(0, 600);
}

module.exports = { init };
