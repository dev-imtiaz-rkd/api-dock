// Disk persistence. Each collection is its own JSON file in data/collections
// so collections can be kept in git; environments, history and settings
// live in single files.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_DIR = path.resolve(__dirname, '..');
// The desktop app points this at a writable per-user folder (installed files are read-only).
const DATA_DIR = process.env.APIDOCK_DATA || path.join(APP_DIR, 'data');
const COLL_DIR = path.join(DATA_DIR, 'collections');
const ENV_FILE = path.join(DATA_DIR, 'environments.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SCAN_CACHE_FILE = path.join(DATA_DIR, 'scan-cache.json');
const HISTORY_LIMIT = 200;

fs.mkdirSync(COLL_DIR, { recursive: true });

const newId = () => crypto.randomUUID();

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const safeId = (id) => {
  if (!/^[A-Za-z0-9-]+$/.test(String(id))) throw new Error('Invalid id');
  return id;
};
const collFile = (id) => path.join(COLL_DIR, `${safeId(id)}.json`);

// ---------- collections ----------
function listCollections() {
  return fs
    .readdirSync(COLL_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(COLL_DIR, f), null))
    .filter(Boolean)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function getCollection(id) {
  return readJson(collFile(id), null);
}

function saveCollection(coll) {
  if (!coll.id) coll.id = newId();
  coll.updatedAt = new Date().toISOString();
  writeJson(collFile(coll.id), coll);
  return coll;
}

function deleteCollection(id) {
  try {
    fs.unlinkSync(collFile(id));
  } catch {}
}

// ---------- environments ----------
function listEnvironments() {
  return readJson(ENV_FILE, []);
}

function saveEnvironments(envs) {
  writeJson(ENV_FILE, envs);
  return envs;
}

function upsertEnvironment(env) {
  const envs = listEnvironments();
  if (!env.id) env.id = newId();
  const i = envs.findIndex((e) => e.id === env.id);
  if (i >= 0) envs[i] = env;
  else envs.push(env);
  saveEnvironments(envs);
  return env;
}

function deleteEnvironment(id) {
  saveEnvironments(listEnvironments().filter((e) => e.id !== id));
}

// ---------- history ----------
function listHistory() {
  return readJson(HISTORY_FILE, []);
}

function addHistory(entry) {
  const h = listHistory();
  h.unshift({ id: newId(), ...entry });
  writeJson(HISTORY_FILE, h.slice(0, HISTORY_LIMIT));
}

function clearHistory() {
  writeJson(HISTORY_FILE, []);
}

// ---------- settings ----------
function getSettings() {
  const s = readJson(SETTINGS_FILE, {});
  s.roots = s.roots || [process.env.APIDOCK_ROOT || path.dirname(APP_DIR)];
  s.services = s.services || {};
  s.activeEnvironmentId = s.activeEnvironmentId || null;
  return s;
}

function saveSettings(s) {
  writeJson(SETTINGS_FILE, s);
  return s;
}

module.exports = {
  APP_DIR,
  DATA_DIR,
  SCAN_CACHE_FILE,
  newId,
  readJson,
  writeJson,
  listCollections,
  getCollection,
  saveCollection,
  deleteCollection,
  listEnvironments,
  upsertEnvironment,
  deleteEnvironment,
  listHistory,
  addHistory,
  clearHistory,
  getSettings,
  saveSettings,
};
