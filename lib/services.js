// Discovery of APIs on disk plus start/stop of local Laravel servers.
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { scanRoots } = require('./scan');
const { listRoutes } = require('./laravel');
const procs = require('./processes');
const { newId } = store;

const FIRST_PORT = 8101;

let discovery = store.readJson(store.SCAN_CACHE_FILE, null);
let scanning = null;

const idFor = (dir) => crypto.createHash('sha1').update(dir.toLowerCase()).digest('hex').slice(0, 12);

function relName(p, roots) {
  for (const r of roots) {
    const rel = path.relative(r, p);
    if (!rel.startsWith('..')) return rel.split(path.sep).join('/');
  }
  return p;
}

async function rescan() {
  if (scanning) return scanning;
  scanning = (async () => {
    const settings = store.getSettings();
    const found = scanRoots(settings.roots);
    discovery = {
      scannedAt: new Date().toISOString(),
      roots: settings.roots,
      services: found.laravel.map((dir) => ({ id: idFor(dir), kind: 'laravel', name: relName(dir, settings.roots), dir })),
      collections: found.collections.map((file) => ({ file, name: relName(file, settings.roots) })),
      environments: found.environments.map((file) => ({ file, name: relName(file, settings.roots) })),
    };
    store.writeJson(store.SCAN_CACHE_FILE, discovery);
    return discovery;
  })().finally(() => {
    scanning = null;
  });
  return scanning;
}

function serviceById(id) {
  return discovery && discovery.services.find((s) => s.id === id);
}

function portFor(id) {
  const s = store.getSettings();
  return (s.services[id] && s.services[id].port) || null;
}

function state() {
  const imported = new Set(store.listCollections().map((c) => c.source).filter(Boolean));
  const importedEnvs = new Set(store.listCollections().flatMap((c) => (c.environments || []).map((e) => e.source)).filter(Boolean));
  if (!discovery) return { scanning: !!scanning, services: [], collections: [], environments: [] };
  return {
    scanning: !!scanning,
    scannedAt: discovery.scannedAt,
    roots: discovery.roots,
    services: discovery.services.map((s) => {
      const p = procs.info(s.id);
      const port = p.port || portFor(s.id);
      return {
        ...s,
        status: p.status,
        error: p.error,
        port,
        baseUrl: port ? `http://127.0.0.1:${port}` : null,
        imported: imported.has(s.dir),
      };
    }),
    collections: discovery.collections.map((c) => ({ ...c, imported: imported.has(c.file) })),
    environments: discovery.environments.map((e) => ({ ...e, imported: importedEnvs.has(e.file) })),
  };
}

async function assignPort(id) {
  const settings = store.getSettings();
  const saved = settings.services[id] && settings.services[id].port;
  const taken = procs.usedPorts();
  for (const [otherId, cfg] of Object.entries(settings.services)) if (otherId !== id && cfg.port) taken.add(cfg.port);
  const port = await procs.findFreePort(saved || FIRST_PORT, taken);
  settings.services[id] = { ...(settings.services[id] || {}), port };
  store.saveSettings(settings);
  return port;
}

async function start(id) {
  const svc = serviceById(id);
  if (!svc) throw new Error('Unknown service');
  const port = await assignPort(id);
  procs.start(id, {
    cmd: 'php',
    args: ['artisan', 'serve', '--host=127.0.0.1', `--port=${port}`],
    cwd: svc.dir,
    readyUrl: `http://127.0.0.1:${port}/`,
    port,
  });
  return state().services.find((s) => s.id === id);
}

async function stop(id) {
  await procs.stop(id);
}

function logs(id) {
  return procs.info(id).logs;
}

// Builds a collection from a Laravel app's route list, grouped by the first
// path segment after /api.
async function toCollection(id) {
  const svc = serviceById(id);
  if (!svc) throw new Error('Unknown service');
  const port = portFor(id) || (await assignPort(id));
  const { endpoints, warning } = await listRoutes(svc.dir);
  if (!endpoints.length) throw new Error(warning || 'No routes found');

  const folders = new Map();
  for (const ep of endpoints) {
    const segs = ep.path.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const group = segs[0] && !segs[0].startsWith('{') ? segs[0] : 'root';
    if (!folders.has(group)) folders.set(group, []);
    const pathVars = [];
    const url = '{{base_url}}' + ep.path.replace(/\{(\w+)\??\}/g, (_, name) => {
      pathVars.push({ key: name, value: '', enabled: true });
      return ':' + name;
    });
    const hasBody = !['GET', 'HEAD', 'DELETE'].includes(ep.method);
    folders.get(group).push({
      id: newId(),
      type: 'request',
      name: ep.path.replace(/^\/api(?=\/|$)/, '') || '/',
      description: ep.name || '',
      method: ep.method,
      url,
      params: [],
      pathVars,
      headers: [{ key: 'Accept', value: 'application/json', enabled: true }],
      auth: ep.auth ? { type: 'inherit' } : { type: 'none' },
      body: { mode: hasBody ? 'raw' : 'none', rawType: 'json', raw: hasBody ? '{\n  \n}' : '', urlencoded: [], formdata: [] },
    });
  }

  const coll = {
    id: newId(),
    name: svc.name,
    description: `Generated from the Laravel routes of ${svc.dir}${warning ? `\n\nNote: ${warning}` : ''}`,
    variables: [
      { key: 'base_url', value: `http://127.0.0.1:${port}`, enabled: true },
      { key: 'access_token', value: '', enabled: true },
    ],
    auth: { type: 'bearer', bearer: { token: '{{access_token}}' } },
    items: [...folders.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, items]) => ({ id: newId(), type: 'folder', name, description: '', auth: { type: 'inherit' }, items })),
    source: svc.dir,
    createdAt: new Date().toISOString(),
  };
  return store.saveCollection(coll);
}

module.exports = { rescan, state, start, stop, logs, toCollection, stopAll: procs.stopAll, hasScan: () => !!discovery };
