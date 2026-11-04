// ApiDock — local API client. Serves the UI and a small JSON API.
const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const postman = require('./lib/postman');
const services = require('./lib/services');
const { send } = require('./lib/runner');
const cloud = require('./lib/cloud');

const PORT = Number(process.env.APIDOCK_PORT) || 4000;
let port = PORT; // the port actually bound (the desktop app asks for a free one)
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_UPLOAD = 60 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) {
        reject(new Error('Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('Body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

// Environments belong to a collection, so importing one needs a target collection.
function importJson(content, sourceFile, collectionId) {
  const data = typeof content === 'string' ? JSON.parse(content.replace(/^﻿/, '')) : content;
  const kind = postman.detectKind(data);
  if (kind === 'collection') return { kind, item: store.saveCollection(postman.collectionFromPostman(data, sourceFile)) };
  if (kind === 'environment') {
    const coll = collectionId && store.getCollection(collectionId);
    if (!coll) throw new Error('Pick the collection this environment belongs to.');
    const env = postman.environmentFromPostman(data, sourceFile);
    coll.environments = [...(coll.environments || []), env];
    if (!coll.activeEnvironmentId) coll.activeEnvironmentId = env.id;
    return { kind, item: env, collection: store.saveCollection(coll) };
  }
  throw new Error('Unrecognised file. ApiDock imports Postman v2.0/v2.1 collections and Postman environments.');
}

function isDiscovered(file) {
  const st = services.state();
  return [...st.collections, ...st.environments].some((x) => x.file === file);
}

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler });
};

// ---- bootstrap ----
route('GET', '/api/bootstrap', () => ({
  collections: store.listCollections(),
  settings: store.getSettings(),
}));

// ---- collections ----
route('GET', '/api/collections', () => store.listCollections());
route('POST', '/api/collections', (_, body) =>
  store.saveCollection({
    name: body.name || 'New Collection',
    description: '',
    variables: [],
    auth: { type: 'none' },
    items: [],
    createdAt: new Date().toISOString(),
    ...body,
    id: undefined,
  }),
);
route('PUT', '/api/collections/:id', ({ id }, body) => store.saveCollection({ ...body, id }));
route('DELETE', '/api/collections/:id', ({ id }) => (store.deleteCollection(id), { ok: true }));
route('GET', '/api/collections/:id/export', ({ id }, _, res) => {
  const c = store.getCollection(id);
  if (!c) return json(res, 404, { error: 'Not found' });
  const fileName = `${c.name.replace(/[^\w.-]+/g, '_')}.postman_collection.json`;
  json(res, 200, postman.collectionToPostman(c), { 'Content-Disposition': `attachment; filename="${fileName}"` });
});

// ---- environments (stored inside their collection) ----
route('GET', '/api/collections/:id/environments/:envId/export', ({ id, envId }, _, res) => {
  const e = (store.getCollection(id)?.environments || []).find((x) => x.id === envId);
  if (!e) return json(res, 404, { error: 'Not found' });
  const fileName = `${e.name.replace(/[^\w.-]+/g, '_')}.postman_environment.json`;
  json(res, 200, postman.environmentToPostman(e), { 'Content-Disposition': `attachment; filename="${fileName}"` });
});

// ---- settings ----
route('PUT', '/api/settings', (_, body) => {
  const s = store.getSettings();
  if (Array.isArray(body.roots)) s.roots = body.roots.filter((r) => typeof r === 'string' && r.trim());
  return store.saveSettings(s);
});

// ---- import ----
route('POST', '/api/import', (_, body) => importJson(body.content, undefined, body.collectionId));
route('POST', '/api/import-file', (_, body) => {
  if (!isDiscovered(body.file)) throw new Error('That file was not found by the scan.');
  return importJson(fs.readFileSync(body.file, 'utf8'), body.file, body.collectionId);
});

// ---- sending ----
route('POST', '/api/send', async (_, body) => {
  const result = await send(body);
  store.addHistory({
    at: new Date().toISOString(),
    method: result.request.method,
    url: result.request.url,
    status: result.status,
    ms: result.ms,
    requestId: body.requestId || null,
    collectionId: body.collectionId || null,
    snapshot: body.snapshot || null,
  });
  return result;
});

// ---- history ----
route('GET', '/api/history', () => store.listHistory());
route('DELETE', '/api/history', () => (store.clearHistory(), { ok: true }));

// ---- discovery & services ----
route('GET', '/api/discover', () => services.state());
route('POST', '/api/discover/rescan', async () => {
  await services.rescan();
  return services.state();
});
route('POST', '/api/services/:id/start', ({ id }) => services.start(id));
route('POST', '/api/services/:id/stop', async ({ id }) => (await services.stop(id), { ok: true }));
route('GET', '/api/services/:id/logs', ({ id }) => services.logs(id));
route('POST', '/api/services/:id/collection', ({ id }) => services.toCollection(id));

// ---- team server (sign-in + proxy; the session token stays on this machine) ----
route('GET', '/api/cloud/status', () => cloud.status());
route('POST', '/api/cloud/login', () => ({ url: cloud.loginUrl(port) }));
route('GET', '/api/cloud/config', () => cloud.authConfig());
route('POST', '/api/cloud/auth', (_, body) => cloud.passwordAuth(body.mode, body));
route('POST', '/api/cloud/logout', async () => (await cloud.logout(), cloud.status()));
route('PUT', '/api/cloud/server', (_, body) => cloud.setServer(body.server));
route('GET', '/api/cloud/callback', async (params, body, res, query) => {
  let title = 'Signed in';
  let msg = '';
  try {
    const user = await cloud.finishLogin(query.get('token') || '', query.get('state') || '');
    msg = `Signed in as <b>${String(user.email).replace(/[<>&"]/g, '')}</b>. You can close this tab and go back to ApiDock.`;
  } catch (err) {
    title = 'Sign-in failed';
    msg = String(err.message).replace(/[<>&"]/g, '');
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><title>ApiDock — ${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,'Segoe UI',sans-serif;background:#121211;color:#ecebe5}
.c{max-width:420px;padding:32px;border:1px solid #2a2926;border-radius:16px;background:#1c1c1a}h1{font-size:20px;margin:0 0 8px}p{color:#bdb9af;margin:0}</style>
<div class="c"><h1>${title}</h1><p>${msg}</p></div><script>setTimeout(()=>window.close(),2500)</script>`);
});
// Everything else under /api/cloud/x/... is forwarded to the team server's /api/...
for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
  routes.push({
    method,
    re: /^\/api\/cloud\/x(\/.*)$/,
    keys: ['path'],
    handler: async ({ path: p }, body, res) => {
      try {
        return await cloud.call(method, p, ['POST', 'PUT', 'PATCH'].includes(method) ? body : undefined);
      } catch (err) {
        res.writeHead(err.status || 502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message, ...(err.data || {}) }));
      }
    },
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (!pathname.startsWith('/api/')) return serveStatic(req, res);

  // Only the ApiDock page itself may call this API.
  const origin = req.headers.origin;
  if (origin && origin !== `http://${HOST}:${port}` && origin !== `http://localhost:${port}`) {
    return json(res, 403, { error: 'Cross-origin requests are not allowed' });
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = pathname.match(r.re);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    try {
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      const out = await r.handler(params, body, res, new URL(req.url, 'http://x').searchParams);
      if (!res.headersSent) json(res, 200, out ?? { ok: true });
    } catch (err) {
      if (!res.headersSent) json(res, 400, { error: err.message });
    }
    return;
  }
  json(res, 404, { error: 'Unknown endpoint' });
});

// Starts the server; resolves with the bound port. Port 0 picks a free one.
function start(wanted = PORT) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(wanted, HOST, () => {
      port = server.address().port;
      if (!services.hasScan()) services.rescan().then((d) => console.log(`Scan found ${d.services.length} Laravel apps and ${d.collections.length} collections.`));
      resolve(port);
    });
  });
}

async function stop() {
  await services.stopAll();
  await new Promise((r) => server.close(() => r()));
}

module.exports = { start, stop };

// `node server.js` — run as a plain local server.
if (require.main === module) {
  start().then((p) => console.log(`ApiDock is running at http://localhost:${p}`));
  const shutdown = async () => {
    await services.stopAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
