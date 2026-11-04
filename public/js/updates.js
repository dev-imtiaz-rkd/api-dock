// In-app update notice (desktop app only). The Electron preload exposes
// window.apidockUpdater; in the browser version this module does nothing.
import { h, icon, toast } from './util.js';
import { app } from './bus.js';

const U = window.apidockUpdater;
export const updatesSupported = !!U;

let status = { state: 'idle' };
let dismissedFor = null; // version the user said "Later" to
let manual = false; // last check was started by the user
let current = null;
const card = h('div', { class: 'update-card', role: 'status', hidden: true });

export async function initUpdates() {
  if (!U) return;
  document.body.append(card);
  current = await U.version().catch(() => null);
  U.onStatus((s) => {
    status = s;
    if (manual && s.state === 'latest') {
      manual = false;
      toast(`You’re up to date — ApiDock ${s.version}`);
    }
    if (manual && s.state === 'error') {
      manual = false;
      toast(s.message, 'error');
    }
    render();
    app.renderDock && app.renderDock();
  });
}

export function updateAvailable() {
  return ['available', 'downloading', 'downloaded', 'restarting'].includes(status.state) ? status : null;
}

export function showUpdateCard() {
  dismissedFor = null;
  render();
}

export async function checkForUpdates() {
  if (!U) return;
  const v = current || (await U.version());
  if (!v.supported) return toast(v.reason, 'error');
  manual = true;
  toast('Checking for updates…');
  const s = await U.check().catch((e) => ({ state: 'error', message: e.message }));
  if (s && s.state === 'available') {
    manual = false;
    showUpdateCard();
  }
}

export function versionInfo() {
  return current;
}

async function install() {
  status = { ...status, state: 'downloading', percent: 0 };
  render();
  const r = await U.install().catch((e) => ({ state: 'error', message: e.message }));
  if (r && r.state === 'error') {
    status = { ...status, ...r };
    render();
  }
}

function render() {
  const s = status;
  const show = (s.state === 'available' && dismissedFor !== s.version) || ['downloading', 'downloaded', 'restarting'].includes(s.state) || (s.state === 'error' && s.version);
  card.hidden = !show;
  if (!show) return;

  if (s.state === 'available') {
    card.replaceChildren(
      h('div', { class: 'uc-icon' }, icon('download', 18)),
      h(
        'div',
        { class: 'uc-main' },
        h('b', {}, `ApiDock ${s.version} is available`),
        h('span', {}, `You have ${current?.version || 'an older version'}. The update installs and ApiDock reopens by itself.`),
        s.notes ? h('details', { class: 'uc-notes' }, h('summary', {}, 'What’s new'), h('p', {}, s.notes)) : null,
        h(
          'div',
          { class: 'uc-actions' },
          h('button', { class: 'btn primary sm', onClick: install }, 'Update & restart'),
          h('button', { class: 'btn ghost sm', onClick: () => ((dismissedFor = s.version), render(), app.renderDock && app.renderDock()) }, 'Later'),
        ),
      ),
    );
  } else if (s.state === 'downloading') {
    const pct = Math.max(0, Math.min(100, s.percent || 0));
    card.replaceChildren(
      h('div', { class: 'uc-icon spin-slow' }, icon('refresh', 18)),
      h(
        'div',
        { class: 'uc-main' },
        h('b', {}, `Downloading ApiDock ${s.version || ''}…`),
        h('div', { class: 'uc-bar' }, h('i', { style: { width: `${pct}%` } })),
        h('span', {}, `${pct}%${s.total ? ` of ${(s.total / 1048576).toFixed(0)} MB` : ''} — ApiDock restarts when it’s done.`),
      ),
    );
  } else if (s.state === 'downloaded' || s.state === 'restarting') {
    card.replaceChildren(h('div', { class: 'uc-icon ok' }, icon('check', 18)), h('div', { class: 'uc-main' }, h('b', {}, 'Installing the update…'), h('span', {}, 'ApiDock will reopen in a moment.')));
  } else if (s.state === 'error') {
    card.replaceChildren(
      h('div', { class: 'uc-icon err' }, icon('alert', 18)),
      h(
        'div',
        { class: 'uc-main' },
        h('b', {}, 'Update failed'),
        h('span', {}, s.message || 'Something went wrong.'),
        h('div', { class: 'uc-actions' }, h('button', { class: 'btn sm', onClick: install }, 'Try again'), h('button', { class: 'btn ghost sm', onClick: () => ((status = { state: 'idle' }), render()) }, 'Close')),
      ),
    );
  }
}
