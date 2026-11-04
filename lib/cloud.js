// Connection to the ApiDock Team server. The session token is kept here, on the
// user's machine (data/cloud.json); the UI talks to the team server only through
// this local proxy, so the token never sits in the web page.
const crypto = require('crypto');
const path = require('path');
const store = require('./store');

const DEFAULT_SERVER = 'https://apidock.ebareidechutionek.cfd';
const FILE = path.join(store.DATA_DIR, 'cloud.json');

let state = store.readJson(FILE, {});
const pendingStates = new Map(); // login nonce -> created at

const save = () => store.writeJson(FILE, state);
const serverUrl = () => (process.env.APIDOCK_CLOUD || state.server || DEFAULT_SERVER).replace(/\/+$/, '');

function status() {
  return { server: serverUrl(), signedIn: !!state.token, user: state.user || null };
}

function loginUrl(localPort) {
  const nonce = crypto.randomBytes(16).toString('hex');
  pendingStates.set(nonce, Date.now());
  const redirect = `http://127.0.0.1:${localPort}/api/cloud/callback`;
  return `${serverUrl()}/auth/google/start?redirect=${encodeURIComponent(redirect)}&state=${nonce}`;
}

async function finishLogin(token, nonce) {
  const created = pendingStates.get(nonce);
  pendingStates.delete(nonce);
  if (!created || Date.now() - created > 15 * 60e3) throw new Error('This sign-in link expired. Start again from ApiDock.');
  state = { ...state, token };
  const me = await call('GET', '/me');
  state.user = me.user;
  save();
  return me.user;
}

// Email + password: mode is 'login' or 'register'.
async function passwordAuth(mode, { name, email, password }) {
  let res;
  try {
    res = await fetch(`${serverUrl()}/auth/${mode === 'register' ? 'register' : 'login'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    const e = new Error(`Can't reach the team server (${serverUrl()}). Check your internet connection.`);
    e.status = 503;
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `Team server error ${res.status}`);
    e.status = res.status;
    throw e;
  }
  state = { ...state, token: data.token, user: data.user };
  save();
  return status();
}

// Which sign-in methods the team server offers (Google only once it is configured).
async function authConfig() {
  try {
    const res = await fetch(`${serverUrl()}/auth/config`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error();
    return { ...(await res.json()), reachable: true };
  } catch {
    return { google: false, password: true, reachable: false };
  }
}

async function logout() {
  if (state.token) await call('POST', '/logout').catch(() => {});
  state = { server: state.server };
  save();
}

// Calls the team server's /api/<path> with the stored session.
async function call(method, apiPath, body) {
  if (!state.token) {
    const e = new Error('Not signed in');
    e.status = 401;
    throw e;
  }
  let res;
  try {
    res = await fetch(`${serverUrl()}/api${apiPath}`, {
      method,
      headers: { Authorization: `Bearer ${state.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const e = new Error(`Can't reach the team server (${serverUrl()}). Check your internet connection.`);
    e.status = 503;
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // Session ended on the server: forget it locally too.
    state = { server: state.server };
    save();
  }
  if (!res.ok) {
    const e = new Error(data.error || `Team server error ${res.status}`);
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}

function setServer(url) {
  state.server = String(url || '').trim() || undefined;
  save();
  return status();
}

module.exports = { status, loginUrl, finishLogin, passwordAuth, authConfig, logout, call, setServer };
