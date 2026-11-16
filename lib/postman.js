// Converts between Postman v2.x JSON and ApiDock's internal model.
//
// ApiDock model
//   collection: { id, name, description, variables[], auth, items[], events?, source? }
//   folder:     { id, type:'folder', name, description, auth?, items[] }
//   request:    { id, type:'request', name, description, method, url,
//                 params[], pathVars[], headers[], auth, body, events? }
//   key/value:  { key, value, enabled, description? }
//   auth:       { type:'inherit'|'none'|'bearer'|'basic'|'apikey',
//                 bearer:{token}, basic:{username,password}, apikey:{key,value,in} }
//   body:       { mode:'none'|'raw'|'urlencoded'|'formdata', rawType, raw,
//                 urlencoded[], formdata[{key,value,type:'text'|'file',enabled}] }
const { newId } = require('./store');

const str = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

function kv(list) {
  return (list || [])
    .filter((x) => x && x.key != null)
    .map((x) => ({
      key: String(x.key),
      value: str(x.value),
      enabled: !x.disabled && x.enabled !== false,
      ...(x.description ? { description: str(x.description.content || x.description) } : {}),
    }));
}

function authFromPostman(a) {
  if (!a) return { type: 'inherit' };
  const get = (list, k) => {
    const hit = (Array.isArray(list) ? list : []).find((x) => x.key === k);
    return hit ? str(hit.value) : '';
  };
  switch (a.type) {
    case 'noauth':
      return { type: 'none' };
    case 'bearer':
      return { type: 'bearer', bearer: { token: get(a.bearer, 'token') } };
    case 'basic':
      return { type: 'basic', basic: { username: get(a.basic, 'username'), password: get(a.basic, 'password') } };
    case 'apikey':
      return {
        type: 'apikey',
        apikey: { key: get(a.apikey, 'key'), value: get(a.apikey, 'value'), in: get(a.apikey, 'in') || 'header' },
      };
    default:
      return { type: 'inherit' };
  }
}

function authToPostman(a) {
  if (!a || a.type === 'inherit') return undefined;
  const pair = (obj) => Object.entries(obj || {}).map(([key, value]) => ({ key, value, type: 'string' }));
  if (a.type === 'none') return { type: 'noauth' };
  if (a.type === 'bearer') return { type: 'bearer', bearer: pair(a.bearer) };
  if (a.type === 'basic') return { type: 'basic', basic: pair(a.basic) };
  if (a.type === 'apikey') return { type: 'apikey', apikey: pair(a.apikey) };
  return undefined;
}

const RAW_LANGS = new Set(['json', 'text', 'xml', 'html', 'javascript']);

function bodyFromPostman(b) {
  const empty = { mode: 'none', rawType: 'json', raw: '', urlencoded: [], formdata: [] };
  if (!b || b.disabled) return empty;
  if (b.mode === 'raw') {
    const lang = b.options && b.options.raw && b.options.raw.language;
    return { ...empty, mode: 'raw', raw: b.raw || '', rawType: RAW_LANGS.has(lang) ? lang : /^\s*[{[]/.test(b.raw || '') ? 'json' : 'text' };
  }
  if (b.mode === 'urlencoded') return { ...empty, mode: 'urlencoded', urlencoded: kv(b.urlencoded) };
  if (b.mode === 'formdata') {
    return {
      ...empty,
      mode: 'formdata',
      formdata: (b.formdata || []).map((f) => ({
        key: str(f.key),
        value: f.type === 'file' ? '' : str(f.value),
        type: f.type === 'file' ? 'file' : /json/i.test(str(f.contentType)) ? 'json' : 'text',
        fileName: f.type === 'file' ? str(Array.isArray(f.src) ? f.src[0] : f.src).split(/[\\/]/).pop() : undefined,
        enabled: !f.disabled,
      })),
    };
  }
  if (b.mode === 'graphql' && b.graphql) {
    return { ...empty, mode: 'raw', rawType: 'json', raw: JSON.stringify(b.graphql, null, 2) };
  }
  return empty;
}

function bodyToPostman(b) {
  if (!b || b.mode === 'none') return undefined;
  const pm = (list) => (list || []).map((x) => ({ key: x.key, value: x.value, type: 'text', ...(x.enabled ? {} : { disabled: true }) }));
  if (b.mode === 'raw') return { mode: 'raw', raw: b.raw || '', options: { raw: { language: b.rawType || 'text' } } };
  if (b.mode === 'urlencoded') return { mode: 'urlencoded', urlencoded: pm(b.urlencoded) };
  if (b.mode === 'formdata') {
    return {
      mode: 'formdata',
      formdata: (b.formdata || []).map((x) =>
        x.type === 'file'
          ? { key: x.key, type: 'file', src: x.fileName || '', ...(x.enabled ? {} : { disabled: true }) }
          : { key: x.key, value: x.value, type: 'text', ...(x.type === 'json' ? { contentType: 'application/json' } : {}), ...(x.enabled ? {} : { disabled: true }) },
      ),
    };
  }
  return undefined;
}

function urlFromPostman(u) {
  if (!u) return { url: '', params: [], pathVars: [] };
  if (typeof u === 'string') return { url: u, params: queryFromUrl(u), pathVars: [] };
  let raw = u.raw;
  if (!raw) {
    const host = Array.isArray(u.host) ? u.host.join('.') : u.host || '';
    const p = Array.isArray(u.path) ? u.path.join('/') : u.path || '';
    raw = `${u.protocol ? u.protocol + '://' : ''}${host}${p ? '/' + p : ''}`;
  }
  const base = raw.split('?')[0];
  const params = u.query ? kv(u.query) : queryFromUrl(raw);
  const enabledQs = params.filter((p) => p.enabled).map((p) => `${p.key}=${p.value}`).join('&');
  return {
    url: enabledQs ? `${base}?${enabledQs}` : base,
    params,
    pathVars: kv(u.variable),
  };
}

function queryFromUrl(url) {
  const i = url.indexOf('?');
  if (i < 0) return [];
  return url
    .slice(i + 1)
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const j = pair.indexOf('=');
      return { key: j < 0 ? pair : pair.slice(0, j), value: j < 0 ? '' : pair.slice(j + 1), enabled: true };
    });
}

function descr(d) {
  if (!d) return '';
  return typeof d === 'string' ? d : str(d.content);
}

function itemFromPostman(it) {
  if (Array.isArray(it.item)) {
    return {
      id: newId(),
      type: 'folder',
      name: it.name || 'Folder',
      description: descr(it.description),
      auth: authFromPostman(it.auth),
      items: it.item.map(itemFromPostman),
      ...(it.event ? { events: it.event } : {}),
    };
  }
  const r = typeof it.request === 'string' ? { method: 'GET', url: it.request } : it.request || {};
  const u = urlFromPostman(r.url);
  return {
    id: newId(),
    type: 'request',
    name: it.name || u.url || 'Request',
    description: descr(r.description || it.description),
    method: String(r.method || 'GET').toUpperCase(),
    url: u.url,
    params: u.params,
    pathVars: u.pathVars,
    headers: kv(r.header),
    auth: authFromPostman(r.auth),
    body: bodyFromPostman(r.body),
    ...(it.event ? { events: it.event } : {}),
  };
}

function collectionFromPostman(json, sourceFile) {
  if (!json || !json.info || !Array.isArray(json.item)) throw new Error('Not a Postman v2 collection');
  const auth = authFromPostman(json.auth);
  return {
    id: newId(),
    name: json.info.name || 'Imported collection',
    description: descr(json.info.description),
    variables: kv(json.variable),
    auth: auth.type === 'inherit' ? { type: 'none' } : auth,
    items: json.item.map(itemFromPostman),
    ...(json.event ? { events: json.event } : {}),
    ...(sourceFile ? { source: sourceFile } : {}),
    createdAt: new Date().toISOString(),
  };
}

function environmentFromPostman(json, sourceFile) {
  if (!json || !Array.isArray(json.values)) throw new Error('Not a Postman environment');
  return { id: newId(), name: json.name || 'Imported environment', variables: kv(json.values), ...(sourceFile ? { source: sourceFile } : {}) };
}

function detectKind(json) {
  if (json && json.info && Array.isArray(json.item)) return 'collection';
  if (json && Array.isArray(json.values)) return 'environment';
  return null;
}

// ---------- export ----------
function urlToPostman(r) {
  const raw = r.url || '';
  const [base] = raw.split('?');
  const m = base.match(/^(https?):\/\/([^/]*)(.*)$/i);
  const out = { raw };
  if (m) {
    out.protocol = m[1];
    out.host = m[2].split('.');
    out.path = m[3].split('/').filter((s, i) => i > 0 || s);
  } else {
    const [host, ...rest] = base.split('/');
    out.host = [host];
    out.path = rest;
  }
  if ((r.params || []).length) {
    out.query = r.params.map((p) => ({ key: p.key, value: p.value, ...(p.enabled ? {} : { disabled: true }) }));
  }
  if ((r.pathVars || []).length) out.variable = r.pathVars.map((p) => ({ key: p.key, value: p.value }));
  return out;
}

function itemToPostman(it) {
  if (it.type === 'folder') {
    const auth = authToPostman(it.auth);
    return {
      name: it.name,
      ...(it.description ? { description: it.description } : {}),
      ...(auth ? { auth } : {}),
      ...(it.events ? { event: it.events } : {}),
      item: (it.items || []).map(itemToPostman),
    };
  }
  const auth = authToPostman(it.auth);
  const body = bodyToPostman(it.body);
  return {
    name: it.name,
    ...(it.events ? { event: it.events } : {}),
    request: {
      method: it.method,
      header: (it.headers || []).map((h) => ({ key: h.key, value: h.value, ...(h.enabled ? {} : { disabled: true }) })),
      ...(auth ? { auth } : {}),
      ...(body ? { body } : {}),
      url: urlToPostman(it),
      ...(it.description ? { description: it.description } : {}),
    },
  };
}

function collectionToPostman(c) {
  const auth = authToPostman(c.auth);
  return {
    info: {
      name: c.name,
      description: c.description || '',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    ...(auth ? { auth } : {}),
    ...(c.events ? { event: c.events } : {}),
    variable: (c.variables || []).map((v) => ({ key: v.key, value: v.value, ...(v.enabled ? {} : { disabled: true }) })),
    item: (c.items || []).map(itemToPostman),
  };
}

function environmentToPostman(e) {
  return {
    name: e.name,
    values: (e.variables || []).map((v) => ({ key: v.key, value: v.value, enabled: v.enabled !== false })),
    _postman_variable_scope: 'environment',
  };
}

module.exports = {
  collectionFromPostman,
  environmentFromPostman,
  collectionToPostman,
  environmentToPostman,
  detectKind,
};
