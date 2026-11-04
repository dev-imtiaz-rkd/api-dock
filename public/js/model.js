// App state, collection tree helpers, variable resolution and request building.
import { api } from './util.js';

export const S = {
  collections: [],
  environments: [],
  settings: {},
  history: [],
  discover: null,
  ws: 'drafts', // active workspace: a collection id, or 'drafts' | 'services'
  activeByWs: {}, // workspace -> active tab id
  tabs: [], // every tab carries .ws; only the active workspace's tabs are shown
  expanded: new Set(),
  filter: '',
};

// The active tab is per workspace, so switching collections restores each one's own tab.
Object.defineProperty(S, 'activeTabId', {
  get() {
    return S.activeByWs[S.ws] || null;
  },
  set(v) {
    S.activeByWs[S.ws] = v;
  },
});

export const uid = () => crypto.randomUUID();
export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

export function newRequest(name = 'Untitled request') {
  return {
    id: uid(),
    type: 'request',
    name,
    description: '',
    method: 'GET',
    url: '',
    params: [],
    pathVars: [],
    headers: [],
    auth: { type: 'inherit' },
    body: { mode: 'none', rawType: 'json', raw: '', urlencoded: [], formdata: [] },
  };
}

export function normalizeRequest(r) {
  r.params = r.params || [];
  r.pathVars = r.pathVars || [];
  r.headers = r.headers || [];
  r.auth = r.auth || { type: 'inherit' };
  r.body = { mode: 'none', rawType: 'json', raw: '', urlencoded: [], formdata: [], ...(r.body || {}) };
  return r;
}

// ---------- tree helpers ----------
export const getCollection = (id) => S.collections.find((c) => c.id === id);

export function findItem(coll, id, parents = []) {
  for (const it of coll.items || []) {
    if (it.id === id) return { item: it, parents, list: coll.items };
    if (it.type === 'folder') {
      const r = findItem(it, id, [...parents, it]);
      if (r) return r;
    }
  }
  return null;
}

export function findAnywhere(id) {
  for (const c of S.collections) {
    const r = findItem(c, id);
    if (r) return { ...r, collection: c };
  }
  return null;
}

export function countRequests(node) {
  let n = 0;
  for (const it of node.items || []) n += it.type === 'folder' ? countRequests(it) : 1;
  return n;
}

export function flattenRequests(node, out = [], trail = []) {
  for (const it of node.items || []) {
    if (it.type === 'folder') flattenRequests(it, out, [...trail, it.name]);
    else out.push({ item: it, folder: trail.join(' / ') });
  }
  return out;
}

export function reassignIds(item) {
  item.id = uid();
  for (const c of item.items || []) reassignIds(c);
  return item;
}

// ---------- team (shared) collections ----------
// Shared collections live on the team server, reached through the local proxy.
export const cloudApi = (method, p, body) => api(method, `/api/cloud/x${p}`, body);

// Which variable set is in use is personal, so it stays on this machine.
const ACTIVE_KEY = 'apidock.cloudActive';
function cloudActiveMap() {
  try {
    return JSON.parse(localStorage.getItem(ACTIVE_KEY) || '{}');
  } catch {
    return {};
  }
}
export function rememberCloudActive(coll) {
  const m = cloudActiveMap();
  m[coll.id] = coll.activeEnvironmentId || null;
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(m));
  } catch {}
}

// Server record -> collection object used by the UI.
export function fromCloud(full) {
  const data = { ...full.data, id: full.id };
  data.cloud = { teamId: full.teamId, teamName: full.teamName, role: full.role, version: full.version, updatedAt: full.updatedAt, updatedBy: full.updatedBy };
  const act = cloudActiveMap()[full.id];
  data.activeEnvironmentId = act && (data.environments || []).some((e) => e.id === act) ? act : null;
  return data;
}

// Collection object -> what is stored on the server (no personal/local fields).
export function toCloudData(coll) {
  const d = stripTransient(coll);
  delete d.cloud;
  delete d.activeEnvironmentId;
  delete d.source;
  return d;
}

export const isViewOnly = (coll) => !!(coll && coll.cloud && coll.cloud.role === 'viewer');

async function saveCloudCollection(coll) {
  rememberCloudActive(coll);
  if (isViewOnly(coll)) {
    const e = new Error('View only — ask the owner for Editor access to change this collection');
    e.quiet = false;
    throw e;
  }
  try {
    const meta = await cloudApi('PUT', `/collections/${coll.id}`, { data: toCloudData(coll), baseVersion: coll.cloud.version });
    coll.cloud = { ...coll.cloud, version: meta.version, updatedAt: meta.updatedAt, updatedBy: meta.updatedBy };
    return coll;
  } catch (err) {
    if (err.status === 409 && err.data && err.data.current) {
      // Someone else saved first: take their version so nothing of theirs is lost.
      const fresh = fromCloud(err.data.current);
      const i = S.collections.findIndex((c) => c.id === coll.id);
      if (i >= 0) S.collections[i] = fresh;
      const e = new Error(`${err.message}. Their version is loaded — save again to apply your change on top.`);
      e.conflict = true;
      throw e;
    }
    throw err;
  }
}

export async function saveCollection(coll) {
  if (coll.cloud) return saveCloudCollection(coll);
  const saved = await api('PUT', `/api/collections/${coll.id}`, stripTransient(coll));
  const i = S.collections.findIndex((c) => c.id === coll.id);
  if (i >= 0) S.collections[i] = { ...coll, updatedAt: saved.updatedAt };
  return coll;
}

// File contents picked for form-data never get written to disk.
export function stripTransient(obj) {
  return JSON.parse(JSON.stringify(obj, (k, v) => (k === 'fileData' ? undefined : v)));
}

// ---------- variables ----------
// Parses .env style text (KEY=value, key: value, `export KEY="v"`, # comments).
export function parseVarText(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const off = line.startsWith('//');
    if (off) line = line.slice(2).trim();
    line = line.replace(/^export\s+/, '');
    const eq = line.indexOf('=');
    const co = line.indexOf(':');
    const i = eq < 0 ? co : co < 0 ? eq : Math.min(eq, co);
    if (i <= 0) continue;
    let value = line.slice(i + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out.push({ key: line.slice(0, i).trim(), value, enabled: !off });
  }
  return out;
}

export function looksLikeVarText(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  return lines.length > 0 && lines.every((l) => /^\s*(export\s+)?(\/\/)?\s*[\w.-]+\s*[=:]/.test(l));
}

// Environments live inside a collection; each collection has its own active one.
export function activeEnv(collectionId) {
  const coll = collectionId && getCollection(collectionId);
  if (!coll || !coll.activeEnvironmentId) return null;
  return (coll.environments || []).find((e) => e.id === coll.activeEnvironmentId) || null;
}

export function findEnv(collectionId, envId) {
  return (getCollection(collectionId)?.environments || []).find((e) => e.id === envId) || null;
}

export function variableScope(collectionId) {
  const map = new Map();
  const coll = collectionId && getCollection(collectionId);
  if (!coll) return map;
  // One set at a time: the selected set, or the collection's Default set. Sets never mix.
  const env = activeEnv(collectionId);
  const vars = env ? env.variables : coll.variables;
  const source = env ? env.name : 'Default';
  for (const v of vars || []) if (v.enabled !== false && v.key) map.set(v.key, { value: v.value, source });
  return map;
}


const DYNAMIC = {
  $guid: () => crypto.randomUUID(),
  $randomUUID: () => crypto.randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1000)),
  $randomEmail: () => `user${Math.floor(Math.random() * 100000)}@example.com`,
};

export const VAR_RE = /\{\{\s*([^{}\s]+)\s*\}\}/g;

export function resolveVars(str, scope, depth = 0) {
  if (str == null) return '';
  const out = String(str).replace(VAR_RE, (m, name) => {
    if (DYNAMIC[name]) return DYNAMIC[name]();
    const v = scope.get(name);
    return v ? v.value : m;
  });
  return depth < 3 && VAR_RE.test(out) && out !== str ? resolveVars(out, scope, depth + 1) : out;
}

export function unresolved(str, scope) {
  const missing = [];
  for (const m of String(str || '').matchAll(VAR_RE)) if (!DYNAMIC[m[1]] && !scope.has(m[1])) missing.push(m[1]);
  return missing;
}

// ---------- URL <-> params ----------
export function splitUrl(url) {
  const i = url.indexOf('?');
  return i < 0 ? [url, ''] : [url.slice(0, i), url.slice(i + 1)];
}

export function parseQuery(qs) {
  return qs
    .split('&')
    .filter((p) => p.length)
    .map((pair) => {
      const j = pair.indexOf('=');
      return { key: j < 0 ? pair : pair.slice(0, j), value: j < 0 ? '' : pair.slice(j + 1), enabled: true };
    });
}

export function buildQuery(params) {
  return params
    .filter((p) => p.enabled !== false && (p.key || p.value))
    .map((p) => (p.value === '' && !p.key.includes('=') ? `${p.key}=` : `${p.key}=${p.value}`))
    .join('&');
}

// Merges query params from a typed URL with the disabled ones kept in the table.
export function paramsFromUrl(url, previous) {
  const [, qs] = splitUrl(url);
  const enabled = parseQuery(qs);
  const disabled = (previous || []).filter((p) => p.enabled === false);
  return [...enabled.map((p, i) => ({ ...p, description: previous?.filter((x) => x.enabled !== false)[i]?.description })), ...disabled];
}

export function urlWithParams(url, params) {
  const [base] = splitUrl(url);
  const qs = buildQuery(params);
  return qs ? `${base}?${qs}` : base;
}

export function pathVarNames(url) {
  const [base] = splitUrl(url);
  const noScheme = base.replace(/^[a-z]+:\/\/[^/]*/i, '').replace(/^\{\{[^}]+\}\}/, '');
  return [...noScheme.matchAll(/\/:([A-Za-z_][\w-]*)/g)].map((m) => m[1]);
}

export function syncPathVars(req) {
  const names = pathVarNames(req.url);
  const old = new Map((req.pathVars || []).map((p) => [p.key, p]));
  req.pathVars = names.map((n) => old.get(n) || { key: n, value: '', enabled: true });
}

// ---------- auth ----------
export function effectiveAuth(req, collectionId) {
  if (req.auth && req.auth.type !== 'inherit') return { auth: req.auth, from: 'request' };
  const coll = collectionId && getCollection(collectionId);
  if (coll) {
    const found = findItem(coll, req.id);
    const parents = found ? [...found.parents].reverse() : [];
    for (const p of parents) if (p.auth && p.auth.type !== 'inherit') return { auth: p.auth, from: `folder “${p.name}”` };
    if (coll.auth && coll.auth.type !== 'inherit') return { auth: coll.auth, from: `collection “${coll.name}”` };
  }
  return { auth: { type: 'none' }, from: null };
}

// ---------- building the outgoing request ----------
export function buildOutgoing(req, collectionId) {
  const scope = variableScope(collectionId);
  const R = (s) => resolveVars(s, scope);

  let url = R(req.url).trim();
  for (const pv of req.pathVars || []) {
    url = url.replace(new RegExp(`/:${pv.key}(?=/|\\?|#|$)`), '/' + encodeURIComponent(R(pv.value)));
  }
  // Leave a URL that starts with '/' alone: it means the base variable is empty.
  if (url && !url.startsWith('/') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'http://' + url;

  const headers = (req.headers || []).filter((x) => x.enabled !== false && x.key).map((x) => ({ key: R(x.key), value: R(x.value) }));
  const has = (name) => headers.some((x) => x.key.toLowerCase() === name.toLowerCase());

  const { auth } = effectiveAuth(req, collectionId);
  if (auth.type === 'bearer' && !has('Authorization')) {
    const token = R(auth.bearer?.token);
    if (token) headers.push({ key: 'Authorization', value: `Bearer ${token}` });
  } else if (auth.type === 'basic' && !has('Authorization')) {
    const raw = `${R(auth.basic?.username)}:${R(auth.basic?.password)}`;
    headers.push({ key: 'Authorization', value: `Basic ${btoa(unescape(encodeURIComponent(raw)))}` });
  } else if (auth.type === 'apikey' && auth.apikey?.key) {
    const k = R(auth.apikey.key);
    const v = R(auth.apikey.value);
    if (auth.apikey.in === 'query') url += (url.includes('?') ? '&' : '?') + `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    else if (!has(k)) headers.push({ key: k, value: v });
  }
  if (!has('Accept')) headers.push({ key: 'Accept', value: '*/*' });
  if (!has('User-Agent')) headers.push({ key: 'User-Agent', value: 'ApiDock/0.1' });

  const b = req.body || { mode: 'none' };
  const rows = (list) => (list || []).filter((x) => x.enabled !== false && x.key);
  const body = {
    mode: b.mode,
    rawType: b.rawType,
    raw: b.mode === 'raw' ? R(b.raw) : '',
    urlencoded: b.mode === 'urlencoded' ? rows(b.urlencoded).map((x) => ({ key: R(x.key), value: R(x.value) })) : [],
    formdata:
      b.mode === 'formdata'
        ? rows(b.formdata).map((x) =>
            x.type === 'file'
              ? { key: R(x.key), type: 'file', fileName: x.fileName, fileType: x.fileType, fileData: x.fileData }
              : { key: R(x.key), type: 'text', value: R(x.value) },
          )
        : [],
  };

  const missing = [
    ...unresolved(req.url, scope),
    ...headers.flatMap((x) => unresolved(x.value, scope)),
    ...(b.mode === 'raw' ? unresolved(b.raw, scope) : []),
  ];
  // Defined but blank variables in the URL (e.g. an unset base_url) are just as fatal.
  const empty = [...String(req.url).matchAll(VAR_RE)].map((m) => m[1]).filter((n) => scope.has(n) && scope.get(n).value === '');
  return { method: req.method, url, headers, body, missing: [...new Set(missing)], empty: [...new Set(empty)] };
}

// ---------- code snippets ----------
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function codeSnippet(lang, out) {
  const { method, url, headers, body } = out;
  const bodyText =
    body.mode === 'raw'
      ? body.raw
      : body.mode === 'urlencoded'
        ? new URLSearchParams(body.urlencoded.map((x) => [x.key, x.value])).toString()
        : '';
  const hdrs = headers.filter((x) => x.key !== 'User-Agent');
  if (lang === 'curl') {
    const lines = [`curl -X ${method} ${shq(url)}`];
    for (const x of hdrs) lines.push(`  -H ${shq(`${x.key}: ${x.value}`)}`);
    if (body.mode === 'formdata') for (const f of body.formdata) lines.push(`  -F ${shq(f.type === 'file' ? `${f.key}=@${f.fileName || 'file'}` : `${f.key}=${f.value}`)}`);
    else if (bodyText && method !== 'GET') lines.push(`  --data-raw ${shq(bodyText)}`);
    return lines.join(' \\\n');
  }
  if (lang === 'fetch') {
    const opts = [`  method: ${JSON.stringify(method)}`];
    if (hdrs.length) opts.push(`  headers: ${JSON.stringify(Object.fromEntries(hdrs.map((x) => [x.key, x.value])), null, 2).replace(/\n/g, '\n  ')}`);
    if (bodyText && method !== 'GET') opts.push(`  body: ${JSON.stringify(bodyText)}`);
    return `const res = await fetch(${JSON.stringify(url)}, {\n${opts.join(',\n')}\n});\nconst data = await res.text();\nconsole.log(res.status, data);`;
  }
  if (lang === 'python') {
    const lines = ['import requests', '', `url = ${JSON.stringify(url)}`, `headers = ${JSON.stringify(Object.fromEntries(hdrs.map((x) => [x.key, x.value])), null, 4)}`];
    if (bodyText && method !== 'GET') lines.push(`payload = ${JSON.stringify(bodyText)}`);
    lines.push('', `response = requests.request(${JSON.stringify(method)}, url, headers=headers${bodyText && method !== 'GET' ? ', data=payload' : ''})`, 'print(response.status_code, response.text)');
    return lines.join('\n');
  }
  if (lang === 'php') {
    const lines = [
      '<?php',
      '$ch = curl_init();',
      'curl_setopt_array($ch, [',
      `    CURLOPT_URL => ${JSON.stringify(url)},`,
      '    CURLOPT_RETURNTRANSFER => true,',
      `    CURLOPT_CUSTOMREQUEST => ${JSON.stringify(method)},`,
      `    CURLOPT_HTTPHEADER => [${hdrs.map((x) => JSON.stringify(`${x.key}: ${x.value}`)).join(', ')}],`,
    ];
    if (bodyText && method !== 'GET') lines.push(`    CURLOPT_POSTFIELDS => ${JSON.stringify(bodyText)},`);
    lines.push(']);', '$response = curl_exec($ch);', 'curl_close($ch);', 'echo $response;');
    return lines.join('\n');
  }
  return '';
}
